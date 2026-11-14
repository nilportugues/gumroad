import { describeErbLayoutReplay } from "../src/erb-layout";

// The example of spec/requests/erb_layout_pages_parity_spec.rb where the nav's star count is not in the cache: the page asks GitHub (a
// stand-in server here, as WebMock is in the spec) and caches the answer. The process starts with an empty Rails.cache. The example
// where a nil was cached is in erb-layout-pages-nil-stars.replay.test.ts: it needs a process of its own.
describeErbLayoutReplay("ERB layout pages on a cold cache", {
  routeFlags: "nextjs_gumclaw,nextjs_mcp_connectors",
  seed: {},
  github: 4242,
  select: (name) => name.includes("without-a-cached-star-count"),
});
