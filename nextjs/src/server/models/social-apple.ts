// User.find_or_create_for_apple_oauth (app/models/concerns/user/social_apple.rb), split in two so the callback can judge every case before it
// spends Apple's single-use code: `planAppleSignIn` reads, and hands back what this port does not write (guest purchases to attach,
// the adoption of an unconfirmed row); `applyAppleSignIn` runs after the exchange and performs the writes in Rails' order.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { isBlank } from "../html/text-helper.ts";
import { notifyError } from "../infra/error-reporting.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { execute, column, selectRows, table } from "./sql.ts";
import { invalidateActiveSessions } from "./user-risk.ts";
import {
  findUser,
  INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX,
  isConfirmed,
  isValidEmailFormat,
  setPassword,
  type UserRecord,
  Users,
} from "./user.ts";

const RANDOM_PASSWORD_LENGTH = 20;
const PROVIDER = "apple";
const BLOCKED_SIGNUP_MESSAGE = "Something went wrong.";

export type AppleData = {
  uid: string;
  // info.email, nil once pruned (an empty claim is pruned as well).
  email: string | null;
  emailVerified: boolean;
  // info.name, nil once pruned.
  name: string | null;
};

export type ApplePlan =
  | { kind: "rejected" }
  | {
      kind: "user";
      user: UserRecord;
      uid: string;
      name: string | null;
      email: string | null;
      isNew: boolean;
      adopting: boolean;
    };

// Devise.friendly_token(20): SecureRandom.urlsafe_base64(20).tr("lIO0", "sxyz")[0, 20]
async function randomPassword(): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  return randomBytes(RANDOM_PASSWORD_LENGTH)
    .toString("base64url")
    .replace(/[lIO0]/gu, (c) => ({ l: "s", I: "x", O: "y", "0": "z" })[c]!)
    .slice(0, RANDOM_PASSWORD_LENGTH);
}

const verifiedEmail = (data: AppleData) => (data.emailVerified ? data.email : null);

async function hasAppleIdentity(userId: unknown): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("user_external_authentications")} WHERE ${column("user_external_authentications", "user_id")} = ${userId} AND ${column("user_external_authentications", "provider")} = ${PROVIDER} LIMIT 1`,
  );
  return rows.length > 0;
}

async function hasGuestPurchases(email: string): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "email")} = ${email} AND ${column("purchases", "purchaser_id")} IS NULL LIMIT 1`,
  );
  return rows.length > 0;
}

export async function planAppleSignIn(data: AppleData, identityUser: UserRecord | null): Promise<ApplePlan> {
  let user = identityUser;
  let isNew = false;
  const email = verifiedEmail(data);
  if (user === null) {
    // An address Apple has not verified must not create an account that would then hold the identity.
    if (email === null && data.email !== null) return { kind: "rejected" };
    if (isValidEmailFormat(email)) {
      const found = await db.user.findFirst({ where: { email: email! }, orderBy: { id: "asc" } });
      if (found !== null) {
        user = await findUser(found.id);
        if (user === null) throw new HandBackToRails("a user that vanished");
      }
    }
    if (user === null) {
      const attached = isValidEmailFormat(email) && (await hasGuestPurchases(email!));
      if (attached) throw new HandBackToRails("guest purchases to attach to the new account");
      user = Users.build({});
      user.set("provider", PROVIDER);
      isNew = true;
    }
  }
  const adopting = !isNew && isBlank(user.get("provider")) && !(await hasAppleIdentity(user.get("id")));
  if (adopting && !isConfirmed(user))
    throw new HandBackToRails("the adoption of an unconfirmed account, which revokes its unproven access");
  return { kind: "user", user, uid: data.uid, name: data.name, email, isNew, adopting };
}

const isBlockedSignup = (error: RecordInvalid) => error.errors.on("base").includes(BLOCKED_SIGNUP_MESSAGE);

// Devise's `confirm` for a record that is not pending reconfirmation: confirmed_at saved without validation, then User#after_confirmation.
async function confirm(user: UserRecord, now: () => Date): Promise<void> {
  user.set("confirmed_at", new Date(Math.floor(now().getTime() / 1000) * 1000));
  await Users.save(user, { validate: false, now });
  user.set("reset_password_token", null);
  user.set("reset_password_sent_at", null);
  await Users.saveBang(user, { validate: false, now });
  await performAsync("AttachPastPurchasesToUserWorker", [Number(user.get("id")), user.get("email")]);
}

// apply_apple_data and the rest of find_or_create_for_apple_oauth. A RecordInvalid is the nil user of Rails (reported unless a signup gate
// refused it).
export async function applyAppleSignIn(
  plan: Extract<ApplePlan, { kind: "user" }>,
  now: () => Date,
): Promise<UserRecord | null> {
  const { user } = plan;
  try {
    if (isBlank(user.get("name")) && plan.name !== null && !isBlank(plan.name)) {
      user.set("name", plan.name.replace(new RegExp(INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX.source, "gu"), ""));
    }
    if (plan.isNew && isValidEmailFormat(plan.email)) user.set("email", plan.email);
    if (plan.isNew) await setPassword(user, await randomPassword());

    if (plan.adopting) {
      await setPassword(user, await randomPassword());
      await invalidateActiveSessions(user, now);
    }
    user.ivars.skip_confirmation_notification = true;
    await Users.saveBang(user, { now });
    // Apple proves only the current address, so a pending change waits for its emailed link.
    if (!isConfirmed(user) && isBlank(user.get("unconfirmed_email"))) await confirm(user, now);

    const existing = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("user_external_authentications")} WHERE ${column("user_external_authentications", "provider")} = ${PROVIDER} AND ${column("user_external_authentications", "uid")} = ${plan.uid} AND ${column("user_external_authentications", "user_id")} = ${user.get("id")} LIMIT 1`,
    );
    if (existing.length === 0) {
      const at = now();
      await execute(
        Prisma.sql`INSERT INTO ${table("user_external_authentications")} (${Prisma.raw("`user_id`, `provider`, `uid`, `created_at`, `updated_at`")}) VALUES (${user.get("id")}, ${PROVIDER}, ${plan.uid}, ${at}, ${at})`,
      );
    }
    return user;
  } catch (error) {
    if (!(error instanceof RecordInvalid)) throw error;
    if (!isBlockedSignup(error)) notifyError(error);
    return null;
  }
}
