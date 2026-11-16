// The named routes the ported mailer views link to, as ActionMailer's url helpers build them with
// config.action_mailer.default_url_options (named after the Rails helpers, without the suffix).
import { domainConfig } from "../infra/domain.ts";
import { mailerUrl } from "./views.ts";

// ActionDispatch::Journey::Router::Utils.escape_segment: everything but unreserved, sub-delims,
// ":" and "@" is percent-encoded, byte by byte.
export function escapeSegment(segment: string): string {
  return Array.from(Buffer.from(segment, "utf8"))
    .map((b) => {
      const ch = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~!$&'()*+,;=:@]/u.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export class UrlGenerationError extends Error {}

// A `host:` option that carries its own scheme: url_for keeps the default protocol and takes the
// host after "://".
function hostOf(host: string | null): string {
  if (host === null) return domainConfig().domain;
  return host.replace(/^[^:]+:\/\//u, "");
}

export const MailerRoutes = {
  // custom_domain_view_post_url(slug:, host:): get "/p/:slug"
  customDomainViewPost(slug: string | null, host: string | null): string {
    if (slug === null || slug === "") throw new UrlGenerationError("No route matches custom_domain_view_post: missing required key [:slug]");
    return `${domainConfig().protocol}://${hostOf(host)}/p/${escapeSegment(slug)}`;
  },
  // community_url(seller_id, community_id, query): get "/communities/:seller_id/:community_id"
  community(sellerId: string | null, communityId: string, query: Record<string, string> = {}): string {
    if (sellerId === null || sellerId === "") throw new UrlGenerationError("No route matches community: missing required key [:seller_id]");
    return mailerUrl(`/communities/${escapeSegment(sellerId)}/${escapeSegment(communityId)}`, query);
  },
  // settings_main_url(anchor:)
  settingsMain(anchor: string): string {
    return `${mailerUrl("/settings")}#${anchor}`;
  },
};
