import { CACHED_STARS, describeErbLayoutReplay, STARS_KEY } from "../src/erb-layout";

// Replays spec/requests/home_static_pages_parity_spec.rb against a process whose Rails.cache holds the star count the nav prints.
// The example about a cold cache is in home-static-pages-cold-cache.replay.test.ts: two `next dev` servers cannot share a directory.
describeErbLayoutReplay("Home static pages", {
  spec: "home_static_pages_parity_spec",
  routeFlags: "nextjs_home_pages",
  seed: { [STARS_KEY]: CACHED_STARS },
  select: (name) => !name.includes("star-count"),
});
