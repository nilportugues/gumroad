// The failure kinds the content moderation strategies branch on. They mirror the Faraday and
// Net::ReadTimeout errors the Ruby rescues, so the transport adapter maps its errors onto these.
export type OpenAiRequestErrorKind = "bad_request" | "timeout" | "connection" | "parsing" | "server";

// `body` is the parsed JSON error response, which carries OpenAI's `error.code` and `error.message`.
export class OpenAiRequestError extends Error {
  constructor(
    readonly kind: OpenAiRequestErrorKind,
    readonly body?: unknown,
  ) {
    super(`OpenAI request failed: ${kind}`);
  }
}
