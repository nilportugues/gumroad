// User.find_or_create_for_apple_oauth (app/models/concerns/user/social_apple.rb), split in two so the callback can judge every case before it
// spends Apple's single-use code: `planAppleSignIn` reads, and hands back what this port does not write (guest purchases to attach); `applyAppleSignIn` runs after the exchange and performs the writes in Rails' order.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { isBlank } from "../html/text-helper.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { changePurchaser } from "./purchase-delivery-writes.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { execute, column, selectRows, table } from "./sql.ts";
import { revokeUnprovenAccess } from "./user-adoption.ts";
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

// Purchase.where(email:, purchaser_id: nil), in primary key order as MySQL returns it.
const guestPurchases = (email: string) =>
  db.purchase.findMany({ where: { email, purchaser_id: null }, orderBy: { id: "asc" } });

// What `Purchase#attach_to_user_and_card(user, nil, nil)` writes beyond `purchaser_id`: a preorder or subscription row, and the
// bundle callback `attach_unclaimed_bundle_product_purchases`. Those stay in Rails.
async function assertAttachable(email: string): Promise<void> {
  for (const purchase of await guestPurchases(email)) {
    const flags = purchase.flags;
    if (PurchaseFlags.isSet(flags, "is_bundle_purchase"))
      throw new HandBackToRails("a guest bundle purchase to attach to the new account");
    if (purchase.preorder_id !== null) throw new HandBackToRails("a guest preorder to attach to the new account");
    if (purchase.subscription_id !== null && !PurchaseFlags.isSet(flags, "is_gift_sender_purchase"))
      throw new HandBackToRails("a guest subscription to attach to the new account");
  }
}

// The loop of find_or_create_for_apple_oauth after the new user is saved. A reassignment-locked purchase is skipped. The seller and test
// purchase guards cannot apply: the user was created by this call, so it owns no product and no purchase has it as purchaser.
async function attachGuestPurchases(user: UserRecord, now: () => Date): Promise<void> {
  const email = user.get("email");
  if (typeof email !== "string" || isBlank(email)) return;
  for (const purchase of await guestPurchases(email)) {
    if (PurchaseFlags.isSet(purchase.flags, "is_reassignment_locked")) continue;
    await changePurchaser(purchase, BigInt(String(user.get("id"))), { now });
  }
}

// `revoke_unproven_access!` rewrites the json_data of each merchant account. One that holds a Hash which is not valid JSON would fail
// half way through the second transaction, after the first one committed; Rails reads such a column as an error as well.
async function assertRetirable(userId: unknown): Promise<void> {
  const rows = await selectRows<{ json_data: string | null }>(
    Prisma.sql`SELECT ${column("merchant_accounts", "json_data")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId}`,
  );
  for (const { json_data: raw } of rows) {
    if (raw == null || !/^\s*\{/u.test(raw)) continue;
    try {
      JSON.parse(raw);
    } catch {
      throw new HandBackToRails(
        "a merchant account whose json_data is not valid JSON, on an unconfirmed account being adopted",
      );
    }
  }
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
      if (isValidEmailFormat(email)) await assertAttachable(email!);
      user = Users.build({});
      user.set("provider", PROVIDER);
      isNew = true;
    }
  }
  const adopting = !isNew && isBlank(user.get("provider")) && !(await hasAppleIdentity(user.get("id")));
  if (adopting && !isConfirmed(user)) await assertRetirable(user.get("id"));
  return { kind: "user", user, uid: data.uid, name: data.name, email, isNew, adopting };
}

export const isBlockedSignup = (error: RecordInvalid) => error.errors.on("base").includes(BLOCKED_SIGNUP_MESSAGE);

// Devise's `confirm` for a record that is not pending reconfirmation: confirmed_at saved without validation, then User#after_confirmation.
export async function confirmUser(user: UserRecord, now: () => Date): Promise<void> {
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
      if (!isConfirmed(user)) await revokeUnprovenAccess(user, now);
    }
    user.ivars.skip_confirmation_notification = true;
    await Users.saveBang(user, { now });
    // Apple proves only the current address, so a pending change waits for its emailed link.
    if (!isConfirmed(user) && isBlank(user.get("unconfirmed_email"))) await confirmUser(user, now);

    const existing = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("user_external_authentications")} WHERE ${column("user_external_authentications", "provider")} = ${PROVIDER} AND ${column("user_external_authentications", "uid")} = ${plan.uid} AND ${column("user_external_authentications", "user_id")} = ${user.get("id")} LIMIT 1`,
    );
    if (existing.length === 0) {
      const at = now();
      await execute(
        Prisma.sql`INSERT INTO ${table("user_external_authentications")} (${Prisma.raw("`user_id`, `provider`, `uid`, `created_at`, `updated_at`")}) VALUES (${user.get("id")}, ${PROVIDER}, ${plan.uid}, ${at}, ${at})`,
      );
    }
    if (plan.isNew) await attachGuestPurchases(user, now);
    return user;
  } catch (error) {
    if (!(error instanceof RecordInvalid)) throw error;
    if (!isBlockedSignup(error)) notifyError(error);
    return null;
  }
}
