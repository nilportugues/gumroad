// Shared props need data owned by other workstreams. Each piece sits behind a port with a safe default
// so pages can be converted now; the owning workstream registers the real implementation at boot.
import type { RequestContext } from "@/server/auth/context";
import { isFeatureEnabled, userActor } from "@/server/infra/flipper";

import { NotPortedError } from "./not-ported.ts";
import { signedInPresenters } from "./signed-in/presenters.ts";

export { NotPortedError };

// The Rails session (WS-03 decrypts it).
export interface RailsSessionPort {
  // session[:_csrf_token], base64. Null when the session has none yet (Rails would create one).
  rawCsrfToken(): Promise<string | null>;
  // Reads and discards the flash, like rendering a Rails response does.
  consumeFlash(): Promise<Record<string, string>>;
  // inertia_rails keeps validation errors from a redirect in session[:inertia_errors].
  consumeInertiaErrors(): Promise<Record<string, string>>;
  // session[:mobile_param] ("0"/"1"), session[:mobile_app_web_view] and session[:prompt_passkey_setup].
  value(key: "mobile_param" | "mobile_app_web_view" | "prompt_passkey_setup"): Promise<unknown>;
}

// Flipper (WS-06). `actor` is a users row for per-user gates.
export interface FeatureFlagPort {
  isActive(feature: string, actor?: RequestContext["loggedInUser"]): Promise<boolean>;
}

// Presenters for signed-in visitors (RenderingExtension#logged_in_user_props, UserPresenter#as_current_seller,
// ApplicationHelper#current_user_props). They need Pundit policies (WS-03) and model services (WS-02).
export interface SignedInPresentersPort {
  loggedInUser(context: RequestContext): Promise<Record<string, unknown>>;
  currentSeller(context: RequestContext): Promise<Record<string, unknown>>;
  currentUser(context: RequestContext): Promise<Record<string, unknown>>;
  // `promptedUserId`: session[:prompt_passkey_setup]; `mobileAppCookie`: cookies[:is_gumroad_mobile_app].
  showPasskeySetupPrompt(context: RequestContext, input: { promptedUserId: unknown; mobileAppCookie: string | null | undefined }): Promise<boolean>;
  // `seller.disable_third_party_analytics?` (a User flag) for PageMeta::Analytics.
  thirdPartyAnalyticsDisabled(seller: NonNullable<RequestContext["currentSeller"]>): Promise<boolean>;
}

export type SharedPropsPorts = {
  session: RailsSessionPort;
  flags: FeatureFlagPort;
  presenters: SignedInPresentersPort;
};

const defaults: SharedPropsPorts = {
  session: {
    rawCsrfToken: async () => null,
    consumeFlash: async () => ({}),
    consumeInertiaErrors: async () => ({}),
    value: async () => undefined,
  },
  flags: { isActive: (feature, actor) => isFeatureEnabled(feature, actor ? userActor(actor.id) : undefined) },
  presenters: signedInPresenters,
};

let ports: SharedPropsPorts = defaults;

export function configureSharedPropsPorts(overrides: Partial<SharedPropsPorts>) {
  ports = { ...ports, ...overrides };
}

export function sharedPropsPorts(): SharedPropsPorts {
  return ports;
}
