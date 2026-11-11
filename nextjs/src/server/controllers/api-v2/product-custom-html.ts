// Api::V2::LinksController#custom_html: the product's custom landing page, and the refusals of #edit_custom_html before it sanitizes. The
// sanitizing writes (edit_custom_html, preview_custom_html, update) stay in Rails; the last two are throttled by Rack::Attack as well.
import { db } from "../../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { findLink, findUserById } from "../../presenters/product-reads.ts";
import { longUrl } from "../../presenters/product.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";
import { type ApiV2Input, EDIT_PRODUCTS_SCOPES, loadProduct, PUBLIC_READ_SCOPES, registerApiV2, renderResponse } from "./base.ts";
import { blank } from "./ruby-params.ts";

// String#present? for the page's HTML.
const present = (value: string | null): boolean => value !== null && !/^[\s\u0085᠎]*$/u.test(value);

// before_action :set_link_id_to_id, :fetch_product, then :ensure_custom_html_pages_enabled
async function loadProductWithCustomHtml(input: ApiV2Input) {
  const halted = await loadProduct("id")(input);
  if (halted) return halted;
  if (!(await isFeatureEnabled("custom_html_pages", userActor(input.owner.id)))) return renderResponse(false, { message: "You do not have access to custom HTML pages." });
  return undefined;
}

registerApiV2({
  method: "GET",
  pattern: "/v2/products/:id/custom_html",
  scopes: PUBLIC_READ_SCOPES,
  before: loadProductWithCustomHtml,
  async run(input) {
    const product = input.state.product;
    // `has_one :page, -> { roots }`
    const page = await db.page.findFirst({ where: { pageable_type: "Link", pageable_id: product.id, slug: null }, orderBy: { id: "asc" } });
    const customHtml = page?.custom_html ?? null;
    const row = await findLink(product.id);
    const seller = await findUserById(input.owner.id);
    return renderResponse(true, { custom_html: customHtml, has_landing_page: present(customHtml), landing_url: longUrl(row!, seller!) });
  },
});

registerApiV2({
  method: "POST",
  pattern: "/v2/products/:id/custom_html/edit",
  scopes: EDIT_PRODUCTS_SCOPES,
  before: loadProductWithCustomHtml,
  run({ params }) {
    const { find, replace } = params;
    if (typeof find !== "string" || blank(find)) return renderResponse(false, { message: "find is required and must be a non-empty string copied exactly from the current custom HTML." });
    if (typeof replace !== "string") return renderResponse(false, { message: 'replace is required and must be a string (use "" to delete the snippet).' });
    // Pages::CustomHtmlWriter.edit! sanitizes the whole spliced document and saves it.
    throw new NotPortedError("editing the custom HTML, which runs the sanitizer");
  },
});
