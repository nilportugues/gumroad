// WishlistsController#create, #update and #destroy (app/controllers/wishlists_controller.rb).
import { Prisma, type Wishlist } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { castRow, column, execute, selectRows, table } from "../models/sql.ts";
import { WishlistDeletable, Wishlists } from "../models/wishlist.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { wishlistPolicy } from "../policies/buyer.ts";
import { loadSellerContext, type SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { cgiEscape, requestFormat } from "./rails-params.ts";
import { fullpath } from "./rails-request.ts";

const SEE_OTHER = 303;
// Wishlist.attribute_names
const WRAPPED_COLUMNS = [
  "id",
  "user_id",
  "name",
  "deleted_at",
  "created_at",
  "updated_at",
  "followers_last_contacted_at",
  "description",
  "flags",
  "recommendable",
  "follower_count",
  "recent_follower_count",
];
const DISCOVER_OPTED_OUT_FLAG = 1;
// FlagShihTzu::TRUE_VALUES
const FLAG_TRUE_VALUES = [true, 1, "1", "t", "T", "true", "TRUE", "on", "ON"];

const redirect = (notice?: string, inertiaErrors?: Record<string, unknown>): ActionResult => ({
  status: SEE_OTHER,
  location: Routes.wishlists_path(),
  ...(notice === undefined ? {} : { flash: { notice } }),
  ...(inertiaErrors === undefined ? {} : { inertiaErrors }),
});

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `params.require(:wishlist).permit(...)`: a missing or non-hash value raises in Rails, and a value that is not a plain string
// would be cast by ActiveRecord.
function permitted(input: MutationInput, keys: string[]): Record<string, unknown> {
  const { params } = input;
  let wishlist = params.wishlist;
  // ParamsWrapper: a JSON body without the key is wrapped under it, limited to the model's columns.
  if (
    !("wishlist" in params) &&
    (input.request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json"
  ) {
    wishlist = Object.fromEntries(Object.entries(params).filter(([key]) => WRAPPED_COLUMNS.includes(key)));
  }
  // `require` raises for a missing or blank value.
  if (!isHash(wishlist) || Object.keys(wishlist).length === 0)
    throw new HandBackToRails("a wishlist parameter that is not a populated hash");
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in wishlist)) continue;
    const value = wishlist[key];
    if (key === "discover_opted_out") {
      if (isHash(value) || Array.isArray(value)) continue;
      out[key] = value;
    } else if (value === null || typeof value === "string") out[key] = value;
    else if (isHash(value) || Array.isArray(value)) continue;
    else throw new HandBackToRails(`a non-string ${key}`);
  }
  return out;
}

// `current_seller.wishlists.alive.find_by_external_id!(params[:id])`
async function findWishlist(sellerId: bigint, externalId: string): Promise<ModelRecord<Wishlist>> {
  const id = decrypt(externalId);
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`wishlists`.*")} FROM ${table("wishlists")} WHERE ${column("wishlists", "user_id")} = ${sellerId} AND ${column("wishlists", "deleted_at")} IS NULL AND ${column("wishlists", "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  return Wishlists.load(castRow<Wishlist>("Wishlist", row));
}

// ApplicationController#authenticate_user! for a visitor who is not signed in: e404_json for json and js, else a redirect to the login
// page that remembers where the visitor was. Null when signed in.
export function signedOutRefusal(input: MutationInput): ActionResult | null {
  if (railsLoggedInUser(input.context) !== null) return null;
  const format = requestFormat(input.request);
  if (format === "other") throw new HandBackToRails("a signed-out wishlist request in another format");
  return format === "json"
    ? { ...jsonResponse({ success: false, error: "Not found" }, 404), rescued: true }
    : { status: 302, location: `/login?next=${cgiEscape(fullpath(input.request))}`, rescued: true };
}

// authenticate_user!, then `authorize`, answered as PunditAuthorization#default_user_not_authorized does.
async function guarded(
  input: MutationInput,
  authorize: (context: SellerContext) => boolean,
  find: boolean,
): Promise<{ denied: ActionResult | null; wishlist: ModelRecord<Wishlist> | null }> {
  const signedOut = signedOutRefusal(input);
  if (signedOut) return { denied: signedOut, wishlist: null };
  if (input.context.currentSeller === null) throw new HandBackToRails("a signed-in request without a current seller");
  const sellerContext = await loadSellerContext(input.context);
  const wishlist = find ? await findWishlist(input.context.currentSeller.id, input.routeParams.id!) : null;
  if (
    !(find ? wishlistPolicy.update(sellerContext, { user_id: wishlist!.get("user_id") }) : authorize(sellerContext))
  ) {
    const message = notAllowedMessage(sellerContext);
    const account = input.url.searchParams.get("account_switched");
    return {
      denied:
        requestFormat(input.request) === "json"
          ? { ...jsonResponse({ success: false, error: message }, 401), rescued: true }
          : {
              status: 302,
              location: Routes.dashboard_url(input.urlOptions),
              rescued: true,
              ...(account ? {} : { flash: { alert: message } }),
            },
      wishlist,
    };
  }
  return { denied: null, wishlist };
}

const json = (input: MutationInput) => requestFormat(input.request) === "json";

registerMutations(
  {
    method: "POST",
    pattern: "/wishlists",
    formats: ["html", "json"],
    run: async (input) => {
      const { denied } = await guarded(input, wishlistPolicy.create, false);
      if (denied) return denied;
      const attributes = permitted(input, ["name"]);
      const record = Wishlists.build({ user_id: input.context.currentSeller!.id, ...attributes } as Partial<Wishlist>);
      const saved = await Wishlists.save(record);
      if (saved) {
        return json(input)
          ? { ...jsonResponse({ wishlist: { id: encrypt(record.get("id")), name: record.get("name") } }, 201) }
          : redirect("Wishlist created!");
      }
      const messages = record.errors.fullMessages();
      return json(input) ? jsonResponse({ error: messages[0] }, 422) : redirect(undefined, { base: messages });
    },
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/wishlists/:id",
    formats: ["html", "json"] as ("html" | "json")[],
    run: async (input: MutationInput) => {
      const { denied, wishlist } = await guarded(input, wishlistPolicy.update as never, true);
      if (denied) return denied;
      const attributes = permitted(input, ["name", "description", "discover_opted_out"]);
      const { discover_opted_out: optedOut, ...columns } = attributes;
      wishlist!.assign(columns as Partial<Wishlist>);
      if ("discover_opted_out" in attributes) {
        const flags = Number(wishlist!.get("flags"));
        wishlist!.set(
          "flags",
          (FLAG_TRUE_VALUES.includes(optedOut as never)
            ? flags | DISCOVER_OPTED_OUT_FLAG
            : flags & ~DISCOVER_OPTED_OUT_FLAG) as never,
        );
      }
      if (await Wishlists.save(wishlist!))
        return json(input)
          ? { status: 204, body: "", contentType: "application/json", paramsRead: true }
          : redirect("Wishlist updated!");
      const messages = wishlist!.errors.fullMessages();
      return json(input) ? jsonResponse({ error: messages[0] }, 422) : redirect(undefined, { base: messages });
    },
  })),
  {
    method: "DELETE",
    pattern: "/wishlists/:id",
    formats: ["html", "json"],
    run: async (input) => {
      const { denied, wishlist } = await guarded(input, wishlistPolicy.update as never, true);
      if (denied) return denied;
      await transaction(async () => {
        await WishlistDeletable.markDeletedBang(wishlist!);
        // `wishlist_followers.alive.update_all(deleted_at: Time.current)`
        await execute(
          Prisma.sql`UPDATE ${table("wishlist_followers")} SET ${column("wishlist_followers", "deleted_at")} = ${new Date(Math.floor(Date.now() / 1000) * 1000)} WHERE ${column("wishlist_followers", "wishlist_id")} = ${wishlist!.get("id")} AND ${column("wishlist_followers", "deleted_at")} IS NULL`,
        );
      });
      return redirect("Wishlist deleted!");
    },
  },
);
