import { describeErbLayoutReplay } from "../src/erb-layout";

// The examples of spec/requests/erb_layout_pages_parity_spec.rb where the nav's star count is not in the cache (never fetched, or
// fetched as nil): Rails would call GitHub or print another nav, so the page is Rails'. The process starts with an empty Rails.cache.
describeErbLayoutReplay("ERB layout pages on a cold cache", {
  routeFlags: "nextjs_gumclaw,nextjs_mcp_connectors",
  seed: {},
  select: (name) => name.includes("star-count"),
});
