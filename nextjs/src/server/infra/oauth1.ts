// OAuth 1.0a request signing as the `oauth` gem does it for omniauth-twitter (HMAC-SHA1, parameters in the Authorization header), and the
// HTTP call that carries it. Every provider call goes through outboundFetch, so a parity replay can answer it from a stand-in server.
import { createHmac, randomBytes } from "node:crypto";

import { outboundFetch } from "./outbound-http.ts";
import { railsEnv } from "./rails-env.ts";

// OAuth::Client::Helper#amend_user_agent_header
export const OAUTH_USER_AGENT = "OAuth gem v1.1.0";
const NONCE_BYTES = 32;
const TIMEOUT_MS = 30_000;
const SIGNATURE_METHOD = "HMAC-SHA1";
const OAUTH_VERSION = "1.0";

// A call that ran past the strategy's 30 second open and read timeouts: `Timeout::Error`, which the strategy ends in `fail!(:timeout)`.
export class OAuth1Timeout extends Error {}

// OAuth::Helper.escape: everything but letters, digits and "-._~" is percent-encoded byte by byte, in upper case hex.
export function oauthEscape(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[a-zA-Z0-9\-._~]/u.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

// OAuth::Helper.generate_key: 32 random bytes in Base64 with every non-word character dropped. A parity replay fixes it, because the
// signature it has to reproduce depends on it; the override is honoured in the test environment only.
export function generateNonce(): string {
  const fixed = process.env.OAUTH1_PARITY_NONCE;
  if (fixed !== undefined && fixed !== "" && railsEnv() === "test") return fixed;
  return randomBytes(NONCE_BYTES).toString("base64").replace(/\W/gu, "");
}

// OAuth::Helper.generate_timestamp
export function generateTimestamp(now: Date): string {
  const fixed = process.env.OAUTH1_PARITY_TIMESTAMP;
  if (fixed !== undefined && fixed !== "" && railsEnv() === "test") return fixed;
  return String(Math.floor(now.getTime() / 1000));
}

export type Pair = [string, string];

// OAuth::Helper.normalize: the pairs sorted by name and value, escaped, joined.
function normalize(pairs: Pair[]): string {
  return [...pairs]
    .sort(([keyA, valueA], [keyB, valueB]) => compare(keyA, keyB) || compare(valueA, valueB))
    .map(([key, value]) => `${oauthEscape(key)}=${oauthEscape(value)}`)
    .join("&");
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// OAuth::RequestProxy::Base#normalized_uri: the scheme and host in lower case, the port only when it is not the default, no query.
function normalizedUri(url: URL): string {
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname}`;
}

export type Signing = {
  method: string;
  url: URL;
  consumerKey: string;
  consumerSecret: string;
  token?: { token: string; secret: string };
  callback?: string;
  verifier?: string;
  // The parameters of a form-encoded body; the query string is read off the URL.
  formParams?: Pair[];
  now: Date;
};

// OAuth::Client::Helper#oauth_parameters: the ones with a value, in the header's order once sorted.
function oauthParameters(signing: Signing): Record<string, string> {
  const all: Record<string, string> = {
    oauth_callback: signing.callback ?? "",
    oauth_consumer_key: signing.consumerKey,
    oauth_token: signing.token?.token ?? "",
    oauth_signature_method: SIGNATURE_METHOD,
    oauth_timestamp: generateTimestamp(signing.now),
    oauth_nonce: generateNonce(),
    oauth_verifier: signing.verifier ?? "",
    oauth_version: OAUTH_VERSION,
  };
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== ""));
}

// The Authorization header of OAuth::Client::Helper#header.
export function authorizationHeader(signing: Signing): string {
  const parameters = oauthParameters(signing);
  const query = [...signing.url.searchParams] as Pair[];
  const base = [
    signing.method.toUpperCase(),
    oauthEscape(normalizedUri(signing.url)),
    oauthEscape(normalize([...Object.entries(parameters), ...query, ...(signing.formParams ?? [])])),
  ].join("&");
  const key = `${oauthEscape(signing.consumerSecret)}&${oauthEscape(signing.token?.secret ?? "")}`;
  parameters.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  const header = Object.entries(parameters)
    .sort(([a], [b]) => compare(a, b))
    .map(([name, value]) => `${name}="${oauthEscape(value)}"`)
    .join(", ");
  return `OAuth ${header}`;
}

export type OAuth1Answer = { status: number; headers: Headers; text: string };

// Net::HTTP through OAuth::Consumer#request. `form` is OAuth::Helper.normalize(data) with a form content type; Rails sets both for the request
// token call even when the data is empty. A redirect is returned as it is: the caller decides.
export async function signedRequest(signing: Signing & { form?: Pair[] }): Promise<OAuth1Answer> {
  const headers: Record<string, string> = {
    Authorization: authorizationHeader({ ...signing, formParams: signing.form }),
    "User-Agent": OAUTH_USER_AGENT,
  };
  const init: RequestInit = { method: signing.method, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (signing.form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = normalize(signing.form);
  }
  try {
    const response = await outboundFetch(signing.url.toString(), init);
    return { status: response.status, headers: response.headers, text: await response.text() };
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new OAuth1Timeout("timeout");
    throw error;
  }
}

// CGI.parse(body) with the first value of each name, which is how OAuth::Consumer#token_request reads a token answer.
export function parseTokenAnswer(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) if (!(key.trim() in out)) out[key.trim()] = value;
  return out;
}
