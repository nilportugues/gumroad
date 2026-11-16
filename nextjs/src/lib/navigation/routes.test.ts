import { describe, expect, it } from "vitest";

import { mergeDataIntoQueryString, objectToFormData } from "./form-data";
import { buildRoute, configureRouteDefaults, help_center_category_path, help_center_category_url, help_center_root_path, settings_main_url } from "./routes";

describe("js-routes port", () => {
  it("fills required segments and drops unfilled optional groups", () => {
    expect(help_center_root_path()).toBe("/help");
    expect(help_center_category_path("316-open-an-account")).toBe("/help/category/316-open-an-account");
    expect(help_center_category_path("x", { format: "json" })).toBe("/help/category/x.json");
  });

  it("takes required parameters from the options hash and objects with to_param", () => {
    expect(buildRoute("/l/:id(.:format)", [{ id: "abc" }], false)).toBe("/l/abc");
    expect(buildRoute("/l/:id(.:format)", [{ to_param: () => "custom" }], false)).toBe("/l/custom");
  });

  it("turns extra options into a Rails-style query string and appends the anchor", () => {
    expect(help_center_root_path({ q: "refund policy", filter: { audience: ["creator", "customer"] }, anchor: "top" })).toBe(
      "/help?filter%5Baudience%5D%5B%5D=creator&filter%5Baudience%5D%5B%5D=customer&q=refund%20policy#top",
    );
  });

  it("builds absolute URLs from the configured defaults or explicit host and protocol", () => {
    configureRouteDefaults("https", "gumroad.com");
    expect(settings_main_url()).toBe("https://gumroad.com/settings");
    expect(help_center_category_url("x", { host: "app.gumroad.com", protocol: "http" })).toBe("http://app.gumroad.com/help/category/x");
  });

  it("throws when a required parameter is missing", () => {
    expect(() => help_center_category_path()).toThrow(":slug");
  });
});

describe("Inertia request encoding", () => {
  it("encodes form data with bracketed keys, indexed arrays and Rails booleans", () => {
    const form = objectToFormData({ user: { name: "Gum", tags: ["a", "b"], public: true, bio: null } });
    expect([...form.entries()]).toEqual([
      ["user[name]", "Gum"],
      ["user[tags][0]", "a"],
      ["user[tags][1]", "b"],
      ["user[public]", "1"],
      ["user[bio]", ""],
    ]);
  });

  it("moves GET data into the query string, replacing parameters with the same name", () => {
    const [url, data] = mergeDataIntoQueryString("get", new URL("https://gumroad.com/customers?page=1&sort=asc"), { page: 2, ids: ["x", "y"] });
    expect(url.search).toBe("?sort=asc&page=2&ids[]=x&ids[]=y");
    expect(data).toEqual({});
  });

  it("leaves non-GET data in the body", () => {
    const [url, data] = mergeDataIntoQueryString("post", new URL("https://gumroad.com/customers"), { page: 2 });
    expect(url.search).toBe("");
    expect(data).toEqual({ page: 2 });
  });
});
