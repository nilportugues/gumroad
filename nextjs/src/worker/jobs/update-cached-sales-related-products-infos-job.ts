// Port of app/sidekiq/update_cached_sales_related_products_infos_job.rb. Golden:
// __fixtures__/update-cached-sales-related-products-infos-job.golden.json
// (scripts/golden/update-cached-sales-related-products-infos-job.rb).
import { Prisma, type CachedSalesRelatedProductsInfo, type Link } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { CachedSalesRelatedProductsInfos, PRODUCT } from "../../server/models/cached-sales-related-products-info.ts";
import { setAssociation } from "../../server/models/concerns/rails-validations.ts";
import { findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, selectRows } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const RELATED_PRODUCTS_LIMIT = 500;

// `SalesRelatedProductsInfo.related_product_ids_and_sales_counts`: the text is what Rails sends after String#squish, trailing
// spaces from the heredocs included.
function oneSided(productId: bigint, column: string, mirrorColumn: string) {
  return `(select ${mirrorColumn} as product_id, sales_count from sales_related_products_infos where ${column} = ${productId} order by sales_count desc limit ${RELATED_PRODUCTS_LIMIT} )`;
}

async function relatedProductIdsAndSalesCounts(productId: bigint): Promise<Map<string, number>> {
  const twoSided = `${oneSided(productId, "smaller_product_id", "larger_product_id")} union all ${oneSided(productId, "larger_product_id", "smaller_product_id")} `;
  const rows = await selectRows<{ product_id: bigint | number; sales_count: bigint | number }>(
    Prisma.sql`${Prisma.raw(`select product_id, sales_count from (${twoSided}) t order by sales_count desc limit ${RELATED_PRODUCTS_LIMIT}`)}`,
  );
  // Hash#to_h: a repeated key keeps its first position and takes the last value.
  return new Map(rows.map((row) => [String(row.product_id), Number(row.sales_count)]));
}

// A Json column comes back from a raw query as text.
function storedCounts(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

export const updateCachedSalesRelatedProductsInfosJobWith = modelJob({ min: 1 }, async ([productIdArg], deps) => {
  const productId = await beforeSideEffects(() => recordIdFrom(productIdArg, "Link.find"));
  const product = await findByIdBang<Link>("Link", productId);

  const counts = Object.fromEntries(await relatedProductIdsAndSalesCounts(productId));

  // `find_or_create_by!(product:)` then `update!`: a new row is saved with its default `{}` first, and keeps the product
  // it was built for, which a found row loads again when update! validates it.
  const found = await findOneBy<CachedSalesRelatedProductsInfo>(
    "CachedSalesRelatedProductsInfo",
    "product_id",
    productId,
    true,
  );
  let cache;
  if (found) {
    cache = CachedSalesRelatedProductsInfos.load(
      castRow<CachedSalesRelatedProductsInfo>("CachedSalesRelatedProductsInfo", {
        ...found,
        counts: storedCounts(found.counts),
      }),
    );
  } else {
    cache = CachedSalesRelatedProductsInfos.build({ product_id: productId, counts: {} });
    setAssociation(cache, PRODUCT.name, productId, product);
    await CachedSalesRelatedProductsInfos.saveBang(cache, { now: deps.now });
  }
  await CachedSalesRelatedProductsInfos.updateBang(cache, { counts }, { now: deps.now });
});

export const updateCachedSalesRelatedProductsInfosJob = updateCachedSalesRelatedProductsInfosJobWith();
