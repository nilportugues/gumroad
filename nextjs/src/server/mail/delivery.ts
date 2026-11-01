// MailDeliveryJob#perform on the Node worker: deserialize the ActiveJob arguments, render the
// ported mailer method, then deliver_now over SMTP with the mailer's rescue and retry rules.
import { Prisma } from "@prisma/client";

import { getConfig } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";
import type { JobsRuntime } from "../jobs/runtime.ts";
import type { SidekiqItem } from "../jobs/sidekiq/item.ts";
import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { selectRows } from "../models/sql.ts";
import { MAIL_RETRY_ON, type MailJobRoute, pushMailDeliveryItem, retryMailDeliveryItem } from "./active-job.ts";
import type { MailerDeps } from "./application-mailer.ts";
import { composeMail, type ComposedMail, type RenderedMail } from "./compose.ts";
import { defaultDeliveryMethodOptions } from "./mailer-info.ts";
import { MimeNotPortedError } from "./mime.ts";
import { UnsupportedHtmlError } from "./premailer/html.ts";
import { UnsupportedSelectorError } from "./premailer/selector.ts";
import { deserializeArgument, GlobalIdRef, MailArgumentNotPortedError, RubyHash, RubySymbol, type RubyValue } from "./ruby-value.ts";
import { StylesheetNotPortedError } from "./stylesheet.ts";
import { ViewHelperNotPortedError } from "./view-helpers.ts";
import { MailViewNotPortedError } from "./views.ts";
import { notifySellerOfNewComment } from "./mailers/comment-mailer.ts";
import { communityChatRecapNotification } from "./mailers/community-chat-recap-mailer.ts";
import { notify as internalNotification } from "./mailers/internal-notification-mailer.ts";
import { marketingXReconnect } from "./mailers/creator-mailer.ts";
import { filesReadyForDownload, partialRefund, paypalPurchaseFailed, refund, subscriptionMagicLink } from "./mailers/customer-mailer.ts";
import { invite as teamInvite } from "./mailers/team-mailer.ts";
import { receiverSignedUp } from "./mailers/invite-mailer.ts";
import { authenticationToken } from "./mailers/two-factor-authentication-mailer.ts";
import { confirmationInstructions, type DeviseMailOptions, emailChanged, type SignupMailUser } from "./mailers/user-signup-mailer.ts";
import { sendSmtp, SmtpError, type SmtpSettings } from "./smtp.ts";

export class MailJobArgumentsError extends Error {}

// A mailer method: null when it returns without calling `mail` (ActionMailer's NullMail).
type MailerMethod = (args: RubyValue[], deps: MailerDeps) => Promise<RenderedMail | null>;

// GlobalID::Locator.locate for the one model the ported mailers take. A missing row raises, as
// ActiveJob::DeserializationError does, and Sidekiq's retry takes over.
async function locateUser(argument: RubyValue | undefined): Promise<SignupMailUser> {
  const gid = argument instanceof GlobalIdRef ? argument.gid : "";
  const match = /^gid:\/\/gumroad\/User\/(\d+)$/u.exec(gid);
  if (!match) throw new MailJobArgumentsError(`GlobalID not ported: ${gid}`);
  const [row] = await selectRows<{ email: string | null; unconfirmed_email: string | null; confirmation_token: string | null; external_id: string | null }>(
    Prisma.sql`SELECT email, unconfirmed_email, confirmation_token, external_id FROM users WHERE id = ${BigInt(match[1]!)} LIMIT 1`,
  );
  if (!row) throw new MailJobArgumentsError(`Couldn't find User with 'id'=${match[1]}`);
  return { email: row.email ?? "", unconfirmedEmail: row.unconfirmed_email, confirmationToken: row.confirmation_token, externalId: row.external_id ?? "" };
}

// Devise's opts: a symbol-keyed hash whose only key is :to.
function deviseOptions(argument: RubyValue | undefined): DeviseMailOptions {
  if (argument === undefined || argument === null) return {};
  if (!(argument instanceof RubyHash)) throw new MailJobArgumentsError("Devise options not ported");
  const options: DeviseMailOptions = {};
  for (const [key, value] of argument.entries) {
    if (!(key instanceof RubySymbol) || key.name !== "to" || (value !== null && typeof value !== "string")) throw new MailJobArgumentsError(`mailer option ${String(key)} not ported`);
    options.to = value;
  }
  return options;
}

const integerArgument = (value: RubyValue | undefined): number | bigint => {
  if (typeof value === "number" || typeof value === "bigint") return value;
  throw new MailJobArgumentsError(`expected an Integer argument, got ${JSON.stringify(value)}`);
};

const optionalString = (value: RubyValue | undefined): string | null => {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new MailJobArgumentsError(`expected a String argument, got ${JSON.stringify(value)}`);
};

// A call with only keyword arguments: one keyword hash whose keys are exactly `names`.
function keywords(args: RubyValue[], names: string[]): Record<string, RubyValue> {
  const [hash] = args;
  if (args.length !== 1 || !(hash instanceof RubyHash)) throw new MailJobArgumentsError("expected keyword arguments");
  const out: Record<string, RubyValue> = {};
  for (const [key, value] of hash.entries) {
    if (!(key instanceof RubySymbol) || !names.includes(key.name)) throw new MailJobArgumentsError(`unknown keyword ${String(key)}`);
    out[key.name] = value;
  }
  return out;
}

// `authentication_token(user_id, email_provider: nil)`; the keyword hash is absent when the
// caller passed no keywords.
function twoFactorArguments(args: RubyValue[]): [number | bigint, string | null] {
  const [userId, options, ...rest] = args;
  if (rest.length > 0) throw new MailJobArgumentsError("arity");
  if (options === undefined) return [integerArgument(userId), null];
  const { email_provider: provider = null } = keywords([options], ["email_provider"]);
  if (provider !== null && typeof provider !== "string") throw new MailJobArgumentsError(`email_provider ${JSON.stringify(provider)} not ported`);
  return [integerArgument(userId), provider];
}

// Mailer methods the Node worker renders. Everything else stays with Rails.
const NODE_MAILERS: Record<string, Record<string, MailerMethod>> = {
  CommentMailer: {
    notify_seller_of_new_comment: (args, deps) =>
      args.length === 1 ? notifySellerOfNewComment(integerArgument(args[0]), deps) : Promise.reject(new MailJobArgumentsError("arity")),
  },
  CommunityChatRecapMailer: {
    community_chat_recap_notification: ([userId, sellerId, recapIds, ...rest], deps) => {
      if (rest.length > 0 || !Array.isArray(recapIds)) return Promise.reject(new MailJobArgumentsError("arity"));
      return communityChatRecapNotification(integerArgument(userId), integerArgument(sellerId), recapIds.map(integerArgument), deps);
    },
  },
  CreatorMailer: {
    marketing_x_reconnect: (args, deps) => marketingXReconnect(integerArgument(keywords(args, ["marketing_action_id"]).marketing_action_id), deps),
  },
  CustomerMailer: {
    refund: (args, deps) => {
      const [email, linkId, purchaseId, ...rest] = args;
      if (rest.length > 0 || args.length < 3) return Promise.reject(new MailJobArgumentsError("arity"));
      return refund(optionalString(email), integerArgument(linkId), purchaseId === null ? null : integerArgument(purchaseId), args, deps);
    },
    partial_refund: (args, deps) => {
      const [email, linkId, purchaseId, refundAmountCentsUsd, refundType, presentmentCents = null, presentmentCurrency = null, ...rest] = args;
      if (rest.length > 0 || args.length < 5 || typeof refundType !== "string") return Promise.reject(new MailJobArgumentsError("arity"));
      return partialRefund(
        {
          email: optionalString(email),
          linkId: integerArgument(linkId),
          purchaseId: purchaseId === null ? null : integerArgument(purchaseId),
          refundAmountCentsUsd: integerArgument(refundAmountCentsUsd),
          refundType,
          presentmentRefundAmountCents: presentmentCents === null ? null : integerArgument(presentmentCents),
          presentmentRefundCurrency: optionalString(presentmentCurrency),
        },
        args,
        deps,
      );
    },
    files_ready_for_download: (args, deps) => (args.length === 1 ? filesReadyForDownload(integerArgument(args[0]), args, deps) : Promise.reject(new MailJobArgumentsError("arity"))),
    subscription_magic_link: (args, deps) => {
      const [subscriptionId, email, ...rest] = args;
      if (rest.length > 0 || typeof email !== "string") return Promise.reject(new MailJobArgumentsError("arity"));
      return subscriptionMagicLink(integerArgument(subscriptionId), email, args, deps);
    },
    paypal_purchase_failed: (args, deps) => (args.length === 1 ? paypalPurchaseFailed(integerArgument(args[0]), args, deps) : Promise.reject(new MailJobArgumentsError("arity"))),
  },
  InternalNotificationMailer: {
    notify: (args, deps) => internalNotification(args, deps),
  },
  InviteMailer: {
    receiver_signed_up: (args, deps) => (args.length === 1 ? receiverSignedUp(integerArgument(args[0]), deps) : Promise.reject(new MailJobArgumentsError("arity"))),
  },
  TeamMailer: {
    invite: (args, deps) => (args.length === 1 ? teamInvite(args, deps) : Promise.reject(new MailJobArgumentsError("arity"))),
  },
  TwoFactorAuthenticationMailer: {
    authentication_token: (args, deps) => {
      const [userId, emailProvider] = twoFactorArguments(args);
      return authenticationToken(userId, emailProvider, args, deps);
    },
  },
  UserSignupMailer: {
    confirmation_instructions: async ([user, token, options]) => confirmationInstructions(await locateUser(user), token as string, deviseOptions(options)),
    email_changed: async ([user, options]) => emailChanged(await locateUser(user), deviseOptions(options)),
  },
};

// "Mailer#method" pairs Node can deliver. lib/sidekiq_node_bridge.rb diverts Ruby's deliveries of
// these through node-owned-mailers.generated.json, which a test keeps equal to this list.
export function nodeMailerMethods(): string[] {
  return Object.entries(NODE_MAILERS)
    .flatMap(([mailer, methods]) => Object.keys(methods).map((method) => `${mailer}#${method}`))
    .sort();
}

// Rollout switch: until it is on, every delivery, from Node or Ruby, is left to Rails.
export function mailRoute(mailer: string, method: string): MailJobRoute {
  if (getConfig("NODE_MAIL_DELIVERY") !== "enabled" || railsEnv() !== "production") return "ruby";
  return NODE_MAILERS[mailer]?.[method] ? "node" : "ruby";
}

export function renderNodeMailer(mailer: string, method: string, args: RubyValue[], deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const render = NODE_MAILERS[mailer]?.[method];
  if (!render) throw new MailJobArgumentsError(`${mailer}#${method} is not ported`);
  return render(args, deps);
}

// Mail::SMTP's settings: config.action_mailer.smtp_settings (SendGrid, the gumroad domain) with the
// message's delivery_method_options merged over them. mailRoute keeps other environments on Rails.
function smtpSettings(mail: ComposedMail): SmtpSettings {
  const options = mail.smtp ?? defaultDeliveryMethodOptions("gumroad");
  return { address: options.address, port: 587, domain: options.domain, userName: options.user_name, password: options.password ?? "" };
}

export type MailDeliveryDeps = {
  send(mail: ComposedMail): Promise<void>;
  log(message: string): void;
  random?: () => number;
  mailer?: MailerDeps;
};

const defaultDeps: MailDeliveryDeps = {
  send: (mail) => sendSmtp(smtpSettings(mail), { from: mail.envelopeFrom, to: mail.envelopeTo }, mail.encoded),
  log: (message) => console.error(message),
};

// RescueSmtpErrors' rescue_from: logged as Rails does, and the job succeeds.
const RESCUED: readonly string[] = ["Net::SMTPAuthenticationError", "Net::SMTPSyntaxError", "Net::SMTPFatalError"];

// Input the port cannot reproduce exactly; Rails renders those.
const NOT_PORTED = [MailJobArgumentsError, MailArgumentNotPortedError, MailViewNotPortedError, ViewHelperNotPortedError, MimeNotPortedError, StylesheetNotPortedError, UnsupportedHtmlError, UnsupportedSelectorError];
export const isNotPorted = (error: unknown) => NOT_PORTED.some((type) => error instanceof type);

// Render and compose: undefined when the method sends nothing, null when Mail would refuse the
// blank To (RescueSmtpErrors logs that).
export async function composeNodeMail(mailer: string, method: string, args: RubyValue[], deps: MailerDeps = {}): Promise<ComposedMail | null | undefined> {
  const rendered = await renderNodeMailer(mailer, method, args, deps);
  return rendered === null ? undefined : composeMail(rendered);
}

// `deliver_now` of an already composed message: true when Mail returned the message, false when
// RescueSmtpErrors swallowed the failure. Retryable SMTP errors propagate.
export async function sendComposed(mail: ComposedMail | null, deps: Pick<MailDeliveryDeps, "send" | "log">): Promise<boolean> {
  if (mail === null) {
    deps.log(`Mailer Error: #<ArgumentError: SMTP To address may not be blank: ${JSON.stringify([])}>`);
    return false;
  }
  try {
    await deps.send(mail);
    return true;
  } catch (error) {
    if (error instanceof SmtpError && RESCUED.includes(error.rubyClass)) {
      deps.log(`Mailer Error: #<${error.rubyClass}: ${error.message}>`);
      return false;
    }
    throw error;
  }
}

export const defaultMailDeliveryDeps = defaultDeps;

// Runs one MailDeliveryJob wrapper item. A mailer method Node has not ported is handed back to
// Sidekiq unchanged (same jid), so Rails delivers it.
export async function performMailDelivery(runtime: JobsRuntime, item: SidekiqItem, deps: MailDeliveryDeps = defaultDeps): Promise<void> {
  const job = (item.args as Record<string, JsonValue>[])[0]!;
  const [mailer, method, deliveryMethod, params] = job.arguments as [string, string, string, Record<string, JsonValue>];
  if (!NODE_MAILERS[mailer]?.[method] || deliveryMethod !== "deliver_now") return pushMailDeliveryItem(runtime, item, "ruby");

  let mail: ComposedMail | null | undefined;
  try {
    mail = await composeNodeMail(mailer, method, (params.args as JsonValue[]).map(deserializeArgument), deps.mailer);
  } catch (error) {
    if (!isNotPorted(error)) throw error;
    deps.log(`Handing ${mailer}#${method} back to Rails: ${(error as Error).message}`);
    return pushMailDeliveryItem(runtime, item, "ruby");
  }
  if (mail === undefined) return;
  try {
    await sendComposed(mail, deps);
  } catch (error) {
    if (!(error instanceof SmtpError) || !MAIL_RETRY_ON.includes(error.rubyClass)) throw error;
    const retry = retryMailDeliveryItem(item, { jid: runtime.newJid(), now: runtime.now(), ...(deps.random ? { random: deps.random } : {}) });
    if (!retry) throw error;
    await pushMailDeliveryItem(runtime, retry, mailRoute(mailer, method));
  }
}
