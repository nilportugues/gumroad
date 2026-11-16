// Ports of GstValidationService (IRAS), QstValidationService (Revenu Quebec) and TaxIdValidationService (taxid.pro) with the
// `rescue` of RegionalVatIdValidationService#process, recorded by scripts/golden/tax-id-vendors.rb. Each answer is memoised
// for ten minutes in Rails.cache under the key Ruby uses, so the two stacks share it. The Vatstack validators (ABN, MVA) are
// ported without that memo: Ruby caches the whole HTTParty::Response (a Marshal dump), which Node can neither write nor read, so
// every cart line asks Vatstack. VIES through valvat is `vies-vat-id.ts`.
import { type RailsCache, railsCache } from "../cache/rails-cache.ts";
import { getConfig } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";

import { isBlank } from "./regional-vat-id-shape.ts";

export type VendorTaxIdService =
  | "GstValidationService"
  | "QstValidationService"
  | "TaxIdValidationService"
  | "AbnValidationService"
  | "MvaValidationService";

export type VendorTaxIdOutcome =
  | { kind: "valid"; valid: boolean }
  // An answer on which Ruby raises something RegionalVatIdValidationService does not rescue (a 500 in Rails): left to Rails.
  | { kind: "unsupported"; reason: string };

export type VendorTaxIdDeps = { fetch?: typeof fetch; cache?: RailsCache };

const CACHE_TTL_SECONDS = 600;
export const REQUEST_TIMEOUT_MS = 5000;

// HTTParty::Parser::SupportedFormats, matched by `String#include?` in this order.
const CONTENT_TYPE_FORMATS: readonly (readonly [string, "xml" | "json" | "string" | "csv"])[] = [
  ["text/xml", "xml"],
  ["application/xml", "xml"],
  ["application/json", "json"],
  ["application/vnd.api+json", "json"],
  ["application/hal+json", "json"],
  ["text/json", "json"],
  ["application/javascript", "string"],
  ["text/javascript", "string"],
  ["text/html", "string"],
  ["text/plain", "string"],
  ["text/csv", "csv"],
  ["application/csv", "csv"],
  ["text/comma-separated-values", "csv"],
];

class Unsupported extends Error {}
// What RegionalVatIdValidationService rescues (a dropped connection, a timeout, JSON::ParserError): false, nothing cached.
class Rescued extends Error {}

const unsupported = (reason: string): never => {
  throw new Unsupported(reason);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Parsed = { kind: "nil" } | { kind: "string"; text: string } | { kind: "json"; value: unknown };

// HTTParty::Parser#parse: a blank body or "null" is nil whatever the type; the BOM is dropped; JSON is parsed with quirks.
function parseBody(contentType: string | null, body: string): Parsed {
  if (body === "null" || /^[\t\n\v\f\r \0]*$/u.test(body)) return { kind: "nil" };
  const text = body; // Ruby drops a leading BOM here; Response#text() already has.
  const format =
    contentType === null ? undefined : CONTENT_TYPE_FORMATS.find(([mime]) => contentType.includes(mime))?.[1];
  if (format === "xml" || format === "csv") return unsupported(`a ${format} answer`);
  if (format !== "json") return { kind: "string", text };
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    // Ruby parses NaN and Infinity (allow_nan), JSON.parse does not: not a ParserError there.
    if (/\b(?:NaN|-?Infinity)\b/u.test(text)) return unsupported("JSON with NaN or Infinity");
    throw new Rescued();
  }
}

// Addressable::Template expansion of `{var}`: everything but the RFC 3986 unreserved characters is percent-encoded.
const expand = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

// ActiveSupport's JSON encoding escapes these on top of JSON.stringify (U+2028 and U+2029 are spelled by code point).
const RAILS_JSON_ESCAPES = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "gu");
const railsJson = (value: unknown): string =>
  JSON.stringify(value).replace(RAILS_JSON_ESCAPES, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const irasEndpoint = () => {
  const override = process.env.IRAS_ENDPOINT?.trim();
  if (override) return override;
  return railsEnv() === "production"
    ? "https://apiservices.iras.gov.sg/iras/prod/GSTListing/SearchGSTRegistered"
    : "https://apisandbox.iras.gov.sg/iras/sb/GSTListing/SearchGSTRegistered";
};
// The overrides let a replay stand in for the vendors (as TAXJAR_ENDPOINT does for TaxJar).
export const revenuQuebecBase = () => process.env.REVENU_QUEBEC_ENDPOINT?.trim() || "https://svcnab2b.revenuquebec.ca";
export const vatstackEndpoint = () =>
  process.env.VATSTACK_ENDPOINT?.trim() || "https://api.vatstack.com/v1/validations";
export const taxIdProBase = () => process.env.TAX_ID_PRO_ENDPOINT?.trim() || "https://v3.api.taxid.pro";

type Answer = { status: number; contentType: string | null; body: string };

async function call(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Answer> {
  let response: Response;
  try {
    // HTTParty follows redirects and Node would too, but a 3xx is not a recorded answer.
    response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Rescued();
  }
  if (response.status >= 300 && response.status < 400) return unsupported(`a ${response.status} redirect`);
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

// `response["returnCode"] == "10" && response["data"]["Status"] == "Registered"`; on a nil body HTTParty falls through to the header lookup.
function gstRegistered(parsed: Parsed): boolean {
  if (parsed.kind !== "json") return false;
  const root = parsed.value;
  if (root === null || typeof root === "boolean" || typeof root === "string") return false;
  if (!isRecord(root)) return unsupported("a GST answer that is not an object");
  if (root.returnCode !== "10") return false;
  const data = root.data;
  if (typeof data === "string") return false;
  if (!isRecord(data)) return unsupported("GST data that is not an object");
  return data.Status === "Registered";
}

// `response.code == 200 && response.parsed_response.dig("Resultat", "StatutSousDossierUsager") == "R"`
function qstRegistered(answer: Answer): boolean {
  if (answer.status !== 200) return false;
  const parsed = parseBody(answer.contentType, answer.body);
  if (parsed.kind !== "json" || !isRecord(parsed.value)) return unsupported("a QST answer that is not an object");
  const result = parsed.value.Resultat;
  if (result === undefined || result === null) return false;
  if (!isRecord(result)) return unsupported("a QST Resultat that is not an object");
  return result.StatutSousDossierUsager === "R";
}

// `response.code == 200 && response.parsed_response["is_valid"]`: a body Ruby reads as a String answers "is_valid" when it names it.
function taxIdProValid(answer: Answer): boolean | null | "is_valid" {
  if (answer.status !== 200) return false;
  const parsed = parseBody(answer.contentType, answer.body);
  if (parsed.kind === "nil") return unsupported("an empty taxid.pro answer");
  if (parsed.kind === "string") return parsed.text.includes("is_valid") ? "is_valid" : null;
  if (typeof parsed.value === "string") return parsed.value.includes("is_valid") ? "is_valid" : null;
  if (!isRecord(parsed.value)) return unsupported("a taxid.pro answer that is not an object");
  const valid = parsed.value.is_valid;
  if (valid === undefined || valid === null) return null;
  return typeof valid === "boolean" ? valid : unsupported("an is_valid that is not a boolean");
}

// Vatstack's `type` for each validator.
const VATSTACK_TYPE = { AbnValidationService: "au_gst", MvaValidationService: "no_vat" } as const;

// `return false if "INVALID_INPUT" == response["code"]; return false if response["valid"].nil?; response["valid"] && response["active"]`.
// A nil body falls through to the header lookup (nil); the other shapes `[]` is not defined for are Ruby's.
function vatstackVerdict(parsed: Parsed): unknown {
  if (parsed.kind === "nil") return false;
  if (parsed.kind !== "json" || !isRecord(parsed.value)) return unsupported("a Vatstack answer that is not an object");
  const { code, valid, active } = parsed.value;
  if (code === "INVALID_INPUT" || valid === undefined || valid === null) return false;
  return valid === false ? false : active;
}

const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false;

/** `RegionalVatIdValidationService#process` for a country whose validator calls a vendor and whose answer is modelled here. */
export async function validateVendorTaxId(
  service: VendorTaxIdService,
  taxId: string | null | undefined,
  countryCode: string | null | undefined,
  deps: VendorTaxIdDeps = {},
): Promise<VendorTaxIdOutcome> {
  if (taxId == null || isBlank(taxId)) return { kind: "valid", valid: false };
  const fetcher = deps.fetch ?? fetch;
  const cache = deps.cache ?? railsCache();
  try {
    if (service === "AbnValidationService" || service === "MvaValidationService") {
      const key = getConfig("VATSTACK_API_KEY");
      if (key === undefined) return { kind: "unsupported", reason: "a Vatstack key that is not configured" };
      const answer = await call(fetcher, vatstackEndpoint(), {
        method: "POST",
        headers: { "X-API-KEY": key, "content-type": "application/x-www-form-urlencoded" },
        body: `type=${VATSTACK_TYPE[service]}&query=${expand(taxId)}`,
      });
      return { kind: "valid", valid: truthy(vatstackVerdict(parseBody(answer.contentType, answer.body))) };
    }
    if (service === "GstValidationService") {
      const id = getConfig("IRAS_API_ID");
      const secret = getConfig("IRAS_API_SECRET");
      if (id === undefined || secret === undefined)
        return { kind: "unsupported", reason: "IRAS credentials that are not configured" };
      const value = await cache.fetch(`iras_validation_${taxId}`, { expiresIn: CACHE_TTL_SECONDS }, async () => {
        const answer = await call(fetcher, irasEndpoint(), {
          method: "POST",
          headers: {
            "X-IBM-Client-Id": id,
            "X-IBM-Client-Secret": secret,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: railsJson({ clientID: id, regID: taxId }),
        });
        return gstRegistered(parseBody(answer.contentType, answer.body));
      });
      return { kind: "valid", valid: truthy(value) };
    }
    if (service === "QstValidationService") {
      const value = await cache.fetch(`revenu_quebec_validation_${taxId}`, { expiresIn: CACHE_TTL_SECONDS }, async () =>
        qstRegistered(
          await call(fetcher, `${revenuQuebecBase()}/2019/02/ValidationTVQ/${expand(taxId)}`, { method: "GET" }),
        ),
      );
      return { kind: "valid", valid: truthy(value) };
    }
    if (countryCode == null || isBlank(countryCode)) return { kind: "valid", valid: false };
    const apiKey = getConfig("TAX_ID_PRO_API_KEY");
    if (apiKey === undefined) return { kind: "unsupported", reason: "a taxid.pro key that is not configured" };
    const value = await cache.fetch(
      `tax_id_validation_${taxId}_${countryCode}`,
      { expiresIn: CACHE_TTL_SECONDS },
      async () =>
        taxIdProValid(
          await call(fetcher, `${taxIdProBase()}/validate?country=${expand(countryCode)}&tin=${expand(taxId)}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
          }),
        ),
    );
    return { kind: "valid", valid: truthy(value) };
  } catch (error) {
    if (error instanceof Rescued) return { kind: "valid", valid: false };
    if (error instanceof Unsupported) return { kind: "unsupported", reason: error.message };
    throw error;
  }
}
