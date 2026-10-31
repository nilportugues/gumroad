// What ActionMailer does between a mailer method and the SMTP transaction: premailer-rails'
// delivering_email hook, Mail::Message#encoded, and the SMTP envelope.
import type { RenderedMail } from "./mailers/user-signup-mailer.ts";
import { encodeMessage, type MimeIdentity, newIdentity } from "./mime.ts";
import { premailerRails, type StylesheetLoader } from "./premailer/premailer.ts";
import { loadEmailStylesheet } from "./stylesheet.ts";

export type ComposedMail = { encoded: string; envelopeFrom: string; envelopeTo: string[] };

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
  return { encoded, envelopeFrom: bareAddress(rendered.from), envelopeTo: [bareAddress(rendered.to)] };
}
