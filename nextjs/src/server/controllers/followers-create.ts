// FollowersController#create and #from_embed_form (app/controllers/followers_controller.rb) with Follower::CreateService: the
// subscribe form of a seller and the embed form copied onto other sites. Both are throttled by Rack::Attack (controllers/rack-attack.ts).
//
// Left to Rails, before anything is written: a seller who needs a CAPTCHA on POST /follow (an unreviewed one: Google's verification is a call the
// Rails test environment skips, so there is no recording of it; the embed form has no challenge, so its JSON refusal is served), a waitlist product, a seller under a newsletter cutover, and the HTML
// answer of #from_embed_form, which renders an Inertia page that a mutation cannot (its props are page-props/audience/follower-embed-form.ts).
import { Prisma, type User } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { railsCache } from "../cache/rails-cache.ts";
import { getConfig } from "../infra/config.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { currentJobsRuntime } from "../models/concerns/job-runtime.ts";
import { confirmBang, coveredByCutover, Followers, type FollowerRecord } from "../models/follower.ts";
import { LinkFlags } from "../models/link.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { castRow, column, isRecordNotUnique, selectRows, table } from "../models/sql.ts";
import { isAccountActive, isCompliant, Users } from "../models/user.ts";
import { embedFormCaptchaProps, followConfirmationMessage } from "../page-props/audience/follower-embed-form.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { notFoundJson } from "./seller-json.ts";

const SEE_OTHER = 303;
const FOUND = 302;
const UNPROCESSABLE_ENTITY = 422;
const SUBSCRIBE_PATH = "/subscribe";
const SOMETHING_WENT_WRONG = "Sorry, something went wrong.";
const EMBED_FORM_FAILURE = "Something went wrong. Please try to follow the creator again.";
const EMBED_FORM = "embed_form";
// Rails.cache.fetch("follower_confirmation_email_sent_#{id}", expires_in: 1.hour)
const CONFIRMATION_EMAIL_TTL_SECONDS = 60 * 60;
// FollowerMailer.confirm_follower(...).deliver_later(queue: "critical", wait: 3.seconds)
const CONFIRMATION_EMAIL_DELAY_SECONDS = 3;

type Seller = ReturnType<typeof Users.load>;

// ActiveSupport's Array#to_sentence
function toSentence(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// `User.find_by_external_id(params[:seller_id])`: users keep their external id in a column.
async function followedUser(params: MutationInput["params"]): Promise<Seller | null> {
  const sellerId = params.seller_id;
  if (sellerId !== undefined && typeof sellerId !== "string")
    throw new HandBackToRails("a seller_id that is not a string");
  if (sellerId === undefined) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "external_id")} = ${sellerId} LIMIT 1`,
  );
  return row ? Users.load(castRow<User>("User", row)) : null;
}

// FollowRecaptcha.required?: any seller that is not reviewed, compliant and active, while a site key is configured.
function captchaRequired(seller: Seller | null): boolean {
  if (seller === null) return false;
  if (isCompliant(seller) && isAccountActive(seller)) return false;
  return (getConfig("RECAPTCHA_FOLLOW_SITE_KEY") ?? getConfig("RECAPTCHA_MONEY_SITE_KEY")) !== undefined;
}

async function userIdWithEmail(email: string): Promise<number | null> {
  const [row] = await selectRows<{ id: number | bigint }>(
    Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "email")} = ${email} LIMIT 1`,
  );
  return row === undefined ? null : Number(row.id);
}

// Follower#send_confirmation_email: one request an hour for each follower.
async function sendConfirmationEmail(follower: FollowerRecord): Promise<void> {
  await railsCache().fetch(
    `follower_confirmation_email_sent_${follower.get("id")}`,
    { expiresIn: CONFIRMATION_EMAIL_TTL_SECONDS },
    async () => {
      await deliverLater(
        currentJobsRuntime(),
        {
          mailer: "FollowerMailer",
          method: "confirm_follower",
          args: [Number(follower.get("followed_id")), Number(follower.get("id"))],
          queue: "critical",
          waitSeconds: CONFIRMATION_EMAIL_DELAY_SECONDS,
        },
        mailRoute("FollowerMailer", "confirm_follower"),
      );
      return true;
    },
  );
}

// `waitlist_product_from_params`: a product of the seller whose waitlist is switched off is ignored and the follow goes on as a plain one.
// A product that takes signups, one the seller does not own and a seller that does not exist are not proven, so Rails keeps them.
export async function requireNoWaitlistProduct(productId: unknown, seller: Seller | null): Promise<void> {
  if (productId === undefined || productId === "") return;
  if (typeof productId === "string" && seller !== null) {
    const id = decrypt(productId);
    if (id !== null) {
      const [row] = await selectRows<{ flags: bigint }>(
        Prisma.sql`SELECT ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} AND ${column("links", "user_id")} = ${seller.get("id")} LIMIT 1`,
      );
      if (row !== undefined && !LinkFlags.isSet(row.flags, "waitlist_enabled")) return;
    }
  }
  throw new HandBackToRails("a follow from a waitlist");
}

type Outcome = { follower: FollowerRecord | null; seller: Seller | null };

// FollowersController#create_follower and Follower::CreateService#perform, for a request without a waitlist product.
async function createFollower(input: MutationInput, source: string | null): Promise<Outcome> {
  const { params } = input;
  const seller = await followedUser(params);
  await requireNoWaitlistProduct(params.product_id, seller);
  if (seller === null || !isAccountActive(seller)) return { follower: null, seller };

  const email = params.email;
  if (email !== undefined && typeof email !== "string") throw new HandBackToRails("an email that is not a string");
  // `return if followed_user.blank? || follower_email.blank?`
  if (email === undefined || email.trim() === "") return { follower: null, seller };
  const sellerId = seller.get("id");
  if (await coveredByCutover(Number(sellerId))) throw new HandBackToRails("a seller in a newsletter cutover");

  const visitor = railsLoggedInUser(input.context);
  const verifiedSession = visitor !== null && visitor.confirmed_at !== null && visitor.email === email;

  const attributes = { follower_user_id: await userIdWithEmail(email), source };
  const [existing] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`followers`.*")} FROM ${table("followers")} WHERE ${column("followers", "followed_id")} = ${sellerId} AND ${column("followers", "email")} = ${email} LIMIT 1`,
  );

  let follower: FollowerRecord;
  if (existing) {
    follower = Followers.load(castRow("Follower", existing));
    follower.set("deleted_at", null);
    await Followers.saveBang(follower);
    follower.assign(attributes as never);
    await Followers.save(follower);
  } else {
    follower = Followers.build({ followed_id: Number(sellerId), email, ...attributes } as never);
    try {
      await Followers.saveBang(follower);
    } catch (error) {
      if (isRecordNotUnique(error)) throw new HandBackToRails("a follow created by a concurrent request");
      // `Rails.logger.error`: the unsaved follower carries the errors the visitor is shown.
      if (!(error instanceof RecordInvalid)) throw error;
    }
  }

  // confirm_follower
  if (follower.persisted && (await Followers.valid(follower))) {
    if (follower.get("source") === "csv_import" || verifiedSession) await confirmBang(follower);
    else await transaction(() => sendConfirmationEmail(follower));
  }
  return { follower, seller };
}

const failureMessage = (follower: FollowerRecord | null) =>
  follower === null ? null : follower.errors.isEmpty() ? null : toSentence(follower.errors.fullMessages());

async function create(input: MutationInput): Promise<ActionResult> {
  const format = requestFormat(input.request);
  if (format === "other") throw new HandBackToRails("a format whose content type is not modelled");
  if (captchaRequired(await followedUser(input.params))) throw new HandBackToRails("a follow that needs a CAPTCHA");

  const { follower, seller } = await createFollower(input, null);
  if (follower === null || seller === null) {
    if (format === "json") return json({ success: false, message: SOMETHING_WENT_WRONG }, UNPROCESSABLE_ENTITY);
    return { status: FOUND, location: SUBSCRIBE_PATH, flash: { alert: SOMETHING_WENT_WRONG } };
  }
  const errors = failureMessage(follower);
  if (errors !== null) {
    if (format === "json") return json({ success: false, message: errors }, UNPROCESSABLE_ENTITY);
    return { status: FOUND, location: SUBSCRIBE_PATH, flash: { alert: errors } };
  }
  const message = followConfirmationMessage(seller, follower.get("confirmed_at") !== null);
  if (format === "json") return json({ success: true, message });
  return { status: SEE_OTHER, location: SUBSCRIBE_PATH, flash: { notice: message } };
}

async function fromEmbedForm(input: MutationInput): Promise<ActionResult> {
  const format = requestFormat(input.request);
  if (format === "other") throw new HandBackToRails("a format whose content type is not modelled");
  // Every HTML answer past the CAPTCHA and the seller lookup is an Inertia page or a redirect that depends on the write.
  if (format !== "json") throw new HandBackToRails("the HTML answer of the embed form, an Inertia page");
  const seller = await followedUser(input.params);
  if (seller !== null && captchaRequired(seller)) {
    // The refusal is decided before the CAPTCHA widget could matter (the embed form has none). A posted product may turn it into the
    // waitlist wording, which is not modelled.
    const productId = input.params.product_id;
    if (productId !== undefined && productId !== null && productId !== "")
      throw new HandBackToRails("a CAPTCHA refusal of the embed form for a product");
    const { message, subscribe_url: destination } = embedFormCaptchaProps(seller);
    // The JSON callers get the destination inside the sentence.
    return json({ success: false, message: destination ? `${message} ${destination}` : message }, UNPROCESSABLE_ENTITY);
  }

  const { follower } = await createFollower(input, EMBED_FORM);
  if (follower === null || !follower.errors.isEmpty()) {
    // `e404_json unless user.try(:username)`: no seller at all (User#username falls back to the external id).
    if (seller === null) return notFoundJson();
    return json({ success: false, message: failureMessage(follower) ?? EMBED_FORM_FAILURE }, UNPROCESSABLE_ENTITY);
  }
  return json({ success: true, message: followConfirmationMessage(seller!, follower.get("confirmed_at") !== null) });
}

registerMutations(
  {
    method: "POST",
    pattern: "/follow",
    formats: ["any"],
    run: create,
  },
  {
    method: "POST",
    pattern: "/follow_from_embed_form",
    formats: ["any"],
    run: fromEmbedForm,
  },
);
