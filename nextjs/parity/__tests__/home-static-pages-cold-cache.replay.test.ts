import { describeErbLayoutReplay } from "../src/erb-layout";

// The example of spec/requests/home_static_pages_parity_spec.rb where the nav's star count is not in the cache: Rails would call
// GitHub, so the page is Rails'. The process starts with an empty Rails.cache.
describeErbLayoutReplay("Home static pages on a cold cache", {
  spec: "home_static_pages_parity_spec",
  routeFlags: "nextjs_home_pages",
  seed: {},
  select: (name) => name.includes("star-count"),
});
