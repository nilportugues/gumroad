// SellerProfileProductsSection (and the virtual default products section) as ProfileSectionsPresenter renders it for a
// visitor: the section's Elasticsearch search (`search_products`) and a ProductPresenter.card_for_web per product.
// A card the port cannot prove throws NotPortedError; `assertProductSectionsRender` turns that into a hand-back before
// anything is rendered, because a page cannot hand back once it is rendering.
import type { User } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails, RoutingError } from "../../controllers/application-controller.ts";
import { queryParam, type RailsRequest } from "../../controllers/rails-request.ts";
import { LinkFlags } from "../../models/link.ts";
import { db } from "../../../lib/db.ts";
import { findLink, type LinkRow } from "../../presenters/product-reads.ts";
import { cardForWeb, remainingForSaleCount, type PresenterRequest } from "../../presenters/product.ts";
import { ProductSortKey, SellerProfileSectionParam } from "../../search/product-search.ts";
import type { Params } from "../../search/ruby-params.ts";
import {
  normalizeSearchParamValues,
  searchProductsWithFacets,
  validFilterTokens,
} from "../../search/search-products.ts";
import { NotPortedError } from "../not-ported.ts";

// ProfileSectionsPresenter::DEFAULT_PRODUCTS_SECTION_ID / _TYPE
export const DEFAULT_PRODUCTS_SECTION_ID = "default-products";
export const PRODUCTS_SECTION_TYPE = "SellerProfileProductsSection";
// Product::Layout::PROFILE
const PROFILE_LAYOUT = "profile";

// ProfileSectionsPresenter::VISITOR_SEARCH_PARAMS: a visitor's filters re-run the section searches.
const VISITOR_SEARCH_PARAMS = [
  "query",
  "tags",
  "filetypes",
  "min_price",
  "max_price",
  "rating",
  "sort",
  "from",
  "size",
  "recommended_by",
];

const decode = (value: string) => {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
};

// Names whose `name[]=` and `name[key]=` forms the port reads; a nested shape of another name is Rails' to answer.
export const NESTED_VISITOR_PARAMS = ["tags", "filetypes"];
const INTEGER_LIKE_KEY = /^(?:0|[1-9]\d*)$/u;

// `normalize_search_param_values!(request.query_parameters.slice(*VISITOR_SEARCH_PARAMS))`, or null when the request
// carries none of them. Rack's nested parser gives `tags[]=` a list and `tags[a]=` a hash (last duplicate wins); a
// shape that is a ParameterTypeError (a flat key mixed with a nested one), a deeper nesting, a valueless nested key,
// or a hash JavaScript would reorder is Rails' to answer.
export async function visitorSearchParams(queryString: string): Promise<Params | null> {
  const nested = new Map<string, { list: string[]; hash: Map<string, string> }>();
  const flat = new Set<string>();
  for (const pair of queryString.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = decode(index === -1 ? pair : pair.slice(0, index));
    const name = VISITOR_SEARCH_PARAMS.find((candidate) => key === candidate || key.startsWith(`${candidate}[`));
    if (name === undefined) continue;
    if (key === name) {
      flat.add(name);
      continue;
    }
    const match = /^([a-z_]+)\[([^[\]]*)\]$/u.exec(key);
    if (!match || !NESTED_VISITOR_PARAMS.includes(name) || index === -1 || key.includes(";"))
      throw new HandBackToRails("a nested visitor search param");
    const entry = nested.get(name) ?? { list: [], hash: new Map<string, string>() };
    const value = decode(pair.slice(index + 1));
    if (match[2] === "") entry.list.push(value);
    // A filetypes hash is not normalized into a list in Rails (Elasticsearch gets the hash).
    else if (name === "filetypes" || INTEGER_LIKE_KEY.test(match[2]!) || match[2] === "__proto__")
      throw new HandBackToRails("an ordered hash");
    else entry.hash.set(match[2]!, value);
    nested.set(name, entry);
  }
  const request = { queryString } as RailsRequest;
  const params: Params = {};
  for (const name of VISITOR_SEARCH_PARAMS) {
    const entry = nested.get(name);
    if (entry) {
      if (flat.has(name) || (entry.list.length > 0 && entry.hash.size > 0))
        throw new HandBackToRails("a visitor search param of two shapes");
      params[name] = entry.hash.size > 0 ? Object.fromEntries(entry.hash) : entry.list;
      continue;
    }
    const value = queryParam(request, name);
    if (value !== undefined) params[name] = value;
  }
  if (Object.keys(params).length === 0) return null;
  return normalizeSearchParamValues(params, { validFilterTokens }, { actionControllerParams: false });
}

export type ProductsSectionRow = { id: bigint; header: string | null; flags: bigint; json_data: unknown };
type Header = { id: string; header: string | null };

// `section_search_results(section)`, then the cards of the products found (section_props for a visitor, who is
// not the profile's owner: sold-out products that hide their sold-out state are left out and the total follows).
export async function productsSectionProps(
  seller: User,
  section: ProductsSectionRow | null,
  header: Header,
  request: PresenterRequest,
  visitor: Params | null = null,
  omit: LinkRow | null = null,
): Promise<Record<string, unknown>> {
  const data = (section?.json_data ?? {}) as {
    show_filters?: boolean | null;
    default_product_sort?: string | null;
    shown_products?: number[] | null;
  };
  const sort = data.default_product_sort || ProductSortKey.PAGE_LAYOUT;
  // `params[:sort] || section&.default_product_sort`: an empty ?sort= is truthy in Ruby and wins.
  const found = await searchProductsWithFacets({
    ...visitor,
    sort: visitor?.sort ?? sort,
    section: section ? new SellerProfileSectionParam(data.shown_products ?? []) : undefined,
    is_alive_on_profile: true,
    user_id: Number(seller.id),
  });

  // Link.find(ids) raises RecordNotFound (a 404) for an indexed product that is gone.
  const rows = [];
  for (const id of found.product_ids) {
    const row = await findLink(BigInt(id));
    if (!row) throw new RoutingError("Not Found");
    rows.push(row);
  }
  let total = found.total;
  // `omit_product`: the product page's catalogue leaves out the product the buyer is viewing and shrinks the total with it.
  let candidates = rows;
  if (omit) {
    candidates = rows.filter((row) => row.id !== omit.id);
    if (total !== null) {
      if (candidates.length < rows.length) total -= rows.length - candidates.length;
      else if (omitProductInSearchTotal(seller, data.shown_products ?? [], section === null, omit)) total -= 1;
    }
  }
  const shown = [];
  for (const row of candidates) {
    if (LinkFlags.isSet(row.flags, "hide_sold_out_variants") && (await remainingForSaleCount(row)) === 0) {
      total = total === null ? total : total - 1;
      continue;
    }
    shown.push(row);
  }
  const products = [];
  for (const row of shown) {
    products.push(
      await cardForWeb(row.id, {
        request,
        target: PROFILE_LAYOUT,
        showSeller: false,
        recommendedBy: (visitor?.recommended_by as string | null | undefined) ?? null,
        computeDescription: false,
        computeInventory: false,
      }),
    );
  }

  return {
    id: header.id,
    header: header.header,
    type: PRODUCTS_SECTION_TYPE,
    show_filters: section ? (data.show_filters ?? null) : false,
    default_product_sort: section ? (data.default_product_sort ?? null) : ProductSortKey.PAGE_LAYOUT,
    search_results: {
      total,
      tags_data: found.tags_data,
      filetypes_data: found.filetypes_data,
      taxonomy_attributes_data: found.taxonomy_attributes_data,
      products,
    },
    ...(omit ? { exclude_ids: [externalId(omit.id)] } : {}),
  };
}

// The omitted product sits beyond the fetched page: the grid's `exclude_ids` pagination never returns it, so the
// total shrinks only when the search counted it (no sold-out check: ES totals include sold-out products).
function omitProductInSearchTotal(seller: User, shownProducts: number[], isDefaultSection: boolean, omit: LinkRow) {
  const alive = omit.purchase_disabled_at === null && omit.banned_at === null && omit.deleted_at === null;
  if (!alive || LinkFlags.isSet(omit.flags, "archived")) return false;
  return isDefaultSection ? omit.user_id === seller.id : shownProducts.includes(Number(omit.id));
}

// `sections.empty? && seller.products.alive.not_archived.exists?`
export async function defaultProductsSectionAvailable(seller: User): Promise<boolean> {
  const products = await db.link.findMany({
    where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null },
    select: { flags: true },
  });
  return products.some((product) => !LinkFlags.isSet(product.flags, "archived"));
}

// NotPortedError -> the caller hands the request back.
export async function assertProductSectionsRender(
  render: () => Promise<unknown>,
  handBack: () => never,
): Promise<void> {
  try {
    await render();
  } catch (error) {
    if (error instanceof NotPortedError) handBack();
    throw error;
  }
}

export const sectionHeader = (section: ProductsSectionRow, hideHeader: boolean): Header => ({
  id: externalId(section.id),
  header: hideHeader ? null : section.header,
});
