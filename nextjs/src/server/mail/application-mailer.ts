// Port of app/mailers/application_mailer.rb: the default from and delivery_method_options, the
// validate_from_email_domain! after_action, and #process's United Internet redirect and X-GUM
// headers, in that order. Pinned by application-mailer.golden.json.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../models/sql.ts";
import type { RenderedMail } from "./compose.ts";
import {
  buildHeaders,
  defaultEmailDomain,
  type DeliveryMethodOptions,
  EMAIL_PROVIDER_RESEND,
  EMAIL_PROVIDER_SENDGRID,
  forceSendgridForRecipients,
  isResend,
  type RandomIv,
  randomDeliveryMethodOptions,
  type RouterDeps,
  sendgridEquivalentOptions,
} from "./mailer-info.ts";
import type { MimeAttachment } from "./mime.ts";
import type { RubyValue } from "./ruby-value.ts";
import type { S3Reader } from "./s3-object.ts";

// ApplicationMailer::NOREPLY_EMAIL and NOREPLY_EMAIL_WITH_NAME.
export const noreplyEmail = () => `noreply@${defaultEmailDomain()}`;
export const noreplyEmailWithName = () => `Gumroad <${noreplyEmail()}>`;

// `now` is Time.now; `redisSetEx` stands in for `$redis.set(key, value, ex:)`.
export type MailerDeps = { s3?: S3Reader; router?: RouterDeps; randomIv?: RandomIv; now?: () => Date; redisSetEx?: (key: string, value: string, seconds: number) => Promise<unknown> };

// What a mailer method hands to `mail`, plus the name and arguments ActionMailer passed to
// #process (MailerInfo puts them in the headers).
export type ApplicationMail = {
  mailerClass: string;
  mailerMethod: string;
  args: RubyValue[];
  from?: string;
  to: string | null;
  cc?: string;
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: MimeAttachment[];
  // Absent: the class default, `MailerInfo.random_delivery_method_options(domain: :gumroad)`.
  deliveryMethodOptions?: DeliveryMethodOptions;
};

const bareAddress = (address: string) => /<([^>]+)>$/u.exec(address)?.[1] ?? address;

// validate_from_email_domain!
export function validateFromEmailDomain(from: string, expectedDomain: string): void {
  const address = bareAddress(from);
  if (address.split("@").at(-1) !== expectedDomain) {
    throw new Error(`From email \`${address}\` domain does not match expected delivery domain \`${expectedDomain}\``);
  }
}

// ActionMailer's `mail` with ApplicationMailer's defaults, then the rest of the request cycle.
export async function applicationMail(mail: ApplicationMail, deps: MailerDeps = {}): Promise<RenderedMail> {
  const from = mail.from ?? noreplyEmailWithName();
  let smtp = mail.deliveryMethodOptions ?? (await randomDeliveryMethodOptions("gumroad", {}, deps.router));
  validateFromEmailDomain(from, smtp.domain);

  // redirect_united_internet_recipients_to_sendgrid!: `destinations` is to, cc and bcc (no ported mailer sets bcc).
  if (forceSendgridForRecipients([mail.to, mail.cc ?? null])) smtp = sendgridEquivalentOptions(smtp) ?? smtp;

  const emailProvider = isResend(smtp) ? EMAIL_PROVIDER_RESEND : EMAIL_PROVIDER_SENDGRID;
  const headers = buildHeaders({ mailerClass: mail.mailerClass, mailerMethod: mail.mailerMethod, mailerArgs: mail.args, emailProvider, ...(deps.randomIv ? { randomIv: deps.randomIv } : {}) });
  return {
    from,
    to: mail.to,
    ...(mail.cc !== undefined ? { cc: mail.cc } : {}),
    subject: mail.subject,
    ...(mail.replyTo !== undefined ? { replyTo: mail.replyTo } : {}),
    html: mail.html,
    ...(mail.attachments ? { attachments: mail.attachments } : {}),
    headers,
    smtp,
  };
}

// ActiveRecord::RecordNotFound: the delivery job fails and Sidekiq retries it, as in Ruby.
export class RecordNotFoundError extends Error {}

// `Model.find(id)` / `find_by(id:)`: `SELECT table.* FROM table WHERE table.id = ? LIMIT 1`.
export async function findRow<T>(tableName: string, id: number | bigint, where: Prisma.Sql | null = null): Promise<T | null> {
  const conditions = [...(where ? [where] : []), Prisma.sql`${column(tableName, "id")} = ${id}`];
  const [row] = await selectRows<T>(Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${Prisma.join(conditions, " AND ")} LIMIT 1`);
  return row ?? null;
}

export async function findRowOrRaise<T>(tableName: string, rubyClass: string, id: number | bigint | null): Promise<T> {
  if (id === null) throw new RecordNotFoundError(`Couldn't find ${rubyClass} without an ID`);
  const row = await findRow<T>(tableName, id);
  if (!row) throw new RecordNotFoundError(`Couldn't find ${rubyClass} with 'id'=${String(id)}`);
  return row;
}
