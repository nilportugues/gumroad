// What ActionMailer does between a mailer method and the SMTP transaction: premailer-rails'
// delivering_email hook, Mail::Message#encoded, and the SMTP envelope.
import type { DeliveryMethodOptions, ReceiptRecordIds } from "./mailer-info.ts";
import { encodeMessage, type MimeIdentity, type MimeMessage, newIdentity } from "./mime.ts";
import { premailerRails, type StylesheetLoader } from "./premailer/premailer.ts";
import { loadEmailStylesheet } from "./stylesheet.ts";

// The message before premailer adds its text part. `smtp` is the message's delivery_method_options;
// without it the mail goes through config.action_mailer.smtp_settings, as Devise's do.
export type RenderedMail = Omit<MimeMessage, "parts" | "to"> & { to: string | null; html: string; smtp?: DeliveryMethodOptions; recordIds?: ReceiptRecordIds };

export type ComposedMail = { encoded: string; envelopeFrom: string; envelopeTo: string[]; smtp?: DeliveryMethodOptions; recordIds?: ReceiptRecordIds };

// Mail::Address#address for the forms mime.ts accepts.
const bareAddress = (address: string) => /<([^>]+)>$/u.exec(address)?.[1] ?? address;

// The html body is read back through Body#decoded, which turns CRLF and CR into LF for an ASCII body
// (7bit) and leaves a non-ASCII one (8bit) as it is.
function normalizeLineEndings(html: string): string {
  if (!html.includes("\r")) return html;
  if (/[^\x00-\x7f]/u.test(html)) return html;
  return html.replace(/\r\n|\r/gu, "\n");
}

// The two initializers that change the message after premailer-rails: both are on in Rails. Off only
// to replay a golden recorded before them (receipt-mailer.golden.json), until it is re-recorded.
export type ComposeInitializers = { quotedPrintableHtml?: boolean; customProperties?: boolean };

// Null when Mail would raise "SMTP To address may not be blank", which RescueSmtpErrors logs and
// swallows.
export function composeMail(
  rendered: RenderedMail,
  options: { identity?: MimeIdentity; loadStylesheet?: StylesheetLoader; initializers?: ComposeInitializers } = {},
): ComposedMail | null {
  if (rendered.to === null || rendered.to.trim() === "") return null;
  const { text, html } = premailerRails(normalizeLineEndings(rendered.html), options.loadStylesheet ?? loadEmailStylesheet, {
    resolveCustomProperties: options.initializers?.customProperties ?? true,
  });
  const encoded = encodeMessage(
    {
      from: rendered.from,
      replyTo: rendered.replyTo,
      to: [rendered.to],
      ...(rendered.cc !== undefined ? { cc: rendered.cc } : {}),
      subject: rendered.subject,
      ...(rendered.headers ? { headers: rendered.headers } : {}),
      ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
      parts: [
        { contentType: "text/html", body: html },
        { contentType: "text/plain", body: text },
      ],
    },
    options.identity ?? newIdentity(),
    { quotedPrintableHtml: options.initializers?.quotedPrintableHtml ?? true },
  );
  return { encoded, envelopeFrom: bareAddress(rendered.from), envelopeTo: [bareAddress(rendered.to), ...(rendered.cc !== undefined ? [bareAddress(rendered.cc)] : [])], ...(rendered.smtp ? { smtp: rendered.smtp } : {}), ...(rendered.recordIds ? { recordIds: rendered.recordIds } : {}) };
}
