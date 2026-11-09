// UtmLinksController#create, #update and #destroy (app/controllers/utm_links_controller.rb) and SaveUtmLinkService.
import { Prisma, type UtmLink } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { UtmLinkDeletable, UtmLinks } from "../models/utm-link.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize, type PolicyQuery } from "../policies/authorize.ts";
import { utmLinkPolicy } from "../policies/utm-link.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { resolvedTargetResourceId } from "./api-v2/ws17c-utm-links.ts";
import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { railsSegment, registerMutations, remoteIp, type MutationInput } from "./mutation.ts";

const SEE_OTHER = 303;
const GUID_COOKIE = "_gumroad_guid";
const SCALAR_KEYS = ["title", "target_resource_type", "target_resource_id", "permalink", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const UPDATABLE_KEYS = ["title", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const INDEX_ROUTE_KEYS = ["query", "page", "key", "direction"] as const;

const isHash = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const castString = (value: unknown) => (value === undefined ? undefined : value === null ? null : String(value));

// `params.require(:utm_link).permit(...)`: scalars only; a missing or blank value is a 400 Rails answers.
function permittedParams(input: MutationInput): Record<string, unknown> {
  const link = input.params.utm_link;
  if (!isHash(link) || Object.keys(link).length === 0) throw new HandBackToRails("a utm_link parameter that is not a populated hash");
  const out: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    const value = link[key];
    if (value !== undefined && (value === null || typeof value !== "object")) out[key] = value;
  }
  return out;
}

// `current_seller.utm_links.find_by_external_id(params[:id])`, or e404 (the link may be soft deleted).
async function setUtmLink(seller: NonNullable<SellerContext["seller"]>, externalId: string): Promise<ModelRecord<UtmLink>> {
  const id = decrypt(externalId);
  const [row] =
    id === null
      ? []
      : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`utm_links`.*")} FROM ${table("utm_links")} WHERE ${column("utm_links", "seller_id")} = ${seller.id} AND ${column("utm_links", "id")} = ${id} LIMIT 1`);
  if (!row) throw new RoutingError("Not Found");
  return UtmLinks.load(castRow<UtmLink>("UtmLink", row));
}

async function guarded(input: MutationInput, policy: PolicyQuery, find: boolean): Promise<{ denied: ActionResult | null; link: ModelRecord<UtmLink> | null }> {
  let link: ModelRecord<UtmLink> | null = null;
  const denied = await sellerGuard(
    { context: input.context, config: domainConfig(process.env), url: input.url, params: input.routeParams, urlOptions: input.urlOptions },
    (sellerContext) => authorize(policy, sellerContext),
    { beforeAuthorize: async (sellerContext) => void (find && (link = await setUtmLink(sellerContext.seller!, input.routeParams.id!))) },
  );
  return { denied, link };
}

const listPath = () => Routes.dashboard_utm_links_path();

// `redirect_to error_redirect_path, inertia: { errors: { "utm_link.attr" => message } }`
function invalid(link: ModelRecord<UtmLink>, location: string): ActionResult {
  const [first] = link.errors.details;
  return { status: 302, location, inertiaErrors: { [`utm_link.${first!.attribute}`]: first!.message } };
}

async function save(input: MutationInput, link: ModelRecord<UtmLink> | null, errorLocation: string, notice: string): Promise<ActionResult> {
  const seller = input.context.currentSeller!;
  const params = permittedParams(input);
  const record =
    link ??
    UtmLinks.build({
      seller_id: seller.id,
      title: castString(params.title) as never,
      target_resource_type: castString(params.target_resource_type) as never,
      target_resource_id: (await resolvedTargetResourceId(seller as never, params.target_resource_type, params.target_resource_id)) as never,
      ...(params.permalink === undefined ? {} : { permalink: castString(params.permalink) as never }),
      utm_source: castString(params.utm_source) as never,
      utm_medium: castString(params.utm_medium) as never,
      utm_campaign: castString(params.utm_campaign) as never,
      utm_term: (castString(params.utm_term) ?? null) as never,
      utm_content: (castString(params.utm_content) ?? null) as never,
      ip_address: remoteIp(input.request) as never,
      browser_guid: (input.request.cookies.get(GUID_COOKIE) ?? null) as never,
    } as never);
  if (link !== null) {
    const attributes: Record<string, unknown> = {};
    for (const key of UPDATABLE_KEYS) if (key in params) attributes[key] = castString(params[key]);
    link.assign(attributes as never);
  }
  try {
    await UtmLinks.saveBang(record);
  } catch (error) {
    if (error instanceof RecordInvalid) return invalid(record, errorLocation);
    throw error;
  }
  return { status: SEE_OTHER, location: listPath(), flash: { notice } };
}

// `index_route_params.except(:ids).compact`
function indexLocation(input: MutationInput): string {
  const query = new URLSearchParams();
  for (const key of INDEX_ROUTE_KEYS) {
    const value = input.params[key];
    if (typeof value === "string" || typeof value === "number") query.set(key, String(value));
    else if (value !== undefined && value !== null) throw new HandBackToRails(`a non-scalar ${key}`);
  }
  // Hash#to_query sorts its pairs.
  const encoded = [...query].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%20/gu, "+")}`).join("&");
  return encoded === "" ? listPath() : `${listPath()}?${encoded}`;
}

registerMutations(
  {
    method: "POST",
    pattern: "/dashboard/utm_links",
    run: async (input) => {
      const { denied } = await guarded(input, utmLinkPolicy.create, false);
      if (denied) return denied;
      const copyFrom = input.params.copy_from;
      if (copyFrom !== undefined && typeof copyFrom !== "string") throw new HandBackToRails("a non-string copy_from");
      const errorLocation = Routes.new_dashboard_utm_link_path(copyFrom === undefined ? {} : { copy_from: copyFrom });
      return save(input, null, errorLocation, "Link created!");
    },
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/dashboard/utm_links/:id",
    run: async (input: MutationInput) => {
      const { denied, link } = await guarded(input, utmLinkPolicy.update, true);
      if (denied) return denied;
      if (link!.get("deleted_at") != null) return { status: 302, location: listPath(), flash: { alert: "Link not found" } };
      return save(input, link, `/dashboard/utm_links/${railsSegment(encrypt(link!.get("id")))}/edit`, "Link updated!");
    },
  })),
  {
    method: "DELETE",
    pattern: "/dashboard/utm_links/:id",
    run: async (input) => {
      const { denied, link } = await guarded(input, utmLinkPolicy.destroy, true);
      if (denied) return denied;
      await UtmLinkDeletable.markDeletedBang(link!);
      return { status: 302, location: indexLocation(input), flash: { notice: "Link deleted!" } };
    },
  },
);
