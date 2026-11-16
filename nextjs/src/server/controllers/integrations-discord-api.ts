// DiscordApi's bot and profile calls (app/services/discord_api.rb) as Discordrb::API.request makes them: a 2xx answer is returned, a 403
// is NoPermission, a 502 is retried, and any other error is a CodeError built from the JSON body (its code picks the class; 10004 is
// UnknownServer). A 429 is not ported: it throws, since the exchange it follows cannot be repeated.
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { NotPortedError } from "../models/user.ts";
import { isHash } from "../services/http-party.ts";

export const DISCORD_API_BASE = "https://discord.com/api/v9";
const HTTP_SUCCESS_MINIMUM = 200;
const HTTP_SUCCESS_LIMIT = 300;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502;
const UNKNOWN_SERVER_CODE = 10_004;

export type DiscordApiErrorKind = "no_permission" | "unknown_server" | "code_error" | "parser_error";

export class DiscordApiError extends Error {
  constructor(readonly kind: DiscordApiErrorKind) {
    super(`Discord API error: ${kind}`);
  }
}

export type DiscordResponse = { status: number; body: string };

async function discordRequest(
  method: string,
  url: string,
  authorization: string,
  json?: unknown,
): Promise<DiscordResponse> {
  for (;;) {
    const response = await outboundFetch(url, {
      method,
      headers: { Authorization: authorization, ...(json === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const body = await response.text();
    if (response.status >= HTTP_SUCCESS_MINIMUM && response.status < HTTP_SUCCESS_LIMIT)
      return { status: response.status, body };
    if (response.status === HTTP_BAD_GATEWAY) continue;
    if (response.status === HTTP_FORBIDDEN) throw new DiscordApiError("no_permission");
    if (response.status === HTTP_TOO_MANY_REQUESTS)
      throw new NotPortedError("a Discord rate limit", "Discordrb::API.request");
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw new DiscordApiError("parser_error");
    }
    if (!isHash(data)) throw new Error("Discord answered an error body that is not a JSON object");
    throw new DiscordApiError(data.code === UNKNOWN_SERVER_CODE ? "unknown_server" : "code_error");
  }
}

const botToken = () => `Bot ${getConfig("DISCORD_BOT_TOKEN")}`;

// DiscordApi#identify
export const identify = (token: string) => discordRequest("GET", `${DISCORD_API_BASE}/users/@me`, `Bearer ${token}`);

// DiscordApi#add_member
export const addMember = (serverId: string, userId: string, accessToken: string) =>
  discordRequest("PUT", `${DISCORD_API_BASE}/guilds/${serverId}/members/${userId}`, botToken(), {
    access_token: accessToken,
    nick: null,
    roles: [],
    mute: false,
    deaf: false,
  });

// DiscordApi#remove_member
export const removeMember = (serverId: string, userId: string) =>
  discordRequest("DELETE", `${DISCORD_API_BASE}/guilds/${serverId}/members/${userId}`, botToken());
