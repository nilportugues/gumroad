// Port of InternalNotificationMailer#notify (app/mailers/internal_notification_mailer.rb) with
// app/views/internal_notification_mailer/notify.html.erb, which has no layout.
import { getConfig } from "../../infra/config.ts";
import { railsEnv } from "../../infra/rails-env.ts";
import { isBlank, simpleFormat } from "../../html/text-helper.ts";
import { applicationMail, type MailerDeps, noreplyEmail } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { assertAttachmentSupported, type MimeAttachment } from "../mime.ts";
import { RubyHash, type RubyValue, RubySymbol } from "../ruby-value.ts";
import { defaultS3Reader } from "../s3-object.ts";
import { h, MailViewNotPortedError } from "../views.ts";

const MAILER = "InternalNotificationMailer";
const METHOD = "notify";
const MAX_S3_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const DEFAULT_ATTACHMENT_TYPE = "text/csv";

// config/initializers/chat_rooms.rb. GlobalConfig.get with a default keeps an empty ENV value.
const internalEmail = () => getConfig("INTERNAL_NOTIFICATION_EMAIL", "gumclaw@gumroad.com");
const paymentsEmail = () => getConfig("PAYMENTS_NOTIFICATION_EMAIL", "finance@gumroad.com");
const alwaysCc = () => getConfig("INTERNAL_NOTIFICATION_ALWAYS_CC", "gumclaw@gumroad.com");

const CHAT_ROOMS: Record<string, () => string> = {
  agent_reports: alwaysCc,
  announcements: internalEmail,
  awards: internalEmail,
  internals_log: internalEmail,
  migrations: internalEmail,
  payments: paymentsEmail,
  payouts: paymentsEmail,
  risk: internalEmail,
  test: internalEmail,
};

type S3Attachment = { bucket: string; key: string; filename: string; mimeType: string | null };
type Input = { roomName: string; sender: string; messageText: string; attachmentsData: { fallback: string | null; text: string | null }[]; s3Attachments: S3Attachment[] };

const notPorted = (what: string) => new MailViewNotPortedError(`InternalNotificationMailer ${what}`);

function stringOrNull(value: RubyValue | undefined, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw notPorted(`${what} that is not a String`);
  return value;
}

// A JSON object, as Sidekiq's JSON gave it: String keys.
function stringKeyed(value: RubyValue | undefined, what: string): Map<string, RubyValue> {
  if (!(value instanceof RubyHash)) throw notPorted(`${what} that is not a Hash`);
  const entries = new Map<string, RubyValue>();
  for (const [key, entry] of value.entries) {
    if (typeof key !== "string") throw notPorted(`${what} with a non-String key`);
    entries.set(key, entry);
  }
  return entries;
}

function requiredString(attachment: Map<string, RubyValue>, name: string): string {
  const value = attachment.get(name);
  if (typeof value !== "string") throw notPorted(`s3 attachment without a String ${name}`);
  return value;
}

// The keywords of `notify(room_name:, sender:, message_text:, attachments_data: [], s3_attachments: [])`.
function parseInput(args: RubyValue[]): Input {
  const [hash, ...rest] = args;
  if (rest.length > 0 || !(hash instanceof RubyHash)) throw notPorted("arguments other than keywords");
  const keywords = new Map<string, RubyValue>();
  for (const [key, value] of hash.entries) {
    if (!(key instanceof RubySymbol) || !["room_name", "sender", "message_text", "attachments_data", "s3_attachments"].includes(key.name)) throw notPorted("keywords");
    keywords.set(key.name, value);
  }
  const roomName = keywords.get("room_name");
  const sender = keywords.get("sender");
  const messageText = keywords.get("message_text");
  if (typeof roomName !== "string" || typeof sender !== "string" || typeof messageText !== "string") throw notPorted("room_name, sender or message_text that is not a String");

  const attachmentsData = keywords.get("attachments_data") ?? [];
  const s3Attachments = keywords.get("s3_attachments") ?? [];
  if (!Array.isArray(attachmentsData) || !Array.isArray(s3Attachments)) throw notPorted("attachments that are not an Array");
  return {
    roomName,
    sender,
    messageText,
    attachmentsData: attachmentsData.map((attachment) => {
      const fields = stringKeyed(attachment, "attachment");
      return { fallback: stringOrNull(fields.get("fallback"), "fallback"), text: stringOrNull(fields.get("text"), "text") };
    }),
    s3Attachments: s3Attachments.map((attachment) => {
      const fields = stringKeyed(attachment, "s3 attachment");
      return {
        bucket: requiredString(fields, "bucket"),
        key: requiredString(fields, "key"),
        filename: requiredString(fields, "filename"),
        mimeType: stringOrNull(fields.get("mime_type"), "mime_type"),
      };
    }),
  };
}

// notify.html.erb: Erubi drops the lines that hold only a `<% %>` tag.
function renderBody(input: Input): string {
  let html = `<p><strong>${h(input.sender)}</strong></p>\n\n<p>${simpleFormat(input.messageText)}</p>\n\n`;
  for (const attachment of input.attachmentsData) {
    html += "  <hr>\n";
    if (!isBlank(attachment.fallback)) html += `    <p>${simpleFormat(attachment.fallback)}</p>\n`;
    if (!isBlank(attachment.text) && attachment.text !== attachment.fallback) html += `    <p>${simpleFormat(attachment.text)}</p>\n`;
  }
  return html;
}

// Rails.env prefix of the subject; ApplicationMailer sends only from production here.
const subjectPrefix = () => (railsEnv() === "production" ? "" : `[${railsEnv()}] `);

export async function notify(args: RubyValue[], deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const input = parseInput(args);
  const recipient = Object.hasOwn(CHAT_ROOMS, input.roomName) ? CHAT_ROOMS[input.roomName]!() : undefined;
  if (recipient === undefined || isBlank(recipient)) return null;

  // Checked before any S3 read: a file Mail would name or encode differently is left to Rails.
  const wanted = input.s3Attachments.map((attachment) => ({ ...attachment, contentType: isBlank(attachment.mimeType) ? DEFAULT_ATTACHMENT_TYPE : attachment.mimeType! }));
  for (const attachment of wanted) assertAttachmentSupported(attachment.filename, attachment.contentType);

  const s3 = deps.s3 ?? defaultS3Reader;
  const attachments: MimeAttachment[] = [];
  for (const attachment of wanted) {
    // The size comes from one HEAD; a file over the limit is left to the 7-day link in the body.
    if (((await s3.contentLength(attachment.bucket, attachment.key)) ?? 0) > MAX_S3_ATTACHMENT_BYTES) continue;
    attachments.push({ filename: attachment.filename, contentType: attachment.contentType, content: await s3.read(attachment.bucket, attachment.key) });
  }

  // CC the always-cc address on every notification unless it already is the room's recipient.
  const cc = alwaysCc();
  return applicationMail(
    {
      mailerClass: MAILER,
      mailerMethod: METHOD,
      args,
      from: noreplyEmail(),
      to: recipient,
      ...(!isBlank(cc) && cc !== recipient ? { cc } : {}),
      subject: `${subjectPrefix()}[${input.roomName}] ${input.sender}`,
      html: renderBody(input),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    deps,
  );
}
