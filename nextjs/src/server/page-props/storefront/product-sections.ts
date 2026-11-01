// SellerProfileProductsSection (and the virtual default products section) as ProfileSectionsPresenter renders it for a
// visitor: the section's Elasticsearch search (`search_products`) and a ProductPresenter.card_for_web per product.
// A card the port cannot prove throws NotPortedError; `assertProductSectionsRender` turns that into a hand-back before
// anything is rendered, because a page cannot hand back once it is rendering.
import type { User } from "@prisma/client";

import { RoutingError } from "../../controllers/application-controller.ts";
import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { LinkFlags } from "../../models/link.ts";
import { cardForWeb, remainingForSaleCount, type PresenterRequest } from "../../presenters/product.ts";
import { findLink } from "../../presenters/product-reads.ts";
import { ProductSortKey, SellerProfileSectionParam } from "../../search/product-search.ts";
import { searchProductsWithFacets } from "../../search/search-products.ts";
import { NotPortedError } from "../not-ported.ts";

// ProfileSectionsPresenter::DEFAULT_PRODUCTS_SECTION_ID / _TYPE
export const DEFAULT_PRODUCTS_SECTION_ID = "default-products";
export const PRODUCTS_SECTION_TYPE = "SellerProfileProductsSection";
// Product::Layout::PROFILE
const PROFILE_LAYOUT = "profile";

export type ProductsSectionRow = { id: bigint; header: string | null; flags: bigint; json_data: unknown };
type Header = { id: string; header: string | null };

// `section_search_results(section)`, then the cards of the products found (section_props for a visitor, who is
// not the profile's owner: sold-out products that hide their sold-out state are left out and the total follows).
export async function productsSectionProps(seller: User, section: ProductsSectionRow | null, header: Header, request: PresenterRequest): Promise<Record<string, unknown>> {
  const data = (section?.json_data ?? {}) as { show_filters?: boolean | null; default_product_sort?: string | null; shown_products?: number[] | null };
  const sort = data.default_product_sort || ProductSortKey.PAGE_LAYOUT;
  const found = await searchProductsWithFacets({
    sort,
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
  const shown = [];
  for (const row of rows) {
    if (LinkFlags.isSet(row.flags, "hide_sold_out_variants") && (await remainingForSaleCount(row)) === 0) {
      total = total === null ? total : total - 1;
      continue;
    }
    shown.push(row);
  }
  const products = [];
  for (const row of shown) {
    products.push(await cardForWeb(row.id, { request, target: PROFILE_LAYOUT, showSeller: false, computeDescription: false, computeInventory: false }));
  }

  return {
    id: header.id,
    header: header.header,
    type: PRODUCTS_SECTION_TYPE,
    show_filters: section ? (data.show_filters ?? null) : false,
    default_product_sort: section ? (data.default_product_sort ?? null) : ProductSortKey.PAGE_LAYOUT,
    search_results: { total, tags_data: found.tags_data, filetypes_data: found.filetypes_data, taxonomy_attributes_data: found.taxonomy_attributes_data, products },
  };
}

// NotPortedError -> the caller hands the request back.
export async function assertProductSectionsRender(render: () => Promise<unknown>, handBack: () => never): Promise<void> {
  try {
    await render();
  } catch (error) {
    if (error instanceof NotPortedError) handBack();
    throw error;
  }
}

export const sectionHeader = (section: ProductsSectionRow, hideHeader: boolean): Header => ({ id: externalId(section.id), header: hideHeader ? null : section.header });
