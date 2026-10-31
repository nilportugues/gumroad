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
import { composeMail, type ComposedMail } from "./compose.ts";
import { MimeNotPortedError } from "./mime.ts";
import { UnsupportedHtmlError } from "./premailer/html.ts";
import { UnsupportedSelectorError } from "./premailer/selector.ts";
import { StylesheetNotPortedError } from "./stylesheet.ts";
import { MailViewNotPortedError } from "./views.ts";
import { confirmationInstructions, type DeviseMailOptions, emailChanged, type RenderedMail, type SignupMailUser } from "./mailers/user-signup-mailer.ts";
import { sendSmtp, SmtpError, type SmtpSettings } from "./smtp.ts";

export class MailJobArgumentsError extends Error {}

type Deserialized = SignupMailUser | string | DeviseMailOptions | null;
type MailerMethod = (args: Deserialized[]) => RenderedMail;

// Mailer methods the Node worker renders. Everything else stays with Rails.
const NODE_MAILERS: Record<string, Record<string, MailerMethod>> = {
  UserSignupMailer: {
    confirmation_instructions: ([user, token, options]) => confirmationInstructions(user as SignupMailUser, token as string, (options ?? {}) as DeviseMailOptions),
    email_changed: ([user, options]) => emailChanged(user as SignupMailUser, (options ?? {}) as DeviseMailOptions),
  },
};

// Rollout switch: until it is on, every delivery, from Node or Ruby, is left to Rails.
export function mailRoute(mailer: string, method: string): MailJobRoute {
  if (getConfig("NODE_MAIL_DELIVERY") !== "enabled" || railsEnv() !== "production") return "ruby";
  return NODE_MAILERS[mailer]?.[method] ? "node" : "ruby";
}

// GlobalID::Locator.locate for the one model the ported mailers take. A missing row raises, as
// ActiveJob::DeserializationError does, and Sidekiq's retry takes over.
async function locateUser(gid: string): Promise<SignupMailUser> {
  const match = /^gid:\/\/gumroad\/User\/(\d+)$/u.exec(gid);
  if (!match) throw new MailJobArgumentsError(`GlobalID not ported: ${gid}`);
  const [row] = await selectRows<{ email: string | null; unconfirmed_email: string | null; confirmation_token: string | null; external_id: string | null }>(
    Prisma.sql`SELECT email, unconfirmed_email, confirmation_token, external_id FROM users WHERE id = ${BigInt(match[1]!)} LIMIT 1`,
  );
  if (!row) throw new MailJobArgumentsError(`Couldn't find User with 'id'=${match[1]}`);
  return { email: row.email ?? "", unconfirmedEmail: row.unconfirmed_email, confirmationToken: row.confirmation_token, externalId: row.external_id ?? "" };
}

// ActiveJob::Arguments.deserialize for strings, nil, records and symbol-keyed hashes of strings.
async function deserialize(argument: JsonValue): Promise<Deserialized> {
  if (argument === null || typeof argument === "string") return argument;
  if (typeof argument === "object" && !Array.isArray(argument)) {
    const hash = argument as Record<string, JsonValue>;
    if (typeof hash._aj_globalid === "string" && Object.keys(hash).length === 1) return locateUser(hash._aj_globalid);
    const symbolKeys = hash._aj_symbol_keys;
    if (Array.isArray(symbolKeys) && Object.keys(hash).every((key) => key === "_aj_symbol_keys" || symbolKeys.includes(key))) {
      const options: DeviseMailOptions = {};
      for (const key of symbolKeys) {
        const value = hash[key as string];
        if (key !== "to" || (value !== null && typeof value !== "string")) throw new MailJobArgumentsError(`mailer option ${String(key)} not ported`);
        options.to = value;
      }
      return options;
    }
  }
  throw new MailJobArgumentsError(`ActiveJob argument not ported: ${JSON.stringify(argument)}`);
}

// config/initializers/mailer.rb's production smtp_settings: SendGrid with the gumroad-domain
// credentials. mailRoute keeps other environments on Rails.
function defaultSmtpSettings(): SmtpSettings {
  return {
    address: getConfig("SENDGRID_SMTP_ADDRESS", "smtp.sendgrid.net"),
    port: 587,
    domain: "gumroad.com",
    userName: "apikey",
    password: getConfig("SENDGRID_GUMROAD_TRANSACTIONS_API_KEY") ?? "",
  };
}

export type MailDeliveryDeps = {
  send(mail: ComposedMail): Promise<void>;
  log(message: string): void;
  random?: () => number;
};

const defaultDeps: MailDeliveryDeps = {
  send: (mail) => sendSmtp(defaultSmtpSettings(), { from: mail.envelopeFrom, to: mail.envelopeTo }, mail.encoded),
  log: (message) => console.error(message),
};

// RescueSmtpErrors' rescue_from: logged as Rails does, and the job succeeds.
const RESCUED: readonly string[] = ["Net::SMTPAuthenticationError", "Net::SMTPSyntaxError", "Net::SMTPFatalError"];

// Input the port cannot reproduce exactly; Rails renders those.
const NOT_PORTED = [MailJobArgumentsError, MailViewNotPortedError, MimeNotPortedError, StylesheetNotPortedError, UnsupportedHtmlError, UnsupportedSelectorError];

// Runs one MailDeliveryJob wrapper item. A mailer method Node has not ported is handed back to
// Sidekiq unchanged (same jid), so Rails delivers it.
export async function performMailDelivery(runtime: JobsRuntime, item: SidekiqItem, deps: MailDeliveryDeps = defaultDeps): Promise<void> {
  const job = (item.args as Record<string, JsonValue>[])[0]!;
  const [mailer, method, deliveryMethod, params] = job.arguments as [string, string, string, Record<string, JsonValue>];
  const render = NODE_MAILERS[mailer]?.[method];
  if (!render || deliveryMethod !== "deliver_now") return pushMailDeliveryItem(runtime, item, "ruby");

  let mail: ComposedMail | null;
  try {
    mail = composeMail(render(await Promise.all((params.args as JsonValue[]).map(deserialize))));
  } catch (error) {
    if (!NOT_PORTED.some((type) => error instanceof type)) throw error;
    deps.log(`Handing ${mailer}#${method} back to Rails: ${(error as Error).message}`);
    return pushMailDeliveryItem(runtime, item, "ruby");
  }
  if (!mail) {
    deps.log(`Mailer Error: #<ArgumentError: SMTP To address may not be blank: ${JSON.stringify([])}>`);
    return;
  }
  try {
    await deps.send(mail);
  } catch (error) {
    if (!(error instanceof SmtpError)) throw error;
    if (RESCUED.includes(error.rubyClass)) {
      deps.log(`Mailer Error: #<${error.rubyClass}: ${error.message}>`);
      return;
    }
    if (!MAIL_RETRY_ON.includes(error.rubyClass)) throw error;
    const retry = retryMailDeliveryItem(item, { jid: runtime.newJid(), now: runtime.now(), ...(deps.random ? { random: deps.random } : {}) });
    if (!retry) throw error;
    await pushMailDeliveryItem(runtime, retry, mailRoute(mailer, method));
  }
}
