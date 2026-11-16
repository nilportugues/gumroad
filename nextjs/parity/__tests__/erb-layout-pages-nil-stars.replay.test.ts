import { describeErbLayoutReplay, STARS_KEY } from "../src/erb-layout";

// The example of spec/requests/erb_layout_pages_parity_spec.rb where the nav's star count was cached as nil (the GitHub call failed):
// the nav prints "GitHub" without a count.
describeErbLayoutReplay("ERB layout pages with a cached nil star count", {
  routeFlags: "nextjs_gumclaw,nextjs_mcp_connectors",
  seed: { [STARS_KEY]: null },
  select: (name) => name.includes("star-count-lookup-failed"),
});
