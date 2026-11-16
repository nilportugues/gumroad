// Port of the part of Pages::ProductPrices (app/services/pages/product_prices.rb) that does not price anything. The per-request build
// (visitor GeoIP, buyer-currency localization, offer codes, option prices) is Rails': a page that references the payload is handed back.
import { NotPortedError } from "../page-props/not-ported.ts";

// Pages::ProductPrices.referenced_in?
export const referencedInPrices = (html: string | null | undefined): boolean =>
  /data-gumroad-product|gumroad-prices/u.test(html ?? "");

// Pages::ProductPrices.build
export function buildProductPrices(): never {
  throw new NotPortedError("Pages::ProductPrices.build");
}
