// Api::Internal::AgentCustomHtmlPreviewsController. #show is a Redis read and runs here. #create answers the gates and every proposal the
// controller refuses before it sanitizes anything; a preview that renders (Ai::PageSanitizer over Nokogiri, Pages::Interpolator,
// Pages::ProfileData, Pages::DefaultProfileDocument) is Rails'.
import { db } from "../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { getRedis } from "../infra/redis.ts";
import { storageConfig } from "../infra/storage.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";

import { HandBackToRails, type ActionResult, type Rendered } from "./application-controller.ts";
import { authorizeStoreAgent, guarded, handingBack } from "./internal-agent.ts";
import { json, jsonAction } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

// Page::MAX_CUSTOM_HTML_LENGTH
const MAX_CUSTOM_HTML_LENGTH = 500_000;
const CUSTOM_FEATURE = "custom_html_pages";

// RendersCustomHtmlPages::CUSTOM_HTML_SANDBOX_TOKENS
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

// RendersCustomHtmlPages::CUSTOM_HTML_CSP
function customHtmlCsp(): string {
  const { protocol, assetDomain } = domainConfig(process.env);
  const { cdnS3ProxyHost, publicStorageCdnS3ProxyHost } = storageConfig();
  const assetHosts = [...new Set([cdnS3ProxyHost, publicStorageCdnS3ProxyHost])].join(" ");
  return `${[
    `sandbox ${SANDBOX}`,
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com",
    `style-src 'unsafe-inline' ${protocol}://${assetDomain} https://cdn.tailwindcss.com https://fonts.googleapis.com https://fonts.bunny.net`,
    `img-src data: blob: ${assetHosts}`,
    `media-src data: blob: ${assetHosts}`,
    "font-src data: https://fonts.gstatic.com https://fonts.bunny.net",
    "connect-src 'none'",
    "form-action 'self'",
  ].join("; ")};`;
}

// AgentCustomHtmlPreviewsController::EXPIRED_PREVIEW_DOCUMENT
const EXPIRED_PREVIEW_DOCUMENT = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; font-family: system-ui, sans-serif; color: #666;">
    <p>This preview has expired.</p>
  </body>
</html>
`;

// String#blank? of a Ruby string: Unicode white space only
const RUBY_BLANK = /^\p{White_Space}*$/u;
const WHITESPACE_RUN = String.raw`(?:\p{White_Space}|&nbsp;)+`;
const NOT_FOUND = 404;

const html = (body: string, status: number): Rendered => ({
  status,
  body,
  contentType: "text/html; charset=utf-8",
  paramsRead: true,
  headers: {
    "Content-Security-Policy": customHtmlCsp(),
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
  },
});

// GET #show: `staged_preview_document` rescues a stalled read into the expired page
async function stagedDocument(sellerId: bigint, token: string): Promise<string | null> {
  try {
    return await getRedis("main").get(`agent_custom_html_preview:${sellerId}:${token}`);
  } catch {
    return null;
  }
}

export const agentCustomHtmlPreview = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, async (input) => {
    const { context, url, urlOptions } = input;
    const config = domainConfig(process.env);
    // `authenticate_user!` redirects an HTML request to the login page; a refused policy redirects to the dashboard
    const refused = await sellerGuard({ context, config, url, params: routeParams, urlOptions }, authorizeStoreAgent, {
      requireAccountEmail: false,
    });
    if (refused !== null) return refused;
    const document = await stagedDocument(context.currentSeller!.id, routeParams.token!);
    return document === null ? html(EXPIRED_PREVIEW_DOCUMENT, NOT_FOUND) : html(document, 200);
  });

const codePoints = (text: string): number => [...text].length;

// Ai::CustomHtmlSnippetMatcher.whitespace_tolerant_pattern
function tolerantPattern(find: string): RegExp {
  const segments = find
    .split(new RegExp(`(${WHITESPACE_RUN})`, "u"))
    .map((segment, index) => (index % 2 === 1 ? WHITESPACE_RUN : segment.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")));
  return new RegExp(segments.join(""), "gu");
}

// Ai::CustomHtmlSnippetMatcher.match, reduced to what the controller reads before it splices: the occurrence count and the edited length
function matchSnippet(page: string, find: string, replace: string): { occurrences: number; edited: string } {
  const exact = page.split(find).length - 1;
  if (exact > 0) {
    const at = page.indexOf(find);
    return { occurrences: exact, edited: `${page.slice(0, at)}${replace}${page.slice(at + find.length)}` };
  }
  const pattern = tolerantPattern(find);
  const matches = [...page.matchAll(pattern)];
  const first = matches[0];
  return {
    occurrences: matches.length,
    edited:
      first === undefined
        ? page
        : `${page.slice(0, first.index)}${replace}${page.slice(first.index + first[0].length)}`,
  };
}

const lengthError = (text: string): string | null =>
  codePoints(text) <= MAX_CUSTOM_HTML_LENGTH
    ? null
    : `The edited page would be too long (maximum is ${MAX_CUSTOM_HTML_LENGTH} characters).`;

const failure = (error: string) => json({ success: false, error });

// #resulting_custom_html up to the point a proposal needs the sanitizer
async function previewProposal(input: MutationInput): Promise<ActionResult> {
  const { params } = input;
  const seller = input.context.currentSeller!;
  if (!(await isFeatureEnabled(CUSTOM_FEATURE, userActor(seller.id))))
    return failure("Custom HTML pages are not enabled on this account.");

  const endpoint = typeof params.endpoint === "string" ? params.endpoint : "";
  if (endpoint === "update_user_custom_html") {
    if (!("custom_html" in params)) return failure("The proposed update is missing its custom_html value.");
    const customHtml = params.custom_html;
    if (Array.isArray(customHtml))
      throw new HandBackToRails("an array custom_html, which Rails' parameter munging may rewrite");
    if (customHtml !== null && typeof customHtml !== "string") return failure("custom_html must be a string.");
    if (customHtml === null || RUBY_BLANK.test(customHtml))
      throw new HandBackToRails("a proposal that clears the page");
    const tooLong = lengthError(customHtml);
    if (tooLong !== null) return failure(tooLong);
    throw new HandBackToRails("a page preview, which sanitizes the proposed HTML");
  }
  if (endpoint === "edit_user_custom_html") {
    const { find, replace } = params;
    if (typeof find !== "string" || RUBY_BLANK.test(find))
      return failure("The proposed edit is missing the snippet to replace.");
    if (typeof replace !== "string") return failure("The proposed edit is missing the replacement text.");
    // User#page: the root page, the one with no slug
    const page = await db.page.findFirst({
      where: { pageable_type: "User", pageable_id: seller.id, slug: null },
      orderBy: { id: "asc" },
    });
    const current = page?.custom_html ?? null;
    if (current === null || RUBY_BLANK.test(current)) return failure("There is no custom HTML page to edit.");
    const { expected_custom_html_sha256: expected, result_custom_html_sha256: result } = params;
    if (expected !== undefined && expected !== null) throw new HandBackToRails("a guarded edit");
    if (result !== undefined && result !== null) throw new HandBackToRails("a guarded edit");
    const { occurrences, edited } = matchSnippet(current, find, replace);
    if (occurrences === 0) return failure("The snippet to replace no longer appears in the current page.");
    if (occurrences > 1) return failure(`The snippet to replace matches ${occurrences} places in the current page.`);
    const tooLong = lengthError(edited);
    if (tooLong !== null) return failure(tooLong);
    throw new HandBackToRails("a page preview, which sanitizes the edited HTML");
  }
  return failure("This change doesn't have a page preview.");
}

registerMutations({
  method: "POST",
  pattern: "/internal/agent/custom_html_preview",
  formats: ["any"],
  run: (input) => handingBack(() => guarded(input, () => previewProposal(input))),
});
