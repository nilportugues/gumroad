// The catalogue below a storefront seller's product page: ProductPresenter#product_page_props with
// `show_storefront_catalog?`, i.e. `ProfileSectionsPresenter.props(editing: false, include_default_products_section: true,
// omit_product: product)` over the seller's products sections (never the other section types).
import type { User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { nameOrUsername, Users } from "../../models/user.ts";
import type { LinkRow } from "../../presenters/product-reads.ts";
import type { PresenterRequest } from "../../presenters/product.ts";
import type { Params } from "../../search/ruby-params.ts";

import {
  DEFAULT_PRODUCTS_SECTION_ID,
  defaultProductsSectionAvailable,
  PRODUCTS_SECTION_TYPE,
  productsSectionProps,
  sectionHeader,
  type ProductsSectionRow,
} from "./product-sections.ts";

const PROFILE_SECTION_FLAG_HIDE_HEADER = 2 ** 1;

// `ProductPresenter#show_storefront_catalog?` besides the seller's own flag: the visitor is not the seller
// (`pundit_user&.seller != user`) and the product has no sections of its own.
export async function storefrontCatalogSections(
  seller: User,
  product: LinkRow,
  request: PresenterRequest,
  visitor: Params | null,
): Promise<Record<string, unknown>[]> {
  const sections = await db.sellerProfileSection.findMany({
    where: { seller_id: seller.id, product_id: null, type: PRODUCTS_SECTION_TYPE },
    orderBy: { id: "asc" },
  });
  if (sections.length === 0) {
    if (!(await defaultProductsSectionAvailable(seller))) return [];
    // The virtual catalogue needs a label on a product page: without a heading it reads as stray cards.
    return [
      await productsSectionProps(
        seller,
        null,
        { id: DEFAULT_PRODUCTS_SECTION_ID, header: `More from ${nameOrUsername(Users.load(seller))}` },
        request,
        visitor,
        product,
      ),
    ];
  }
  return Promise.all(
    sections.map((section) => {
      const hideHeader = (section.flags & BigInt(PROFILE_SECTION_FLAG_HIDE_HEADER)) !== 0n;
      return productsSectionProps(
        seller,
        section as ProductsSectionRow,
        sectionHeader(section as ProductsSectionRow, hideHeader),
        request,
        visitor,
        product,
      );
    }),
  );
}
