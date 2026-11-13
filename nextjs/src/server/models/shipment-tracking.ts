// Shipment#calculated_tracking_url: the stored link, or the carrier's tracking form with the number appended, when it is a link the
// sale JSON shows. Whether Ruby's URI.parse accepts an arbitrary string is not ported: a link outside the plain http(s) form is not
// answered (NotPortedError), so only a link both parsers read the same way, or one that is blank, comes out here.
import { NotPortedError } from "./user.ts";

const CARRIER_TRACKING_URL_MAPPING: Record<string, string> = {
  USPS: "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=",
  UPS: "http://wwwapps.ups.com/WebTracking/processInputRequest?TypeOfInquiryNumber=T&InquiryNumber1=",
  FedEx: "http://www.fedex.com/Tracking?language=english&cntry_code=us&tracknumbers=",
  DHL: "http://www.dhl.com/content/g0/en/express/tracking.shtml?brand=DHL&AWB=",
  "DHL Global Mail": "http://webtrack.dhlglobalmail.com/?trackingnumber=",
  OnTrac: "http://www.ontrac.com/trackres.asp?tracking_number=",
  "Canada Post": "https://www.canadapost.ca/cpotools/apps/track/personal/findByTrackNumber?LOCALE=en&trackingNumber=",
};
const TRACKING_LINK_MAX_LENGTH = 2083;
// Ruby's String#strip: ASCII whitespace (and a trailing NUL)
const RUBY_STRIP = /^[\t\n\v\f\r ]+|[\t\n\v\f\r \0]+$/gu;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;
const HOST = String.raw`[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*`;
const URI_CHARS = String.raw`(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*`;
const PLAIN_LINK = new RegExp(`^https?://${HOST}(?::\\d+)?(?:[/?]${URI_CHARS})?(?:#${URI_CHARS})?$`, "iu");

type ShipmentRow = { tracking_url: string | null; tracking_number: string | null; carrier: string | null };

// String#present?
const present = (value: string | null): value is string => value !== null && value.trim() !== "";

export function calculatedTrackingUrl(shipment: ShipmentRow): string | null {
  let raw: string | null = null;
  if (present(shipment.tracking_url)) raw = shipment.tracking_url;
  else if (
    present(shipment.tracking_number) &&
    present(shipment.carrier) &&
    Object.hasOwn(CARRIER_TRACKING_URL_MAPPING, shipment.carrier)
  )
    raw = CARRIER_TRACKING_URL_MAPPING[shipment.carrier]! + shipment.tracking_number;
  if (raw === null) return null;
  if (!PRINTABLE_ASCII.test(raw.replace(RUBY_STRIP, "")))
    throw new NotPortedError(
      "a tracking link with control or non-ASCII characters",
      "Shipment#calculated_tracking_url",
    );
  const link = raw.replace(RUBY_STRIP, "");
  if (link === "" || link.length > TRACKING_LINK_MAX_LENGTH) return null;
  if (!PLAIN_LINK.test(link))
    throw new NotPortedError("a tracking link URI.parse may read differently", "Shipment#calculated_tracking_url");
  return link;
}
