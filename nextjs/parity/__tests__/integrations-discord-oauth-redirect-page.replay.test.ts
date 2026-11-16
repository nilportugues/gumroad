import { describeErbLayoutReplay } from "../src/erb-layout";

// Replays spec/requests/integrations_discord_oauth_redirect_page_parity_spec.rb: the empty `application` layout page Discord's
// oauth_redirect renders when the state names no seller.
describeErbLayoutReplay("Integrations::DiscordController oauth_redirect page", {
  routeFlags: "nextjs_integrations_discord",
  seed: {},
  select: () => true,
  spec: "integrations_discord_oauth_redirect_page_parity_spec",
});
