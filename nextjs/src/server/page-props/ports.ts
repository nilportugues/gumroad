// Shared props need data owned by other workstreams. Each piece sits behind a port with a safe default
// so pages can be converted now; the owning workstream registers the real implementation at boot.
import type { RequestContext } from "@/server/auth/context";

export class NotPortedError extends Error {
  constructor(what: string) {
    super(`${what} is not ported to Next.js yet`);
  }
}

// The Rails session (WS-03 decrypts it).
export interface RailsSessionPort {
  // session[:_csrf_token], base64. Null when the session has none yet (Rails would create one).
  rawCsrfToken(): Promise<string | null>;
  // Reads and discards the flash, like rendering a Rails response does.
  consumeFlash(): Promise<Record<string, string>>;
  // inertia_rails keeps validation errors from a redirect in session[:inertia_errors].
  consumeInertiaErrors(): Promise<Record<string, string>>;
  // session[:mobile_param] ("0"/"1") and session[:mobile_app_web_view].
  value(key: "mobile_param" | "mobile_app_web_view"): Promise<unknown>;
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
  showPasskeySetupPrompt(context: RequestContext): Promise<boolean>;
  // `seller.disable_third_party_analytics?` (a User flag) for PageMeta::Analytics.
  thirdPartyAnalyticsDisabled(seller: NonNullable<RequestContext["currentSeller"]>): Promise<boolean>;
}

export type SharedPropsPorts = {
  session: RailsSessionPort;
  flags: FeatureFlagPort;
  presenters: SignedInPresentersPort;
};

const notPorted = (what: string) => async (): Promise<never> => {
  throw new NotPortedError(what);
};

const defaults: SharedPropsPorts = {
  session: {
    rawCsrfToken: async () => null,
    consumeFlash: async () => ({}),
    consumeInertiaErrors: async () => ({}),
    value: async () => undefined,
  },
  // Flipper answers false for a feature nobody has enabled.
  flags: { isActive: async () => false },
  presenters: {
    loggedInUser: notPorted("logged_in_user props"),
    currentSeller: notPorted("current_seller props"),
    currentUser: notPorted("current_user props"),
    showPasskeySetupPrompt: notPorted("prompt_passkey_setup"),
    thirdPartyAnalyticsDisabled: notPorted("User#disable_third_party_analytics?"),
  },
};

let ports: SharedPropsPorts = defaults;

export function configureSharedPropsPorts(overrides: Partial<SharedPropsPorts>) {
  ports = { ...ports, ...overrides };
}

export function sharedPropsPorts(): SharedPropsPorts {
  return ports;
}
