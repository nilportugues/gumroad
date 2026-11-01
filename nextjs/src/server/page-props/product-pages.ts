// LinksController#show (Products/Show), on the Gumroad domain (always a redirect to the seller's host), on
// seller subdomains and custom domains, and on a product's own domain. The filters live in
// controllers/product-page.ts; a request they do not halt is handed back to Rails until the render is ported.
import { PRODUCT_PAGE_OPTIONS } from "../controllers/product-page.ts";
import { NotPortedError } from "./not-ported.ts";
import type { PageSpec } from "./pages.ts";

const productPage: PageSpec = {
  component: "Products/Show",
  options: PRODUCT_PAGE_OPTIONS,
  props: () => {
    throw new NotPortedError("Products/Show");
  },
};

export const PRODUCT_PAGES: Record<string, PageSpec> = {
  "/l/:id": productPage,
  "/l/:id/:code": productPage,
  "seller:/l/:id": productPage,
  "seller:/l/:id/:code": productPage,
  "product:/": productPage,
  "product:/l/:id": productPage,
  "product:/l/:id/:code": productPage,
};
