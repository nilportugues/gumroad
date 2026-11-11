// Api::V2::EmailsController: the seller's posts as emails (list, read, create, send, schedule, unschedule, delete).
import { Prisma, type Installment, type InstallmentRule, type Link, type User } from "@prisma/client";

import { decrypt, decryptNumeric, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { setJsonDataForAttr } from "../../models/concerns/json-data.ts";
import { InstallmentFlags } from "../../models/installment-post.ts";
import { InstallmentRules, markDeletedBang as markRuleDeletedBang } from "../../models/installment-rule-writes.ts";
import { Installments, markDeleted } from "../../models/installment-writes.ts";
import { hasBeenBlasted } from "../../models/post-email-blast.ts";
import { saveInstallment } from "../../models/save-installment.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../../models/user.ts";
import { filterValue, parseJsonData } from "../../models/with-filtering.ts";
import {
  userSubdomainWithProtocol,
  userUsername,
  domainWithProtocol,
  externalId,
} from "../../page-props/audience/support.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { assertFlatQuery } from "../rails-params.ts";

import {
  authorize,
  error400,
  errorWithCreatingObject,
  errorWithObject,
  halted,
  renderResponse,
  successWithObject,
  timeJson,
  type ApiCall,
} from "./ws17c-base.ts";

const RESULTS_PER_PAGE = 10;
const AUDIENCE_TYPES_BY_PARAM: Record<string, string> = {
  all: "audience",
  audience: "audience",
  customers: "seller",
  seller: "seller",
  followers: "follower",
  follower: "follower",
  product: "product",
};
const TYPES = ["published", "scheduled", "draft"] as const;
const FLAG_READY_TO_PUBLISH = 2 ** 9;

// Installment.ordered_updates(seller, nil).reorder(nil): the seller's posts and those of their products, alive, outside workflows.
const owned = (seller: User) =>
  Prisma.sql`((SELECT * FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${seller.id}) UNION (SELECT * FROM ${table("installments")} WHERE ${column("installments", "link_id")} IN (SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL))) ${table("installments")}`;
const scope = Prisma.sql`${column("installments", "deleted_at")} IS NULL AND ${column("installments", "workflow_id")} IS NULL`;

function typeCondition(type: string | null): Prisma.Sql {
  const published = column("installments", "published_at");
  const flags = column("installments", "flags");
  if (type === "published") return Prisma.sql`${published} IS NOT NULL`;
  if (type === "scheduled") return Prisma.sql`${published} IS NULL AND ${flags} & ${FLAG_READY_TO_PUBLISH} > 0`;
  if (type === "draft") return Prisma.sql`${published} IS NULL AND ${flags} & ${FLAG_READY_TO_PUBLISH} = 0`;
  return Prisma.sql`1 = 1`;
}

const displayType = (installment: Installment) =>
  installment.published_at !== null
    ? "published"
    : InstallmentFlags.isSet(installment.flags, "ready_to_publish")
      ? "scheduled"
      : "draft";

// Installment#user: `seller.presence || link.user`
async function userOf(installment: Installment, link: Link | null): Promise<User> {
  const id = installment.seller_id ?? link?.user_id;
  const [user] = await selectRows<User>(
    Prisma.sql`SELECT * FROM ${table("users")} WHERE ${column("users", "id")} = ${id ?? 0} LIMIT 1`,
  );
  if (!user) throw new NotPortedError("Installment#user for a post without an owner", "installment.rb");
  return user;
}

// Installment#public_page_location
async function publicPageLocation(installment: Installment, link: Link | null): Promise<string | null> {
  if (installment.slug === null || installment.slug === "") return null;
  const user = await userOf(installment, link);
  const host = userSubdomainWithProtocol(user);
  if (host) return `${host}/p/${encodeURIComponent(installment.slug)}`;
  return `${domainWithProtocol()}/${userUsername(user) ?? user.external_id}/p/${encodeURIComponent(installment.slug)}`;
}

// Installment#as_json_for_api
async function emailJson(installment: Installment): Promise<Record<string, unknown>> {
  const [link] =
    installment.link_id === null
      ? []
      : await selectRows<Link>(
          Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} = ${installment.link_id} LIMIT 1`,
        );
  const [rule] = await selectRows<InstallmentRule>(
    Prisma.sql`SELECT * FROM ${table("installment_rules")} WHERE ${column("installment_rules", "installment_id")} = ${installment.id} LIMIT 1`,
  );
  const state = displayType(installment);
  const published = installment.published_at !== null;
  return {
    id: externalId(installment.id),
    subject: installment.name,
    message: installment.message,
    audience_type: installment.installment_type,
    product_id: link ? externalId(link.id) : null,
    state,
    published_at: timeJson(installment.published_at),
    scheduled_at: state === "scheduled" && rule && rule.deleted_at === null ? timeJson(rule.to_be_published_at) : null,
    send_emails: InstallmentFlags.isSet(installment.flags, "send_emails"),
    shown_on_profile: InstallmentFlags.isSet(installment.flags, "shown_on_profile"),
    audience_count: null,
    recipients_count: published ? installment.customer_count : null,
    url: published ? await publicPageLocation(installment, link ?? null) : null,
    created_at: timeJson(installment.created_at),
    updated_at: timeJson(installment.updated_at),
  };
}

// An Addressable-style query: the pairs sorted by key, keys and values percent-encoded except the unreserved characters.
const UNRESERVED = /[A-Za-z0-9\-._~]/u;
const encodeComponent = (value: string) =>
  [...Buffer.from(value, "utf8")]
    .map((byte) =>
      UNRESERVED.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");

// Api::V2::BaseController#next_page_url
function nextPageUrl(call: ApiCall, pageKey: string): string {
  assertFlatQuery(call.request.queryString);
  const pairs = new Map<string, string>();
  for (const pair of call.request.queryString.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    if (index === -1) throw new HandBackToRails("a query parameter without a value");
    pairs.set(
      decodeURIComponent(pair.slice(0, index).replaceAll("+", " ")),
      decodeURIComponent(pair.slice(index + 1).replaceAll("+", " ")),
    );
  }
  for (const key of ["access_token", "page", "page_key"]) pairs.delete(key);
  pairs.set("page_key", pageKey);
  const query = [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`)
    .join("&");
  return `${call.request.path}?${query}`;
}

// Api::V2::BaseController#encode_page_key: created_at in %Y%m%d%H%M%S%6N, then the obfuscated id.
function encodePageKey(installment: Installment): string {
  const stamp = installment.created_at
    .toISOString()
    .replace(/[-:T]/gu, "")
    .replace(/\.(\d{3})Z$/u, "$1000");
  return `${stamp}-${encryptNumeric(installment.id)}`;
}

// #decode_page_key: nil for a key Rails would raise ArgumentError on.
function decodePageKey(key: string): { createdAt: Date; id: number } | null {
  const [dateString, obfuscated, ...rest] = key.split("-");
  const id = Number.parseInt(obfuscated ?? "", 10);
  if (rest.length > 0 && !Number.isNaN(id)) throw new HandBackToRails("a page key with extra parts");
  if (!Number.isInteger(id) || id === 0) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{6})$/u.exec(dateString ?? "");
  if (!match) throw new HandBackToRails("a page key whose time Time.zone.parse reads");
  const [, year, month, day, hour, minute, second, micro] = match;
  return {
    createdAt: new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(micro) / 1000,
      ),
    ),
    id: decryptNumeric(id),
  };
}

export async function index(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const type =
    typeof call.params.type === "string" && call.params.type !== ""
      ? call.params.type
      : call.params.type === undefined || call.params.type === ""
        ? null
        : "invalid";
  if (type !== null && !(TYPES as readonly string[]).includes(type))
    return error400(`Invalid type. Valid values are: ${TYPES.join(", ")}.`);
  if (call.params.type !== undefined && typeof call.params.type !== "string")
    throw new HandBackToRails("a type parameter that is not a string");
  let pagination = Prisma.sql`1 = 1`;
  const pageKey = call.params.page_key;
  if (pageKey !== undefined && pageKey !== null && pageKey !== "") {
    if (typeof pageKey !== "string") throw new HandBackToRails("a page_key that is not a string");
    const decoded = decodePageKey(pageKey);
    if (decoded === null) return error400("Invalid page_key.");
    pagination = Prisma.sql`(${column("installments", "created_at")} < ${decoded.createdAt}) OR (${column("installments", "created_at")} = ${decoded.createdAt} AND ${column("installments", "id")} < ${decoded.id})`;
  }
  const rows = await selectRows<Installment>(
    Prisma.sql`SELECT ${table("installments")}.* FROM ${owned(auth.owner)} WHERE ${scope} AND ${typeCondition(type)} AND (${pagination}) ORDER BY ${column("installments", "created_at")} DESC, ${column("installments", "id")} DESC LIMIT ${RESULTS_PER_PAGE + 1}`,
  );
  const page = rows.slice(0, RESULTS_PER_PAGE);
  const next =
    rows.length > RESULTS_PER_PAGE
      ? { next_page_key: encodePageKey(page.at(-1)!), next_page_url: nextPageUrl(call, encodePageKey(page.at(-1)!)) }
      : {};
  const emails: Record<string, unknown>[] = [];
  for (const installment of page) emails.push(await emailJson(installment));
  return successWithObject("emails", emails, next);
}

// #fetch_installment: `scoped_installments.find_by_external_id(params[:id])`, rendered as a missing email.
async function fetchInstallment(call: ApiCall, seller: User): Promise<Installment | null> {
  const id = decrypt(call.routeParams.id!);
  if (id === null) return null;
  const [row] = await selectRows<Installment>(
    Prisma.sql`SELECT ${table("installments")}.* FROM ${owned(seller)} WHERE ${scope} AND ${column("installments", "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

const emailNotFound = (): ActionResult => ({ ...errorWithObject("email", null, false), rescued: true });

export async function show(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const installment = await fetchInstallment(call, auth.owner);
  if (installment === null) return emailNotFound();
  return successWithObject("email", await emailJson(installment));
}

export async function destroy(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const row = await fetchInstallment(call, auth.owner);
  if (row === null) return emailNotFound();
  const record = Installments.load(castRow<Installment>("Installment", row as never));
  if (await markDeleted(record)) return successWithObject("email", null);
  return errorWithObject("email", record.errors.fullMessages());
}

export async function unschedule(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const row = await fetchInstallment(call, auth.owner);
  if (row === null) return emailNotFound();
  const record = Installments.load(castRow<Installment>("Installment", row as never));
  let refusal: string | null = null;
  await Installments.withLock(record, async () => {
    if (!InstallmentFlags.isSet(record.get("flags"), "ready_to_publish")) {
      refusal = "This email is not scheduled.";
      return;
    }
    if ((await hasBeenBlasted(record.get("id"))) || record.get("published_at") !== null) {
      refusal = "The email has already been sent.";
      return;
    }
    record.set("flags", Number(InstallmentFlags.set(record.get("flags"), "ready_to_publish", false)));
    const [rule] = await selectRows<InstallmentRule>(
      Prisma.sql`SELECT * FROM ${table("installment_rules")} WHERE ${column("installment_rules", "installment_id")} = ${record.get("id")} LIMIT 1`,
    );
    if (rule && rule.deleted_at === null) await markRuleDeletedBang(InstallmentRules.load(rule));
    // Skip content and audience validations: cancelling a schedule is not a send.
    await Installments.saveBang(record, { validate: false });
  });
  if (refusal !== null) return renderResponse(false, { message: refusal });
  return successWithObject(
    "email",
    await emailJson(
      (
        await selectRows<Installment>(
          Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "id")} = ${record.get("id")} LIMIT 1`,
        )
      )[0]!,
    ),
  );
}

const boolean = (value: unknown): boolean | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  return !(typeof value === "string" && ["0", "f", "F", "false", "FALSE", "off", "OFF"].includes(value)) && value !== 0;
};

// #installment_type_from_audience_param, #product_link_id_for
async function createParams(
  call: ApiCall,
  seller: User,
): Promise<{ params: Record<string, unknown> } | { error: ActionResult }> {
  const audienceParam = call.params.audience;
  const audience =
    typeof audienceParam === "string" && audienceParam !== ""
      ? audienceParam
      : audienceParam === undefined || audienceParam === null || audienceParam === ""
        ? "audience"
        : String(audienceParam);
  const installmentType = AUDIENCE_TYPES_BY_PARAM[audience.toLowerCase()];
  const creationError = (message: string) => ({ error: errorWithCreatingObject("email", [message]) });
  if (installmentType === undefined)
    return creationError(`Invalid audience. Valid values are: ${Object.keys(AUDIENCE_TYPES_BY_PARAM).join(", ")}.`);
  let productLinkId: string | null = null;
  if (installmentType === "product") {
    const identifier = [call.params.product_id, call.params.link_id].find(
      (value) => typeof value === "string" && value !== "",
    );
    if (identifier === undefined) return creationError("Product audience requires a product_id or link_id.");
    const id = decrypt(identifier as string);
    const [product] = await selectRows<Link>(
      Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND (${id === null ? Prisma.sql`1 = 0` : Prisma.sql`${column("links", "id")} = ${id}`} OR ${column("links", "unique_permalink")} = ${identifier as string}) ORDER BY (${id === null ? Prisma.sql`0` : Prisma.sql`${column("links", "id")} = ${id}`}) DESC LIMIT 1`,
    );
    if (!product) return creationError("Product not found.");
    productLinkId = product.unique_permalink;
  }
  const publishRequested = boolean(call.params.publish) === true || boolean(call.params.draft) === false;
  return {
    params: {
      installment: {
        name: call.params.subject,
        message: call.params.body,
        installment_type: installmentType,
        link_id: productLinkId,
        bought_products: installmentType === "product" ? [productLinkId] : [],
        send_emails: true,
        shown_on_profile: false,
        shown_in_profile_sections: [],
      },
      ...(publishRequested ? { publish: "true" } : {}),
    },
  };
}

export async function create(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const built = await createParams(call, auth.owner);
  if ("error" in built) return built.error;
  // friendly_id gives a post with no name a random UUID slug, which the model port does not write.
  if (typeof call.params.subject !== "string" || call.params.subject.trim() === "")
    throw new HandBackToRails("an email without a subject");
  // The preview email recipient is the seller: a send_preview_email is refused by the port, which hands the request back.
  const result = await saveInstallment({ seller: auth.owner, params: built.params, installment: null });
  if (result.ok && result.installment !== null)
    return successWithObject("email", await emailJson(await reload(result.installment.get("id"))));
  return renderResponse(false, { message: result.error });
}

const reload = async (id: number): Promise<Installment> =>
  (
    await selectRows<Installment>(
      Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "id")} = ${id} LIMIT 1`,
    )
  )[0]!;

// #installment_service_attributes: the stored post as the service's own params.
async function serviceAttributes(installment: Installment, seller: User): Promise<Record<string, unknown>> {
  const json = parseJsonData(installment.json_data);
  const value = (key: string) => filterValue({ jsonData: () => json }, key);
  const files = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("product_files")} WHERE ${column("product_files", "installment_id")} = ${installment.id} AND ${column("product_files", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (files.length > 0) throw new HandBackToRails("an email with files");
  if (installment.installment_type === "variant") throw new HandBackToRails("a variant email");
  const [link] =
    installment.link_id === null
      ? []
      : await selectRows<Link>(
          Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} = ${installment.link_id} LIMIT 1`,
        );
  const sections = await selectRows<{ id: number; json_data: unknown }>(
    Prisma.sql`SELECT * FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "seller_id")} = ${seller.id} AND ${column("seller_profile_sections", "type")} = 'SellerProfilePostsSection' ORDER BY ${column("seller_profile_sections", "id")} ASC`,
  );
  const shown = sections.filter((section) => {
    const data =
      typeof section.json_data === "string"
        ? (JSON.parse(section.json_data) as { shown_posts?: number[] })
        : (section.json_data as { shown_posts?: number[] } | null);
    return (data?.shown_posts ?? []).map(Number).includes(installment.id);
  });
  const productType = installment.installment_type === "product";
  const hasPurchaseFilter = value("bought_products") !== null || value("bought_variants") !== null;
  const bought =
    hasPurchaseFilter || !productType ? (value("bought_products") ?? []) : [link?.unique_permalink].filter(Boolean);
  return {
    name: installment.name,
    message: installment.message,
    installment_type: installment.installment_type,
    link_id: link?.unique_permalink ?? null,
    paid_more_than_cents: value("paid_more_than_cents"),
    paid_less_than_cents: value("paid_less_than_cents"),
    created_after: value("created_after"),
    created_before: value("created_before"),
    bought_from: value("bought_from"),
    active_customers_only: value("active_customers_only"),
    minimum_license_uses: value("minimum_license_uses"),
    shown_on_profile: InstallmentFlags.isSet(installment.flags, "shown_on_profile"),
    send_emails: true,
    allow_comments: InstallmentFlags.isSet(installment.flags, "allow_comments"),
    bought_products: bought,
    bought_variants: value("bought_variants") ?? [],
    affiliate_products: value("affiliate_products"),
    not_bought_products: value("not_bought_products"),
    not_bought_variants: value("not_bought_variants"),
    waitlisted_products: value("waitlisted_products"),
    shown_in_profile_sections: shown.map((section) => externalId(section.id)),
    files: [],
  };
}

// #ensure_installment_seller: a post owned through its product has no seller_id, which Rails fills in with an update_column.
function assertHasSeller(installment: Installment) {
  if (installment.seller_id === null) throw new HandBackToRails("an email without a seller_id");
}

export async function sendEmail(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const installment = await fetchInstallment(call, auth.owner);
  if (installment === null) return emailNotFound();
  if (await hasBeenBlasted(installment.id))
    return renderResponse(false, { message: "The email has already been sent." });
  if (installment.published_at === null && InstallmentFlags.isSet(installment.flags, "ready_to_publish"))
    return renderResponse(false, { message: "The email is scheduled to be sent at its scheduled time." });
  assertHasSeller(installment);
  const record = Installments.load(castRow<Installment>("Installment", installment as never));
  const attributes = await serviceAttributes(installment, auth.owner);
  // #ensure_implicit_purchase_filters writes the two filters into json_data ahead of the service, which fixes their place in the column.
  setJsonDataForAttr(record, "bought_products", attributes.bought_products as never);
  setJsonDataForAttr(record, "bought_variants", attributes.bought_variants as never);
  const params = { installment: attributes, publish: "true" };
  const result = await saveInstallment({ seller: auth.owner, params, installment: record });
  if (result.ok && result.installment !== null)
    return successWithObject("email", await emailJson(await reload(result.installment.get("id"))));
  return renderResponse(false, { message: result.error });
}

export async function schedule(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const installment = await fetchInstallment(call, auth.owner);
  if (installment === null) return emailNotFound();
  if ((await hasBeenBlasted(installment.id)) || installment.published_at !== null)
    return renderResponse(false, { message: "The email has already been sent." });
  const at = call.params.to_be_published_at;
  if (at === undefined || at === null || (typeof at === "string" && at.trim() === ""))
    return renderResponse(false, { message: "The to_be_published_at parameter is required." });
  assertHasSeller(installment);
  const record = Installments.load(castRow<Installment>("Installment", installment as never));
  const attributes = await serviceAttributes(installment, auth.owner);
  // A post saved without these filters gets them in the order Rails' filter validation writes them.
  for (const key of [
    "paid_more_than_cents",
    "paid_less_than_cents",
    "created_after",
    "created_before",
    "bought_from",
    "active_customers_only",
    "minimum_license_uses",
    "bought_products",
    "not_bought_products",
    "bought_variants",
    "not_bought_variants",
  ])
    setJsonDataForAttr(record, key, attributes[key] as never);
  const params = { installment: attributes, to_be_published_at: at };
  const result = await saveInstallment({ seller: auth.owner, params, installment: record });
  if (result.ok && result.installment !== null)
    return successWithObject("email", await emailJson(await reload(result.installment.get("id"))));
  return renderResponse(false, { message: result.error });
}

export async function preview(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const installment = await fetchInstallment(call, auth.owner);
  if (installment === null) return emailNotFound();
  // Installment#send_preview_email renders and delivers the mail to the seller.
  throw new HandBackToRails("an email preview");
}
