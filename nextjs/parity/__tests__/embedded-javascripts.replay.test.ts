import { describeErbLayoutReplay } from "../src/erb-layout";

// Replays spec/requests/embedded_javascripts_parity_spec.rb: the loader scripts of /js/gumroad*. The scripts carry no CSRF token or nonce,
// so the shared replay's masking leaves them alone; the cookies, the preload `Link` header and the body compare as recorded.
describeErbLayoutReplay("Embedded javascript loaders", {
  spec: "embedded_javascripts_parity_spec",
  routeFlags: "nextjs_embedded_loaders_js",
  seed: {},
  select: () => true,
});
