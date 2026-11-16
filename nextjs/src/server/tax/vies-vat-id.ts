// Port of VatValidationService (app/services/vat_validation_service.rb) over valvat 1.4.4: the id is normalised and shape-checked
// offline, a GB id stops there, and anything else asks VIES (SOAP checkVatApprox). Everything but an explicit "not registered"
// falls back to the shape check, which has already passed, so the answer is false only for a bad shape, a `valid` of false or the
// INVALID_INPUT fault. Recorded by scripts/golden/tax-id-vendors.rb (the `VIES ...` cases).
//
// REXML tolerates and rejects things Node does not model (whitespace text nodes, comments, CDATA, other prefixes, truncated
// documents). A body outside the shapes below that could still say "false" is left to Rails; one that cannot is Ruby's fallback.
import { getConfig } from "../infra/config.ts";

export type ViesOutcome = { kind: "valid"; valid: boolean } | { kind: "unsupported"; reason: string };

export type ViesDeps = { fetch?: typeof fetch };

const VIES_ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";
export const VIES_TIMEOUT_MS = 30_000;
// Valvat::Lookup::Base#fetch retries a reset connection and raises on the seventh.
const MAX_ATTEMPTS = 7;

export const viesEndpoint = () => process.env.VIES_ENDPOINT?.trim() || VIES_ENDPOINT;

const SUPPORTED_STATES = new Set(
  "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK GB".split(" "),
);
const VAT_TO_ISO_COUNTRY: Record<string, string> = { EL: "GR", XI: "GB" };

// Valvat::Syntax::VAT_PATTERNS, keyed by ISO country.
const VAT_PATTERNS: Record<string, RegExp> = {
  AT: /^ATU[0-9]{8}$/u,
  BE: /^BE[0-1][0-9]{9}$/u,
  BG: /^BG[0-9]{9,10}$/u,
  CY: /^CY(?!12)[0-69][0-9]{7}[A-Z]$/u,
  CZ: /^CZ[0-9]{8,10}$/u,
  DE: /^DE[0-9]{9}$/u,
  DK: /^DK[0-9]{8}$/u,
  EE: /^EE10[0-9]{7}$/u,
  GR: /^EL[0-9]{9}$/u,
  ES: /^ES([A-Z][0-9]{8}|[0-9]{8}[A-Z]|[A-Z][0-9]{7}[A-Z])$/u,
  FI: /^FI[0-9]{8}$/u,
  FR: /^FR[A-HJ-NP-Z0-9]{2}[0-9]{9}$/u,
  GB: /^(GB|XI)([0-9]{9}|[0-9]{12}|(HA|GD)[0-9]{3})$/u,
  HR: /^HR[0-9]{11}$/u,
  HU: /^HU[0-9]{8}$/u,
  IE: /^IE([0-9][A-Z][0-9]{5}|[0-9]{7}[A-Z]?)[A-Z]$/u,
  IT: /^IT[0-9]{11}$/u,
  LT: /^LT([0-9]{7}1[0-9]|[0-9]{10}1[0-9])$/u,
  LU: /^LU[0-9]{8}$/u,
  LV: /^LV[0-9]{11}$/u,
  MT: /^MT[0-9]{8}$/u,
  NL: /^NL[0-9]{9}B[0-9]{2}$/u,
  PL: /^PL[0-9]{10}$/u,
  PT: /^PT[0-9]{9}$/u,
  RO: /^RO[1-9][0-9]{1,9}$/u,
  SE: /^SE[0-9]{10}01$/u,
  SI: /^SI[0-9]{8}$/u,
  SK: /^SK[0-9]{10}$/u,
};

// Valvat::Utils::NORMALIZE_PATTERN: [[:punct:][:cntrl:]] and [[:space:]]; Onigmo's [[:punct:]] adds $+<=>^`|~ to \p{P}.
const NORMALIZE = /[\p{P}\p{Cc}\p{White_Space}$+<=>^`|~]+/gu;
const COUNTRY_PATTERN = /^([A-Z]{2})(.+)$/u;

export type Valvat = { raw: string; vatCountryCode: string | null; withoutCountry: string | null };

export function valvat(value: string | null | undefined): Valvat {
  const raw = (value ?? "").toUpperCase().replace(NORMALIZE, "");
  const match = COUNTRY_PATTERN.exec(raw);
  const country = match?.[1];
  const supported = country !== undefined && SUPPORTED_STATES.has(VAT_TO_ISO_COUNTRY[country] ?? country);
  return { raw, vatCountryCode: supported ? country : null, withoutCountry: supported ? (match?.[2] ?? null) : null };
}

/** Valvat#valid?: the shape check of the id's own country. */
export function validShape(vat: Valvat): boolean {
  if (vat.vatCountryCode === null) return false;
  const pattern = VAT_PATTERNS[VAT_TO_ISO_COUNTRY[vat.vatCountryCode] ?? vat.vatCountryCode];
  return pattern?.test(vat.raw) ?? false;
}

// Valvat::Lookup::VIES::BODY after `gsub(/^\s+/, "")`, with the requester always present as in VatValidationService.
function requestBody(vat: Valvat, requester: Valvat): string {
  return [
    '<soapenv:Envelope\nxmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    'xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">',
    "<soapenv:Header/>",
    "<soapenv:Body>",
    "<urn:checkVatApprox>",
    `<urn:countryCode>${vat.vatCountryCode ?? ""}</urn:countryCode>`,
    `<urn:vatNumber>${vat.withoutCountry ?? ""}</urn:vatNumber>`,
    "",
    `<urn:requesterCountryCode>${requester.vatCountryCode ?? ""}</urn:requesterCountryCode>`,
    `<urn:requesterVatNumber>${requester.withoutCountry ?? ""}</urn:requesterVatNumber>`,
    "",
    "</urn:checkVatApprox>",
    "</soapenv:Body>",
    "</soapenv:Envelope>",
    "",
  ].join("\n");
}

class Unsupported extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (text: string): string =>
  text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/gu, (_m, dec: string, hex: string, name: string) =>
    name ? ENTITIES[name]! : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16)),
  );

// Valvat::Lookup::VIES#convert_key
const convertKey = (key: string): string =>
  key
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .replace(/^trader_/u, "")
    .toLowerCase();

const NAME = "[A-Za-z][A-Za-z0-9]*";
const PREFIXED = `(?:${NAME}:)?`;
const LEAF = new RegExp(`<${PREFIXED}(${NAME})(?:>([^<>]*)</${PREFIXED}\\1>|/>)`, "yu");

type Parsed = { values: Map<string, string | null> };

// `/env:Envelope/env:Body` and the first child of Body, read into the flat hash VIES#parse builds. Only the plain shape is modelled.
function parseBody(body: string): Parsed {
  const text = body.replace(/^<\?xml[^>]*\?>/u, "");
  const envelope = /^<env:Envelope((?:\s+[A-Za-z][A-Za-z0-9:_.-]*="[^"<>]*")*)>/u.exec(text);
  if (!envelope?.[1]!.includes('xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"'))
    throw new Unsupported("an answer that is not a plain SOAP envelope");
  let rest = text.slice(envelope[0].length);
  if (!rest.endsWith("</env:Body></env:Envelope>"))
    throw new Unsupported("an answer that is not a plain SOAP envelope");
  rest = rest.slice(0, -"</env:Body></env:Envelope>".length);
  rest = rest.replace(/^<env:Header\/>/u, "");
  if (!rest.startsWith("<env:Body>")) throw new Unsupported("an answer whose Body is not plain");
  rest = rest.slice("<env:Body>".length);
  const wrapper = new RegExp(
    `^<(${PREFIXED}${NAME})((?:\\s+[A-Za-z][A-Za-z0-9:_.-]*="[^"<>]*")*)>(.*)</\\1>$`,
    "su",
  ).exec(rest);
  if (!wrapper) throw new Unsupported("an answer whose first Body element is not plain");
  const declared = new Set([...text.matchAll(/xmlns:([A-Za-z][A-Za-z0-9]*)=/gu)].map((m) => m[1]!));
  for (const prefix of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*):/gu)) {
    if (!declared.has(prefix[1]!) && prefix[1] !== "env") throw new Unsupported("an answer with an undeclared prefix");
  }
  const values = new Map<string, string | null>();
  const inner = wrapper[3]!;
  let position = 0;
  while (position < inner.length) {
    LEAF.lastIndex = position;
    const leaf = LEAF.exec(inner);
    if (!leaf) throw new Unsupported("an answer element that is not plain text");
    const content = leaf[2];
    const value = content === undefined || content === "" ? null : unescapeXml(content);
    // REXML text of "---" stays; VIES#convert_value turns it into nil.
    values.set(convertKey(leaf[1]!), value === "---" ? null : value);
    position = LEAF.lastIndex;
  }
  return { values };
}

// Date.parse of a VIES request date, which Ruby raises on when it is nil or not a day: the fallback (true) follows.
function requestDateRaises(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/u.exec(value);
  if (!match) throw new Unsupported("a request date Date.parse reads in a way Node does not model");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return !(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day);
}

/** What the answer says about the id: true/false when VIES decided, null when Ruby falls back to the shape check. */
function viesVerdict(status: number, body: string): boolean | null {
  if (status < 200 || status > 299) return null;
  let parsed: Parsed;
  try {
    parsed = parseBody(body);
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    // A body Ruby would read as "not registered" must be Ruby's to answer; every other body ends in the fallback.
    if (/false|INVALID_INPUT/iu.test(body)) throw error;
    return null;
  }
  const { values } = parsed;
  const fault = values.get("faultstring");
  if (fault !== undefined && fault !== null) return fault === "INVALID_INPUT" ? false : null;
  if (values.has("request_date") && requestDateRaises(values.get("request_date"))) return null;
  const valid = values.get("valid");
  return valid === "true" ? true : valid === "false" ? false : null;
}

async function post(fetcher: typeof fetch, body: string): Promise<{ status: number; body: string } | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetcher(viesEndpoint(), {
        method: "POST",
        headers: { Accept: "text/xml;charset=UTF-8", "Content-Type": "text/xml;charset=UTF-8", SOAPAction: "" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(VIES_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      if (code !== "ECONNRESET") return null;
    }
  }
  return null;
}

/** `VatValidationService#process`. */
export async function validateViesVatId(vatId: string | null | undefined, deps: ViesDeps = {}): Promise<ViesOutcome> {
  if (vatId === null || vatId === undefined) return { kind: "valid", valid: false };
  const vat = valvat(vatId);
  if (vat.vatCountryCode === "GB") return { kind: "valid", valid: validShape(vat) };
  if (!validShape(vat)) return { kind: "valid", valid: false };
  const requester = valvat(getConfig("VAT_REGISTRATION_NUMBER", "EU372030009"));
  const answer = await post(deps.fetch ?? fetch, requestBody(vat, requester));
  if (answer === null) return { kind: "valid", valid: true };
  try {
    return { kind: "valid", valid: viesVerdict(answer.status, answer.body) ?? true };
  } catch (error) {
    if (error instanceof Unsupported) return { kind: "unsupported", reason: error.message };
    throw error;
  }
}
