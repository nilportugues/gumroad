// Api::V2::LinksController#custom_html: the product's custom landing page. Its writes (edit_custom_html, preview_custom_html, update)
// sanitize the HTML and are throttled by Rack::Attack, so they stay in Rails.
import { db } from "../../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { findLink, findUserById } from "../../presenters/product-reads.ts";
import { longUrl } from "../../presenters/product.ts";
import { type ApiV2Input, loadProduct, PUBLIC_READ_SCOPES, registerApiV2, renderResponse } from "./base.ts";

// String#present? for the page's HTML.
const present = (value: string | null): boolean => value !== null && !/^[\s\u0085᠎]*$/u.test(value);

registerApiV2({
  method: "GET",
  pattern: "/v2/products/:id/custom_html",
  scopes: PUBLIC_READ_SCOPES,
  async before(input: ApiV2Input) {
    // before_action :set_link_id_to_id, :fetch_product, then :ensure_custom_html_pages_enabled
    const halted = await loadProduct("id")(input);
    if (halted) return halted;
    if (!(await isFeatureEnabled("custom_html_pages", userActor(input.owner.id)))) return renderResponse(false, { message: "You do not have access to custom HTML pages." });
    return undefined;
  },
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
