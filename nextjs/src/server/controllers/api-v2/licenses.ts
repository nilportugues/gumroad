// Api::V2::LicensesController (app/controllers/api/v2/licenses_controller.rb): #verify (anonymous, the product's license check) and the
// edit_products writes #enable, #disable, #decrement_uses_count and #rotate. The purchase in the response is
// models/license-purchase-json.ts; a purchase it cannot serialize hands the request to Rails before the first write.
import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { doorkeeperToken } from "../../auth/api-token.ts";
import { getNamespacedRedis, getRedis } from "../../infra/redis.ts";
import { performAsync } from "../../models/concerns/job-runtime.ts";
import { timeAgoInWords } from "../../models/concerns/time-ago-in-words.ts";
import { findPurchaseRow, licensePurchaseJson } from "../../models/license-purchase-json.ts";
import { disableBang, disabled, enableBang, findLicense, Licenses, type LicenseRecord } from "../../models/license.ts";
import { timeJson } from "../../models/purchase-json.ts";
import { column, execute, selectRows, table } from "../../models/sql.ts";
import { findLink, type LinkRow } from "../../presenters/product-reads.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { HandBackToRails } from "../application-controller.ts";

import { fromExternalId, json, registerApiV2, type ApiV2Input } from "./base.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const SEARCH_INDEX_DELAY_SECONDS = 2;
const CLEANED_KEYS = ["license_key", "product_id", "product_permalink", "id", "link_id"] as const;
const NOT_FOUND_MESSAGE = "That license does not exist for the provided product.";
const SKIP_PRODUCT_ID_CHECK_NAMESPACE = "license_verifications";
const FORCE_PRODUCT_ID_TIMESTAMP_KEY = "force_product_id_timestamp";

const failure = (message: string, status: number) => json({ success: false, message }, status);

// `String#to_datetime` for the spellings Time#to_s and ISO 8601 produce; anything else would raise in Ruby, which Rails answers.
function parseDateTime(value: string): number | null {
  if (!present(value)) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/u.exec(value.trim());
  if (match === null) throw new HandBackToRails("a force_product_id_timestamp Node does not parse");
  const zone = match[4];
  const offset = zone === undefined || zone === "UTC" || zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const time = Date.parse(`${match[1]}T${match[2]}${match[3] ?? ""}${offset}`);
  if (Number.isNaN(time)) throw new HandBackToRails("a force_product_id_timestamp Node does not parse");
  return time;
}

// An unreadable skip flag leaves the product_id requirement in place, like the rescue in Rails.
async function skipProductIdCheck(productId: unknown): Promise<boolean> {
  try {
    return present(await getNamespacedRedis(SKIP_PRODUCT_ID_CHECK_NAMESPACE).get(`skip_product_id_check_${productId}`));
  } catch {
    return false;
  }
}

// Rails falls back to the cutoff the process last read when Redis stalls, which another process cannot reproduce.
async function forceProductIdTimestamp(): Promise<number | null> {
  try {
    const value = await getRedis("main").get(FORCE_PRODUCT_ID_TIMESTAMP_KEY);
    return value === null ? null : parseDateTime(value);
  } catch (error) {
    if (error instanceof HandBackToRails) throw error;
    throw new HandBackToRails("the force_product_id_timestamp could not be read");
  }
}

// `before_action :clean_params, only: [:verify]`
function cleanParams(input: ApiV2Input): ReturnType<typeof failure> | undefined {
  const { params } = input;
  for (const key of CLEANED_KEYS) {
    const value = params[key];
    if (value === undefined || value === null || typeof value === "string") continue;
    // `blank?` lets an empty list or hash through, which the lookup below would read differently.
    if (typeof value === "object" && Object.keys(value).length === 0) continue;
    return json({ success: false, message: `The '${key}' parameter must be a string.` }, 400);
  }
  // `id` and `link_id` are legacy ways to pass the permalink; the order matters.
  const permalink = [params.id, params.link_id, params.product_permalink].find(present);
  params.product_permalink = permalink ?? null;
  params.increment_uses_count = !["false", false].includes(params.increment_uses_count as string | boolean);
  return undefined;
}

// The params the lookup reads as strings; anything else is a case Rails answers.
function stringParam(input: ApiV2Input, key: string): string | null {
  const value = input.params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HandBackToRails(`a non-text ${key} parameter`);
  return value;
}

const matchesPermalink = (product: LinkRow, permalink: string | null): boolean => {
  if (!present(permalink)) return false;
  const wanted = permalink.toLowerCase();
  return (
    wanted === String(product.unique_permalink).toLowerCase() || wanted === product.custom_permalink?.toLowerCase()
  );
};

// The licenses row for `serial`, within the product when there is one: `find_by(serial:)` compares under the column's collation.
async function findBySerial(serial: string | null, productId?: bigint): Promise<LicenseRecord | null> {
  const [row] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("licenses", "id")} FROM ${table("licenses")} WHERE ${serial === null ? Prisma.sql`${column("licenses", "serial")} IS NULL` : Prisma.sql`${column("licenses", "serial")} = ${serial}`}${productId === undefined ? Prisma.empty : Prisma.sql` AND ${column("licenses", "link_id")} = ${productId}`} LIMIT 1`,
  );
  return row === undefined ? null : findLicense(row.id);
}

// `before_action :fetch_valid_license`
async function fetchValidLicense(input: ApiV2Input) {
  const licenseKey = stringParam(input, "license_key");
  const productId = stringParam(input, "product_id");
  const productPermalink = stringParam(input, "product_permalink");

  let license: LicenseRecord | null = null;
  let product: LinkRow | null = null;
  if (present(productId)) {
    const id = fromExternalId(productId);
    product = id === null ? null : await findLink(id);
    if (product !== null) license = await findBySerial(licenseKey, product.id);
  } else {
    license = await findBySerial(licenseKey);
    const linkId = license?.get("link_id");
    product = linkId == null ? null : await findLink(linkId);
  }

  if (!present(productId) && product !== null && !(await skipProductIdCheck(product.id))) {
    const cutoff = await forceProductIdTimestamp();
    if (cutoff !== null) {
      if (!(product.created_at instanceof Date)) throw new HandBackToRails("a product without created_at");
      if (product.created_at.getTime() > cutoff) {
        // @license.link.external_id
        const message = `The 'product_id' parameter is required to verify the license for this product. Please set 'product_id' to '${encrypt(product.id)}' in the request.`;
        return failure(message, 500);
      }
    }
  }

  if (license === null) return failure(NOT_FOUND_MESSAGE, 404);
  // `product.matches_permalink?` on a license with no product raises
  if (!present(productId) && product === null) throw new HandBackToRails("a license without a product");
  if (!present(productId) && !matchesPermalink(product!, productPermalink)) return failure(NOT_FOUND_MESSAGE, 404);

  const purchaseId = license.get("purchase_id");
  const purchase = purchaseId == null ? null : await findPurchaseRow(purchaseId);
  if (purchase !== null && PurchaseFlags.isSet(purchase.flags, "is_access_revoked")) {
    return failure("Access to the purchase associated with this license has expired.", 404);
  }
  input.state.license = license;
  input.state.purchase = purchase;
  return undefined;
}

const verifyBefore = async (input: ApiV2Input) => cleanParams(input) ?? fetchValidLicense(input);

// `before_action :validate_license_user`
async function writeBefore(input: ApiV2Input) {
  const halted = await fetchValidLicense(input);
  if (halted) return halted;
  const license = input.state.license as LicenseRecord;
  const linkId = license.get("link_id");
  const link = linkId == null ? null : await findLink(linkId);
  if (link === null) throw new HandBackToRails("a license without a product");
  if (link.user_id === null || String(link.user_id) !== String(input.owner.id))
    return json({ success: false, error: "Not found" }, 404);
  return undefined;
}

async function importedCustomerJson(id: unknown): Promise<Record<string, unknown> | null> {
  const [customer] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`imported_customers`.*")} FROM ${table("imported_customers")} WHERE ${column("imported_customers", "id")} = ${id} LIMIT 1`,
  );
  if (customer === undefined) return null;
  if (customer.purchase_date == null) throw new HandBackToRails("an imported customer with no purchase date");
  const link = customer.link_id == null ? null : await findLink(customer.link_id);
  // ImportedCustomer#as_json(without_license_key: true)
  return {
    email: customer.email,
    created_at: timeJson(customer.created_at),
    timestamp: `${timeAgoInWords(customer.purchase_date)} ago`,
    link_name: link?.name ?? null,
    product_name: link?.name ?? null,
    price: null,
    is_imported_customer: true,
    purchase_email: customer.email,
    id: encrypt(customer.id),
    can_update: null,
  };
}

// `success_with_license`
async function successWithLicense(license: LicenseRecord) {
  const body: Record<string, unknown> = { success: true, uses: license.get("uses") };
  const purchaseId = license.get("purchase_id");
  const purchase = purchaseId == null ? null : await findPurchaseRow(purchaseId);
  if (purchase !== null) {
    body.purchase = await licensePurchaseJson(purchase, license.attributes as Row);
  } else {
    const importedId = license.get("imported_customer_id");
    const customer = importedId == null ? null : await importedCustomerJson(importedId);
    if (customer !== null) body.imported_customer = customer;
  }
  return json(body);
}

// The response is serialized once before the write, so a purchase Node cannot serialize hands the request back with nothing changed.
async function rehearse(license: LicenseRecord): Promise<void> {
  await successWithLicense(license);
}

// License#increment!(:uses): the counter update skips callbacks, so the purchase's search document is queued by hand.
async function incrementUses(license: LicenseRecord, by: 1 | -1): Promise<void> {
  await execute(
    Prisma.sql`UPDATE ${table("licenses")} SET ${column("licenses", "uses")} = COALESCE(${column("licenses", "uses")}, 0) + ${by} WHERE ${column("licenses", "id")} = ${license.get("id")}`,
  );
  license.set("uses", (license.get("uses") ?? 0) + by);
  license.clearAttributeChanges(["uses"]);
  const purchaseId = license.get("purchase_id");
  if (purchaseId != null) {
    await performAsync(
      "ElasticsearchIndexerWorker",
      ["update", { record_id: Number(purchaseId), class_name: "Purchase", fields: ["license_uses"] }],
      { delaySeconds: SEARCH_INDEX_DELAY_SECONDS },
    );
  }
}

// SecureRandom.uuid.upcase.delete("-").scan(/.{8}/).join("-")
const generateSerial = () => randomUUID().toUpperCase().replaceAll("-", "").match(/.{8}/gu)!.join("-");

registerApiV2(
  {
    method: "POST",
    pattern: "/v2/licenses/verify",
    scopes: [],
    anonymous: true,
    // skip_before_action :verify_authenticity_token
    keepSession: true,
    // verify never authorizes the token, but the after_action `log_method_use` reads its owner: a token with none (or whose user is gone)
    // raises RecordNotFound, and the CLI's user agent marks the owner as a CLI user. Any other token, valid or not, changes nothing.
    async preAuth({ request, params }) {
      let token;
      try {
        token = await doorkeeperToken({
          authorization: request.headers.get("authorization"),
          parameters: params,
          path: request.path,
        });
      } catch {
        throw new HandBackToRails("a token parameter that is not text");
      }
      if (token === null) return;
      const owner =
        token.resource_owner_id == null
          ? null
          : await db.user.findUnique({ where: { id: BigInt(token.resource_owner_id) }, select: { id: true } });
      if (owner === null) throw new HandBackToRails("a token on a license verification that has no owner");
      if (/^gumroad-cli\//iu.test(request.headers.get("user-agent") ?? ""))
        throw new HandBackToRails("a CLI license verification that carries a token");
    },
    before: verifyBefore,
    async run(input) {
      const license = input.state.license as LicenseRecord;
      if (disabled(license)) return failure("This license key has been disabled.", 404);
      if (input.params.increment_uses_count) {
        await rehearse(license);
        await incrementUses(license, 1);
      }
      return successWithLicense(license);
    },
  },
  {
    method: "PUT",
    pattern: "/v2/licenses/enable",
    scopes: ["edit_products"],
    before: writeBefore,
    async run(input) {
      const license = input.state.license as LicenseRecord;
      await rehearse(license);
      await enableBang(license);
      return successWithLicense(license);
    },
  },
  {
    method: "PUT",
    pattern: "/v2/licenses/disable",
    scopes: ["edit_products"],
    before: writeBefore,
    async run(input) {
      const license = input.state.license as LicenseRecord;
      await rehearse(license);
      await disableBang(license);
      return successWithLicense(license);
    },
  },
  {
    method: "PUT",
    pattern: "/v2/licenses/decrement_uses_count",
    scopes: ["edit_products"],
    before: writeBefore,
    async run(input) {
      const license = input.state.license as LicenseRecord;
      await rehearse(license);
      await Licenses.withLock(license, async () => {
        if ((license.get("uses") ?? 0) > 0) await incrementUses(license, -1);
      });
      return successWithLicense(license);
    },
  },
  {
    method: "PUT",
    pattern: "/v2/licenses/rotate",
    scopes: ["edit_products"],
    before: writeBefore,
    async run(input) {
      const license = input.state.license as LicenseRecord;
      await rehearse(license);
      license.set("serial", generateSerial());
      await Licenses.saveBang(license);
      return successWithLicense(license);
    },
  },
);
