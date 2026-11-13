import { describe, expect, it } from "vitest";

import { calculatedTrackingUrl } from "./shipment-tracking.ts";

const shipment = (tracking_url: string | null) => ({ tracking_url, tracking_number: null, carrier: null });

describe("calculatedTrackingUrl", () => {
  it("prints a plain http link as stored", () => {
    expect(calculatedTrackingUrl(shipment("https://example.com/track/abc"))).toBe("https://example.com/track/abc");
  });

  it("prints no link for a scheme other than http or https", () => {
    expect(calculatedTrackingUrl(shipment("ftp://example.com/track"))).toBeNull();
  });

  it.each([["https://example.com/track me"], ["https://example.com/a b?c=d"], ["http://exa mple.com/"]])(
    "prints no link for %j, which URI.parse refuses",
    (link) => {
      expect(calculatedTrackingUrl(shipment(link))).toBeNull();
    },
  );

  it("strips the spaces around a link before reading it", () => {
    expect(calculatedTrackingUrl(shipment("  https://example.com/x \n"))).toBe("https://example.com/x");
  });

  it("builds the carrier's link from a number with a space inside as no link", () => {
    expect(calculatedTrackingUrl({ tracking_url: null, tracking_number: "1Z 99", carrier: "UPS" })).toBeNull();
  });
});
