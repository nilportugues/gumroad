// Port of app/models/sent_email_info.rb. `mailer_key_digest` hashes Ruby's Array#to_s of the mailer
// arguments, so only the arguments whose #inspect is ported (Integers, nil, booleans and plain ASCII
// Strings) are accepted; anything else is a NotPortedError.
import { createHash } from "node:crypto";

import { Prisma, type SentEmailInfo } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { isRecordNotUnique, selectRows, table, column } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export const SENT_EMAIL_INFOS = "sent_email_infos";

export const SentEmailInfos = defineModel<SentEmailInfo>({
  rubyClass: "SentEmailInfo",
  prismaModel: "SentEmailInfo",
  delegate: (tx) => tx.sentEmailInfo as never,
  validations: [validatesPresenceOf<SentEmailInfo>(["key"])],
});

// `SentEmailInfo.key_exists?(key)`
export async function sentEmailKeyExists(key: string): Promise<boolean> {
  const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(SENT_EMAIL_INFOS)} WHERE ${column(SENT_EMAIL_INFOS, "key")} = ${key} LIMIT 1`);
  return rows.length > 0;
}

// `SentEmailInfo.set_key!(key)`: true once saved, nil (null) when the key already exists.
export async function setSentEmailKey(key: string, now?: () => Date): Promise<true | null> {
  try {
    await SentEmailInfos.saveBang(SentEmailInfos.build({ key }), now ? { now } : undefined);
    return true;
  } catch (error) {
    if (isRecordNotUnique(error)) return null;
    throw error;
  }
}

export type MailerArgument = number | bigint | string | boolean | null;

// String#inspect for strings whose escapes are trivial: printable ASCII without a quote, a
// backslash or an interpolation lead-in (`#{`, `#$`, `#@`).
function inspectString(value: string): string {
  if (!/^[\x20-\x7e]*$/u.test(value) || /["\\]/u.test(value) || /#[{$@]/u.test(value)) {
    throw new NotPortedError(`String#inspect of ${JSON.stringify(value)}`, "sent_email_info.rb:21");
  }
  return `"${value}"`;
}

function inspect(argument: MailerArgument): string {
  if (argument === null) return "nil";
  if (typeof argument === "string") return inspectString(argument);
  if (typeof argument === "boolean") return String(argument);
  if (typeof argument === "number" && !Number.isSafeInteger(argument)) throw new NotPortedError("Float#inspect", "sent_email_info.rb:21");
  return String(argument);
}

// `SentEmailInfo.mailer_key_digest(mailer_class, mailer_method, *args)`: SHA1 of
// "#{mailer_class}.#{mailer_method}#{args}".
export function mailerKeyDigest(mailerClass: string, mailerMethod: string, ...args: MailerArgument[]): string {
  return createHash("sha1").update(`${mailerClass}.${mailerMethod}[${args.map(inspect).join(", ")}]`).digest("hex");
}

// `SentEmailInfo.mailer_exists?`
export function mailerExists(mailerClass: string, mailerMethod: string, ...args: MailerArgument[]): Promise<boolean> {
  return sentEmailKeyExists(mailerKeyDigest(mailerClass, mailerMethod, ...args));
}

// `SentEmailInfo.ensure_mailer_uniqueness`: runs `block` only for the caller that recorded the key.
export async function ensureMailerUniqueness(mailerClass: string, mailerMethod: string, args: MailerArgument[], block: () => Promise<void>, now?: () => Date): Promise<void> {
  const digest = mailerKeyDigest(mailerClass, mailerMethod, ...args);
  if (!(await sentEmailKeyExists(digest)) && (await setSentEmailKey(digest, now))) await block();
}
