import { describeErbLayoutReplay } from "../src/erb-layout";

// The example of spec/requests/home_static_pages_parity_spec.rb where the nav's star count is not in the cache: the page asks GitHub (a
// stand-in server here, as WebMock is in the spec). The process starts with an empty Rails.cache.
describeErbLayoutReplay("Home static pages on a cold cache", {
  spec: "home_static_pages_parity_spec",
  routeFlags: "nextjs_home_pages",
  seed: {},
  github: 4242,
  select: (name) => name.includes("star-count"),
});
