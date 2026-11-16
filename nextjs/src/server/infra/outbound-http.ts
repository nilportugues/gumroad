// fetch() for calls to a payment or AWS host. A parity replay sets OUTBOUND_HTTP_STAND_IN to a local server that answers the
// recorded calls; the request then goes there with its real URL in X-Parity-Original-Url, so the stand-in can match it against
// what Rails sent. Honoured in the test environment only.
import { railsEnv } from "./rails-env.ts";

export const PARITY_ORIGINAL_URL_HEADER = "x-parity-original-url";

export function outboundFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const standIn = process.env.OUTBOUND_HTTP_STAND_IN;
  if (standIn === undefined || standIn === "" || railsEnv() !== "test") return fetch(url, init);
  const original = new URL(url);
  const target = new URL(`${original.pathname}${original.search}`, standIn);
  const headers = new Headers(init.headers);
  headers.set(PARITY_ORIGINAL_URL_HEADER, url);
  return fetch(target, { ...init, headers });
}
