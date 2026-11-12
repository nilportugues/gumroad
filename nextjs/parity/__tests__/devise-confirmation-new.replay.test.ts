import { describeErbLayoutReplay } from "../src/erb-layout";

// Replays spec/requests/devise_confirmation_new_parity_spec.rb: Devise's resend form in the `application` layout.
describeErbLayoutReplay("Devise confirmation pages", {
  routeFlags: "nextjs_auth_confirmation_new",
  seed: {},
  select: () => true,
  spec: "devise_confirmation_new_parity_spec",
});
