import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import golden from "./__fixtures__/geo-ip.golden.json" with { type: "json" };
import { geoIpLookup } from "./geo-ip.ts";

// Recorded by scripts/golden/geo-ip.rb: the real GeoIp.lookup over the same GeoLite2 test database.
const DATABASE = path.join(import.meta.dirname, "__fixtures__", "GeoLite2-City-Test.mmdb");

describe("geoIpLookup", () => {
  beforeEach(() => {
    process.env.GEOIP_DATABASE_PATH = DATABASE;
  });
  afterEach(() => {
    delete process.env.GEOIP_DATABASE_PATH;
  });

  for (const { ip, result } of golden as { ip: string | null; result: unknown }[]) {
    it(`answers like GeoIp.lookup for ${JSON.stringify(ip)}`, () => {
      expect(geoIpLookup(ip)).toEqual(result);
    });
  }

  it("is nil without a database", () => {
    process.env.GEOIP_DATABASE_PATH = path.join(import.meta.dirname, "__fixtures__", "missing.mmdb");
    expect(geoIpLookup("81.2.69.142")).toBeNull();
  });
});
