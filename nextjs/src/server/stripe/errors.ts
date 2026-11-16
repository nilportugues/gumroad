// stripe-ruby 12.5.0's error classes (lib/stripe/errors.rb), so Node code rescues the same cases
// Ruby does: `catch (e) { if (e instanceof InvalidRequestError || e instanceof PermissionError) ... }`
// is `rescue Stripe::InvalidRequestError, Stripe::PermissionError`.
//
// `message` is Ruby's `#message` (the bare API message, what `"#{e.message}"` interpolates);
// `toString()` is Ruby's `#to_s`, with the status and request id in front. `rubyClass` is
// `e.class.name`, for messages that print it.

export type StripeErrorOptions = {
  httpStatus?: number | null;
  httpBody?: string | null;
  // Lower-cased names, as Net::HTTPHeader reads them case-insensitively.
  httpHeaders?: Record<string, string>;
  jsonBody?: Record<string, unknown> | null;
  code?: string | null;
};

export class StripeError extends Error {
  readonly rubyClass: string = "Stripe::StripeError";
  readonly httpStatus: number | null;
  readonly httpBody: string | null;
  readonly httpHeaders: Record<string, string>;
  readonly jsonBody: Record<string, unknown> | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly idempotentReplayed: boolean;
  // The `error` hash of the body (Ruby's ErrorObject), when there was one.
  readonly error: Record<string, unknown> | null;

  constructor(message: string | null, options: StripeErrorOptions = {}) {
    super(message ?? "");
    this.name = new.target.name;
    this.httpStatus = options.httpStatus ?? null;
    this.httpBody = options.httpBody ?? null;
    this.httpHeaders = options.httpHeaders ?? {};
    this.jsonBody = options.jsonBody ?? null;
    this.code = options.code ?? null;
    this.requestId = this.httpHeaders["request-id"] ?? null;
    this.idempotentReplayed = this.httpHeaders["idempotent-replayed"] === "true";
    const error = this.jsonBody?.error;
    this.error = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  }

  override toString(): string {
    const status = this.httpStatus === null ? "" : `(Status ${this.httpStatus}) `;
    const requestId = this.requestId === null ? "" : `(Request ${this.requestId}) `;
    return `${status}${requestId}${this.message}`;
  }
}

export class AuthenticationError extends StripeError {
  override readonly rubyClass: string = "Stripe::AuthenticationError";
}

export class APIConnectionError extends StripeError {
  override readonly rubyClass: string = "Stripe::APIConnectionError";
}

export class APIError extends StripeError {
  override readonly rubyClass: string = "Stripe::APIError";
}

export class CardError extends StripeError {
  override readonly rubyClass: string = "Stripe::CardError";
  readonly param: string | null;

  constructor(message: string | null, param: string | null, options: StripeErrorOptions = {}) {
    super(message, options);
    this.param = param;
  }
}

export class IdempotencyError extends StripeError {
  override readonly rubyClass: string = "Stripe::IdempotencyError";
}

export class InvalidRequestError extends StripeError {
  override readonly rubyClass: string = "Stripe::InvalidRequestError";
  readonly param: string | null;

  constructor(message: string | null, param: string | null, options: StripeErrorOptions = {}) {
    super(message, options);
    this.param = param;
  }
}

export class PermissionError extends StripeError {
  override readonly rubyClass: string = "Stripe::PermissionError";
}

export class RateLimitError extends StripeError {
  override readonly rubyClass: string = "Stripe::RateLimitError";
}

// Stripe::OAuth::OAuthError and its subclasses: `message` is the error description, `code` the
// OAuth error code.
export class OAuthError extends StripeError {
  override readonly rubyClass: string = "Stripe::OAuth::OAuthError";

  constructor(code: string, description: string, options: StripeErrorOptions = {}) {
    super(description, { ...options, code });
  }
}

export class InvalidClientError extends OAuthError {
  override readonly rubyClass: string = "Stripe::OAuth::InvalidClientError";
}
export class InvalidGrantError extends OAuthError {
  override readonly rubyClass: string = "Stripe::OAuth::InvalidGrantError";
}
export class InvalidOAuthRequestError extends OAuthError {
  override readonly rubyClass: string = "Stripe::OAuth::InvalidRequestError";
}
export class InvalidScopeError extends OAuthError {
  override readonly rubyClass: string = "Stripe::OAuth::InvalidScopeError";
}
export class UnsupportedGrantTypeError extends OAuthError {
  override readonly rubyClass: string = "Stripe::OAuth::UnsupportedGrantTypeError";
}
export class UnsupportedResponseTypeError extends OAuthError {
  override readonly rubyClass: string = "Stripe::OAuth::UnsupportedResponseTypeError";
}
