// MailerHelper's sender line and GumroadAddress, as the workflow and email forms show them.
import { getConfig } from "../../infra/config.ts";
import { railsEnv } from "../../infra/rails-env.ts";
import { countryByAlpha2 } from "../../models/compliance-countries.ts";
import { NotPortedError } from "../not-ported.ts";

// config/initializers/mailer.rb
const creatorContactingCustomersMailDomain = () =>
  railsEnv() === "production"
    ? getConfig("CREATOR_CONTACTING_CUSTOMERS_MAIL_DOMAIN_PROD", "creators.gumroad.com")
    : getConfig("CREATOR_CONTACTING_CUSTOMERS_MAIL_DOMAIN_DEV", "staging.creators.gumroad.com");

// MailerHelper#creators_from_email_address
export const creatorsFromEmailAddress = (username: string | null): string =>
  `${username && /[^\s]/u.test(username) ? username : "creators"}@${creatorContactingCustomersMailDomain()}`;

// MailerHelper::EXTENDED_LATIN_AND_SYMBOL_REGEX: a Latin-1/Extended-A/B letter (or a literal "|", which
// the original character class also lists) with a punctuation character, in either order.
const EXTENDED_LATIN = "[\\u0080-\\u024f|]";
const PUNCTUATION = "[\\p{P}$+<=>^`|~]";
const EXTENDED_LATIN_AND_SYMBOL = new RegExp(`(${EXTENDED_LATIN}.*${PUNCTUATION})|(${PUNCTUATION}.*${EXTENDED_LATIN})`, "su");

// MailerHelper#from_email_address_name
function fromEmailAddressName(name: string): string {
  if (/[^\s]/u.test(name) && !EXTENDED_LATIN_AND_SYMBOL.test(name)) return name.replaceAll("\n", "").replaceAll(":", "").trim();
  return "Gumroad";
}

// Mail::Utilities.quote_phrase: a display name with an RFC 5322 special, a control or a non-ASCII byte is
// wrapped in double quotes.
function quotePhrase(name: string): string {
  if (!/[()<>[\]:;@\\,."\u0000-\u001f\u007f-￿]/u.test(name)) return name;
  const match = /^"(.*?)"$/u.exec(name);
  const unquoted = match ? match[1]!.replace(/\\(.)/gu, "$1") : name;
  return `"${unquoted.replace(/[\\"]/gu, (character) => `\\${character}`)}"`;
}

// MailerHelper#from_address_with_name
export function fromAddressWithName(name: string | null, email: string): string {
  const displayName = fromEmailAddressName(name ?? "");
  if (/\r/u.test(displayName)) throw new NotPortedError("a sender name with a carriage return");
  return /[^\s]/u.test(displayName) ? `${quotePhrase(displayName)} <${email}>` : email;
}

// GumroadAddress.full
export function gumroadAddress(): string {
  const zip = getConfig("ADDRESS_ZIP", "94104");
  const country = countryByAlpha2(getConfig("ADDRESS_COUNTRY", "US"));
  if (!country) throw new NotPortedError("GumroadAddress with an unknown ADDRESS_COUNTRY");
  return `${getConfig("ADDRESS_STREET", "548 Market St")}, ${getConfig("ADDRESS_CITY", "San Francisco")}, ${getConfig("ADDRESS_STATE", "CA")} ${zip}-${getConfig("ADDRESS_ZIP_PLUS_FOUR", "5401")}, ${country.alpha3}`;
}
