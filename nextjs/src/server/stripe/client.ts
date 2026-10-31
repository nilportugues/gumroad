// stripe-ruby 12.5.0's StripeClient (lib/stripe/stripe_client.rb): headers, idempotency keys,
// retries with its backoff, telemetry and error mapping, so a request from Node is the request
// Rails sends. __fixtures__/stripe-requests.golden.json records the gem's own requests and
// client.test.ts replays them.
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { gunzipSync, inflateSync } from "node:zlib";

import { encodeParameters, objectsToIds, type StripeParams } from "./encode.ts";
import { stripeConfigFromEnv, type StripeConfig } from "./config.ts";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  CardError,
  IdempotencyError,
  InvalidClientError,
  InvalidGrantError,
  InvalidOAuthRequestError,
  InvalidRequestError,
  InvalidScopeError,
  OAuthError,
  PermissionError,
  RateLimitError,
  StripeError,
  type StripeErrorOptions,
  UnsupportedGrantTypeError,
  UnsupportedResponseTypeError,
} from "./errors.ts";

export type HttpMethod = "get" | "post" | "delete";

// Request options (Ruby's `opts`): the user-specified ones become headers.
export type RequestOptions = {
  apiKey?: string;
  stripeAccount?: string;
  idempotencyKey?: string;
  stripeVersion?: string;
  client?: StripeClient;
};

export type TransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  openTimeoutMs: number;
  readTimeoutMs: number;
};

export type TransportResponse = { status: number; headers: Record<string, string>; body: string };

// A failure below HTTP. `kind` picks the gem's message (NETWORK_ERROR_MESSAGES_MAP); `message` is
// the underlying error's, in Net::HTTP's wording.
export class NetworkError extends Error {
  readonly kind: "connection" | "open_timeout" | "read_timeout" | "ssl";
  constructor(kind: "connection" | "open_timeout" | "read_timeout" | "ssl", message: string) {
    super(message);
    this.kind = kind;
  }
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type StripeResponse = {
  data: Record<string, unknown>;
  status: number;
  headers: Record<string, string>;
  requestId: string | null;
};

const ERROR_MESSAGE_CONNECTION =
  "Unexpected error communicating when trying to connect to Stripe (%s). You may be seeing this message because your DNS is not " +
  "working or you don't have an internet connection.  To check, try running `host stripe.com` from the command line.";
const ERROR_MESSAGE_SSL =
  "Could not establish a secure connection to Stripe (%s), you may need to upgrade your OpenSSL version. To check, try running " +
  "`openssl s_client -connect api.stripe.com:443` from the command line.";
const ERROR_MESSAGE_TIMEOUT_SUFFIX =
  "Please check your internet connection and try again. If this problem persists, you should check Stripe's service " +
  "status at https://status.stripe.com, or let us know at support@stripe.com.";
const NETWORK_MESSAGES: Record<NetworkError["kind"], string> = {
  connection: ERROR_MESSAGE_CONNECTION,
  open_timeout: `Timed out connecting to Stripe (%s). ${ERROR_MESSAGE_TIMEOUT_SUFFIX}`,
  read_timeout: `Timed out communicating with Stripe (%s). ${ERROR_MESSAGE_TIMEOUT_SUFFIX}`,
  ssl: ERROR_MESSAGE_SSL,
};

const BINDINGS_VERSION = "gumroad-nextjs";

// Ruby's String#inspect for the response bodies quoted in "Invalid response object" errors.
export function rubyInspect(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (char === "\f") out += "\\f";
    else if (char === "\v") out += "\\v";
    else if (char === "\b") out += "\\b";
    else if (char === "\x07") out += "\\a";
    else if (char === "\x1b") out += "\\e";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += char;
  }
  // `#{`, `#$` and `#@` are escaped so the result reads back as the same String.
  return `${out.replace(/#(?=[{$@])/gu, "\\#")}"`;
}

function generalApiError(status: number, body: string): APIError {
  return new APIError(`Invalid response object from API: ${rubyInspect(body)} (HTTP response code was ${status})`, { httpStatus: status, httpBody: body });
}

const OAUTH_ERRORS: Record<string, typeof OAuthError> = {
  invalid_client: InvalidClientError,
  invalid_grant: InvalidGrantError,
  invalid_request: InvalidOAuthRequestError,
  invalid_scope: InvalidScopeError,
  unsupported_grant_type: UnsupportedGrantTypeError,
  unsupported_response_type: UnsupportedResponseTypeError,
};

// StripeClient#handle_error_response.
function errorFromResponse(response: TransportResponse): StripeError {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return generalApiError(response.status, response.body);
  }
  const errorData = data && typeof data === "object" ? data.error : undefined;
  if (!errorData) return generalApiError(response.status, response.body);

  const base = { httpBody: response.body, httpHeaders: response.headers, httpStatus: response.status, jsonBody: data };
  if (typeof errorData === "string") {
    const description = typeof data.error_description === "string" ? data.error_description : errorData;
    const Klass = OAUTH_ERRORS[errorData] ?? OAuthError;
    return new Klass(errorData, description, base);
  }
  const error = errorData as Record<string, unknown>;
  const message = typeof error.message === "string" ? error.message : null;
  const param = typeof error.param === "string" ? error.param : null;
  const options: StripeErrorOptions = { ...base, code: typeof error.code === "string" ? error.code : null };
  switch (response.status) {
    case 400:
    case 404:
      return error.type === "idempotency_error" ? new IdempotencyError(message, options) : new InvalidRequestError(message, param, options);
    case 401:
      return new AuthenticationError(message, options);
    case 402:
      return new CardError(message, param, options);
    case 403:
      return new PermissionError(message, options);
    case 429:
      return new RateLimitError(message, options);
    default:
      return new APIError(message, options);
  }
}

// StripeClient.should_retry?
export function shouldRetry(error: unknown, numRetries: number, config: StripeConfig): boolean {
  if (numRetries >= config.maxNetworkRetries) return false;
  if (error instanceof NetworkError) return error.kind !== "ssl";
  if (!(error instanceof StripeError)) return false;
  const header = error.httpHeaders["stripe-should-retry"];
  if (header === "false") return false;
  if (header === "true") return true;
  if (error.httpStatus === 409) return true;
  if (error.httpStatus === 429 && error.code === "lock_timeout") return true;
  return error.httpStatus !== null && error.httpStatus >= 500;
}

// StripeClient.sleep_time, in seconds.
export function sleepTime(numRetries: number, config: StripeConfig, random: () => number = Math.random): number {
  let seconds = Math.min(config.initialNetworkRetryDelay * 2 ** (numRetries - 1), config.maxNetworkRetryDelay);
  seconds *= 0.5 * (1 + random());
  return Math.max(config.initialNetworkRetryDelay, seconds);
}

function checkApiKey(apiKey: string | undefined): asserts apiKey is string {
  if (!apiKey) {
    throw new AuthenticationError(
      'No API key provided. Set your API key using "Stripe.api_key = <API-KEY>". You can generate API keys from the Stripe web interface. ' +
        "See https://stripe.com/api for details, or email support@stripe.com if you have any questions.",
    );
  }
  if (/\s/u.test(apiKey)) {
    throw new AuthenticationError(
      "Your API key is invalid, as it contains whitespace. (HINT: You can double-check your API key from the Stripe web interface. " +
        "See https://stripe.com/api for details, or email support@stripe.com if you have any questions.)",
    );
  }
}

function clientUserAgent(): string {
  return JSON.stringify({
    bindings_version: BINDINGS_VERSION,
    lang: "node",
    lang_version: process.version,
    platform: `${process.arch}-${process.platform}`,
    engine: "v8",
    publisher: "gumroad",
    uname: `${os.type()} ${os.hostname()} ${os.release()} ${os.version()} ${os.machine()}`,
    hostname: os.hostname(),
  });
}

export type StripeClientOptions = {
  config?: StripeConfig;
  transport?: Transport;
  sleep?: (seconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export class StripeClient {
  readonly config: StripeConfig;
  private readonly transport: Transport;
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private lastRequestMetrics: { request_id: string; request_duration_ms: number } | null = null;

  constructor(options: StripeClientOptions = {}) {
    this.config = options.config ?? stripeConfigFromEnv();
    this.transport = options.transport ?? nodeTransport;
    this.sleep = options.sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => performance.now());
  }

  // StripeClient#request_headers, then the caller's opts on top (Util.normalize_headers).
  private requestHeaders(apiKey: string, method: HttpMethod, opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": `Stripe/v1 NodeBindings/${BINDINGS_VERSION}`,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.config.enableTelemetry && this.lastRequestMetrics) {
      headers["X-Stripe-Client-Telemetry"] = JSON.stringify({ last_request_metrics: this.lastRequestMetrics });
    }
    // Only safe to retry a post or delete with an idempotency key.
    if ((method === "post" || method === "delete") && this.config.maxNetworkRetries > 0) headers["Idempotency-Key"] = randomUUID();
    headers["Stripe-Version"] = this.config.apiVersion;
    headers["X-Stripe-Client-User-Agent"] = clientUserAgent();
    // Net::HTTP's defaults, so Stripe sees the same negotiation.
    headers["Accept-Encoding"] = "gzip;q=1.0,deflate;q=0.6,identity;q=0.3";
    headers.Accept = "*/*";
    if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
    if (opts.stripeAccount !== undefined) headers["Stripe-Account"] = opts.stripeAccount;
    if (opts.stripeVersion !== undefined) headers["Stripe-Version"] = opts.stripeVersion;
    return headers;
  }

  async request(method: HttpMethod, path: string, params: StripeParams = {}, opts: RequestOptions = {}): Promise<StripeResponse> {
    if (path.includes("?")) throw new Error("Pass query parameters as params, not in the path");
    const apiKey = opts.apiKey ?? this.config.apiKey;
    checkApiKey(apiKey);
    const cleaned = objectsToIds(params);
    const headers = this.requestHeaders(apiKey, method, opts);
    const encoded = encodeParameters(cleaned);
    // The gem always appends `?<query>` to a get or delete, even an empty one.
    const url = `${this.config.apiBase}${path}${method === "post" ? "" : `?${encoded}`}`;
    const body = method === "post" ? encoded : null;

    let numRetries = 0;
    let response: TransportResponse;
    for (;;) {
      const started = this.now();
      try {
        response = await this.transport({
          method: method.toUpperCase(),
          url,
          headers,
          body,
          openTimeoutMs: this.config.openTimeout * 1000,
          readTimeoutMs: this.config.readTimeout * 1000,
        });
        if (response.status >= 400) throw errorFromResponse(response);
        const requestId = response.headers["request-id"];
        if (this.config.enableTelemetry && requestId) {
          this.lastRequestMetrics = { request_id: requestId, request_duration_ms: Math.floor(this.now() - started) };
        }
        break;
      } catch (error) {
        if (shouldRetry(error, numRetries, this.config)) {
          numRetries += 1;
          await this.sleep(sleepTime(numRetries, this.config, this.random));
          continue;
        }
        if (error instanceof NetworkError) {
          let message = NETWORK_MESSAGES[error.kind].replace("%s", this.config.apiBase);
          if (numRetries > 0) message += ` Request was retried ${numRetries} times.`;
          throw new APIConnectionError(`${message}\n\n(Network error: ${error.message})`);
        }
        throw error;
      }
    }
    // Outside the retry loop, as in the gem: a 2xx that is not JSON is not retried.
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
      throw generalApiError(response.status, response.body);
    }
    return { data, status: response.status, headers: response.headers, requestId: response.headers["request-id"] ?? null };
  }
}

const agents = {
  "http:": new http.Agent({ keepAlive: true }),
  "https:": new https.Agent({ keepAlive: true }),
};

const ERRNO_MESSAGES: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  EHOSTUNREACH: "No route to host",
  ETIMEDOUT: "Connection timed out",
  ENETUNREACH: "Network is unreachable",
};

// Net::HTTP over node:http(s): open_timeout until the socket connects, read_timeout while waiting
// on the response.
export const nodeTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const target = new URL(request.url);
    const hostPort = `${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}`;
    const fail = (error: NetworkError) => {
      req.destroy();
      reject(error);
    };
    const headers: Record<string, string> = { ...request.headers };
    if (request.body !== null) headers["Content-Length"] = String(Buffer.byteLength(request.body));
    // The raw path, not URL#search: Net::HTTP sends the bare `?` of an empty query and URL drops it.
    const rawPath = request.url.slice(target.origin.length);
    const req = (target.protocol === "https:" ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: rawPath,
      method: request.method,
      headers,
      agent: agents[target.protocol as "http:" | "https:"],
    });
    let openTimer: NodeJS.Timeout | undefined;
    req.on("socket", (socket) => {
      if ((socket as { connecting?: boolean }).connecting) {
        openTimer = setTimeout(() => fail(new NetworkError("open_timeout", `Failed to open TCP connection to ${hostPort} (execution expired)`)), request.openTimeoutMs);
        socket.once("connect", () => clearTimeout(openTimer));
      }
    });
    req.setTimeout(request.readTimeoutMs, () => fail(new NetworkError("read_timeout", "Net::ReadTimeout with #<TCPSocket:(closed)>")));
    req.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(openTimer);
      if (error instanceof NetworkError) return;
      const code = error.code ?? "";
      if (ERRNO_MESSAGES[code]) {
        reject(new NetworkError("connection", `Failed to open TCP connection to ${hostPort} (${ERRNO_MESSAGES[code]} - connect(2) for "${target.hostname}" port ${target.port})`));
      } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        reject(new NetworkError("connection", `Failed to open TCP connection to ${hostPort} (getaddrinfo: Name or service not known)`));
      } else if (code === "ECONNRESET") {
        reject(new NetworkError("connection", "Connection reset by peer"));
      } else if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.includes("SSL")) {
        reject(new NetworkError("ssl", error.message));
      } else {
        // EOFError: the server closed the connection before answering.
        reject(new NetworkError("connection", "end of file reached"));
      }
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", () => reject(new NetworkError("connection", "end of file reached")));
      res.on("end", () => {
        let raw = Buffer.concat(chunks);
        const encoding = res.headers["content-encoding"];
        if (encoding === "gzip") raw = gunzipSync(raw);
        else if (encoding === "deflate") raw = inflateSync(raw);
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        }
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: raw.toString("utf8") });
      });
    });
    if (request.body !== null) req.write(request.body);
    req.end();
  });

let defaultClient: StripeClient | undefined;

// The process-wide client (the gem keeps one per thread), built from config on first use.
export function stripeClient(): StripeClient {
  defaultClient ??= new StripeClient();
  return defaultClient;
}

// Tests swap in a client over a fake transport; `undefined` rebuilds from config on next use.
export function setStripeClientForTesting(client: StripeClient | undefined): void {
  defaultClient = client;
}
