// Products::MarketingActionsController (app/controllers/products/marketing_actions_controller.rb). #show, #approve and #cancel run in Node.
// Whatever sends mail or posts to X goes to Rails whole: #execute on a live channel, and #index, which creates the actions, their launch
// UTM links and the email draft before it answers.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import {
  applyCopyApproval,
  cancel,
  findMarketingAction,
  isLiveChannel,
  marketingActionJson,
  MarketingActions,
  marketingEnabledFor,
  type MarketingActionRecord,
} from "../models/marketing-action.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { authorize } from "../policies/authorize.ts";
import { marketingActionPolicy } from "../policies/marketing-action.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

const COMING_SOON = "This channel is coming soon.";
const ABANDONED_CART = "abandoned_cart";
const CART_RECOVERY_RECEIPT = "Use the product Share page or Workflows to change abandoned cart emails.";
const POST_CLOSED = "This post can no longer be changed.";
const POST_NOT_CANCELLABLE = "This post can no longer be cancelled.";

type ProductRow = {
  id: bigint;
  user_id: bigint | null;
  deleted_at: Date | null;
  purchase_disabled_at: Date | null;
  draft: number | boolean;
};

// `head :not_found`
const notFound = (): ActionResult => ({ status: 404, body: "", contentType: "application/json", paramsRead: true });

// `Link.find_by(unique_permalink: params[:product_id]) || e404`: deleted products included.
async function fetchProduct(input: MutationInput): Promise<ProductRow> {
  const permalink = input.routeParams.product_id;
  const [row] = permalink
    ? await selectRows<ProductRow>(
        Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "deleted_at")}, ${column("links", "purchase_disabled_at")}, ${column("links", "draft")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
      )
    : [];
  if (row === undefined) throw new RoutingError("Not Found");
  return row;
}

// `Marketing::Action.where(link: @product).find_by_external_id(params[:id]) || e404`
async function fetchAction(input: MutationInput, product: ProductRow): Promise<MarketingActionRecord> {
  const action = await findMarketingAction(product.id, decrypt(input.routeParams.id ?? ""));
  if (action === null) throw new RoutingError("Not Found");
  return action;
}

async function memberAction(
  input: MutationInput,
  run: (action: MarketingActionRecord, sellerContext: SellerContext) => Promise<ActionResult>,
): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      const product = await fetchProduct(input);
      const action = await fetchAction(input, product);
      const denied = await authorizeJson(input, () =>
        authorize(marketingActionPolicy.show, sellerContext, { user_id: action.get("user_id") }),
      );
      if (denied) return denied;
      if (!(await marketingEnabledFor(input.context.currentSeller!))) return notFound();
      return run(action, sellerContext);
    },
  );
}

async function index(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      const product = await fetchProduct(input);
      const denied = await authorizeJson(input, () => authorize(marketingActionPolicy.index, sellerContext));
      if (denied) return denied;
      const seller = input.context.currentSeller!;
      // Recommendations create the action and its UTM link, so drafts must not reach them even on a direct request.
      const published = product.deleted_at === null && product.purchase_disabled_at === null && !product.draft;
      if (!(await marketingEnabledFor(seller)) || product.user_id !== seller.id || !published) return notFound();
      throw new HandBackToRails(
        "marketing recommendations create the actions, their launch UTM links and the email draft",
      );
    },
  );
}

async function show(input: MutationInput): Promise<ActionResult> {
  return memberAction(input, async (action) => json(await marketingActionJson(action)));
}

// `params.permit(:copy).to_h`: a scalar the model casts to text is a string here; anything else Rails would cast or drop goes to Rails.
function copyParam(input: MutationInput): { copy?: string | null } {
  const copy = input.params.copy;
  if (copy === undefined) return {};
  if (copy !== null && typeof copy !== "string") throw new HandBackToRails("a copy parameter that is not text");
  return { copy };
}

async function approve(input: MutationInput): Promise<ActionResult> {
  return memberAction(input, async (action) => {
    if (action.get("channel") === ABANDONED_CART)
      return json({ success: false, error: CART_RECOVERY_RECEIPT }, UNPROCESSABLE_ENTITY);
    const attributes = copyParam(input);
    const outcome = await MarketingActions.withLock(action, () => applyCopyApproval(action, attributes));
    if (outcome === "invalid")
      return json({ success: false, error: action.errors.fullMessages().join(", ") }, UNPROCESSABLE_ENTITY);
    if (outcome === "closed") return json({ success: false, error: POST_CLOSED }, UNPROCESSABLE_ENTITY);
    return json(await marketingActionJson(action));
  });
}

async function execute(input: MutationInput): Promise<ActionResult> {
  return memberAction(input, async (action) => {
    if (!isLiveChannel(action.get("channel")))
      return json({ success: false, error: COMING_SOON }, UNPROCESSABLE_ENTITY);
    throw new HandBackToRails("executing a live channel posts to X or schedules the email");
  });
}

async function cancelAction(input: MutationInput): Promise<ActionResult> {
  return memberAction(input, async (action) => {
    if (action.get("channel") === ABANDONED_CART)
      return json({ success: false, error: CART_RECOVERY_RECEIPT }, UNPROCESSABLE_ENTITY);
    // with_lock reloads under the row lock, so a cancellation that arrives after the executor's claim sees :queued and is refused.
    const cancelled = await MarketingActions.withLock(action, () => cancel(action));
    if (!cancelled) return json({ success: false, error: POST_NOT_CANCELLABLE }, UNPROCESSABLE_ENTITY);
    return json(await marketingActionJson(action));
  });
}

// `skipForgeryProtection` on the GETs: Rails does not verify a GET's token, and the format check is sellerJsonAction's.
registerMutations(
  { method: "GET", pattern: "/products/:product_id/marketing_actions.json", skipForgeryProtection: true, run: index },
  {
    method: "GET",
    pattern: "/products/:product_id/marketing_actions/:id([A-Za-z0-9_=-]+).json",
    skipForgeryProtection: true,
    run: show,
  },
  { method: "POST", pattern: "/products/:product_id/marketing_actions/:id/approve.json", json: true, run: approve },
  { method: "POST", pattern: "/products/:product_id/marketing_actions/:id/execute.json", json: true, run: execute },
  { method: "POST", pattern: "/products/:product_id/marketing_actions/:id/cancel.json", json: true, run: cancelAction },
);
