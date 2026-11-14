// Port of `Taxjar::Client#summary_rates` (taxjar-ruby 3.0.4: GET /v2/summary_rates through http.rb, JSON parsed, the gem's errors raised).
// Only answers whose outcome Rails decides from the status line and a JSON object are modelled; a body the gem would choke on in a way
// Node does not reproduce is a `HandBackToRuby`, which is safe because the request is the first thing UpdateTaxRatesJob does.
import { getConfig } from "../infra/config.ts";
import { HandBackToRuby } from "../jobs/hand-back.ts";

import { taxjarBaseUrl } from "./taxjar.ts";

const API_VERSION = "2022-01-24";
const REQUEST_TIMEOUT_MS = 60_000;
const SUMMARY_RATES_PATH = "/v2/summary_rates";

// Taxjar::Error::ERRORS
const ERROR_CLASSES: Readonly<Record<number, string>> = {
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  405: "MethodNotAllowed",
  406: "NotAcceptable",
  410: "Gone",
  422: "UnprocessableEntity",
  429: "TooManyRequests",
  500: "InternalServerError",
  503: "ServiceUnavailable",
  504: "GatewayTimeout",
};

// HTTP::Response::Status::REASONS (http.rb 5)
const REASONS: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

/** A `Taxjar::Error` subclass: `name` is the Ruby class, `code` the status or the `status` field of the answer. */
export class TaxjarError extends Error {
  readonly code: unknown;
  constructor(rubyClass: string, message: string, code: unknown) {
    super(message);
    this.name = rubyClass;
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The user agent the gem sends is `TaxJar/Ruby (<uname>; ruby <version>; <openssl>) taxjar-ruby/3.0.4`; Node has no uname to report. */
export const TAXJAR_USER_AGENT = "TaxJar/Ruby (Node) taxjar-ruby/3.0.4";

export type SummaryRatesDeps = { fetch?: typeof fetch };

/** `client.summary_rates`: the `summary_rates` array of the answer (`[]` when missing or null), as parsed JSON. */
export async function fetchSummaryRates(deps: SummaryRatesDeps = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${taxjarBaseUrl()}${SUMMARY_RATES_PATH}`, {
      method: "GET",
      headers: {
        "user-agent": TAXJAR_USER_AGENT,
        authorization: `Bearer ${getConfig("TAXJAR_API_KEY") ?? ""}`,
        "x-api-version": API_VERSION,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HandBackToRuby("a TaxJar request that failed before an answer");
  }

  let body: unknown = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  const status = response.status;
  // `fail(Taxjar::Error.for_json_parse_error(code))` comes before the status is looked at.
  if (body === null) throw new TaxjarError("Taxjar::Error::ServerError", "Couldn't parse response as JSON.", status);
  if (!isRecord(body)) throw new HandBackToRuby("a TaxJar answer that is JSON but not an object");

  if (status >= 200 && status < 300) {
    const rates = body.summary_rates;
    return rates === undefined || rates === null || rates === false ? [] : rates;
  }
  const errorClass = ERROR_CLASSES[status];
  if (errorClass !== undefined) {
    const detail = body.detail;
    if (detail !== undefined && detail !== null && typeof detail !== "string")
      throw new HandBackToRuby("a TaxJar error whose detail is not a string");
    const rubyClass = `Taxjar::Error::${errorClass}`;
    throw new TaxjarError(rubyClass, detail ?? rubyClass, body.status);
  }
  // 1xx and statuses http.rb does not name end up as "Unknown Error".
  throw new TaxjarError("Taxjar::Error", REASONS[status] ?? "Unknown Error", status);
}
