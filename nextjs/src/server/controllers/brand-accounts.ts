// Sellers::BrandAccountsController#create (POST /sellers/brand_accounts, app/controllers/sellers/brand_accounts_controller.rb): the
// account switcher's "new Gumroad". Node answers the refusals ahead of the first write (the feature off for the user, an unconfirmed
// email, a new account that reuses the creator's email) and creates the account: a User with a random password, the owner membership
// the creator may still lack, the admin membership on the new account, the confirmation mail, and the switch into it. Copying the
// creator's payout setup (compliance info, bank account, the Stripe account job) hands back whole, before any write.
import { db } from "../../lib/db.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { TeamMemberships } from "../models/team-membership.ts";
import { deviseFriendlyToken, findUser, setPassword, Users, type UserRecord } from "../models/user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { registerMutations, remoteIp, type MutationInput } from "./mutation.ts";
import { accountEmailRequired } from "./seller-json.ts";
import { createOwnerMembershipIfNeeded } from "./settings-team-invitations.ts";
import { switchSellerAccount } from "./switch-seller-account.ts";

const BRAND_ACCOUNTS_FEATURE = "brand_accounts";
const NOT_AVAILABLE = "Creating a new Gumroad is not available for your account yet.";
const UNCONFIRMED = "Please confirm your email address before creating a new Gumroad.";
const OWN_EMAIL_REQUIRED = "The new account needs its own email address, different from your current account.";
const ASCII_ONLY = /^[^\u0080-\u{10ffff}]*$/u;

const ADMIN_ROLE = "admin";
const DUPLICATE_ACCOUNT_MESSAGE = "An account with that email or username already exists.";
// ActiveModel::Type::Boolean::FALSE_VALUES
const FALSE_VALUES = new Set<unknown>([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);

// `ActiveModel::Type::Boolean.new.cast(value) || false` for a permitted scalar; a list or hash is not permitted and reads as nil.
function castBoolean(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "object") return false;
  return !FALSE_VALUES.has(value);
}

// Ruby's String#strip
const rubyStrip = (value: string) => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");

async function create(input: MutationInput): Promise<ActionResult> {
  const user = railsLoggedInUser(input.context);
  if (user === null) throw new HandBackToRails("a signed-out request");
  const missingEmail = accountEmailRequired(input);
  if (missingEmail) return missingEmail;

  if (!(await isFeatureEnabled(BRAND_ACCOUNTS_FEATURE, userActor(user.id))))
    return json({ success: false, error_message: NOT_AVAILABLE });
  if (user.confirmed_at == null) return json({ success: false, error_message: UNCONFIRMED });

  // params.require(:brand_account).permit(:email, ...): a missing hash is a 400, and only scalars are permitted.
  const attributes = input.params.brand_account;
  if (
    typeof attributes !== "object" ||
    attributes === null ||
    Array.isArray(attributes) ||
    Object.keys(attributes).length === 0
  )
    throw new HandBackToRails("a brand_account that is not a non-empty hash");
  const email = (attributes as Record<string, unknown>).email;
  if (email !== undefined && email !== null && typeof email !== "string")
    throw new HandBackToRails("an email that is not text");

  // `@email.to_s.strip.casecmp?(creator.email.to_s)`: Unicode case folding, which only ASCII text can be judged for here.
  const creatorEmail = user.email ?? "";
  const given = rubyStrip(email ?? "");
  if (!ASCII_ONLY.test(given) || !ASCII_ONLY.test(creatorEmail)) throw new HandBackToRails("a non-ASCII email");
  if (given.toLowerCase() === creatorEmail.toLowerCase())
    return json({ success: false, error_message: OWN_EMAIL_REQUIRED });

  const text = (value: unknown, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    throw new HandBackToRails(`a ${name} that is not text`);
  };
  const { username, name } = attributes as Record<string, unknown>;
  const usernameText = text(username, "username");
  const nameText = text(name, "name");
  const useExistingPayoutSetup = castBoolean((attributes as Record<string, unknown>).use_existing_payout_setup);

  const ip = remoteIp(input.request);
  if (ip === null) throw new HandBackToRails("a request with no client address");
  const creator = await findUser(user.id);
  if (creator === null) throw new HandBackToRails("a creator that vanished");
  if (useExistingPayoutSetup) await refuseUnportedPayoutCopy(creator);

  const created = await createBrandAccount(creator, {
    email: email ?? null,
    username: usernameText,
    name: nameText,
    ip,
    useExistingPayoutSetup,
  });
  if ("error" in created) return json({ success: false, error_message: created.error });

  const cookie = await switchSellerAccount(input.request.host, created.membership, new Date());
  input.chain.session.data.flash = {
    discard: [],
    flashes: {
      notice: `${String(created.brandUser.get("name") ?? "")} is ready — we sent a confirmation link to ${String(created.brandUser.get("email") ?? "")}. Confirm it before publishing.`,
    },
  };
  return { ...json({ success: true }), cookies: [cookie] };
}

// port_payout_setup! copies the creator's compliance info and bank account, then enqueues the Stripe account: none of it is ported.
async function refuseUnportedPayoutCopy(creator: UserRecord): Promise<void> {
  const where = { user_id: Number(creator.get("id")), deleted_at: null };
  if (
    (await db.userComplianceInfo.findFirst({ where })) !== null ||
    (await db.bankAccount.findFirst({ where })) !== null
  )
    throw new HandBackToRails("copying the creator's compliance info or bank account");
}

// User::CreateBrandAccountService#perform from the new User onwards: everything in one transaction, a validation failure answered with
// its first message and nothing written.
async function createBrandAccount(
  creator: UserRecord,
  {
    email,
    username,
    name,
    ip,
    useExistingPayoutSetup,
  }: {
    email: string | null;
    username: string | null;
    name: string | null;
    ip: string;
    useExistingPayoutSetup: boolean;
  },
) {
  try {
    return await transaction(async () => {
      const brandUser = Users.build({ email: email ?? "", username, name });
      await setPassword(brandUser, deviseFriendlyToken());
      brandUser.set("account_created_ip", ip);
      brandUser.ivars.new_tos_agreement_ips = [ip];
      if (useExistingPayoutSetup) {
        if (!isBlankText(creator.get("currency_type"))) brandUser.set("currency_type", creator.get("currency_type"));
        if (!isBlankText(creator.get("payment_address")))
          brandUser.set("payment_address", creator.get("payment_address"));
      }
      await Users.saveBang(brandUser);
      const now = new Date();
      await createOwnerMembershipIfNeeded(creator, now);
      const membership = await TeamMemberships.createBang(
        { seller_id: brandUser.get("id"), user_id: creator.get("id"), role: ADMIN_ROLE },
        { now: () => now },
      );
      return { brandUser, membership };
    });
  } catch (error) {
    if (error instanceof RecordInvalid) return { error: error.errors.fullMessages()[0] ?? "" };
    if ((error as { code?: string }).code === "P2002") return { error: DUPLICATE_ACCOUNT_MESSAGE };
    throw error;
  }
}

const isBlankText = (value: unknown) => value === null || value === undefined || String(value).trim() === "";

registerMutations({ method: "POST", pattern: "/sellers/brand_accounts", json: true, run: create });
