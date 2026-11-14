// Api::V2::MarketingActionsController. The checks, #show, #approve and #cancel run here; whatever creates an action, its launch UTM link
// and the email draft (Marketing::Recommendations) or posts to X / schedules the email (the channel executors) goes to Rails whole.
import { db } from "../../../lib/db.ts";
import { decrypt } from "../../../lib/obfuscate-ids.ts";
import {
  applyCopyApproval,
  cancel,
  findMarketingActionForUser,
  isLiveChannel,
  isMarketingChannel,
  marketingActionJson,
  MarketingActions,
  marketingEnabledFor,
  twitterHandleOf,
  type MarketingActionRecord,
} from "../../models/marketing-action.ts";
import { HandBackToRails, type ActionResult, type Rendered } from "../application-controller.ts";

import { fromExternalId, type ApiV2Input } from "./base.ts";
import { head, renderJson, renderResponse, toSentence } from "./ws17c-base.ts";

const COMING_SOON = "This channel is coming soon.";
const CART_RECOVERY = "Use the product Share page or Workflows to change abandoned cart emails.";
const ABANDONED_CART = "abandoned_cart";
const CONFIRMATION_CHANGED = "The post changed. Review it and confirm again.";

// A before_action that renders halts the request and skips the after_actions, like a rescue_from handler.
const halt = (rendered: Rendered): Rendered => ({ ...rendered, rescued: true });
const marketingError = (message: string): Rendered => renderJson({ success: false, message }, 422);

// `before_action :require_auto_marketing`
const requireAutoMarketing = async (input: ApiV2Input): Promise<Rendered | undefined> =>
  (await marketingEnabledFor(input.owner)) ? undefined : head(404);

// `current_resource_owner.links.visible` by external id, then by permalink; the product must be published.
export async function fetchMarketingProduct(input: ApiV2Input): Promise<Rendered | undefined> {
  const denied = await requireAutoMarketing(input);
  if (denied) return denied;
  const id = input.routeParams.product_id;
  const decoded = fromExternalId(id);
  const visible = { user_id: input.owner.id, deleted_at: null };
  const product =
    (decoded === null ? null : await db.link.findFirst({ where: { ...visible, id: decoded } })) ??
    (await db.link.findFirst({ where: { ...visible, unique_permalink: id } }));
  if (product === null || product.purchase_disabled_at !== null || product.draft) return head(404);
  return undefined;
}

// `fetch_marketing_action`, then `verify_idempotency_key` (not on show; approve and execute also need a confirmation_token).
const fetchMarketingAction =
  (keyed: boolean, confirms: boolean) =>
  async (input: ApiV2Input): Promise<Rendered | undefined> => {
    const denied = await requireAutoMarketing(input);
    if (denied) return denied;
    const action = await findMarketingActionForUser(input.owner.id, decrypt(input.routeParams.id ?? ""));
    if (action === null) return head(404);
    const link = await db.link.findFirst({ where: { id: action.get("link_id") }, select: { user_id: true } });
    if (link === null) throw new HandBackToRails("a marketing action whose product is gone");
    if (link.user_id !== input.owner.id) return head(404);
    input.state.action = action;
    if (!keyed) return undefined;
    const token = input.params.confirmation_token;
    if (confirms && !(typeof token === "string" && token !== ""))
      return halt(marketingError("Review the action and supply its confirmation_token."));
    if (input.params.idempotency_key !== (await marketingActionJson(action)).idempotency_key)
      return halt(marketingError("Use the idempotency_key returned with this action."));
    return undefined;
  };

export const beforeShow = fetchMarketingAction(false, false);
export const beforeApproveOrExecute = fetchMarketingAction(true, true);
export const beforeCancel = fetchMarketingAction(true, false);

async function renderAction(action: MarketingActionRecord): Promise<Rendered> {
  return renderResponse(true, {
    marketing_action: await marketingActionJson(action),
    handle: await twitterHandleOf(action.get("user_id")),
  });
}

export async function recommendations(): Promise<ActionResult> {
  throw new HandBackToRails("marketing recommendations create the actions, their launch UTM links and the email draft");
}

export async function create(input: ApiV2Input): Promise<ActionResult> {
  const channel = input.params.channel;
  if (typeof channel !== "string" || !isMarketingChannel(channel)) return marketingError("Unknown marketing channel.");
  if (!isLiveChannel(channel)) return marketingError(COMING_SOON);
  throw new HandBackToRails("marketing recommendations create the action, its launch UTM link and the email draft");
}

export async function show(input: ApiV2Input): Promise<ActionResult> {
  return renderAction(input.state.action as MarketingActionRecord);
}

// `params.permit(:copy).to_h`: a scalar the model casts to text is a string here; anything else Rails would cast or drop goes to Rails.
function copyParam(input: ApiV2Input): { copy?: string | null } {
  const copy = input.params.copy;
  if (copy === undefined) return {};
  if (copy !== null && typeof copy !== "string") throw new HandBackToRails("a copy parameter that is not text");
  return { copy };
}

export async function approve(input: ApiV2Input): Promise<ActionResult> {
  const action = input.state.action as MarketingActionRecord;
  if (action.get("channel") === ABANDONED_CART) return marketingError(CART_RECOVERY);
  const attributes = copyParam(input);
  const token = input.params.confirmation_token;
  const outcome = await MarketingActions.withLock(action, async () => {
    // verify_confirmation!: the token covers the post text and the seller's handle as they are under the lock.
    if ((await marketingActionJson(action)).confirmation_token !== token) return "changed" as const;
    return applyCopyApproval(action, attributes);
  });
  if (outcome === "changed") return halt(marketingError(CONFIRMATION_CHANGED));
  if (outcome === "invalid") return marketingError(toSentence(action.errors.fullMessages()));
  if (outcome === "closed") return marketingError("This post can no longer be changed.");
  return renderAction(action);
}

export async function execute(input: ApiV2Input): Promise<ActionResult> {
  const action = input.state.action as MarketingActionRecord;
  if (!isLiveChannel(action.get("channel"))) return marketingError(COMING_SOON);
  throw new HandBackToRails("executing a live channel posts to X or schedules the email");
}

export async function cancelAction(input: ApiV2Input): Promise<ActionResult> {
  const action = input.state.action as MarketingActionRecord;
  if (action.get("channel") === ABANDONED_CART) return marketingError(CART_RECOVERY);
  const cancelled = await MarketingActions.withLock(
    action,
    async () => action.get("status") === "cancelled" || cancel(action),
  );
  if (!cancelled) return marketingError("This post can no longer be cancelled.");
  return renderAction(action);
}
