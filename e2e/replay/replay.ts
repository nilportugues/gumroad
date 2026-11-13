import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

import { isSafeHost, resolveBaseUrl } from "../support/base-url.ts";
import type { RecordedExchange } from "../support/recorder.ts";
import { sha256 } from "../support/recorder.ts";

import { maskBody } from "./mask.ts";

/** Same shape as a recording, plus the hash of the body after masking (see mask.ts) and a skip marker. */
export type ReplayedExchange = RecordedExchange & {
  normalizedBodyHash?: string | null;
  replay?: { skipped: string };
};

export const REPLAY_TIMEOUT_MS = 60_000;
const TEXTUAL = /^(?:text\/|application\/(?:json|[\w.+-]*\+json))/iu;
const RESPONSE_HEADERS = ["content-type", "location", "cache-control", "x-inertia", "vary", "content-disposition"];

export const readRecording = (file: string): ReplayedExchange[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        const exchange: ReplayedExchange = JSON.parse(line);
        return exchange;
      } catch {
        throw new Error(`${file}:${index + 1} is not valid JSON`);
      }
    });

/**
 * Maps the host a request was recorded against (`seller.localhost:3003`) onto the target: the subdomain is kept, the
 * host and port are the target's. Throws for any host the suite's guard would refuse, so a tampered recording
 * cannot point the tool elsewhere.
 */
export const mapHost = (recordedHost: string, base: URL) => {
  const recorded = new URL(`http://${recordedHost}`).hostname.toLowerCase();
  if (!isSafeHost(recorded)) throw new Error(`Refusing recorded host "${recorded}": not local or example.*`);
  const baseHost = base.hostname.toLowerCase();
  const loopback = baseHost === "localhost" || baseHost === "127.0.0.1" || baseHost.endsWith(".localhost");
  let hostname = recorded;
  if (recorded === "localhost" || recorded === "127.0.0.1") hostname = baseHost;
  else if (recorded.endsWith(".localhost") && !loopback)
    hostname = `${recorded.slice(0, -".localhost".length)}.${baseHost}`;
  return base.port ? `${hostname}:${base.port}` : hostname;
};

type Cookies = Map<string, string>;

const cookieHeader = (jar: Cookies) => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

const storeCookies = (jar: Cookies, setCookie: string[]) => {
  for (const cookie of setCookie) {
    const [pair = ""] = cookie.split(";", 1);
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // An expired or emptied cookie is a deletion.
    if (value === "" || /expires=thu, 01 jan 1970/iu.test(cookie) || /max-age=0\b/iu.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
};

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

const send = (
  base: URL,
  host: string,
  exchange: RecordedExchange,
  headers: Record<string, string>,
  timeoutMs: number,
) =>
  new Promise<RawResponse>((resolve, reject) => {
    const client = base.protocol === "https:" ? https : http;
    const request = client.request(
      {
        hostname: base.hostname,
        port: base.port || undefined,
        method: exchange.method,
        path: exchange.path,
        headers: { ...headers, host },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end();
  });

const pickHeaders = (headers: http.IncomingHttpHeaders) =>
  Object.fromEntries(
    RESPONSE_HEADERS.flatMap((name) => {
      const value = headers[name];
      return value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]];
    }),
  );

/**
 * Re-sends each recorded exchange, in recorded order, to `baseUrl`. Each (session, actor) has its own cookie jar.
 * Redirects are not followed: the recording holds each hop as its own exchange.
 * Request bodies were never stored (only a hash, because they carry CSRF tokens and passwords), so an exchange
 * with a body is written out as skipped rather than sent empty.
 */
export const replay = async (
  exchanges: RecordedExchange[],
  baseUrl: string,
  { timeoutMs = REPLAY_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<ReplayedExchange[]> => {
  const base = new URL(resolveBaseUrl(baseUrl));
  const jars = new Map<string, Cookies>();
  const out: ReplayedExchange[] = [];

  for (const exchange of exchanges) {
    const host = mapHost(exchange.host, base);
    const blank = {
      ...exchange,
      ts: new Date().toISOString(),
      host,
      responseHeaders: {},
      setCookieNames: [],
      responseBodyHash: null,
      responseBodyBytes: 0,
      normalizedBodyHash: null,
    };
    if (exchange.requestBodyBytes > 0) {
      out.push({ ...blank, status: 0, replay: { skipped: "request body was not recorded" } });
      continue;
    }

    const jarKey = `${exchange.session}\u0000${exchange.actor}`;
    const jar = jars.get(jarKey) ?? new Map<string, string>();
    jars.set(jarKey, jar);
    const headers: Record<string, string> = { ...exchange.requestHeaders };
    if (jar.size > 0) headers.cookie = cookieHeader(jar);

    try {
      const response = await send(base, host, exchange, headers, timeoutMs);
      const setCookie = response.headers["set-cookie"] ?? [];
      storeCookies(jar, setCookie);
      const responseHeaders = pickHeaders(response.headers);
      const textual = TEXTUAL.test(responseHeaders["content-type"] ?? "");
      out.push({
        ...blank,
        status: response.status,
        requestHeaders: exchange.requestHeaders,
        responseHeaders,
        setCookieNames: setCookie.map((cookie) => (cookie.split("=")[0] ?? "").trim()).filter(Boolean),
        responseBodyHash: response.body.length > 0 ? sha256(response.body) : null,
        responseBodyBytes: response.body.length,
        normalizedBodyHash:
          response.body.length === 0
            ? null
            : sha256(textual ? maskBody(response.body.toString("utf8")) : response.body),
      });
    } catch (error) {
      out.push({
        ...blank,
        status: 0,
        replay: { skipped: `request failed: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
  }
  return out;
};

export const writeRecording = (file: string, exchanges: ReplayedExchange[]) =>
  writeFileSync(file, exchanges.map((exchange) => `${JSON.stringify(exchange)}\n`).join(""));
