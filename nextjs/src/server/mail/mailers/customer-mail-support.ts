// What CustomerMailer's methods share: the seller's mailer level, the customers-domain delivery
// options, `from_email_address_with_name`, and the rows the views read.
import { domainConfig } from "../../infra/domain.ts";
import { getRedis } from "../../infra/redis.ts";
import { isBlank } from "../../html/text-helper.ts";
import { railsCache } from "../../cache/rails-cache.ts";
import { RubySymbol } from "../../cache/marshal.ts";
import { INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX } from "../../models/user.ts";
import { type MailerDeps } from "../application-mailer.ts";
import { type DeliveryMethodOptions, type MailerLevel, mailDomains, randomDeliveryMethodOptions } from "../mailer-info.ts";
import { formattedDollarAmount } from "../../models/concerns/currency-helper.ts";
import { rubyJsonParse } from "../../models/concerns/serialized-columns.ts";
import { linkTo } from "../view-helpers.ts";
import { MailViewNotPortedError } from "../views.ts";

export type UserRow = {
  id: number | bigint;
  name: string | null;
  username: string | null;
  email: string | null;
  unconfirmed_email: string | null;
  support_email: string | null;
  external_id: string | null;
};

export type LinkRow = {
  id: number | bigint;
  user_id: number | bigint;
  name: string;
  unique_permalink: string | null;
  custom_permalink: string | null;
  support_email: string | null;
  json_data: string | null;
};

const MAILER_LEVEL_KEY = (userId: number | bigint) => `creator_mailer_level_${String(userId)}`;
const MAILER_LEVEL_CACHE_TTL_SECONDS = 2 * 24 * 60 * 60;

// User#mailer_level: Rails.cache, then the Redis namespace. A seller in neither would be summed up in
// Elasticsearch (User::Stats#sales_cents_total), which Node does not do, so that mail stays with Rails,
// whose `fetch` then fills both caches for the next one.
export async function mailerLevel(userId: number | bigint, deps: MailerDeps): Promise<MailerLevel> {
  if (deps.mailerLevel) {
    const level = await deps.mailerLevel(userId);
    if (level !== null) return level;
  } else {
    const key = MAILER_LEVEL_KEY(userId);
    const cached = await railsCache().read(key, { expiresIn: MAILER_LEVEL_CACHE_TTL_SECONDS });
    const stored = cached instanceof RubySymbol ? cached.name : await getRedis("main").get(`user_mailer_redis_namespace:${key}`);
    if (stored === "level_1" || stored === "level_2") return stored;
    if (stored !== null && stored !== undefined && !isBlank(String(stored))) throw new MailViewNotPortedError(`mailer level ${String(stored)}`);
  }
  throw new MailViewNotPortedError("mailer level that is in neither Rails.cache nor Redis");
}

// MailerInfo.random_delivery_method_options(domain: :customers, seller:, to:)
export async function customersDeliveryOptions(seller: Pick<UserRow, "id"> | null, to: string | null, deps: MailerDeps): Promise<DeliveryMethodOptions> {
  const sellerMailerLevel = seller ? await mailerLevel(seller.id, deps) : undefined;
  return randomDeliveryMethodOptions("customers", { to, ...(sellerMailerLevel ? { sellerMailerLevel } : {}) }, deps.router);
}

// MailerHelper#from_email_address_with_name: ASCII names only; the Latin-script rule that swaps in
// "Gumroad" is not ported, and the encoder only accepts plain words, which is all that passes.
export function fromEmailAddressWithName(name: string | null, email: string): string {
  if (name !== null && /[^\x20-\x7e\n]/u.test(name)) throw new MailViewNotPortedError("non-ASCII sender name");
  const display = isBlank(name) ? "Gumroad" : name!.replaceAll("\n", "").replace(new RegExp(INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX.source, "gu"), "").trim();
  if (display === "") throw new MailViewNotPortedError("sender name that is empty once cleaned");
  return `${display} <${email}>`;
}

export const customersNoreply = () => `noreply@${mailDomains().customers}`;

// User#username: the external id stands in for a seller without one.
const sellerUsername = (user: UserRow) => (isBlank(user.username) ? user.external_id : user.username);

// User#support_or_form_email
export const supportOrFormEmail = (user: UserRow): string | null => (isBlank(user.support_email) ? formEmail(user) : user.support_email);
// User#form_email
export const formEmail = (user: UserRow): string | null => (!isBlank(user.unconfirmed_email) ? user.unconfirmed_email : !isBlank(user.email) ? user.email : null);
// Link#support_email_or_default
export const supportEmailOrDefault = (link: LinkRow, user: UserRow): string | null => link.support_email ?? supportOrFormEmail(user);

// Link#long_url with no options: short_link_url(general_permalink, host:). Rails escapes the path
// segment; permalinks are word characters and dashes, so anything else is refused.
export function productLongUrl(link: LinkRow, user: UserRow): string {
  const permalink = isBlank(link.custom_permalink) ? link.unique_permalink : link.custom_permalink;
  if (permalink === null || !/^[A-Za-z0-9_-]+$/u.test(permalink)) throw new MailViewNotPortedError("permalink that needs URL escaping");
  const { protocol, domain, rootDomain } = domainConfig();
  const username = sellerUsername(user);
  const host = isBlank(username) ? `${protocol}://${domain}` : `${protocol}://${username!.replaceAll("_", "-")}.${rootDomain}`;
  return `${host}/l/${permalink}`;
}

// CurrencyHelper#formatted_price("usd", cents): Money with no_cents_if_whole. Other currencies go through
// CURRENCY_CHOICES symbols and Money's per-currency rules, which are not ported.
export function formattedUsdPrice(cents: number | bigint | null): string {
  return formattedDollarAmount(cents ?? 0);
}

// CurrencyHelper#format_just_price_in_cents for a USD amount.
export function formatJustUsdPriceInCents(cents: number | bigint | null): string {
  const price = formattedUsdPrice(cents);
  return price === "$0.99" ? "99¢" : price;
}

// ProductsHelper#view_content_button_text: json_data's custom text, else "View content".
export function viewContentButtonText(link: Pick<LinkRow, "json_data">): string {
  return jsonDataString(link.json_data, "custom_view_content_button_text") ?? "View content";
}

// A String attribute of a serialized json_data column, nil when blank. Another type is refused:
// Ruby would call `presence` and print whatever `to_s` gives.
export function jsonDataString(raw: string | null, key: string): string | null {
  if (raw === null || isBlank(raw)) return null;
  const parsed = rubyJsonParse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new MailViewNotPortedError("json_data that is not an object");
  const value = (parsed as Record<string, unknown>)[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new MailViewNotPortedError(`json_data ${key} that is not a string`);
  return isBlank(value) ? null : value;
}

// shared/_download_button.html.erb for a purchase that is not a rental: one "button primary" link.
export function downloadButton(label: string, url: string): string {
  return `
  <table class="reset" role="presentation" align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;display:table;">
    <tbody style="width:100%;display:table-row-group;">
      <tr style="width:100%;display:table-row;">
        <td align="center" width="100%" style="width:100%;display:table-cell;">
          ${linkTo(label, url, { class: "button primary", style: "display:inline-block;box-sizing:border-box;width:100%;" })}
        </td>
      </tr>
    </tbody>
  </table>
`;
}
