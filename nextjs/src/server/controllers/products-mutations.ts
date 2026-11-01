// The dashboard's JSON product actions: Products::ArchivedController#create and #destroy, LinksController#unpublish.
// They answer `render json:`, so the filters that Rails runs for an HTML page answer in JSON here (RequireAccountEmail 403,
// Pundit 401), and a request that does not ask for JSON goes to Rails whole.
import { Prisma, type Link, type User } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { LinkFlags, Links, type LinkRecord } from "../models/link.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratingProductIds, linkPolicy, productsArchivedLinkPolicy } from "../policies/link.ts";
import { loadSellerContext, NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { HandBackToRails, RoutingError, type ActionResult, type Rendered } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const ACCOUNT_EMAIL_REQUIRED = "Please add an email address to your account before continuing.";
const JSON_TYPE = "application/json; charset=utf-8";
const UNPROCESSABLE = 422;

const json = (value: unknown, status = 200): Rendered => ({ status, body: esJson(value as JsonValue), contentType: JSON_TYPE });

// RequireAccountEmail and `authenticate_user!`: the route is `signedInOnly`, so a visitor who is not signed in never gets here.
function accountEmailRequired(input: MutationInput): ActionResult | null {
  const user = railsLoggedInUser(input.context);
  if (user === null) throw new HandBackToRails("a visitor who is not signed in");
  if (user.email || user.unconfirmed_email || input.context.impersonatedUser) return null;
  return { ...json({ success: false, error_message: ACCOUNT_EMAIL_REQUIRED }, 403), rescued: true };
}

// `params[:link_id] || params[:id]`, the permalink the fetch filters look up.
function permalinkParam(input: MutationInput): string | null {
  const value = input.params.link_id ?? input.params.id ?? input.routeParams.link_id ?? input.routeParams.id;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HandBackToRails("a permalink that is not text");
  return value;
}

async function fetchVisibleProduct(permalink: string | null, sellerId: bigint | null): Promise<LinkRecord | null> {
  if (permalink === null) return null;
  const owner = sellerId === null ? Prisma.empty : Prisma.sql` AND ${column("links", "user_id")} = ${sellerId}`;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL${owner} AND ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
  );
  return row ? Links.load(castRow<Link>("Link", row)) : null;
}

// PunditAuthorization#default_user_not_authorized for a JSON request.
const notAuthorized = (context: SellerContext): ActionResult => ({ ...json({ success: false, error: notAllowedMessage(context) }, 401), rescued: true });

type Found = { halt: ActionResult } | { halt: null; seller: User; product: LinkRecord; context: SellerContext };

// `fetch_product_and_enforce_ownership` (`Link.fetch(permalink, user: current_seller) || e404`), or `fetch_product_and_enforce_access`
// (the product of any seller, then 404 unless it is current_seller's or the user collaborates on it), then `authorize`.
async function find(input: MutationInput, access: "ownership" | "access", authorization: (context: SellerContext, product: Link) => void): Promise<Found> {
  const halted = accountEmailRequired(input);
  if (halted) return { halt: halted };
  const seller = input.context.currentSeller!;
  const permalink = permalinkParam(input);
  const product = await fetchVisibleProduct(permalink, access === "ownership" ? seller.id : null);
  if (product === null) throw new RoutingError("Not Found");
  const context = await loadSellerContext(input.context);
  if (access === "access" && product.get("user_id") !== seller.id) {
    if ((await collaboratingProductIds(context, [product.get("id")])).has(BigInt(product.get("id")))) throw new NotPortedError("a collaborator acting on the product", "app/controllers/links_controller.rb");
    throw new RoutingError("Not Found");
  }
  try {
    authorization(context, product.attributes);
  } catch (error) {
    if (error instanceof NotAuthorizedError) return { halt: notAuthorized(context) };
    throw error;
  }
  return { halt: null, seller, product, context };
}


// `Time.current` is the first moment the action ran.
const startedAt = (): (() => Date) => {
  const at = new Date();
  return () => at;
};

registerMutations(
  {
    method: "POST",
    pattern: "/products/archived",
    json: true,
    async run(input) {
      const found = await find(input, "ownership", (context, product) => authorize(productsArchivedLinkPolicy.create, context, product));
      if (found.halt) return found.halt;
      const now = startedAt();
      const link = found.product;
      await Links.updateBang(link, { flags: LinkFlags.set(link.get("flags"), "archived", true), purchase_disabled_at: link.get("purchase_disabled_at") ?? now() }, { now });
      return json({ success: true });
    },
  },
  {
    method: "DELETE",
    pattern: "/products/archived/:id",
    json: true,
    async run(input) {
      const found = await find(input, "ownership", (context, product) => authorize(productsArchivedLinkPolicy.destroy, context, product));
      if (found.halt) return found.halt;
      const link = found.product;
      if (!(await Links.update(link, { flags: LinkFlags.set(link.get("flags"), "archived", false) }))) return json({ success: false, errors: link.errors.fullMessages() }, UNPROCESSABLE);
      // User#archived_products_count: `links.visible.archived.count`
      const [row] = await selectRows<Record<string, unknown>>(
        Prisma.sql`SELECT COUNT(*) FROM ${table("links")} WHERE ${column("links", "user_id")} = ${found.seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived")}`,
      );
      return json({ success: true, archived_products_count: Number(Object.values(row ?? {})[0] ?? 0) });
    },
  },
  {
    method: "POST",
    pattern: "/links/:id/unpublish",
    json: true,
    async run(input) {
      const found = await find(input, "access", (context) => authorize(linkPolicy.destroy, context));
      if (found.halt) return found.halt;
      const now = startedAt();
      const link = found.product;
      // Link#unpublish!: `self.purchase_disabled_at ||= Time.current; save!`
      await Links.updateBang(link, { purchase_disabled_at: link.get("purchase_disabled_at") ?? now() }, { now });
      return json({ success: true });
    },
  },
);
