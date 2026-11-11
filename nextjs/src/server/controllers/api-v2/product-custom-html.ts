// Api::V2::LinksController#custom_html: the product's custom landing page, and the refusals of #edit_custom_html and #preview_custom_html
// before they sanitize. The sanitizing itself (Ai::PageSanitizer, Nokogiri) stays in Rails; #preview_custom_html is throttled by Rack::Attack,
// which Node counts ahead of the action (rack-attack.ts) and takes back when it hands the request over.
import type { Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";
import { findLink, findUserById } from "../../presenters/product-reads.ts";
import { longUrl } from "../../presenters/product.ts";
import { HandBackToRails } from "../application-controller.ts";

import {
  type ApiV2Input,
  EDIT_PRODUCTS_SCOPES,
  loadProduct,
  PUBLIC_READ_SCOPES,
  registerApiV2,
  renderResponse,
} from "./base.ts";
import { customHtmlLengthError } from "./product-writes.ts";
import { blank } from "./ruby-params.ts";

// String#present? for the page's HTML.
const present = (value: string | null): boolean => value !== null && !/^[\s\u0085\u180e]*$/u.test(value);

// before_action :set_link_id_to_id, :fetch_product, then :ensure_custom_html_pages_enabled
async function loadProductWithCustomHtml(input: ApiV2Input) {
  const halted = await loadProduct("id")(input);
  if (halted) return halted;
  if (!(await isFeatureEnabled("custom_html_pages", userActor(input.owner.id))))
    return renderResponse(false, { message: "You do not have access to custom HTML pages." });
  return undefined;
}

registerApiV2({
  method: "GET",
  pattern: "/v2/products/:id/custom_html",
  scopes: PUBLIC_READ_SCOPES,
  before: loadProductWithCustomHtml,
  async run(input) {
    const product = input.state.product as Link;
    // `has_one :page, -> { roots }`
    const page = await db.page.findFirst({
      where: { pageable_type: "Link", pageable_id: product.id, slug: null },
      orderBy: { id: "asc" },
    });
    const customHtml = page?.custom_html ?? null;
    const row = await findLink(product.id);
    const seller = await findUserById(input.owner.id);
    return renderResponse(true, {
      custom_html: customHtml,
      has_landing_page: present(customHtml),
      landing_url: longUrl(row!, seller!),
    });
  },
});

registerApiV2({
  method: "POST",
  pattern: "/v2/products/:id/custom_html/edit",
  scopes: EDIT_PRODUCTS_SCOPES,
  before: loadProductWithCustomHtml,
  run({ params }) {
    const { find, replace } = params;
    if (typeof find !== "string" || blank(find))
      return renderResponse(false, {
        message: "find is required and must be a non-empty string copied exactly from the current custom HTML.",
      });
    if (typeof replace !== "string")
      return renderResponse(false, {
        message: 'replace is required and must be a string (use "" to delete the snippet).',
      });
    // Pages::CustomHtmlWriter.edit! sanitizes the whole spliced document and saves it.
    throw new NotPortedError("editing the custom HTML, which runs the sanitizer");
  },
});

// POST /v2/products/:id/preview_custom_html: set_link_id_to_id and fetch_product run ahead of the action's own refusals.
registerApiV2({
  method: "POST",
  pattern: "/v2/products/:id/preview_custom_html",
  scopes: EDIT_PRODUCTS_SCOPES,
  before: loadProduct("id"),
  async run({ owner, params }) {
    if (!(await isFeatureEnabled("custom_html_pages", userActor(owner.id))))
      return renderResponse(false, { message: "You do not have access to custom HTML pages." });
    if (!Object.hasOwn(params, "custom_html")) return renderResponse(false, { message: "custom_html is required." });
    if (params.custom_html !== null && typeof params.custom_html !== "string")
      return renderResponse(false, { message: "custom_html must be a string." });
    const tooLong = customHtmlLengthError(params);
    if (tooLong !== null) return renderResponse(false, { message: tooLong });
    throw new HandBackToRails("a custom HTML preview, which runs the sanitizer");
  },
});
