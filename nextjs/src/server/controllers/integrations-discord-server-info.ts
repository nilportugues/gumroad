// Integrations::DiscordController#server_info (GET /integrations/discord/server_info): the signed-in seller's Discord server, behind an
// OAuth code. The exchange is HTTParty's; the profile request is Discordrb::API::User.profile, so its error handling (a Discord error
// code is a CodeError, a 403 is NoPermission, a 429 is waited out, a 502 is retried) is mirrored here.
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { digParsed, isHash, isPresent, parseHttpParty, postForm } from "../services/http-party.ts";

import { HandBackToRails } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";

const DEFAULT_OAUTH_TOKEN_URL = "https://discord.com/api/oauth2/token";
const API_BASE = "https://discord.com/api/v9";
const OAUTH_REDIRECT_PATH = "/integrations/discord/oauth_redirect";
const HTTP_SUCCESS_MINIMUM = 200;
const HTTP_SUCCESS_LIMIT = 300;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502;
const MILLISECONDS_PER_SECOND = 1000;

const failure = () => jsonResponse({ success: false }, 200, true);
const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * MILLISECONDS_PER_SECOND));

// Ruby's `value[key]` on what JSON.parse returns: a hash answers the key, a string answers the substring or nil, the rest raise.
function rubyIndex(value: unknown, key: string): unknown {
  if (isHash(value)) return value[key];
  if (typeof value === "string") return value.includes(key) ? key : null;
  throw new Error(`Discord answered a ${value === null ? "null" : typeof value} where Ruby indexes by "${key}"`);
}

class DiscordCodeError extends Error {}

// Discordrb::API.request for a GET: the body of a successful answer; a CodeError for an error Discord described.
async function discordGet(url: string, authorization: string): Promise<string> {
  for (;;) {
    const response = await outboundFetch(url, { headers: { Authorization: authorization } });
    const body = await response.text();
    // handle_preemptive_rl: a depleted bucket is waited out before the next request, whatever this one answered.
    if (response.headers.get("x-ratelimit-remaining") === "0")
      await sleep(Number(response.headers.get("x-ratelimit-reset-after") ?? 0) || 0);

    if (response.status >= HTTP_SUCCESS_MINIMUM && response.status < HTTP_SUCCESS_LIMIT) return body;
    if (response.status === HTTP_BAD_GATEWAY) continue;
    if (response.status === HTTP_FORBIDDEN) throw new Error("Discord answered 403 (Discordrb::Errors::NoPermission)");
    if (response.status === HTTP_TOO_MANY_REQUESTS) {
      // `JSON.parse(e.response)` raises its ParserError on a body that is not JSON.
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        throw new DiscordCodeError("Discord answered a rate limit that is not JSON");
      }
      const retryAfter = rubyIndex(parsed, "retry_after");
      await sleep(
        isPresent(retryAfter)
          ? Number(retryAfter)
          : Number.parseInt(response.headers.get("retry-after") ?? "0", 10) || 0,
      );
      continue;
    }
    // `JSON.parse(response.body)`: an empty or malformed body is a ParserError, any hash is a CodeError (the code picks the class).
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw new DiscordCodeError("Discord answered an error that is not JSON");
    }
    rubyIndex(data, "code");
    throw new DiscordCodeError(String(rubyIndex(data, "message")));
  }
}

registerMutations({
  method: "GET",
  pattern: "/integrations/discord/server_info",
  json: true,
  skipForgeryProtection: true,
  formats: ["any"],
  run: async ({ request, params }) => {
    const code = params.code;
    if (code !== undefined && typeof code !== "string") throw new HandBackToRails("an OAuth code that is not a string");
    const oauth = await parseHttpParty(
      await postForm(getConfig("DISCORD_OAUTH_TOKEN_URL", DEFAULT_OAUTH_TOKEN_URL), [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["client_id", getConfig("DISCORD_CLIENT_ID")],
        ["client_secret", getConfig("DISCORD_CLIENT_SECRET")],
        ["redirect_uri", `${request.protocol}${request.hostWithPort}${OAUTH_REDIRECT_PATH}`],
      ]),
    );
    // `parsed = nil if !parsed.is_a?(Hash)`
    const parsed = isHash(oauth.parsed) ? oauth.parsed : null;
    const server = digParsed(parsed, "guild");
    const accessToken = digParsed(parsed, "access_token");
    if (!oauth.ok || !isPresent(server) || !isPresent(accessToken)) return failure();

    let userResponse: string;
    try {
      userResponse = await discordGet(`${API_BASE}/users/@me`, `Bearer ${String(accessToken)}`);
    } catch (error) {
      if (error instanceof DiscordCodeError) return failure();
      throw error;
    }
    let user: unknown;
    try {
      user = JSON.parse(userResponse) as unknown;
    } catch {
      return failure();
    }
    return jsonResponse(
      {
        success: true,
        server_id: rubyIndex(server, "id") ?? null,
        server_name: rubyIndex(server, "name") ?? null,
        username: rubyIndex(user, "username") ?? null,
      },
      200,
      true,
    );
  },
});
