// What CustomerPresenter#customer reads for a physical product or a shipping-required one: `physical` (the Sku), `shipping` (address, price, tracking)
// and the Sku `option` (Sku#to_option_for_product). Every reading that is not modelled throws HandBackToRails.
import { encrypt, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { usdCentsToCurrency } from "../../models/concerns/currency-helper.ts";
import { formatJustPriceInCents } from "../../models/concerns/money-formatter.ts";
import { RECURRENCE_LONG_INDICATOR } from "../../models/purchase-json.ts";
import { displaySafeTrackingLink, escapeNonAscii, isBlank } from "../../models/shipment.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Shipment::CARRIER_TRACKING_URL_MAPPING
const CARRIER_TRACKING_URL_MAPPING: Record<string, string> = {
  USPS: "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=",
  UPS: "http://wwwapps.ups.com/WebTracking/processInputRequest?TypeOfInquiryNumber=T&InquiryNumber1=",
  FedEx: "http://www.fedex.com/Tracking?language=english&cntry_code=us&tracknumbers=",
  DHL: "http://www.dhl.com/content/g0/en/express/tracking.shtml?brand=DHL&AWB=",
  "DHL Global Mail": "http://webtrack.dhlglobalmail.com/?trackingnumber=",
  OnTrac: "http://www.ontrac.com/trackres.asp?tracking_number=",
  "Canada Post": "https://www.canadapost.ca/cpotools/apps/track/personal/findByTrackNumber?LOCALE=en&trackingNumber=",
};
// eslint-disable-next-line no-control-regex
const NUL = /\0/u;
const STRIP = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu;
// URI::RFC3986_Parser's URI pattern (uri 1.1.1) for an http(s) URL: scheme, authority (userinfo, reg-name or IPv4 host, port),
// path-abempty, a query of anything but `#`, and a fragment.
const HEX = "[0-9A-Fa-f]";
const SEG = String.raw`(?:%${HEX}{2}|[!$&-.0-9:;=@A-Z_a-z~/])`;
const FRAGMENT = String.raw`(?:%${HEX}{2}|[!$&-.0-9:;=@A-Z_a-z~/?])*`;
const REG_NAME = String.raw`(?:%${HEX}{2}|[!$&-.0-9;=A-Z_a-z~])*`;
const USERINFO = String.raw`(?:%${HEX}{2}|[!$&-.0-9:;=A-Z_a-z~])*`;
const HTTP_URL = new RegExp(
  String.raw`^https?://(?:(${USERINFO})@)?(${REG_NAME}|\[[^\]]*\])(?::\d*)?(?:/${SEG}*)?(?:\?[^#]*)?(?:#${FRAGMENT})?$`,
  "iu",
);

// RFC 3986 IPv6address (the grammar URI::RFC3986_Parser's IP-literal embeds). A zone id is not part of it: the parser raises on one.
const H16 = "[0-9A-Fa-f]{1,4}";
const DEC_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const LS32 = `(?:${H16}:${H16}|${DEC_OCTET}(?:\\.${DEC_OCTET}){3})`;
const IPV6_ADDRESS = new RegExp(
  `^(?:${[
    `(?:${H16}:){6}${LS32}`,
    `::(?:${H16}:){5}${LS32}`,
    `(?:${H16})?::(?:${H16}:){4}${LS32}`,
    `(?:(?:${H16}:){0,1}${H16})?::(?:${H16}:){3}${LS32}`,
    `(?:(?:${H16}:){0,2}${H16})?::(?:${H16}:){2}${LS32}`,
    `(?:(?:${H16}:){0,3}${H16})?::${H16}:${LS32}`,
    `(?:(?:${H16}:){0,4}${H16})?::${LS32}`,
    `(?:(?:${H16}:){0,5}${H16})?::${H16}`,
    `(?:(?:${H16}:){0,6}${H16})?::`,
  ].join("|")})$`,
  "u",
);

// IPvFuture of the same grammar: a lowercase `v` only, as the parser's pattern spells it.
const IPV_FUTURE = /^v[0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+$/u;

// Whether Shipment.display_safe_tracking_link keeps a stripped, ASCII, control-free URL starting `http(s)://`: false when URI.parse
// raises InvalidURIError (an IP literal that is neither IPv6 nor IPvFuture included), or the host is blank or a userinfo is present.
function classifyHttpUrl(url: string): boolean {
  const match = HTTP_URL.exec(url);
  if (match === null) return false;
  const [, userinfo, host] = match as unknown as [string, string | undefined, string];
  if (host.startsWith("[")) {
    const literal = host.slice(1, -1);
    return (IPV6_ADDRESS.test(literal) || IPV_FUTURE.test(literal)) && !userinfo;
  }
  return host !== "" && !userinfo;
}

// Shipment#calculated_tracking_url: the seller's URL, else the carrier's form for the tracking number, kept only when display-safe.
export function calculatedTrackingUrl(shipment: Row): string | null {
  const fields = [shipment.tracking_url, shipment.tracking_number, shipment.carrier].map((value) =>
    value == null ? "" : String(value),
  );
  if (fields.some((value) => NUL.test(value))) throw new HandBackToRails();
  const [trackingUrl, trackingNumber, carrier] = fields as [string, string, string];

  let raw: string;
  if (!isBlank(trackingUrl)) raw = trackingUrl;
  else if (isBlank(trackingNumber) || isBlank(carrier) || !Object.hasOwn(CARRIER_TRACKING_URL_MAPPING, carrier))
    return null;
  else raw = CARRIER_TRACKING_URL_MAPPING[carrier]! + trackingNumber;

  const safe = displaySafeTrackingLink(raw);
  if (safe === false) return null;
  const normalized = raw.replace(STRIP, "");
  // null: an http(s) URL outside the simple form, which only the RFC 3986 check below can judge.
  if (safe === null && !/^https?:\/\//iu.test(normalized)) throw new HandBackToRails();
  return classifyHttpUrl(escapeNonAscii(normalized)) ? normalized : null;
}

export type ShippingReading = { price: string; shipment: Row | null };

// Purchase#formatted_shipping_amount: the shipping converted at the sale's rate from the product's currency, shown in the displayed one,
// with format_price_in_cents' recurrence suffix. `price` is price_for_recurrence; `singleCharge` is `subscription.single_charge?`.
export async function shippingReading(
  purchase: Row,
  link: Row,
  price: Row | undefined,
  shipment: Row | null,
  knownRate: (currency: string) => boolean,
  singleCharge = false,
): Promise<ShippingReading> {
  const recurrence = price?.recurrence == null ? null : String(price.recurrence);
  if (recurrence !== null && !Object.hasOwn(RECURRENCE_LONG_INDICATOR, recurrence)) throw new HandBackToRails();
  const currency = String(link.price_currency_type);
  if (currency !== "usd" && !knownRate(currency)) throw new HandBackToRails();
  const converted = await usdCentsToCurrency(
    currency,
    Number(purchase.shipping_cents),
    currency === "usd" ? undefined : Number(String(purchase.rate_converted_to_usd).trim()),
  );
  const formatted = formatJustPriceInCents(converted, String(purchase.displayed_price_currency_type));
  // formatted_price_with_recurrence: no price at all leaves the plain amount; no recurrence still gets " x 1".
  let text = formatted;
  if (price !== undefined && recurrence !== null)
    text = singleCharge ? `${formatted} once` : `${formatted} ${RECURRENCE_LONG_INDICATOR[recurrence]}`;
  else if (price !== undefined && singleCharge) text = `${formatted} x 1`;
  return { price: text, shipment };
}

export function shippingJson(purchase: Row, reading: ShippingReading, physical: boolean) {
  const attributes = ["full_name", "street_address", "country", "state", "zip_code", "city"] as const;
  const { shipment } = reading;
  return {
    address: Object.fromEntries(attributes.map((attribute) => [attribute, purchase[attribute] ?? ""])),
    price: reading.price,
    tracking: physical
      ? shipment === null
        ? { shipped: false }
        : { shipped: shipment.shipped_at != null, url: calculatedTrackingUrl(shipment) }
      : null,
  };
}

// Sku#custom_name_or_external_id and Purchase#external_id_numeric
export function physicalJson(purchase: Row, sku: Row) {
  return {
    sku: typeof sku.custom_sku === "string" && sku.custom_sku.trim() !== "" ? sku.custom_sku : encrypt(sku.id),
    order_number: String(encryptNumeric(Number(purchase.id))),
  };
}

// Sku#to_option_for_product
export function skuOption(sku: Row) {
  return {
    id: encrypt(sku.id),
    name: sku.name,
    quantity_left:
      sku.max_purchase_count == null
        ? null
        : Math.max(Number(sku.max_purchase_count) - Number(sku.sales_count_for_inventory_cache ?? 0), 0),
    description: sku.description ?? "",
    price_difference_cents: sku.price_difference_cents,
    recurrence_price_values: null,
    is_pwyw: false,
    duration_in_minutes: sku.duration_in_minutes,
  };
}
