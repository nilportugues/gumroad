// What ActionMailer does between a mailer method and the SMTP transaction: premailer-rails'
// delivering_email hook, Mail::Message#encoded, and the SMTP envelope.
import type { DeliveryMethodOptions } from "./mailer-info.ts";
import { encodeMessage, type MimeIdentity, type MimeMessage, newIdentity } from "./mime.ts";
import { premailerRails, type StylesheetLoader } from "./premailer/premailer.ts";
import { loadEmailStylesheet } from "./stylesheet.ts";

// The message before premailer adds its text part. `smtp` is the message's delivery_method_options;
// without it the mail goes through config.action_mailer.smtp_settings, as Devise's do.
export type RenderedMail = Omit<MimeMessage, "parts" | "to"> & { to: string | null; html: string; smtp?: DeliveryMethodOptions };

export type ComposedMail = { encoded: string; envelopeFrom: string; envelopeTo: string[]; smtp?: DeliveryMethodOptions };

// Mail::Address#address for the forms mime.ts accepts.
const bareAddress = (address: string) => /<([^>]+)>$/u.exec(address)?.[1] ?? address;

// Null when Mail would raise "SMTP To address may not be blank", which RescueSmtpErrors logs and
// swallows.
export function composeMail(
  rendered: RenderedMail,
  options: { identity?: MimeIdentity; loadStylesheet?: StylesheetLoader } = {},
): ComposedMail | null {
  if (rendered.to === null || rendered.to.trim() === "") return null;
  const { text, html } = premailerRails(rendered.html, options.loadStylesheet ?? loadEmailStylesheet);
  const encoded = encodeMessage(
    {
      from: rendered.from,
      replyTo: rendered.replyTo,
      to: [rendered.to],
      subject: rendered.subject,
      ...(rendered.headers ? { headers: rendered.headers } : {}),
      parts: [
        { contentType: "text/html", body: html },
        { contentType: "text/plain", body: text },
      ],
    },
    options.identity ?? newIdentity(),
  );
  return { encoded, envelopeFrom: bareAddress(rendered.from), envelopeTo: [bareAddress(rendered.to)], ...(rendered.smtp ? { smtp: rendered.smtp } : {}) };
}
