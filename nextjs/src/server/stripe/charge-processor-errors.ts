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
  // `processor_error_code`: the wrapped error's own code
  processorErrorCode: string | null = null;
}
export class ChargeProcessorFxQuoteInvalidError extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorFxQuoteInvalidError";
}
export class ChargeProcessorUnavailableError extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorUnavailableError";
  // Not in Ruby, which drops it: the id of a PaymentIntent that was created before the connection to Stripe failed, so a caller can
  // keep what Stripe may have charged.
  lostIntentId: string | null = null;
}
export class ChargeProcessorCardError extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorCardError";
  // get_card_error_details: `card_declined` followed by the decline code, and the id of the charge that was declined
  errorCode: string | null = null;
  chargeId: string | null = null;
}
export class ChargeProcessorErrorRateLimit extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorErrorRateLimit";
}
export class ChargeProcessorErrorGeneric extends ChargeProcessorError {
  override readonly rubyClass = "ChargeProcessorErrorGeneric";
  errorCode: string | null = null;
}

// The rescue clauses of `with_stripe_error_handler`, in its order. Anything that is not a Stripe error passes through.
export function chargeProcessorError(error: unknown): unknown {
  if (!(error instanceof StripeError)) return error;
  if (error instanceof InvalidRequestError) {
    if (error.code === "payment_intent_fx_quote_invalid")
      return new ChargeProcessorFxQuoteInvalidError(error.toString(), error);
    return Object.assign(new ChargeProcessorInvalidRequestError(error.toString(), error), {
      processorErrorCode: error.code,
    });
  }
  if (error instanceof APIConnectionError || error instanceof APIError)
    return new ChargeProcessorUnavailableError(error.toString(), error);
  if (error instanceof CardError) {
    const details = (error.error ?? {}) as { decline_code?: unknown; charge?: unknown };
    const declineCode =
      typeof details.decline_code === "string" && details.decline_code !== "" ? details.decline_code : null;
    return Object.assign(new ChargeProcessorCardError(error.message, error), {
      errorCode: error.code === "card_declined" && declineCode !== null ? `${error.code}_${declineCode}` : error.code,
      chargeId: typeof details.charge === "string" ? details.charge : null,
    });
  }
  if (error instanceof RateLimitError) return new ChargeProcessorErrorRateLimit(error.toString(), error);
  return Object.assign(new ChargeProcessorErrorGeneric(error.toString(), error), { errorCode: error.code });
}

export async function withStripeErrorHandler<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw chargeProcessorError(error);
  }
}
