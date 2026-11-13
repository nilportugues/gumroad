import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { BrowserContext, Request, Response } from "@playwright/test";

export const OUT_DIR = path.resolve(__dirname, "..", ".out");

// Headers worth comparing between two servers. Everything else (date, server, cookies' values) is noise or secret.
const REQUEST_HEADERS = ["accept", "content-type", "x-inertia", "x-inertia-version", "x-requested-with"];
const RESPONSE_HEADERS = ["content-type", "location", "cache-control", "x-inertia", "vary", "content-disposition"];

// Static assets and dev-only tooling add volume without telling Rails and the Node port apart.
const SKIPPED_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "media", "script"]);
const SKIPPED_PATH = /^\/(vite|vite-dev|vite-test|mini-profiler-resources|packs|rails\/active_storage)\b/;

export type RecordedExchange = {
  ts: string;
  session: string;
  step: number;
  actor: string;
  action: string;
  method: string;
  host: string;
  path: string;
  status: number;
  resourceType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  setCookieNames: string[];
  requestBodyHash: string | null;
  requestBodyBytes: number;
  responseBodyHash: string | null;
  responseBodyBytes: number;
};

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const pick = (headers: Record<string, string>, names: string[]) =>
  Object.fromEntries(names.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]!]));

export type RecorderState = { session: string; step: number; actor: string; action: string };

/**
 * Records every request/response pair a context makes as one JSON line.
 * Request bodies carry per-session CSRF tokens, so two runs only agree on `requestBodyHash` for bodiless requests;
 * a replay tool should normalize or ignore those fields.
 */
export const attachRecorder = (
  context: BrowserContext,
  file: string,
  state: RecorderState,
  { includeAssets = process.env.E2E_RECORD_ASSETS === "1" }: { includeAssets?: boolean } = {},
) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const counter = { written: 0 };

  const record = async (response: Response) => {
    const request: Request = response.request();
    const url = new URL(request.url());
    if (!includeAssets && (SKIPPED_RESOURCE_TYPES.has(request.resourceType()) || SKIPPED_PATH.test(url.pathname))) return;

    const requestHeaders = await request.allHeaders().catch(() => ({}));
    const responseHeaders = await response.allHeaders().catch(() => ({}));
    const postData = request.postDataBuffer();
    // Redirects and aborted bodies have none.
    const body = await response.body().catch(() => null);

    const exchange: RecordedExchange = {
      ts: new Date().toISOString(),
      session: state.session,
      step: state.step,
      actor: state.actor,
      action: state.action,
      method: request.method(),
      host: url.host,
      path: `${url.pathname}${url.search}`,
      status: response.status(),
      resourceType: request.resourceType(),
      requestHeaders: pick(requestHeaders, REQUEST_HEADERS),
      responseHeaders: pick(responseHeaders, RESPONSE_HEADERS),
      setCookieNames: (responseHeaders["set-cookie"] ?? "")
        .split("\n")
        .map((cookie) => cookie.split("=")[0]!.trim())
        .filter(Boolean),
      requestBodyHash: postData ? sha256(postData) : null,
      requestBodyBytes: postData?.length ?? 0,
      responseBodyHash: body ? sha256(body) : null,
      responseBodyBytes: body?.length ?? 0,
    };
    appendFileSync(file, `${JSON.stringify(exchange)}\n`);
    counter.written += 1;
  };

  context.on("response", (response) => {
    void record(response).catch(() => undefined);
  });
  return counter;
};
