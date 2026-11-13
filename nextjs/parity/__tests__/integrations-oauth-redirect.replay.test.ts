import { describeErbLayoutReplay } from "../src/erb-layout";

// Replays spec/requests/integrations_oauth_redirect_parity_spec.rb: the empty `application` layout page of the Zoom and Google Calendar
// OAuth redirects.
describeErbLayoutReplay("Integrations oauth_redirect pages", {
  routeFlags: "nextjs_integrations_zoom,nextjs_integrations_google_calendar",
  seed: {},
  select: () => true,
  spec: "integrations_oauth_redirect_parity_spec",
});
