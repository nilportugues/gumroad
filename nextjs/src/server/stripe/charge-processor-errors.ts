// app/business/payments/charging/errors/*.rb and StripeErrorHandler#with_stripe_error_handler: the error a Stripe gem failure becomes
// when it crosses StripeChargeProcessor. `message` is GumroadRuntimeError's `super(message || original_error)`, which is the wrapped
// error's `to_s` (status and request id first) unless the class passes a message of its own (the card error).
import { APIConnectionError, APIError, CardError, InvalidRequestError, RateLimitError, StripeError } from "./errors.ts";

export class ChargeProcessorError extends Error {
  readonly rubyClass: string = "ChargeProcessorError";
  readonly originalError: StripeError | null;

  constructor(message: string, originalError: StripeError | null = null) {
    super(message);
    this.name = new.target.name;
    this.originalError = originalError;
  }
}

export class ChargeProcessorInvalidRequestError extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorInvalidRequestError";
}
export class ChargeProcessorFxQuoteInvalidError extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorFxQuoteInvalidError";
}
export class ChargeProcessorUnavailableError extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorUnavailableError";
}
export class ChargeProcessorCardError extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorCardError";
}
export class ChargeProcessorErrorRateLimit extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorErrorRateLimit";
}
export class ChargeProcessorErrorGeneric extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorErrorGeneric";
}

// The rescue clauses of `with_stripe_error_handler`, in its order. Anything that is not a Stripe error passes through.
export function chargeProcessorError(error: unknown): unknown {
  if (!(error instanceof StripeError)) return error;
  if (error instanceof InvalidRequestError) {
    return error.code === "payment_intent_fx_quote_invalid"
      ? new ChargeProcessorFxQuoteInvalidError(error.toString(), error)
      : new ChargeProcessorInvalidRequestError(error.toString(), error);
  }
  if (error instanceof APIConnectionError || error instanceof APIError)
    return new ChargeProcessorUnavailableError(error.toString(), error);
  if (error instanceof CardError) return new ChargeProcessorCardError(error.message, error);
  if (error instanceof RateLimitError) return new ChargeProcessorErrorRateLimit(error.toString(), error);
  return new ChargeProcessorErrorGeneric(error.toString(), error);
}

export async function withStripeErrorHandler<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw chargeProcessorError(error);
  }
}
