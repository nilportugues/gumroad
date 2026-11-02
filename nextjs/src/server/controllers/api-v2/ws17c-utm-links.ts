// Api::V2::UtmLinksController and SaveUtmLinkService.
import { randomUUID } from "node:crypto";

import { Prisma, type User } from "@prisma/client";

import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { RecordInvalid } from "../../models/runtime/errors.ts";
import { column, castRow, selectRows, table } from "../../models/sql.ts";
import { findAliveUtmLink, UtmLinkDeletable, UtmLinks } from "../../models/utm-link.ts";
import { targets, utmUrl, type Targets, type UtmLinkRow } from "../../page-props/audience/utm-links.ts";
import { externalId, shortDomainWithProtocol } from "../../page-props/audience/support.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { authorize, errorWithCreatingObject, errorWithObject, halted, PUBLIC_READ_SCOPES, successWithObject, timeJson, type ApiCall } from "./ws17c-base.ts";
import { remoteIp } from "../mutation.ts";

const GUID_COOKIE = "_gumroad_guid";

// UtmLink#as_json (the public API shape)
function utmLinkJson(seller: User, link: UtmLinkRow & { total_clicks: number; disabled_at: Date | null; updated_at: Date }, resolved: Targets): Record<string, unknown> {
  const exists = (type: string, map: Map<number, unknown>) => link.target_resource_type === type && link.target_resource_id !== null && map.has(Number(link.target_resource_id));
  const targetId = exists("product_page", resolved.products) || exists("post_page", resolved.posts) ? externalId(link.target_resource_id!) : null;
  return {
    id: externalId(link.id),
    title: link.title,
    short_url: `${shortDomainWithProtocol()}/u/${link.permalink}`,
    utm_url: utmUrl(seller, link, resolved),
    target_resource_type: link.target_resource_type,
    target_resource_id: targetId,
    utm_source: link.utm_source,
    utm_medium: link.utm_medium,
    utm_campaign: link.utm_campaign,
    utm_term: link.utm_term,
    utm_content: link.utm_content,
    enabled: link.disabled_at === null || link.disabled_at === undefined,
    total_clicks: link.total_clicks,
    unique_clicks: link.unique_clicks,
    created_at: timeJson(link.created_at),
    updated_at: timeJson(link.updated_at),
  };
}

type Row = UtmLinkRow & { total_clicks: number; disabled_at: Date | null; updated_at: Date };

async function render(seller: User, links: Row[]) {
  const resolved = await targets(links);
  return links.map((link) => utmLinkJson(seller, link, resolved));
}

async function renderOne(seller: User, id: bigint | number) {
  const [row] = await selectRows<Row>(Prisma.sql`SELECT * FROM ${table("utm_links")} WHERE ${column("utm_links", "id")} = ${id} LIMIT 1`);
  return (await render(seller, [row!]))[0]!;
}

// A NotPortedInstallmentUrl (a post whose seller has no subdomain) is Rails' to render.
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.name === "NotPortedError") throw new HandBackToRails(error.message);
    throw error;
  }
}

export async function index(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT * FROM ${table("utm_links")} WHERE ${column("utm_links", "seller_id")} = ${auth.owner.id} AND ${column("utm_links", "deleted_at")} IS NULL ORDER BY ${column("utm_links", "created_at")} DESC, ${column("utm_links", "id")} DESC`,
  );
  return guarded(async () => successWithObject("utm_links", await render(auth.owner, rows)));
}

// before_action :fetch_utm_link
async function fetchUtmLink(call: ApiCall, owner: User) {
  const id = decrypt(call.routeParams.id!);
  const row = id === null ? null : await findAliveUtmLink(owner.id, id);
  return row;
}

const notFound = () => ({ ...errorWithObject("utm_link", null, false), rescued: true });

export async function show(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const row = await fetchUtmLink(call, auth.owner);
  if (row === null) return notFound();
  return guarded(async () => successWithObject("utm_link", await renderOne(auth.owner, row.id as bigint)));
}

export async function destroy(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_products"]);
  if (halted(auth)) return auth.halt;
  const row = await fetchUtmLink(call, auth.owner);
  if (row === null) return notFound();
  const link = UtmLinks.load(castRow("UtmLink", row) as never);
  if (await UtmLinkDeletable.markDeleted(link as never)) return successWithObject("utm_link", null);
  return errorWithObject("utm_link", link.errors.fullMessages());
}

async function toggle(call: ApiCall, disabledAt: Date | null): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_products"]);
  if (halted(auth)) return auth.halt;
  const row = await fetchUtmLink(call, auth.owner);
  if (row === null) return notFound();
  const link = UtmLinks.load(castRow("UtmLink", row) as never);
  link.set("disabled_at", disabledAt as never);
  await UtmLinks.saveBang(link);
  return guarded(async () => successWithObject("utm_link", await renderOne(auth.owner, row.id as bigint)));
}

// Time.current for a datetime(0) column is truncated to the second.
const currentSecond = () => new Date(Math.floor(Date.now() / 1000) * 1000);
export const disable = (call: ApiCall) => toggle(call, currentSecond());
export const enable = (call: ApiCall) => toggle(call, null);

// `params.permit(...)`: scalars only.
const SCALAR_PARAMS = ["title", "target_resource_type", "target_resource_id", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
function permittedParams(call: ApiCall): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SCALAR_PARAMS) {
    const value = call.params[key];
    if (value !== undefined && (value === null || typeof value !== "object")) out[key] = value;
  }
  return out;
}

const castString = (value: unknown) => (value === undefined ? undefined : value === null ? null : String(value));

// SaveUtmLinkService#resolved_target_resource_id: through the seller's own association, so a foreign id becomes nil.
export async function resolvedTargetResourceId(seller: User, type: unknown, externalIdValue: unknown): Promise<bigint | null> {
  if (externalIdValue == null || String(externalIdValue).trim() === "") return null;
  const id = decrypt(String(externalIdValue));
  if (id === null) return null;
  const tableName = type === "product_page" ? "links" : type === "post_page" ? "installments" : null;
  if (tableName === null) return null;
  const owner = tableName === "links" ? "user_id" : "seller_id";
  const [row] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${column(tableName, "id")} FROM ${table(tableName)} WHERE ${column(tableName, owner)} = ${seller.id} AND ${column(tableName, "id")} = ${id} LIMIT 1`);
  return row?.id ?? null;
}

export async function create(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_products"]);
  if (halted(auth)) return auth.halt;
  const params = permittedParams(call);
  const link = UtmLinks.build({
    seller_id: auth.owner.id,
    title: castString(params.title) as never,
    target_resource_type: castString(params.target_resource_type) as never,
    target_resource_id: (await resolvedTargetResourceId(auth.owner, params.target_resource_type, params.target_resource_id)) as never,
    utm_source: castString(params.utm_source) as never,
    utm_medium: castString(params.utm_medium) as never,
    utm_campaign: castString(params.utm_campaign) as never,
    utm_term: (castString(params.utm_term) ?? null) as never,
    utm_content: (castString(params.utm_content) ?? null) as never,
    ip_address: remoteIp(call.request),
    browser_guid: call.request.cookies.get(GUID_COOKIE) ?? randomUUID(),
  } as never);
  try {
    await UtmLinks.saveBang(link);
  } catch (error) {
    if (error instanceof RecordInvalid) return errorWithCreatingObject("utm_link", link.errors.fullMessages());
    throw error;
  }
  return guarded(async () => successWithObject("utm_link", await renderOne(auth.owner, link.get("id") as bigint)));
}

export async function update(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_products"]);
  if (halted(auth)) return auth.halt;
  const row = await fetchUtmLink(call, auth.owner);
  if (row === null) return notFound();
  const params = permittedParams(call);
  const link = UtmLinks.load(castRow("UtmLink", row) as never);
  const attributes: Record<string, unknown> = {};
  for (const key of ["title", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) if (key in params) attributes[key] = castString(params[key]);
  link.assign(attributes as never);
  try {
    await UtmLinks.saveBang(link);
  } catch (error) {
    if (error instanceof RecordInvalid) return errorWithObject("utm_link", link.errors.fullMessages());
    throw error;
  }
  return guarded(async () => successWithObject("utm_link", await renderOne(auth.owner, row.id as bigint)));
}
