// User::AsyncDeviseNotification#render_and_send_devise_message: the Devise mailer call that
// confirmable makes, sent with `deliver_later(queue: "critical", wait: 3.seconds)`.
import type { JobsRuntime } from "../jobs/runtime.ts";
import { type ActiveJobArgument, deliverLater, record, symbolHash } from "./active-job.ts";
import { mailRoute } from "./delivery.ts";

export type DeviseNotificationUser = { id: bigint | number; unconfirmedEmail: string | null };

const MAILER = "UserSignupMailer";

// `args` is what user.ts's callbacks pass: Devise's raw token and its `to:` option.
export async function deliverDeviseNotification(
  runtime: JobsRuntime,
  user: DeviseNotificationUser,
  notification: "confirmation_instructions" | "email_changed",
  args: Record<string, unknown>,
): Promise<string> {
  let mailArgs: ActiveJobArgument[];
  if (notification === "confirmation_instructions") {
    if (typeof args.token !== "string") throw new Error("confirmation_instructions needs Devise's raw confirmation token");
    // Confirmable#send_confirmation_instructions: `pending_reconfirmation? ? { to: unconfirmed_email } : {}`
    // (config.reconfirmable is on).
    const pending = user.unconfirmedEmail !== null && /[^\s]/u.test(user.unconfirmedEmail);
    mailArgs = [record("User", user.id), args.token, symbolHash(pending ? { to: user.unconfirmedEmail } : {})];
  } else {
    // Confirmable#send_email_changed_notification: `to: devise_email_before_last_save`.
    mailArgs = [record("User", user.id), symbolHash({ to: (args.to as string | null | undefined) ?? null })];
  }
  return deliverLater(runtime, { mailer: MAILER, method: notification, args: mailArgs, queue: "critical", waitSeconds: 3 }, mailRoute(MAILER, notification));
}
