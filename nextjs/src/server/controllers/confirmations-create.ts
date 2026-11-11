// ConfirmationsController#create on `POST /users/confirmation` (Devise's resend form): `send_confirmation_instructions` finds the account by the
// address it is changing to, then by its current one, and User#resend_confirmation_instructions claims the one-minute floor and queues
// ResendConfirmationEmailJob. Whatever ends in the `new` view (a blank or unknown address, an account with nothing pending) is an ERB page and
// goes to Rails whole, before the first write.
import { db } from "../../lib/db.ts";
import { isBlank } from "../html/text-helper.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { findUser, isConfirmed, type UserRecord } from "../models/user.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";

const SIGN_IN_PATH = "/users/sign_in";
const FOUND = 302;
const RESEND_CONFIRMATION_ENQUEUE_FLOOR_MS = 60 * 1000;
const FLASH_SEND_INSTRUCTIONS =
  "You will receive an email with instructions for how to confirm your email address in a few minutes.";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toSeconds = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

async function findPending(email: string): Promise<UserRecord | null> {
  // Devise::Models::Confirmable.send_confirmation_instructions: `reconfirmable` looks at `unconfirmed_email` first.
  const row =
    (await db.user.findFirst({ where: { unconfirmed_email: email }, orderBy: { id: "asc" } })) ??
    (await db.user.findFirst({ where: { email }, orderBy: { id: "asc" } }));
  return row === null ? null : await findUser(row.id);
}

async function confirmationCreate({ params, chain }: MutationInput): Promise<ActionResult> {
  const userParams = params.user === undefined ? {} : params.user;
  if (!isHash(userParams)) throw new HandBackToRails("a user parameter that is not a hash");
  const email = userParams.email;
  if (email !== undefined && email !== null && typeof email !== "string")
    throw new HandBackToRails("an email that is not a string");
  if (typeof email !== "string" || isBlank(email))
    throw new HandBackToRails("the resend form with an error, an ERB view");

  const user = await findPending(email);
  if (user === null) throw new HandBackToRails("an unknown address, the resend form with an error");
  // Devise::Models::Confirmable#pending_any_confirmation
  if (isConfirmed(user) && isBlank(user.get("unconfirmed_email")))
    throw new HandBackToRails("an address that is already confirmed, the resend form with an error");

  // The claim is one conditional UPDATE so two clicks queue one mail; a lost claim still redirects with the flash, as Devise sees no error.
  const sentAt = toSeconds(chain.now);
  const floor = new Date(sentAt.getTime() - RESEND_CONFIRMATION_ENQUEUE_FLOOR_MS);
  const claimed =
    await db.$executeRaw`UPDATE users SET confirmation_sent_at = ${sentAt} WHERE id = ${user.get("id")} AND (confirmation_sent_at IS NULL OR confirmation_sent_at <= ${floor})`;
  if (claimed > 0) await performAsync("ResendConfirmationEmailJob", [Number(user.get("id"))]);

  return { status: FOUND, location: SIGN_IN_PATH, flash: { notice: FLASH_SEND_INSTRUCTIONS } };
}

registerMutations({ method: "POST", pattern: "/users/confirmation", run: confirmationCreate });
