import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composeMail } from "../compose.ts";
import { MailViewNotPortedError } from "../views.ts";
import { confirmationInstructions, emailChanged, type RenderedMail, type SignupMailUser } from "./user-signup-mailer.ts";

process.env.TZ = "UTC";

type MessageCase = { name: string; kind: "message"; rendered_html: string; encoded: string; smtp_envelope_from: string; smtp_envelope_to: string[] };
const golden = JSON.parse(readFileSync(new URL("../__fixtures__/mail.golden.json", import.meta.url), "utf8")) as { cases: { kind: string; name: string }[] };
const messages = new Map(golden.cases.filter((c): c is MessageCase => c.kind === "message").map((c) => [c.name, c]));

// The users generate-mail-golden.rb renders with.
const user: SignupMailUser = { email: "seller@example.com", unconfirmedEmail: null, confirmationToken: "Tok3n-abc_DEF", externalId: "8723460912345" };
const changed: SignupMailUser = { email: "old@example.com", unconfirmedEmail: "new+tag@example.org", confirmationToken: "zZ9_yY8-xX7", externalId: "1111111111111" };
const synced: SignupMailUser = { email: "now@example.net", unconfirmedEmail: null, confirmationToken: "q", externalId: "42" };

const CASES: [string, () => RenderedMail][] = [
  ["confirmation_instructions", () => confirmationInstructions(user, "raw-token", {})],
  ["reconfirmation_instructions", () => confirmationInstructions(changed, "raw-token", { to: changed.unconfirmedEmail })],
  ["email_changed", () => emailChanged(changed, { to: changed.email })],
  ["email_changed_synced", () => emailChanged(synced, { to: "before@example.net" })],
  ["email_changed_no_to", () => emailChanged(synced, {})],
];

const saved = { env: process.env.RAILS_ENV, dir: process.env.MAIL_PUBLIC_DIR };
beforeAll(() => {
  // A production build's public/: the manifest names the stylesheet the layout links.
  const dir = mkdtempSync(path.join(tmpdir(), "mail-public-"));
  mkdirSync(path.join(dir, "vite", ".vite"), { recursive: true });
  mkdirSync(path.join(dir, "vite", "assets"), { recursive: true });
  writeFileSync(path.join(dir, "vite", ".vite", "manifest.json"), JSON.stringify({ "entrypoints/email.ts": { file: "assets/email.js", css: ["assets/email-golden.css"] } }));
  writeFileSync(path.join(dir, "vite", "assets", "email-golden.css"), readFileSync(new URL("../__fixtures__/email.css", import.meta.url)));
  process.env.RAILS_ENV = "production";
  process.env.MAIL_PUBLIC_DIR = dir;
});
afterAll(() => {
  process.env.RAILS_ENV = saved.env;
  process.env.MAIL_PUBLIC_DIR = saved.dir;
});

function identityOf(encoded: string) {
  return {
    date: new Date(/^Date: (.*)\r$/mu.exec(encoded)![1]!),
    messageId: /^Message-ID: (.*)\r$/mu.exec(encoded)![1]!,
    boundary: /boundary="([^"]+)"/u.exec(encoded)![1]!,
  };
}

describe("UserSignupMailer", () => {
  for (const [name, build] of CASES) {
    it(`renders ${name} as the ERB views do and sends the same bytes`, () => {
      const c = messages.get(name)!;
      const rendered = build();
      expect(rendered.html).toBe(c.rendered_html);
      const composed = composeMail(rendered, { identity: identityOf(c.encoded) });
      expect(composed).toEqual({ encoded: c.encoded, envelopeFrom: c.smtp_envelope_from, envelopeTo: c.smtp_envelope_to });
    });
  }

  it("sends nothing when Devise is handed a blank to:", () => {
    expect(composeMail(confirmationInstructions(user, "t", { to: null }))).toBeNull();
  });

  it("refuses the layout outside production, where it adds the environment banner", () => {
    process.env.RAILS_ENV = "staging";
    try {
      expect(() => confirmationInstructions(user, "t")).toThrow(MailViewNotPortedError);
    } finally {
      process.env.RAILS_ENV = "production";
    }
  });
});
