// Port of the js-routes helpers (`Routes.*`) the shared components call. Rails generates the full
// table with `rake js:export`; only the helpers reached by converted pages are listed here, and
// each must match its line in config/routes.rb. Add helpers as pages are converted.
//
// This module ships to the browser, so it must not import server config (which reads files with
// node:fs). PROTOCOL is inlined at build time by next.config.ts, as Vite does; DOMAIN is only
// set on the server, so the browser falls back to window.location.host just like the Vite bundle.
const getConfig = (name: "DOMAIN" | "PROTOCOL"): string | undefined =>
  name === "PROTOCOL" ? process.env.PROTOCOL : process.env.DOMAIN;

type Segment = string | number | { to_param?: () => string; id?: string | number };
type RouteOptions = {
  host?: string;
  protocol?: string;
  port?: string | number;
  anchor?: string;
  format?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

// js-routes options that shape the URL instead of becoming query parameters.
const RESERVED_OPTIONS = new Set(["host", "protocol", "port", "anchor", "format", "params", "subdomain", "trailing_slash", "script_name"]);

function toParam(value: Segment | unknown): string {
  if (value && typeof value === "object") {
    const object = value as { to_param?: () => string; id?: string | number };
    if (typeof object.to_param === "function") return object.to_param();
    if (object.id !== undefined) return String(object.id);
  }
  return String(value);
}

// Rails' `to_query`: nested hashes as `a[b]=`, arrays as `a[]=`, keys sorted.
function toQuery(params: Record<string, unknown>, prefix?: string): string[] {
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodeURIComponent(`${name}[]`)}=${encodeURIComponent(toParam(item ?? ""))}`);
    } else if (value && typeof value === "object" && !("to_param" in value)) {
      parts.push(...toQuery(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value === null ? "" : toParam(value))}`);
    }
  }
  return parts;
}

// js-routes bakes Rails' `default_url_options` (PROTOCOL, DOMAIN) in at generation time. Here the
// page props' domain_settings set them, so server and browser render identical absolute URLs.
const defaults: { protocol?: string; host?: string } = {};

export function configureRouteDefaults(protocol: string, host: string) {
  defaults.protocol = protocol;
  defaults.host = host;
}

function defaultHost() {
  return defaults.host ?? getConfig("DOMAIN") ?? (typeof window !== "undefined" ? window.location.host : "localhost:3000");
}

function defaultProtocol() {
  return defaults.protocol ?? getConfig("PROTOCOL") ?? "http";
}

// `spec` is the Rails route pattern, e.g. "/help/category/:slug(.:format)".
export function buildRoute(spec: string, args: unknown[], absolute: boolean): string {
  const required = [...spec.replace(/\([^)]*\)/g, "").matchAll(/[:*](\w+)/g)].map((m) => m[1] as string);
  const last = args[args.length - 1];
  const hasOptions = args.length > required.length && last !== null && typeof last === "object";
  const options: RouteOptions = hasOptions ? { ...(last as RouteOptions) } : {};
  const positional = hasOptions ? args.slice(0, -1) : args;
  const values: Record<string, unknown> = { ...options.params };
  required.forEach((name, index) => {
    if (index < positional.length) values[name] = positional[index];
    else if (options[name] !== undefined) values[name] = options[name];
    else throw new Error(`Route ${spec} is missing required parameter :${name}`);
  });
  if (options.format !== undefined) values.format = options.format;

  const used = new Set<string>();
  const fill = (pattern: string): string | null => {
    let missing = false;
    const filled = pattern.replace(/([:*])(\w+)/g, (_, kind: string, name: string) => {
      const value = values[name];
      if (value === undefined || value === null || value === "") {
        missing = true;
        return "";
      }
      used.add(name);
      return kind === "*" ? toParam(value).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(toParam(value));
    });
    return missing ? null : filled;
  };
  // Optional groups are dropped unless every parameter inside them is given.
  const path = spec.replace(/\(([^()]*)\)/g, (_, group: string) => fill(group) ?? "");
  const resolved = fill(path) ?? path;

  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!RESERVED_OPTIONS.has(key) && !used.has(key) && !required.includes(key)) query[key] = value;
  }
  const queryString = toQuery(query).join("&");
  let url = resolved + (queryString ? `?${queryString}` : "") + (options.anchor ? `#${options.anchor}` : "");
  if (absolute) {
    const host = options.host ?? defaultHost();
    const port = options.port ? `:${options.port}` : "";
    url = `${options.protocol ?? defaultProtocol()}://${host}${port}${url}`;
  }
  return url;
}

type RouteHelper = (...args: unknown[]) => string;
const path = (spec: string): RouteHelper => (...args) => buildRoute(spec, args, false);
const url = (spec: string): RouteHelper => (...args) => buildRoute(spec, args, true);

// Help center (config/routes.rb `namespace :help_center, path: "help"`).
export const help_center_root_path = path("/help(.:format)");
export const help_center_root_url = url("/help(.:format)");
export const help_center_articles_path = path("/help/article(.:format)");
export const help_center_article_path = path("/help/article/:slug(.:format)");
export const help_center_article_url = url("/help/article/:slug(.:format)");
export const help_center_category_path = path("/help/category/:slug(.:format)");
export const help_center_category_url = url("/help/category/:slug(.:format)");
export const help_center_contact_path = path("/help/contact(.:format)");

// Dashboard navigation (components/client-components/Nav).
export const root_url = url("/");
export const dashboard_url = url("/dashboard(.:format)");
export const discover_url = url("/discover(.:format)");
export const agent_url = url("/agent(.:format)");
export const profile_url = url("/profile(.:format)");
export const pages_url = url("/pages(.:format)");
export const products_url = url("/products(.:format)");
export const collaborators_url = url("/collaborators(.:format)");
export const checkout_discounts_url = url("/checkout/discounts(.:format)");
export const checkout_form_url = url("/checkout/form(.:format)");
export const checkout_upsells_url = url("/checkout/upsells(.:format)");
export const emails_url = url("/emails(.:format)");
export const followers_url = url("/followers(.:format)");
export const workflows_url = url("/workflows(.:format)");
export const customers_url = url("/customers(.:format)");
export const sales_dashboard_url = url("/dashboard/sales(.:format)");
export const audience_dashboard_url = url("/dashboard/audience(.:format)");
export const dashboard_utm_links_url = url("/dashboard/utm_links(.:format)");
export const churn_dashboard_url = url("/dashboard/churn(.:format)");
export const affiliates_url = url("/affiliates(.:format)");
export const balance_url = url("/payouts(.:format)");
export const communities_path = path("/communities(.:format)");
export const library_url = url("/library(.:format)");
export const wishlists_url = url("/wishlists(.:format)");
export const reviews_url = url("/reviews(.:format)");
export const settings_main_url = url("/settings(.:format)");
export const settings_team_url = url("/settings/team(.:format)");
export const logout_url = url("/logout(.:format)");
export const sellers_switch_path = path("/sellers/switch(.:format)");
export const sellers_brand_accounts_path = path("/sellers/brand_accounts(.:format)");
export const dashboard_path = path("/dashboard(.:format)");

// Settings pages (WS-56) and the helpers their component graph calls (generated from config/routes.rb).
export const account_info_integrations_google_calendar_index_path = path("/integrations/google_calendar/account_info(.:format)");
export const approve_product_marketing_action_path = path("/products/:product_id/marketing_actions/:id/approve.:format");
export const calendar_list_integrations_google_calendar_index_path = path("/integrations/google_calendar/calendar_list(.:format)");
export const call_path = path("/calls/:id(.:format)");
export const cancel_product_marketing_action_path = path("/products/:product_id/marketing_actions/:id/cancel.:format");
export const change_can_contact_purchase_path = path("/purchases/:id/change_can_contact(.:format)");
export const checkout_discount_path = path("/checkout/discounts/:id(.:format)");
export const checkout_discounts_path = path("/checkout/discounts(.:format)");
export const checkout_form_path = path("/checkout/form(.:format)");
export const checkout_upsells_path = path("/checkout/upsells(.:format)");
export const checkout_upsells_product_path = path("/checkout/upsells/products/:id(.:format)");
export const checkout_upsells_products_path = path("/checkout/upsells/products(.:format)");
export const checkout_url = url("/checkout(.:format)");
export const commission_path = path("/commissions/:id(.:format)");
export const communities_integrations_circle_index_path = path("/integrations/circle/communities(.:format)");
export const complete_commission_path = path("/commissions/:id/complete(.:format)");
export const compute_discount_offer_codes_path = path("/offer_codes/compute_discount(.:format)");
export const confirm_settings_totp_path = path("/settings/totp/confirm(.:format)");
export const custom_domain_verifications_path = path("/custom_domain/verify(.:format)");
export const customer_charges_path = path("/customers/charges/:purchase_id(.:format)");
export const customer_emails_path = path("/customers/customer_emails/:purchase_id(.:format)");
export const customers_paged_path = path("/customers/paged(.:format)");
export const deactivate_account_path = path("/users/deactivate(.:format)");
export const events_track_user_action_path = path("/events/track_user_action(.:format)");
export const execute_product_marketing_action_path = path("/products/:product_id/marketing_actions/:id/execute.:format");
export const follow_user_path = path("/follow(.:format)");
export const increment_post_views_path = path("/posts/:id/increment_post_views(.:format)");
export const increment_views_link_path = path("/links/:id/increment_views(.:format)");
export const internal_product_review_video_approvals_url = url("/internal/product_review_videos/:product_review_video_id/approvals(.:format)");
export const internal_product_review_video_rejections_url = url("/internal/product_review_videos/:product_review_video_id/rejections(.:format)");
export const internal_single_customer_email_path = path("/internal/customers/:purchase_id/single_customer_email(.:format)");
export const join_server_integrations_discord_index_path = path("/integrations/discord/join_server(.:format)");
export const leave_server_integrations_discord_index_path = path("/integrations/discord/leave_server(.:format)");
export const license_key_lookup_url = url("/license-key-lookup(.:format)");
export const license_path = path("/licenses/:id(.:format)");
export const link_thumbnail_path = path("/links/:link_id/thumbnails/:id(.:format)");
export const link_thumbnails_path = path("/links/:link_id/thumbnails(.:format)");
export const link_variants_path = path("/links/:link_id/variants(.:format)");
export const login_url = url("/login(.:format)");
export const mark_as_shipped_path = path("/shipments/:purchase_id/mark_as_shipped(.:format)");
export const mcp_path = path("/mcp(.:format)");
export const missed_posts_path = path("/customers/missed_posts/:purchase_id(.:format)");
export const oauth_application_path = path("/oauth/applications/:id(.:format)");
export const oauth_applications_path = path("/oauth/applications(.:format)");
export const oauth_authorized_application_path = path("/oauth/authorized_applications/:id(.:format)");
export const oauth_redirect_integrations_discord_index_url = url("/integrations/discord/oauth_redirect(.:format)");
export const oauth_redirect_integrations_google_calendar_index_url = url("/integrations/google_calendar/oauth_redirect(.:format)");
export const paged_checkout_discounts_path = path("/checkout/discounts/paged(.:format)");
export const ping_path = path("/ping(.:format)");
export const product_marketing_actions_path = path("/products/:product_id/marketing_actions.:format");
export const product_purchases_path = path("/customers/product_purchases/:purchase_id(.:format)");
export const product_remaining_call_availabilities_path = path("/products/:product_id/remaining_call_availabilities.:format");
export const product_review_path = path("/product_reviews/:id(.:format)");
export const product_review_response_path = path("/product_review_responses/:id(.:format)");
export const product_review_video_streaming_urls_path = path("/product_review_videos/:product_review_video_id/streaming_urls(.:format)");
export const product_review_videos_upload_context_path = path("/product_review_videos/upload_context(.:format)");
export const product_reviews_path = path("/product_reviews(.:format)");
export const product_reviews_set_path = path("/product_reviews/set(.:format)");
export const products_search_path = path("/products/search(.:format)");
export const profile_path = path("/profile(.:format)");
export const profile_product_path = path("/profile/products/:id(.:format)");
export const profile_third_party_analytics_url = url("/profile/:username(.:format)");
export const purchase_path = path("/purchases/:id(.:format)");
export const purchase_pings_path = path("/purchases/:purchase_id/pings(.:format)");
export const purchase_variant_path = path("/purchases/:purchase_id/variants/:variant_id(.:format)");
export const rails_direct_uploads_path = path("/rails/active_storage/direct_uploads(.:format)");
export const refund_purchase_path = path("/purchases/:id/refund(.:format)");
export const regenerate_recovery_codes_settings_totp_path = path("/settings/totp/regenerate_recovery_codes(.:format)");
export const registration_options_settings_passkeys_path = path("/settings/passkeys/registration_options(.:format)");
export const resend_confirmation_email_settings_main_path = path("/settings/resend_confirmation_email(.:format)");
export const resend_invitation_settings_team_invitation_path = path("/settings/team/invitations/:id/resend_invitation.:format");
export const resend_receipt_purchase_path = path("/purchases/:id/resend_receipt(.:format)");
export const restore_settings_team_invitation_path = path("/settings/team/invitations/:id/restore.:format");
export const restore_settings_team_member_path = path("/settings/team/members/:id/restore.:format");
export const revoke_access_purchase_path = path("/purchases/:id/revoke_access(.:format)");
export const root_path = path("/");
export const s3_utility_cdn_url_for_blob_path = path("/s3_utility/cdn_url_for_blob(.:format)");
export const s3_utility_current_utc_time_string_path = path("/s3_utility/current_utc_time_string(.:format)");
export const s3_utility_generate_multipart_signature_path = path("/s3_utility/generate_multipart_signature(.:format)");
export const selection_discounts_offer_codes_path = path("/offer_codes/selection_discounts(.:format)");
export const send_for_purchase_path = path("/posts/:id/send_for_purchase/:purchase_id(.:format)");
export const server_info_integrations_discord_index_path = path("/integrations/discord/server_info(.:format)");
export const settings_advanced_path = path("/settings/advanced(.:format)");
export const settings_application_access_tokens_path = path("/settings/applications/:application_id/access_tokens(.:format)");
export const settings_authorized_applications_path = path("/settings/authorized_applications(.:format)");
export const settings_billing_path = path("/settings/billing(.:format)");
export const settings_main_path = path("/settings(.:format)");
export const settings_passkey_path = path("/settings/passkeys/:id(.:format)");
export const settings_passkeys_path = path("/settings/passkeys(.:format)");
export const settings_password_path = path("/settings/password(.:format)");
export const settings_payments_path = path("/settings/payments(.:format)");
export const settings_profile_path = path("/settings/profile(.:format)");
export const settings_social_connections_path = path("/settings/social_connections(.:format)");
export const settings_team_invitation_path = path("/settings/team/invitations/:id.:format");
export const settings_team_invitations_path = path("/settings/team/invitations.:format");
export const settings_team_member_path = path("/settings/team/members/:id.:format");
export const settings_team_path = path("/settings/team(.:format)");
export const settings_third_party_analytics_path = path("/settings/third_party_analytics(.:format)");
export const settings_totp_path = path("/settings/totp(.:format)");
export const signup_url = url("/signup(.:format)");
export const space_groups_integrations_circle_index_path = path("/integrations/circle/space_groups(.:format)");
export const statistics_checkout_discount_path = path("/checkout/discounts/:id/statistics(.:format)");
export const test_pings_path = path("/test_pings(.:format)");
export const third_party_analytics_url = url("/:link_id(.:format)");
export const track_user_action_link_path = path("/links/:id/track_user_action(.:format)");
export const undo_revoke_access_purchase_path = path("/purchases/:id/undo_revoke_access(.:format)");
export const unlink_twitter_settings_connections_path = path("/settings/connections/unlink_twitter(.:format)");
export const unsubscribe_by_seller_subscription_path = path("/subscriptions/:id/unsubscribe_by_seller(.:format)");
export const user_instagram_omniauth_authorize_path = path("/users/auth/instagram(.:format)");
export const user_invalidate_active_sessions_path = path("/user/invalidate_active_sessions(.:format)");
export const user_twitter_omniauth_authorize_path = path("/users/auth/twitter(.:format)");
export const user_youtube_omniauth_authorize_path = path("/users/auth/youtube(.:format)");
export const wishlist_followers_path = path("/wishlists/:wishlist_id/followers(.:format)");
export const wishlist_path = path("/wishlists/:id(.:format)");
export const wishlist_product_path = path("/wishlists/:wishlist_id/products/:id(.:format)");
export const wishlist_products_path = path("/wishlists/:wishlist_id/products(.:format)");
export const wishlists_path = path("/wishlists(.:format)");

// Authentication pages (devise_for / devise_scope, two-factor, secure_url_redirect).
export const login_path = path("/login(.:format)");
export const login_passkey_path = path("/login/passkey(.:format)");
export const login_passkey_options_path = path("/login/passkey/options(.:format)");
export const signup_path = path("/signup(.:format)");
export const new_user_password_path = path("/users/forgot_password/new(.:format)");
export const two_factor_authentication_path = path("/two-factor(.:format)");
export const two_factor_authentication_url = url("/two-factor(.:format)");
export const resend_authentication_token_path = path("/two-factor/resend_authentication_token(.:format)");
export const switch_to_email_two_factor_path = path("/two-factor/switch_to_email(.:format)");
export const switch_to_recovery_two_factor_path = path("/two-factor/switch_to_recovery(.:format)");
export const switch_to_authenticator_two_factor_path = path("/two-factor/switch_to_authenticator(.:format)");
export const secure_url_redirect_path = path("/secure_url_redirect(.:format)");
export const user_apple_omniauth_authorize_path = path("/users/auth/apple(.:format)");
export const user_google_oauth2_omniauth_authorize_path = path("/users/auth/google_oauth2(.:format)");
export const user_stripe_connect_omniauth_authorize_path = path("/users/auth/stripe_connect(.:format)");

// Public pages and the marketing shell they render (WS-55).
export const api_path = path("/api(.:format)");
export const widgets_path = path("/widgets(.:format)");
export const charge_data_path = path("/charge_data(.:format)");
export const license_key_lookup_data_path = path("/license_key_lookup_data(.:format)");
export const paypal_charge_data_path = path("/paypal_charge_data(.:format)");
export const follow_user_from_embed_form_path = path("/follow_from_embed_form");
export const follow_user_from_embed_form_url = url("/follow_from_embed_form");
export const custom_domain_subscribe_url = url("/subscribe(.:format)");
export const discover_path = path("/discover(.:format)");
export const about_path = path("/about(.:format)");
export const gumclaw_path = path("/gumclaw(.:format)");
export const features_path = path("/features(.:format)");
export const pricing_path = path("/pricing(.:format)");
export const terms_path = path("/terms(.:format)");
export const privacy_path = path("/privacy(.:format)");
export const small_bets_path = path("/small-bets(.:format)");
export const gumroad_blog_root_path = path("/blog(.:format)");
export const gumroad_blog_post_path = path("/blog/p/:slug(.:format)");
export const gumroad_blog_post_url = url("/blog/p/:slug(.:format)");
export const pages_path = path("/pages(.:format)");
export const new_page_path = path("/pages/new(.:format)");
export const edit_page_path = path("/pages/:slug/edit(.:format)");
export const page_path = path("/pages/:slug(.:format)");
export const preview_page_path = path("/pages/:slug/preview(.:format)");
export const products_page_path = path("/pages/:slug/products(.:format)");
export const products_path = path("/products(.:format)");

// Audience pages: UTM links, followers, workflows and emails (WS-57).
export const audience_dashboard_path = path("/dashboard/audience(.:format)");
export const sales_dashboard_path = path("/dashboard/sales(.:format)");
export const churn_dashboard_path = path("/dashboard/churn(.:format)");
export const dashboard_utm_links_path = path("/dashboard/utm_links(.:format)");
export const dashboard_utm_link_path = path("/dashboard/utm_links/:id(.:format)");
export const new_dashboard_utm_link_path = path("/dashboard/utm_links/new(.:format)");
export const edit_dashboard_utm_link_path = path("/dashboard/utm_links/:id/edit(.:format)");

// Helpers the audience pages reach through the shared components (generated from config/routes.rb named routes).

export const audience_export_path = path("/audience/export(.:format)");
export const custom_domain_view_post_path = path("/p/:slug(.:format)");
export const customer_sale_path = path("/customers/sale/:purchase_id(.:format)");
export const drafts_emails_path = path("/emails/drafts(.:format)");
export const edit_email_path = path("/emails/:id/edit(.:format)");
export const edit_workflow_path = path("/workflows/:id/edit(.:format)");
export const email_path = path("/emails/:id(.:format)");
export const emails_path = path("/emails(.:format)");
export const follower_path = path("/followers/:id(.:format)");
export const followers_path = path("/followers(.:format)");
export const internal_installment_audience_count_path = path("/internal/installments/:id/audience_count(.:format)");
export const internal_installment_clicked_urls_path = path("/internal/installments/:id/clicked_urls(.:format)");
export const internal_installment_non_opener_resend_path = path("/internal/installments/:id/non_opener_resend(.:format)");
export const internal_installment_preview_email_path = path("/internal/installments/:id/preview_email(.:format)");
export const internal_installment_recipient_count_path = path("/internal/installments/recipient_count(.:format)");
export const internal_installment_remaining_send_path = path("/internal/installments/:id/remaining_send(.:format)");
export const new_email_path = path("/emails/new(.:format)");
export const new_product_path = path("/products/new(.:format)");
export const new_workflow_path = path("/workflows/new(.:format)");
export const profile_section_path = path("/profile_sections/:id(.:format)");
export const profile_sections_path = path("/profile_sections(.:format)");
export const published_emails_path = path("/emails/published(.:format)");
export const scheduled_emails_path = path("/emails/scheduled(.:format)");
export const short_link_url = url("/l/:id(.:format)");
export const workflow_emails_path = path("/workflows/:workflow_id/emails(.:format)");
export const workflow_path = path("/workflows/:id(.:format)");
export const workflows_path = path("/workflows(.:format)");

// Seller dashboard pages (WS-58).
export const affiliates_path = path("/affiliates(.:format)");
export const onboarding_affiliates_path = path("/affiliates/onboarding(.:format)");
export const collaborators_path = path("/collaborators(.:format)");
export const collaborator_path = path("/collaborators/:id(.:format)");
export const new_collaborator_path = path("/collaborators/new(.:format)");
export const edit_collaborator_path = path("/collaborators/:id/edit(.:format)");
export const collaborators_incomings_path = path("/collaborators/incomings(.:format)");
export const affiliate_path = path("/affiliates/:id(.:format)");
export const new_affiliate_path = path("/affiliates/new(.:format)");
export const edit_affiliate_path = path("/affiliates/:id/edit(.:format)");
export const export_affiliates_path = path("/affiliates/export(.:format)");
export const statistics_affiliate_path = path("/affiliates/:id/statistics(.:format)");
export const affiliate_request_path = path("/affiliate_requests/:id(.:format)");
export const approve_all_affiliate_requests_path = path("/affiliate_requests/approve_all(.:format)");
export const affiliate_requests_onboarding_form_path = path("/affiliate_requests/onboarding_form(.:format)");
export const custom_domain_new_affiliate_request_url = url("/affiliates(.:format)");
export const balance_path = path("/payouts(.:format)");
export const tax_center_path = path("/payouts/taxes(.:format)");
export const download_tax_form_path = path("/payouts/taxes/:year/:form_type/download(.:format)");
export const tax_form_transaction_report_path = path("/payouts/taxes/:year/transaction_report(.:format)");

// Buyer pages (forgot password, subscription magic link, invoices, library, wishlists, reviews).
export const user_password_path = path("/users/forgot_password(.:format)");
export const edit_user_password_path = path("/users/forgot_password/edit(.:format)");
export const subscription_magic_link_path = path("/subscriptions/:subscription_id/magic_link(.:format)");
export const new_subscription_magic_link_path = path("/subscriptions/:subscription_id/magic_link/new(.:format)");
export const confirm_purchase_invoice_path = path("/purchases/:purchase_id/invoice/confirm(.:format)");
export const new_purchase_invoice_path = path("/purchases/:purchase_id/invoice/new(.:format)");
export const library_path = path("/library(.:format)");
export const reviews_path = path("/reviews(.:format)");
export const wishlists_following_index_path = path("/wishlists/following(.:format)");
export const remove_credit_card_settings_payments_path = path("/settings/payments/remove_credit_card(.:format)");
export const set_country_settings_payments_path = path("/settings/payments/set_country(.:format)");
export const settings_beneficial_owner_path = path("/settings/beneficial_owners/:id(.:format)");
export const settings_beneficial_owners_path = path("/settings/beneficial_owners(.:format)");
export const settings_guardian_path = path("/settings/guardians/:id(.:format)");
export const settings_guardians_path = path("/settings/guardians(.:format)");
export const disconnect_settings_stripe_path = path("/settings/stripe/disconnect(.:format)");
export const opt_in_to_au_backtax_collection_settings_payments_path = path("/settings/payments/opt_in_to_au_backtax_collection(.:format)");
export const remediation_settings_payments_path = path("/settings/payments/remediation(.:format)");
export const cart_items_count_path = path("/cart_items_count(.:format)");
export const cart_items_count_url = url("/cart_items_count(.:format)");
export const custom_domain_post_comments_path = path("/posts/:post_id/comments(.:format)");
export const custom_domain_create_post_comment_path = path("/posts/:post_id/comments(.:format)");
export const custom_domain_update_post_comment_path = path("/posts/:post_id/comments/:id(.:format)");
export const custom_domain_delete_post_comment_path = path("/posts/:post_id/comments/:id(.:format)");
export const custom_domain_create_affiliate_request_path = path("/affiliate_requests(.:format)");
export const instant_payouts_path = path("/instant_payouts(.:format)");
export const payouts_exportables_path = path("/payouts/exportables(.:format)");
export const payouts_exports_path = path("/payouts/exports(.:format)");

// Agent page (WS-75).
export const internal_agent_custom_html_preview_path = path("/internal/agent/custom_html_preview(.:format)");
export const internal_agent_messages_path = path("/internal/agent/messages(.:format)");
export const internal_agent_messages_stream_path = path("/internal/agent/messages/stream(.:format)");
export const internal_agent_turn_status_path = path("/internal/agent/turns/:client_turn_id(.:format)");
export const internal_agent_actions_path = path("/internal/agent/actions(.:format)");
export const internal_agent_action_status_path = path("/internal/agent/actions/status(.:format)");
export const internal_agent_custom_html_preview_document_path = path("/internal/agent/custom_html_previews/:token(.:format)");

// Agent data layer (WS-75).
export const internal_agent_conversations_latest_path = path("/internal/agent/conversations/latest(.:format)");

// Piracy reports and the products tabs (WS-75).
export const products_affiliated_index_path = path("/products/affiliated(.:format)");
export const products_archived_index_path = path("/products/archived(.:format)");
export const products_collabs_path = path("/products/collabs(.:format)");
export const new_piracy_report_path = path("/dashboard/piracy_reports/new(.:format)");
export const piracy_report_path = path("/dashboard/piracy_reports/:id(.:format)");
export const piracy_reports_path = path("/dashboard/piracy_reports(.:format)");
export const sign_piracy_report_path = path("/dashboard/piracy_reports/:id/sign(.:format)");
export const cancel_piracy_report_path = path("/dashboard/piracy_reports/:id/cancel(.:format)");

// Dispute evidence page (WS-75).
export const purchase_dispute_evidence_path = path("/purchases/:purchase_id/dispute_evidence(.:format)");
export const success_purchase_dispute_evidence_path = path("/purchases/:purchase_id/dispute_evidence/success(.:format)");
export const unpublish_link_path = path("/links/:id/unpublish(.:format)");
export const url_redirect_download_archive_path = path("/zip/:id(.:format)");
export const url_redirect_download_product_files_path = path("/r/:id/product_files(.:format)");
export const url_redirect_media_urls_path = path("/media_urls/:id(.:format)");
export const url_redirect_play_path = path("/d/:id/play(.:format)");
export const url_redirect_save_last_content_page_path = path("/r/:id/save_last_content_page(.:format)");
// Url redirect pages (WS-81).
export const confirm_redirect_path = path("/confirm-redirect(.:format)");
export const community_chat_messages_path = path("/communities/:community_id/chat_messages(.:format)");
export const community_chat_message_path = path("/communities/:community_id/chat_messages/:id(.:format)");
export const community_last_read_chat_message_path = path("/communities/:community_id/last_read_chat_message(.:format)");
export const community_notification_settings_path = path("/communities/:community_id/notification_settings(.:format)");
export const community_path = path("/communities/:seller_id/:community_id(.:format)");
export const library_archive_path = path("/library/purchase/:id/archive(.:format)");
export const library_unarchive_path = path("/library/purchase/:id/unarchive(.:format)");
export const library_delete_path = path("/library/purchase/:id/delete(.:format)");
export const add_purchase_to_library_path = path("/add_purchase_to_library(.:format)");
export const cancel_dropbox_file_upload_path = path("/dropbox_files/cancel_upload/:id(.:format)");
export const consumption_analytics_path = path("/consumption_analytics(.:format)");
export const create_dropbox_file_path = path("/dropbox_files/create(.:format)");
export const customers_link_id_path = path("/customers/:link_id(.:format)");
export const disable_downloads_for_all_files_link_path = path("/links/:id/disable_downloads_for_all_files(.:format)");
export const download_folder_archive_path = path("/product_files_utility/folder_archive/:folder_id(.:format)");
export const download_product_files_path = path("/product_files_utility/product_files/:product_id(.:format)");
export const dropbox_files_path = path("/dropbox_files(.:format)");
export const edit_bundle_content_path = path("/bundles/:bundle_id/content/edit(.:format)");
export const internal_product_existing_product_files_path = path("/internal/products/:product_id/existing_product_files(.:format)");
export const internal_product_product_posts_path = path("/internal/products/:product_id/product_posts(.:format)");
export const link_asset_preview_path = path("/links/:link_id/asset_previews/:id(.:format)");
export const link_asset_previews_path = path("/links/:link_id/asset_previews(.:format)");
export const link_path = path("/links/:id(.:format)");
export const manage_subscription_url = url("/subscriptions/:id/manage(.:format)");
export const media_locations_path = path("/media_locations(.:format)");
export const new_purchase_invoice_url = url("/purchases/:purchase_id/invoice/new(.:format)");
export const price_check_product_path = path("/products/:id/price_check(.:format)");
export const product_builds_path = path("/products/:product_id/builds.:format");
export const product_duplicate_path = path("/product_duplicates/:id(.:format)");
export const product_duplicates_path = path("/product_duplicates(.:format)");
export const product_marketing_abandoned_cart_path = path("/products/:product_id/marketing_abandoned_cart.:format");
export const product_waitlist_email_path = path("/products/:product_id/waitlist_email.:format");
export const products_archived_path = path("/products/archived/:id(.:format)");
export const promote_product_build_path = path("/products/:product_id/builds/:id/promote.:format");
export const publish_link_path = path("/links/:id/publish(.:format)");
export const purchase_custom_fields_path = path("/purchase_custom_fields(.:format)");
export const receipt_purchase_url = url("/purchases/:id/receipt(.:format)");
export const recommended_products_url = url("/recommended_products(.:format)");
export const sample_membership_price_change_email_path = path("/links/:id/send_sample_price_change_email(.:format)");
export const save_to_library_path = path("/save_to_library(.:format)");
export const send_to_kindle_path = path("/r/:id/send_to_kindle(.:format)");
export const global_affiliates_product_eligibility_path = path("/global_affiliates/product_eligibility/:url(.:format)");
export const products_affiliated_path = path("/products/affiliated/:id(.:format)");
export const internal_ai_product_details_generations_path = path("/internal/ai_product_details_generations(.:format)");
export const links_path = path("/links(.:format)");
export const settings_dismiss_ai_product_generation_promo_path = path("/settings/dismiss_ai_product_generation_promo(.:format)");
export const analytics_data_by_date_path = path("/analytics/data/by_date(.:format)");
export const analytics_data_by_state_path = path("/analytics/data/by_state(.:format)");
export const analytics_data_by_referral_path = path("/analytics/data/by_referral(.:format)");
export const export_purchases_path = path("/purchases/export(.:format)");
export const tags_path = path("/tags(.:format)");
export const edit_link_path = path("/products/:id/edit(.:format)");
export const internal_product_receipt_preview_path = path("/internal/products/:product_id/receipt_preview(.:format)");
export const internal_product_public_files_path = path("/internal/product_public_files(.:format)");
export const custom_domain_coffee_url = url("/coffee(.:format)");
export const edit_link_url = url("/products/:id/edit(.:format)");
export const sections_link_path = path("/links/:id/sections(.:format)");
export const checkout_path = path("/checkout(.:format)");
export const generate_braintree_transient_customer_token_path = path("/braintree/generate_transient_customer_token(.:format)");
export const stripe_setup_intents_path = path("/stripe/setup_intents(.:format)");
export const billing_agreement_paypal_path = path("/paypal/billing_agreement(.:format)");
export const billing_agreement_token_paypal_path = path("/paypal/billing_agreement_token(.:format)");
export const braintree_client_token_path = path("/braintree/client_token(.:format)");
export const confirm_purchase_path = path("/purchases/:id/confirm(.:format)");
export const customer_surcharges_path = path("/customer_surcharge(.:format)");
export const orders_path = path("/orders(.:format)");
export const prepare_orders_path = path("/orders/prepare(.:format)");
export const confirm_order_path = path("/orders/:id/confirm(.:format)");
export const confirm_error_order_path = path("/orders/:id/confirm_error(.:format)");
export const finalize_order_path = path("/orders/:id/finalize(.:format)");
export const receipt_purchase_path = path("/purchases/:id/receipt(.:format)");
export const connect_paypal_path = path("/paypal/connect(.:format)");
export const discover_search_autocomplete_path = path("/discover_search_autocomplete(.:format)");
export const dashboard_download_tax_form_path = path("/dashboard/download_tax_form(.:format)");
export const dashboard_dismiss_getting_started_checklist_path = path("/dashboard/dismiss_getting_started_checklist(.:format)");
export const posts_path = path("/posts(.:format)");
export const short_link_path = path("/l/:id(.:format)");
