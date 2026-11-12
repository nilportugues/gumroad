import { describe, expect, it } from "vitest";

import type { Chain } from "./application-controller.ts";
import { railsRequest } from "./rails-request.ts";
import { erasedCookies, OVERRIDE_ON_CLOSE_CODE, OVERRIDE_WINDOW_ACTIONS_CODE } from "./third-party-analytics.ts";

const request = (cookie?: string) =>
  railsRequest(new Request("http://analytics.test.gumroad.com/profile/seller", cookie ? { headers: { cookie } } : {}));
const erased = (cookie: string | undefined, guid: string | null) =>
  erasedCookies({ request: request(cookie), chain: { guid } as Chain }).map((line) => line.split(";")[0]);

describe("ThirdPartyAnalyticsController#profile cookie erasure", () => {
  it("expires every cookie the visitor sent", () => {
    expect(erased("foo=bar; baz=1", null)).toEqual(["foo=", "baz="]);
  });

  it("expires the guid it minted after the cookies the visitor sent", () => {
    expect(erased("foo=bar", "minted")).toEqual(["foo=", "_gumroad_guid="]);
  });

  it("expires the guid once when the visitor sent it", () => {
    expect(erased("_gumroad_guid=abc", "minted")).toEqual(["_gumroad_guid="]);
  });

  it("expires the minted guid of a visitor with no cookies", () => {
    expect(erased(undefined, "minted")).toEqual(["_gumroad_guid="]);
  });

  it("writes the expiry the way Rack does", () => {
    expect(erasedCookies({ request: request("foo=bar"), chain: { guid: null } as Chain })).toEqual([
      "foo=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; httponly; samesite=lax",
    ]);
  });
});

describe("window overrides", () => {
  it("are the two script blocks the Rails controller defines", () => {
    expect(OVERRIDE_WINDOW_ACTIONS_CODE).toContain("window.alert = function() {}");
    expect(OVERRIDE_ON_CLOSE_CODE).toContain("window.onbeforeunload = null");
  });
});
