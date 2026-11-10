// What CustomerPresenter#customer reads for a physical product or a shipping-required one: `physical` (the Sku), `shipping` (address, price, tracking)
// and the Sku `option` (Sku#to_option_for_product). Every reading that is not modelled throws HandBackToRails.
import { encrypt, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { usdCentsToCurrency } from "../../models/concerns/currency-helper.ts";
import { formatJustPriceInCents } from "../../models/concerns/money-formatter.ts";
import { displaySafeTrackingLink } from "../../models/shipment.ts";

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
const OUTSIDE_PLAIN_ASCII = /[^\x01-\x7F]/u;
const BLANK = /^[\t\n\v\f\r ]*$/u;
const STRIP = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu;
// What URI.parse accepts of an http(s) URL: displaySafeTrackingLink also admits characters (`|`, `"`, a second `#`) it raises on.
const PCHARS = String.raw`(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})`;
const PARSEABLE_LINK = new RegExp(
  String.raw`^https?://[A-Za-z0-9.-]+(?::\d+)?(?:/${PCHARS}*)?(?:\?(?:${PCHARS}|\?)*)?(?:#(?:${PCHARS}|\?)*)?$`,
  "u",
);

// Shipment#calculated_tracking_url: the seller's URL, else the carrier's form for the tracking number, kept only when display-safe.
export function calculatedTrackingUrl(shipment: Row): string | null {
  const fields = [shipment.tracking_url, shipment.tracking_number, shipment.carrier].map((value) =>
    value == null ? "" : String(value),
  );
  if (fields.some((value) => OUTSIDE_PLAIN_ASCII.test(value))) throw new HandBackToRails();
  const [trackingUrl, trackingNumber, carrier] = fields as [string, string, string];

  let raw: string;
  if (!BLANK.test(trackingUrl)) raw = trackingUrl;
  else if (BLANK.test(trackingNumber) || BLANK.test(carrier) || !Object.hasOwn(CARRIER_TRACKING_URL_MAPPING, carrier))
    return null;
  else raw = CARRIER_TRACKING_URL_MAPPING[carrier]! + trackingNumber;

  const safe = displaySafeTrackingLink(raw);
  if (safe === null) throw new HandBackToRails();
  if (!safe) return null;
  const normalized = raw.replace(STRIP, "");
  if (!PARSEABLE_LINK.test(normalized)) throw new HandBackToRails();
  return normalized;
}

export type ShippingReading = { price: string; shipment: Row | null };

// Purchase#formatted_shipping_amount: the shipping converted at the sale's rate from the product's currency, shown in the displayed one.
// A price with a recurrence, or a subscription's, would append it (format_price_in_cents).
export async function shippingReading(
  purchase: Row,
  link: Row,
  price: Row | undefined,
  shipment: Row | null,
  knownRate: (currency: string) => boolean,
): Promise<ShippingReading> {
  if (purchase.subscription_id != null || (price !== undefined && price.recurrence != null))
    throw new HandBackToRails();
  const currency = String(link.price_currency_type);
  if (currency !== "usd" && !knownRate(currency)) throw new HandBackToRails();
  const converted = await usdCentsToCurrency(
    currency,
    Number(purchase.shipping_cents),
    currency === "usd" ? undefined : Number(String(purchase.rate_converted_to_usd).trim()),
  );
  return { price: formatJustPriceInCents(converted, String(purchase.displayed_price_currency_type)), shipment };
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
