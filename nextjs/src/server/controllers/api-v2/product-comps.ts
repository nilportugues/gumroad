// Api::V2::LinksController#comps: the parameter refusals ahead of the Elasticsearch search. The search (Link.search_options with the price
// percentiles, and the records it returns) is Rails': a request that passes every refusal goes there whole, and Rack::Attack's count for it is
// taken back by the hand-back. Registered ahead of `GET /v2/products/:id`, which would otherwise read `comps` as a product id.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../../models/sql.ts";
import { taxonomyByPath } from "../../page-props/discover/taxonomies.ts";
import { HandBackToRails } from "../application-controller.ts";

import { type ApiV2Input, PUBLIC_READ_SCOPES, present, registerApiV2, renderResponse } from "./base.ts";
import { normalizePriceCurrencyType, supportedCurrency } from "./product-writes.ts";
import { blankParam, rubyToS } from "./ruby-params.ts";

const USD = "usd";
const DIGITS = /^\d+$/u;
// The largest id a bigint column holds; a longer one is a RangeError that `find_by` turns into nil.
const MAX_BIGINT = 2n ** 63n - 1n;
const refuse = (message: string) => renderResponse(false, { message });

async function taxonomyExists(taxonomy: unknown): Promise<boolean> {
  const text = rubyToS(taxonomy);
  if (DIGITS.test(text)) {
    const id = BigInt(text);
    if (id > MAX_BIGINT) return false;
    const [row] = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("taxonomies", "id")} FROM ${table("taxonomies")} WHERE ${column("taxonomies", "id")} = ${id} LIMIT 1`,
    );
    return row !== undefined;
  }
  const slugs = text.split("/");
  while (slugs.at(-1) === "") slugs.pop();
  // Ruby's split keeps empty segments inside the path, and closure_tree reads them as slugs.
  if (slugs.length === 0 || slugs.some((slug) => slug === ""))
    throw new HandBackToRails("a taxonomy path with an empty segment");
  return (await taxonomyByPath(slugs)) !== null;
}

async function comps({ params, rawBody }: ApiV2Input) {
  // Rails reads a JSON body on a GET as parameters; the port reads the query string only.
  if (rawBody.length > 0) throw new HandBackToRails("a GET that carries a body");
  if (present(params.query) && typeof params.query !== "string") return refuse("query must be a string.");
  if (blankParam(params.taxonomy) && blankParam(params.query))
    return refuse("A taxonomy or query parameter is required.");

  // Percentiles over raw price_cents only compare within one currency, so the aggregation is pinned to one.
  const currency = Object.hasOwn(params, "price_currency_type")
    ? normalizePriceCurrencyType(params.price_currency_type)
    : USD;
  if (!supportedCurrency(currency))
    return refuse(`'${rubyToS(params.price_currency_type)}' is not a supported currency.`);

  if (present(params.taxonomy) && !(await taxonomyExists(params.taxonomy)))
    return refuse("The taxonomy was not found.");

  throw new HandBackToRails("the comps search in Elasticsearch");
}

registerApiV2({ method: "GET", pattern: "/v2/products/comps", scopes: PUBLIC_READ_SCOPES, run: comps });
