// How the proxy hands a page what the Rails chain worked out for it. The proxy overwrites both
// headers on every request it serves, so a client cannot forge them.
import type { RenderState } from "../controllers/application-controller.ts";
import type { RailsSessionPort } from "./ports.ts";

export const RENDER_STATE_HEADER = "x-gr-render-state";
// request.original_fullpath: the path and query as the visitor sent them.
export const PAGE_URL_HEADER = "x-gr-page-url";

export const encodeRenderState = (state: RenderState): string => Buffer.from(JSON.stringify(state)).toString("base64url");

export function decodeRenderState(value: string | null): RenderState | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as RenderState;
  } catch {
    return null;
  }
}

export function renderStatePort(state: RenderState): RailsSessionPort {
  return {
    rawCsrfToken: async () => state.csrfToken,
    consumeFlash: async () => state.flash,
    consumeInertiaErrors: async () => state.inertiaErrors,
    value: async (key) => (key === "mobile_param" ? state.mobileParam : state.mobileAppWebView),
  };
}
