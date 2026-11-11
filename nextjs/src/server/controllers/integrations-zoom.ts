// Integrations::ZoomController#account_info (GET /integrations/zoom/account_info): the signed-in seller's Zoom account, behind an OAuth code.
// #oauth_redirect renders the application layout and stays in Rails.
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { Ratelimit } from "../services/ratelimit.ts";

import { jsonResponse } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";
import { HandBackToRails } from "./application-controller.ts";

const ZOOM_OAUTH_URL = "https://zoom.us/oauth/token";
const ZOOM_API_URL = "https://api.zoom.us/v2";
const OAUTH_REDIRECT_PATH = "/integrations/zoom/oauth_redirect";
const RATE_LIMIT_KEY = "ZOOM_API_RATE_LIMIT";
const RATE_LIMIT_THRESHOLD = 30;
const RATE_LIMIT_INTERVAL_SECONDS = 1;
const HTTP_SUCCESS_MINIMUM = 200;
const HTTP_SUCCESS_LIMIT = 300;

// HTTParty's parsed_response: JSON for a JSON content type, the raw string otherwise, nil for an empty body.
async function parsedResponse(response: Response): Promise<{ ok: boolean; parsed: unknown }> {
  const ok = response.status >= HTTP_SUCCESS_MINIMUM && response.status < HTTP_SUCCESS_LIMIT;
  const text = await response.text();
  if (text.trim() === "") return { ok, parsed: null };
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) return { ok, parsed: text };
  try {
    return { ok, parsed: JSON.parse(text) as unknown };
  } catch {
    // HTTParty raises its ParseError, which Rails turns into a 500.
    throw new Error("Zoom answered JSON that does not parse");
  }
}

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// ActiveSupport's Object#present? for a value read out of JSON.
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return !/^[\s\u0000]*$/u.test(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isHash(value)) return Object.keys(value).length > 0;
  return true;
}

// `parsed_response&.dig(key)`, which raises on anything but a hash or nil.
function dig(parsed: unknown, key: string): unknown {
  if (parsed === null) return undefined;
  if (!isHash(parsed)) throw new Error("Zoom answered a body that is not a JSON object");
  return parsed[key];
}

// `response["id"]` on the user answer: HTTParty hands it to the parsed body, and nil has no `[]`.
function index(parsed: unknown, key: string): unknown {
  if (!isHash(parsed)) throw new Error("Zoom answered a body that is not a JSON object");
  return parsed[key];
}

// URI.encode_www_form
const formEncode = (fields: [string, string][]) => new URLSearchParams(fields).toString();

registerMutations({
  method: "GET",
  pattern: "/integrations/zoom/account_info",
  json: true,
  skipForgeryProtection: true,
  formats: ["any"],
  run: async ({ request, params }) => {
    const code = params.code;
    // A missing code encodes as a bare key and a non-string one differently: Rails decides.
    if (typeof code !== "string") throw new HandBackToRails("an OAuth code that is not a string");
    const redirectUri = `${request.protocol}${request.hostWithPort}${OAUTH_REDIRECT_PATH}`;
    const basic = Buffer.from(`${getConfig("ZOOM_CLIENT_ID") ?? ""}:${getConfig("ZOOM_CLIENT_SECRET") ?? ""}`).toString("base64");

    const oauth = await parsedResponse(
      await outboundFetch(ZOOM_OAUTH_URL, {
        method: "POST",
        body: formEncode([
          ["grant_type", "authorization_code"],
          ["code", code],
          ["redirect_uri", redirectUri],
        ]),
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    const accessToken = dig(oauth.parsed, "access_token");
    const refreshToken = dig(oauth.parsed, "refresh_token");
    if (!oauth.ok || !isPresent(accessToken) || !isPresent(refreshToken)) return jsonResponse({ success: false }, 200, true);

    const ratelimit = new Ratelimit(RATE_LIMIT_KEY);
    const user = await ratelimit.execWithinThreshold(
      RATE_LIMIT_KEY,
      { threshold: RATE_LIMIT_THRESHOLD, interval: RATE_LIMIT_INTERVAL_SECONDS },
      async () => {
        await ratelimit.add(RATE_LIMIT_KEY);
        return parsedResponse(
          await outboundFetch(`${ZOOM_API_URL}/users/me`, { headers: { Authorization: `Bearer ${String(accessToken)}` } }),
        );
      },
    );
    const id = index(user.parsed, "id");
    const email = index(user.parsed, "email");
    if (!isPresent(id) || !isPresent(email)) return jsonResponse({ success: false }, 200, true);

    return jsonResponse(
      { success: true, user_id: id, email, access_token: accessToken, refresh_token: refreshToken },
      200,
      true,
    );
  },
});
