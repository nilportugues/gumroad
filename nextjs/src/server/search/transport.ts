// The request layer under EsClient (elasticsearch-transport 7.11.2 over Faraday, as
// config/initializers/elasticsearch.rb builds it). Every call names its HTTP method, path, query
// and body the way elasticsearch-api 7.11.2 writes them, so a request from Node is the request
// Rails sends; search.golden.json records Rails' requests and transport.test.ts replays them.
//
// The retry policy is Ruby's, not the JS client's: `retry_on_failure: 5` retries connection
// failures and timeouts (six tries in all) and never retries an HTTP status, where the JS client
// retries 502/503/504 and gives up on timeouts. So the JS client runs with retries off and this
// module loops.
import type { Client } from "@elastic/elasticsearch";

import { getElasticsearch } from "../infra/elasticsearch.ts";

const MAX_RETRIES = 5;

export type EsMethod = "GET" | "PUT" | "POST" | "DELETE" | "HEAD";

export type EsRequest = {
  method: EsMethod;
  path: string;
  // Faraday's NestedParamsEncoder sorts the query by key; callers pass it in any order.
  query?: Record<string, string>;
  // Already serialized (es-json.ts), or NDJSON for _bulk.
  body?: string;
  ndjson?: boolean;
  // Statuses that return instead of raising, as `ignore:` does.
  ignore?: readonly number[];
};

export type EsResponse = { status: number; body: unknown };

// Transport::Errors::HTTP_STATUSES: the class each status raises.
const HTTP_STATUSES: Record<number, string> = {
  300: "MultipleChoices", 301: "MovedPermanently", 302: "Found", 303: "SeeOther", 304: "NotModified", 305: "UseProxy",
  307: "TemporaryRedirect", 308: "PermanentRedirect", 400: "BadRequest", 401: "Unauthorized", 402: "PaymentRequired",
  403: "Forbidden", 404: "NotFound", 405: "MethodNotAllowed", 406: "NotAcceptable", 407: "ProxyAuthenticationRequired",
  408: "RequestTimeout", 409: "Conflict", 410: "Gone", 411: "LengthRequired", 412: "PreconditionFailed",
  413: "RequestEntityTooLarge", 414: "RequestURITooLong", 415: "UnsupportedMediaType", 416: "RequestedRangeNotSatisfiable",
  417: "ExpectationFailed", 418: "ImATeapot", 421: "TooManyConnectionsFromThisIP", 426: "UpgradeRequired",
  450: "BlockedByWindowsParentalControls", 494: "RequestHeaderTooLarge", 497: "HTTPToHTTPS", 499: "ClientClosedRequest",
  500: "InternalServerError", 501: "NotImplemented", 502: "BadGateway", 503: "ServiceUnavailable", 504: "GatewayTimeout",
  505: "HTTPVersionNotSupported", 506: "VariantAlsoNegotiates", 510: "NotExtended",
};

// Elasticsearch::Transport::Transport::ServerError and its per-status subclasses
// (Errors::NotFound, Errors::Conflict, ...): "[<status>] <response body>".
export class EsServerError extends Error {
  readonly status: number;
  readonly responseBody: string;
  constructor(status: number, responseBody: string) {
    super(`[${status}] ${responseBody}`);
    const name = HTTP_STATUSES[status];
    this.name = name ? `Elasticsearch::Transport::Transport::Errors::${name}` : "Elasticsearch::Transport::Transport::ServerError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

// Faraday::TimeoutError / Faraday::ConnectionFailed, raised once the retries are spent.
export class EsHostUnreachableError extends Error {
  readonly kind: "timeout" | "connection";
  constructor(kind: "timeout" | "connection", message: string) {
    super(message);
    this.name = kind === "timeout" ? "Faraday::TimeoutError" : "Faraday::ConnectionFailed";
    this.kind = kind;
  }
}

export const isConflict = (error: unknown): boolean => error instanceof EsServerError && error.status === 409;
export const isNotFound = (error: unknown): boolean => error instanceof EsServerError && error.status === 404;
export const isTimeout = (error: unknown): boolean => error instanceof EsHostUnreachableError && error.kind === "timeout";

// A transport that answers one request: the JS client in production, a recorder in tests.
export type EsSender = (request: EsRequest) => Promise<EsResponse>;

function sortedQuery(query: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!query || Object.keys(query).length === 0) return undefined;
  return Object.fromEntries(Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function errorBodyText(body: unknown): string {
  if (body === undefined || body === null) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

export function clientSender(client: () => Client = getElasticsearch): EsSender {
  return async (request) => {
    try {
      const result = await client().transport.request(
        {
          method: request.method,
          path: request.path,
          querystring: sortedQuery(request.query) ?? {},
          ...(request.body === undefined ? {} : request.ndjson ? { bulkBody: request.body } : { body: request.body }),
        },
        { maxRetries: 0, ignore: [...(request.ignore ?? [])] },
      );
      return { status: result.statusCode ?? 200, body: result.body };
    } catch (error) {
      const err = error as { name?: string; message?: string; meta?: { statusCode?: number; body?: unknown } };
      if (err.name === "ResponseError" && err.meta?.statusCode !== undefined) {
        throw new EsServerError(err.meta.statusCode, errorBodyText(err.meta.body));
      }
      if (err.name === "TimeoutError") throw new EsHostUnreachableError("timeout", err.message ?? "timeout");
      if (err.name === "ConnectionError" || err.name === "NoLivingConnectionsError") {
        throw new EsHostUnreachableError("connection", err.message ?? "connection failed");
      }
      throw error;
    }
  };
}

let sender: EsSender = clientSender();

export function setEsSender(next: EsSender): () => void {
  const previous = sender;
  sender = next;
  return () => {
    sender = previous;
  };
}

// Transport::Base#perform_request: retries host-unreachable errors, raises a ServerError for any
// status >= 300 not in `ignore`.
export async function perform(request: EsRequest): Promise<EsResponse> {
  const normalized: EsRequest = { ...request, ...(request.query ? { query: sortedQuery(request.query) ?? {} } : {}) };
  for (let tries = 1; ; tries++) {
    try {
      const response = await sender(normalized);
      if (response.status >= 300 && !(request.ignore ?? []).includes(response.status)) {
        throw new EsServerError(response.status, errorBodyText(response.body));
      }
      return response;
    } catch (error) {
      if (error instanceof EsHostUnreachableError && tries <= MAX_RETRIES) continue;
      throw error;
    }
  }
}
