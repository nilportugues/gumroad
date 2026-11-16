// Port of ThirdPartyAnalyticsController#profile and #index (app/controllers/third_party_analytics_controller.rb): the seller's raw snippets
// for the profile page and for a product's page, served on the third-party analytics host. #index with a `purchase_id` substitutes $VALUE,
// $CURRENCY and $ORDER from the sale; a purchase_id outside [A-Za-z0-9_=-] or on a sale or product whose price or currency is
// missing goes to Rails.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { formatMoney } from "../page-props/audience/filters.ts";

import { HandBackToRails, RoutingError, type ActionContext, type Rendered } from "./application-controller.ts";
import { deleteCookieHeader } from "./signed-in-filters.ts";

export const OVERRIDE_WINDOW_ACTIONS_CODE = `<script type="text/javascript">
try { window.alert = function() {}; } catch(error) { }
try { window.confirm = function() {}; } catch(error) { }
try { window.prompt = function() {}; } catch(error) { }
try { window.print = function() {}; } catch(error) { }
</script>`;

export const OVERRIDE_ON_CLOSE_CODE = `<script type="text/javascript">
try { window.onbeforeunload = null; } catch(error) { }
try { window.onabort = null; } catch(error) { }
</script>`;

// app/views/third_party_analytics/index.html.erb, rendered with `layout: false`.
const page = (snippets: string) => `<!DOCTYPE html>\n<html>\n  <body>\n    ${snippets}\n  </body>\n</html>\n`;

// after_action :erase_cookies_and_skip_session: `cookies.clear` expires the cookies the visitor sent and the guid this request minted.
// They come after the cookies the response set, so a minted guid is written and then erased.
export function erasedCookies({ request, chain }: Pick<ActionContext, "request" | "chain">): string[] {
  const names = [...request.cookies.keys()];
  if (chain.guid !== null) names.push("_gumroad_guid");
  return [...new Set(names)].map((name) => deleteCookieHeader(name, { httpOnly: true }));
}

export async function profile(username: string, action: ActionContext): Promise<Rendered> {
  const [user] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${Prisma.raw("`users`.`id`")} FROM ${table("users")} WHERE ${column("users", "username")} = ${username} AND ${column("users", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (!user) throw new RoutingError("Not Found");

  const rows = await selectRows<{ analytics_code: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`third_party_analytics`.`analytics_code`")} FROM ${table("third_party_analytics")} WHERE ${column("third_party_analytics", "user_id")} = ${user.id} AND ${column("third_party_analytics", "link_id")} IS NULL AND ${column("third_party_analytics", "deleted_at")} IS NULL AND ${column("third_party_analytics", "location")} = 'all'`,
  );
  const snippets = rows.map((row) => row.analytics_code ?? "").join("\n");
  const body = OVERRIDE_WINDOW_ACTIONS_CODE + snippets + OVERRIDE_ON_CLOSE_CODE;
  return {
    status: 200,
    body: page(body),
    contentType: "text/html; charset=utf-8",
    paramsRead: true,
    cookies: erasedCookies(action),
  };
}

const EXTERNAL_ID = /^[\w=-]+$/u;

// `@product.sales.find_by_external_id(params[:purchase_id])`, then the placeholders `gsub!` replaces in the snippets. A blank purchase_id
// is not `present?` and substitutes nothing.
async function substitutePurchase(
  snippets: string,
  product: { id: bigint; price_currency_type: string | null },
  purchaseId: string,
): Promise<string> {
  if (purchaseId === "") return snippets;
  if (!EXTERNAL_ID.test(purchaseId)) throw new HandBackToRails("a purchase_id Node does not read");
  const id = decrypt(purchaseId);
  const [purchase] =
    id === null
      ? []
      : await selectRows<{ displayed_price_cents: number | null }>(
          Prisma.sql`SELECT ${column("purchases", "displayed_price_cents")} FROM ${table("purchases")} WHERE ${column("purchases", "link_id")} = ${product.id} AND ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (!purchase) throw new RoutingError("Not Found");
  if (purchase.displayed_price_cents === null || product.price_currency_type === null)
    throw new HandBackToRails("a sale or product without a price or currency");
  return snippets
    .replaceAll("$VALUE", () => formatMoney(Number(purchase.displayed_price_cents), product.price_currency_type))
    .replaceAll("$CURRENCY", () => product.price_currency_type!.toUpperCase())
    .replaceAll("$ORDER", () => purchaseId);
}

const UNSUPPORTED_QUERY = /^(?:id|location\[|purchase_id\[)/u;

// #index: the product's alive snippets for the location, then the seller's universal ones, between the two overrides.
export async function index(linkId: string, url: URL, action: ActionContext): Promise<Rendered> {
  // fetch_product reads `params[:id] || params[:link_id]`, and a list or hash in the query is not a string location.
  if ([...url.searchParams.keys()].some((key) => UNSUPPORTED_QUERY.test(key)))
    throw new HandBackToRails("a location or id the query gives as a list");
  const [product] = await selectRows<{ id: bigint; user_id: bigint; price_currency_type: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.`id`, `links`.`user_id`, `links`.`price_currency_type`")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${linkId} AND ${column("links", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (!product) throw new RoutingError("Not Found");

  // `where(location: [params[:location], "all"])`: a missing location also matches the rows with none.
  const location = url.searchParams.get("location");
  const locations =
    location === null
      ? Prisma.sql`(${column("third_party_analytics", "location")} = 'all' OR ${column("third_party_analytics", "location")} IS NULL)`
      : Prisma.sql`${column("third_party_analytics", "location")} IN (${location}, 'all')`;
  const snippetsOf = async (owner: Prisma.Sql) =>
    (
      await selectRows<{ analytics_code: string | null }>(
        Prisma.sql`SELECT ${Prisma.raw("`third_party_analytics`.`analytics_code`")} FROM ${table("third_party_analytics")} WHERE ${owner} AND ${column("third_party_analytics", "deleted_at")} IS NULL AND ${locations} ORDER BY ${column("third_party_analytics", "id")} ASC`,
      )
    )
      .map((row) => row.analytics_code ?? "")
      .join("\n");
  const productSnippets = await snippetsOf(Prisma.sql`${column("third_party_analytics", "link_id")} = ${product.id}`);
  const userSnippets = await snippetsOf(
    Prisma.sql`${column("third_party_analytics", "user_id")} = ${product.user_id} AND ${column("third_party_analytics", "link_id")} IS NULL`,
  );
  const snippets = OVERRIDE_WINDOW_ACTIONS_CODE + productSnippets + userSnippets + OVERRIDE_ON_CLOSE_CODE;
  return {
    status: 200,
    body: page(await substitutePurchase(snippets, product, url.searchParams.get("purchase_id") ?? "")),
    contentType: "text/html; charset=utf-8",
    paramsRead: true,
    cookies: erasedCookies(action),
  };
}
