import { afterEach, describe, expect, it } from "vitest";

import { indexName, productPageViewIndexForTimestamp, useEsAliases } from "./elasticsearch.ts";

describe("Elasticsearch index names match the Rails models", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("appends ES_INDEX_SUFFIX to each model's index", () => {
    process.env.RAILS_ENV = "test";
    process.env.ES_INDEX_SUFFIX = "_lane2";
    expect(indexName("Link")).toBe("products_lane2");
    expect(indexName("AudienceMember")).toBe("audience_members_lane2");
    delete process.env.ES_INDEX_SUFFIX;
    expect(indexName("ConfirmedFollowerEvent")).toBe("confirmed_follower_events");
  });

  it("renames all but audience members on staging preview apps", () => {
    Object.assign(process.env, { RAILS_ENV: "staging", BRANCH_DEPLOYMENT: "true", DATABASE_NAME: "gumroad_pr_42" });
    expect(indexName("ConfirmedFollowerEvent")).toBe("branch-app-gumroad_pr_42__confirmedfollowerevent");
    expect(indexName("Link")).toBe("branch-app-gumroad_pr_42__link");
    expect(indexName("AudienceMember")).toBe("audience_members");
    expect(useEsAliases()).toBe(false);
  });

  it("writes page views to monthly indices where aliases are used", () => {
    process.env.RAILS_ENV = "production";
    delete process.env.ES_INDEX_SUFFIX;
    expect(productPageViewIndexForTimestamp("2026-10-31T12:00:00Z")).toBe("product_page_views-2026-10");
    process.env.RAILS_ENV = "development";
    expect(productPageViewIndexForTimestamp("2026-10-31T12:00:00Z")).toBe("product_page_views");
  });
});
