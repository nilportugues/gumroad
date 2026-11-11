// app/models/marketing/action.rb for the dashboard's show, approve and cancel, and Marketing::Eligibility. Creating an action, the channel
// executors and Marketing::Recommendations stay in Rails: they write UTM links and email drafts, or post to X.
import { createHash } from "node:crypto";

import { Prisma, type MarketingAction, type User } from "@prisma/client";

import { encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import {
  evaluateFeature,
  parseGateValues,
  readFeatureDoc,
  UnsupportedFlipperGateError,
  userActor,
} from "../infra/flipper.ts";
import { shortDomainWithProtocol } from "../page-props/audience/support.ts";
import { esJson, timeAsJson } from "../search/es-json.ts";

import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import {
  validatesInclusionOf,
  validatesLengthOf,
  validatesPresenceOf,
  validatesUniquenessOf,
} from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

// X counts every URL as 23 characters, and the post is copy, a blank line and the link.
const MAX_POST_LENGTH = 280;
const X_URL_LENGTH = 23;
export const MAX_COPY_LENGTH = MAX_POST_LENGTH - X_URL_LENGTH - 2;

// Marketing::Channel.action_channels
const ACTION_CHANNELS = ["x", "instagram", "youtube", "tiktok", "email", "abandoned_cart"];
// The Marketing::Channel::ALL entries with `live: true`.
const LIVE_CHANNELS = new Set(["x", "email"]);
// Marketing::Channel::ALL.key?
export const isMarketingChannel = (channel: string): boolean =>
  ACTION_CHANNELS.includes(channel) && channel !== "abandoned_cart";
export const isLiveChannel = (channel: string): boolean => LIVE_CHANNELS.has(channel);

const OPEN_STATUSES = ["recommended", "approved"];

export const MarketingActions = defineModel<MarketingAction>({
  rubyClass: "Marketing::Action",
  prismaModel: "MarketingAction",
  delegate: (tx) => tx.marketingAction as never,
  validations: [
    validatesInclusionOf<MarketingAction>(["channel"], { in: ACTION_CHANNELS }),
    validatesPresenceOf<MarketingAction>(["idempotency_key"]),
    validatesUniquenessOf<MarketingAction>("marketing_actions", ["idempotency_key"], {}),
    validatesPresenceOf<MarketingAction>(["copy"]),
    validatesLengthOf<MarketingAction>(["copy"], { maximum: MAX_COPY_LENGTH }),
  ],
});

export type MarketingActionRecord = ModelRecord<MarketingAction>;

// `Marketing::Action.where(link: product).find_by(id:)`
export async function findMarketingAction(productId: bigint, id: number | null): Promise<MarketingActionRecord | null> {
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`marketing_actions`.*")} FROM ${table("marketing_actions")} WHERE ${column("marketing_actions", "link_id")} = ${productId} AND ${column("marketing_actions", "id")} = ${id} LIMIT 1`,
  );
  return row ? MarketingActions.load(row as unknown as MarketingAction) : null;
}

// `Marketing::Action.where(user:).find_by_external_id`
export async function findMarketingActionForUser(
  userId: bigint,
  id: number | null,
): Promise<MarketingActionRecord | null> {
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`marketing_actions`.*")} FROM ${table("marketing_actions")} WHERE ${column("marketing_actions", "user_id")} = ${userId} AND ${column("marketing_actions", "id")} = ${id} LIMIT 1`,
  );
  return row ? MarketingActions.load(row as unknown as MarketingAction) : null;
}

export async function twitterHandleOf(userId: bigint | number): Promise<string | null> {
  const [owner] = await selectRows<{ twitter_handle: string | null }>(
    Prisma.sql`SELECT ${column("users", "twitter_handle")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`,
  );
  return owner?.twitter_handle ?? null;
}

// Marketing::Eligibility.enabled_for?: the seller's frozen holdout assignment, then the `auto_marketing` flag. A seller without an
// assignment gets one created from their lifetime sales, which stays in Rails.
export async function marketingEnabledFor(seller: Pick<User, "id">): Promise<boolean> {
  const [assignment] = await selectRows<{ marketing_holdout: number | boolean }>(
    Prisma.sql`SELECT ${column("marketing_holdout_assignments", "marketing_holdout")} FROM ${table("marketing_holdout_assignments")} WHERE ${column("marketing_holdout_assignments", "user_id")} = ${seller.id} LIMIT 1`,
  );
  if (assignment === undefined)
    throw new NotPortedError("Marketing::HoldoutAssignment.for_seller!", "marketing/holdout_assignment.rb");
  if (assignment.marketing_holdout) return false;
  try {
    return evaluateFeature(
      "auto_marketing",
      parseGateValues(await readFeatureDoc("auto_marketing")),
      userActor(seller.id),
    );
  } catch (error) {
    if (error instanceof UnsupportedFlipperGateError)
      throw new NotPortedError("an expression gate on auto_marketing", "marketing/eligibility.rb");
    // These gates only gate marketing tools, so a stalled Redis read means "not enabled".
    return false;
  }
}

// `approve`: [:recommended, :approved] => :approved
async function approve(action: MarketingActionRecord): Promise<boolean> {
  if (!OPEN_STATUSES.includes(action.get("status"))) return false;
  action.assign({ status: "approved", approved_at: new Date() });
  return MarketingActions.save(action);
}

// `cancel`: [:recommended, :approved] => :cancelled. Not from :queued, where the executor has claimed the post.
export async function cancel(action: MarketingActionRecord): Promise<boolean> {
  if (!OPEN_STATUSES.includes(action.get("status"))) return false;
  action.assign({ status: "cancelled" });
  return MarketingActions.save(action);
}

export type ApprovalOutcome = "invalid" | "closed" | "claimed" | "approved";

// Marketing::Action#apply_copy_approval; `copy` is only present when the request carried the key.
export async function applyCopyApproval(
  action: MarketingActionRecord,
  attributes: { copy?: string | null },
): Promise<ApprovalOutcome> {
  if (action.get("status") === "queued" || action.get("status") === "posted") return "claimed";
  if ("copy" in attributes) action.set("copy", attributes.copy ?? null);
  if (action.attributeChanged("copy") && !(await MarketingActions.valid(action))) return "invalid";
  return (await approve(action)) ? "approved" : "closed";
}

// Marketing::Action#as_json
export async function marketingActionJson(action: MarketingActionRecord): Promise<Record<string, unknown>> {
  const copy = action.get("copy");
  const utmLinkId = action.get("utm_link_id");
  let shortUrl: string | null = null;
  if (utmLinkId !== null) {
    const [link] = await selectRows<{ permalink: string }>(
      Prisma.sql`SELECT ${column("utm_links", "permalink")} FROM ${table("utm_links")} WHERE ${column("utm_links", "id")} = ${utmLinkId} LIMIT 1`,
    );
    if (link !== undefined) shortUrl = `${shortDomainWithProtocol()}/u/${link.permalink}`;
  }
  const postText = [copy, shortUrl].filter((part) => part !== null).join("\n\n");
  const twitterHandle = await twitterHandleOf(action.get("user_id"));
  const idempotencyKey = action.get("idempotency_key");
  return {
    id: externalId(action.get("id")),
    idempotency_key: createHash("sha256").update(idempotencyKey).digest("hex"),
    confirmation_token: createHash("sha256")
      .update(esJson([idempotencyKey, postText, twitterHandle]))
      .digest("hex"),
    channel: action.get("channel"),
    status: action.get("status"),
    copy,
    post_text: postText,
    link_url: shortUrl,
    external_url: action.get("external_url"),
    error_code: action.get("error_code"),
    approved_at: timeAsJson(action.get("approved_at")),
    posted_at: timeAsJson(action.get("posted_at")),
  };
}
