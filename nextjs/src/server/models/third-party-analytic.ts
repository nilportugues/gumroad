// Port of app/models/third_party_analytic.rb and ThirdPartyAnalytic.save_third_party_analytics, which the third-party analytics
// settings page calls.
import { Prisma, type ThirdPartyAnalytic } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";

import { deletable } from "./concerns/deletable.ts";
import { validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { RubyFloat, rubyFloatToS } from "./concerns/ruby-values.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { clearProductsCache } from "./user.ts";

export const FOR_ALL_PRODUCTS = "#all_products";

export const DUPLICATE_BLOCK_MESSAGE =
  "Only one analytics block is allowed per product. Please consolidate your tracking segments by pasting them into in a single block.";

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };

export class ThirdPartyAnalyticInvalid extends Error {}

export const ThirdPartyAnalytics = defineModel<ThirdPartyAnalytic>({
  rubyClass: "ThirdPartyAnalytic",
  prismaModel: "ThirdPartyAnalytic",
  delegate: (tx) => tx.thirdPartyAnalytic as never,
  validations: [validatesAssociationPresence<ThirdPartyAnalytic>(USER)],
  afterCommit: [
    {
      name: "clear_related_products_cache",
      // `user.clear_products_cache`; validates_presence_of :user guarantees the user exists.
      run: (record) => clearProductsCache(record.get("user_id")),
    },
  ],
});

const analyticDeletable = deletable(ThirdPartyAnalytics);
type AnalyticRecord = ModelRecord<ThirdPartyAnalytic>;

export type SnippetParams = { id?: unknown; code?: unknown; location?: unknown; name?: unknown; product?: unknown };

const present = (value: unknown) => !isBlank(value);
// A param cast for a string attribute (a Float by its `Float#to_s`). The MySQL adapter casts true/false to "1"/"0" for
// a varchar column and to "t"/"f" for a text one (`analytics_code`).
export function nullable(value: unknown, column: "varchar" | "text" = "varchar"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return column === "text" ? (value ? "t" : "f") : value ? "1" : "0";
  return value instanceof RubyFloat ? rubyFloatToS(value.value) : String(value);
}

// A Ruby Hash key: a Float is eql? only to an equal Float, never to its text or an Integer.
const hashKey = (value: unknown): unknown => (value instanceof RubyFloat ? Symbol.for(`float:${value.value}`) : value);

// ThirdPartyAnalytic.product_from_permalink: `Link.find_by(unique_permalink:)`, whoever owns it and deleted or not.
async function productIdFromPermalink(permalink: unknown): Promise<number | null> {
  if (permalink === FOR_ALL_PRODUCTS) return null;
  const condition =
    permalink === undefined || permalink === null ? Prisma.raw("IS NULL") : Prisma.sql`= ${nullable(permalink)}`;
  const [row] = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} ${condition} LIMIT 1`,
  );
  return row ? Number(row.id) : null;
}

const aliveOf = (sellerId: unknown) =>
  Prisma.sql`SELECT ${Prisma.raw("`third_party_analytics`.*")} FROM ${table("third_party_analytics")} WHERE ${column("third_party_analytics", "user_id")} = ${sellerId} AND ${column("third_party_analytics", "deleted_at")} IS NULL`;
const load = (row: unknown) =>
  ThirdPartyAnalytics.load(castRow<ThirdPartyAnalytic>("ThirdPartyAnalytic", row as never));

// ThirdPartyAnalytic.save_third_party_analytics
export async function saveThirdPartyAnalytics(
  analyticsParams: SnippetParams[],
  sellerId: bigint | number,
): Promise<void> {
  const existing = (await selectRows(aliveOf(sellerId))).map(load);
  const keep: AnalyticRecord[] = [];

  if (analyticsParams.length === 0) {
    for (const analytic of existing) await analyticDeletable.markDeleted(analytic);
    return;
  }

  const taken = new Map<unknown, Set<number | null>>();
  for (const params of analyticsParams) {
    const productId = await productIdFromPermalink(params.product);
    const location = hashKey(params.location ?? null);
    const products = taken.get(location) ?? new Set<number | null>();
    if (products.has(productId)) throw new ThirdPartyAnalyticInvalid(DUPLICATE_BLOCK_MESSAGE);
    products.add(productId);
    taken.set(location, products);
  }

  for (const params of analyticsParams) {
    const productId = await productIdFromPermalink(params.product);
    let analytic: AnalyticRecord;
    if (present(params.id)) {
      const id = decrypt(String(params.id));
      const [row] =
        id === null
          ? []
          : await selectRows(
              Prisma.sql`${aliveOf(sellerId)} AND ${column("third_party_analytics", "id")} = ${id} LIMIT 1`,
            );
      if (!row) continue;
      analytic = load(row);
      if (analytic.get("link_id") !== productId) analytic.set("link_id", productId);
      if (present(params.name)) analytic.set("name", nullable(params.name));
      if (present(params.location)) analytic.set("location", nullable(params.location));
      if (analytic.get("analytics_code") !== (params.code ?? null))
        analytic.set("analytics_code", nullable(params.code, "text"));
      await ThirdPartyAnalytics.saveBang(analytic);
    } else {
      analytic = await ThirdPartyAnalytics.createBang({
        user_id: Number(sellerId),
        analytics_code: nullable(params.code, "text"),
        name: nullable(params.name),
        location: nullable(params.location),
        link_id: productId,
      });
    }
    keep.push(analytic);
  }

  const kept = new Set(keep.map((analytic) => analytic.get("id")));
  for (const analytic of existing) if (!kept.has(analytic.get("id"))) await analyticDeletable.markDeleted(analytic);
}
