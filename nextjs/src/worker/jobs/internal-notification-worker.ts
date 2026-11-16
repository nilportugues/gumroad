// Port of app/sidekiq/internal_notification_worker.rb. InternalNotificationMailer.notify(...).deliver_now
// runs on the Node mailer; anything it cannot reproduce byte for byte (a file name or type Mail
// would encode differently, non-ASCII text, an unexpected argument shape) hands the job back to
// Rails, which is safe because nothing has been sent or written by then.
import { railsEnv } from "../../server/infra/rails-env.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { type JsonValue, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { composeNodeMail, defaultMailDeliveryDeps, isNotPorted, type MailDeliveryDeps, sendComposed } from "../../server/mail/delivery.ts";
import { RubyHash, RubySymbol, type RubyValue } from "../../server/mail/ruby-value.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const MAILER = "InternalNotificationMailer";
const METHOD = "notify";

// JSON.parse's Hash: String keys.
function fromJson(value: JsonValue): RubyValue {
  if (value instanceof RubyFloat) throw new HandBackToRuby("a Float argument");
  if (Array.isArray(value)) return value.map(fromJson);
  if (value !== null && typeof value === "object") return new RubyHash(Object.entries(value).map(([key, entry]): [RubyValue, RubyValue] => [key, fromJson(entry as JsonValue)]));
  return value as RubyValue;
}

export type Deps = { mail: MailDeliveryDeps };

export function internalNotificationWorkerWith(overrides: Partial<Deps> = {}): JobHandler {
  const deps: Deps = { mail: defaultMailDeliveryDeps, ...overrides };
  return async (args) => {
    checkArity(args, 3, 5);
    const [roomName, sender, messageText, , options = {}] = args;
    // The subject prefix, the SMTP settings and the layout banner differ outside production.
    if (railsEnv() !== "production") throw new HandBackToRuby(`${MAILER} outside production (${railsEnv()})`);
    if (options === null || typeof options !== "object" || Array.isArray(options) || options instanceof RubyFloat) throw new HandBackToRuby(`${MAILER} options that are not a Hash`);

    const keyword = (name: string, value: JsonValue): [RubyValue, RubyValue] => [new RubySymbol(name), fromJson(value)];
    const mailArgs = [
      new RubyHash([
        keyword("room_name", roomName!),
        keyword("sender", sender!),
        keyword("message_text", messageText!),
        keyword("attachments_data", Object.hasOwn(options, "attachments") ? options.attachments! : []),
        keyword("s3_attachments", Object.hasOwn(options, "s3_attachments") ? options.s3_attachments! : []),
      ]),
    ];

    let mail;
    try {
      mail = await composeNodeMail(MAILER, METHOD, mailArgs, deps.mail.mailer);
    } catch (error) {
      if (!isNotPorted(error)) throw error;
      deps.mail.log(`Handing ${MAILER}#${METHOD} back to Rails: ${(error as Error).message}`);
      throw new HandBackToRuby((error as Error).message);
    }
    if (mail === undefined) return;
    await sendComposed(mail, deps.mail);
  };
}

export const internalNotificationWorker = internalNotificationWorkerWith();
