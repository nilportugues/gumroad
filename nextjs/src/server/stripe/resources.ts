// The Stripe resources Node code calls, as stripe-ruby 12.5.0's class methods build them
// (`Stripe::Account.retrieve(id, opts)` is `Account.retrieve(id, opts)`). Responses are the
// parsed JSON; stripe-node's types describe them for API version 2023-10-16.
import type Stripe from "stripe";

import { type RequestOptions, stripeClient } from "./client.ts";
import { cgiEscape, type StripeParams } from "./encode.ts";

async function call<T>(method: "get" | "post" | "delete", path: string, params: StripeParams, opts: RequestOptions): Promise<T> {
  const client = opts.client ?? stripeClient();
  const response = await client.request(method, path, params, opts);
  return response.data as T;
}

// Util.normalize_id: a Hash id carries the retrieve params alongside `id`.
type IdOrParams = string | ({ id: string } & Record<string, unknown>);

function normalizeId(id: IdOrParams): [string, StripeParams] {
  if (typeof id === "string") return [id, {}];
  const { id: value, ...params } = id;
  return [value, params as StripeParams];
}

function retrieve<T>(collectionPath: string) {
  return (id: IdOrParams, opts: RequestOptions = {}): Promise<T> => {
    const [value, params] = normalizeId(id);
    return call<T>("get", `${collectionPath}/${cgiEscape(value)}`, params, opts);
  };
}

// CGI.escape(nil)
function escapeId(id: string | null | undefined): string {
  if (id == null) throw new TypeError("no implicit conversion of nil into String");
  return cgiEscape(id);
}

export const Account = {
  // A nil id retrieves the platform's own account (`/v1/account`).
  retrieve: (id: IdOrParams | null | undefined, opts: RequestOptions = {}) =>
    id == null ? call<Stripe.Account>("get", "/v1/account", {}, opts) : retrieve<Stripe.Account>("/v1/accounts")(id, opts),
  update: (id: string | null | undefined, params: StripeParams = {}, opts: RequestOptions = {}) =>
    call<Stripe.Account>("post", `/v1/accounts/${escapeId(id)}`, params, opts),
};

export const Payout = {
  retrieve: retrieve<Stripe.Payout>("/v1/payouts"),
};

export const Balance = {
  // SingletonAPIResource.retrieve(opts).
  retrieve: (opts: RequestOptions = {}) => call<Stripe.Balance>("get", "/v1/balance", {}, opts),
};

export const Transfer = {
  create: (params: StripeParams, opts: RequestOptions = {}) => call<Stripe.Transfer>("post", "/v1/transfers", params, opts),
  retrieve: retrieve<Stripe.Transfer>("/v1/transfers"),
  list: (filters: StripeParams = {}, opts: RequestOptions = {}) => call<Stripe.ApiList<Stripe.Transfer>>("get", "/v1/transfers", filters, opts),
  createReversal: (id: string, params: StripeParams = {}, opts: RequestOptions = {}) =>
    call<Stripe.TransferReversal>("post", `/v1/transfers/${cgiEscape(id)}/reversals`, params, opts),
};

export const ApplePayDomain = {
  create: (params: StripeParams, opts: RequestOptions = {}) => call<Stripe.ApplePayDomain>("post", "/v1/apple_pay/domains", params, opts),
  retrieve: retrieve<Stripe.ApplePayDomain>("/v1/apple_pay/domains"),
  delete: (id: string, params: StripeParams = {}, opts: RequestOptions = {}) =>
    call<Stripe.DeletedApplePayDomain>("delete", `/v1/apple_pay/domains/${cgiEscape(id)}`, params, opts),
};
