import { describe, expect, it } from "vitest";

import { NotPortedError } from "../../models/user.ts";

import { findAdminRoute } from "./registry.ts";
import { parseIso8601 } from "./users-search.ts";
import "./index.ts";

// Expected values are what Time.iso8601 answered in Ruby 3.4 (UTC, microseconds).
describe("parseIso8601", () => {
  it.each([
    ["2020-01-01T00:00:00Z", "2020-01-01 00:00:00.000000"],
    ["2020-01-01T00:00:00", "2020-01-01 00:00:00.000000"],
    ["2020-01-01T00:00:00+0200", "2019-12-31 22:00:00.000000"],
    ["2020-01-01T00:00:00+02", "2019-12-31 22:00:00.000000"],
    ["2020-01-01T00:00:00-05:30", "2020-01-01 05:30:00.000000"],
    ["2020-01-01T00:00:00.1234567Z", "2020-01-01 00:00:00.123456"],
    ["2020-01-01T00:00:00.5z", "2020-01-01 00:00:00.500000"],
    ["2020-02-30T00:00:00Z", "2020-03-01 00:00:00.000000"],
    ["2020-04-31T00:00:00Z", "2020-05-01 00:00:00.000000"],
    ["2021-02-29T00:00:00Z", "2021-03-01 00:00:00.000000"],
    ["2020-01-01T24:00:00Z", "2020-01-02 00:00:00.000000"],
    ["2020-01-01T23:59:60Z", "2020-01-02 00:00:00.000000"],
    [" 2020-01-01t00:00:00z ", "2020-01-01 00:00:00.000000"],
  ])("reads %s", (input, sql) => {
    expect(parseIso8601(input)).toEqual({ sql });
  });

  it.each([
    "2020-01-01",
    "2020-01-01Z",
    "2020-01-01T00:00Z",
    "20200101T000000Z",
    "2020-01-01T00:00:00 Z",
    "2020-01-01T00:00:00.Z",
    "2020-01-01T00:00:00,5Z",
    "2020-13-01T00:00:00Z",
    "2020-00-10T00:00:00Z",
    "2020-01-32T00:00:00Z",
    "2020-01-00T00:00:00Z",
    "2020-01-01T00:60:00Z",
    "2020-01-01T24:00:01Z",
    "2020-01-01T23:59:61Z",
    "2020-01-01T00:00:00+24:00",
    "2020-01-01T00:00:00+99:99",
    "yesterday",
  ])("refuses %s as Ruby does", (input) => {
    expect(parseIso8601(input)).toBeNull();
  });

  it("reads year 999, which MySQL compares as written", () => {
    expect(parseIso8601("0999-01-01T00:00:00Z")).toEqual({ sql: "0999-01-01 00:00:00.000000" });
  });

  it("hands back a year no recording covers", () => {
    expect(() => parseIso8601("0099-01-01T00:00:00Z")).toThrow(NotPortedError);
    expect(() => parseIso8601("12020-01-01T00:00:00Z")).toThrow(NotPortedError);
  });
});

describe("routes added with the users search", () => {
  it("serves every read and guard of this round", () => {
    const served = [
      ["GET", "/internal/admin/users/purchases"],
      ["GET", "/internal/admin/users/related"],
      ["GET", "/internal/admin/users/social_connections"],
      ["GET", "/internal/admin/users/radar_stats"],
      ["POST", "/internal/admin/users/mark_compliant"],
      ["POST", "/internal/admin/purchases/reassign"],
      ["GET", "/internal/admin/scheduled_payouts"],
      ["GET", "/internal/admin/stranded_buyers/scan"],
      ["GET", "/internal/admin/payouts"],
      ["POST", "/internal/admin/payouts/pause"],
      ["POST", "/internal/admin/payouts/resume"],
      ["GET", "/internal/admin/feature_announcement_campaigns/launch/preview"],
      ["POST", "/internal/admin/stripe_restraint_notices"],
    ] as const;
    for (const [method, path] of served) expect(findAdminRoute(method, path), `${method} ${path}`).not.toBeNull();
  });
});
