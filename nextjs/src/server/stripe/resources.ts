// The Stripe resources Node code calls, as stripe-ruby 12.5.0's class methods build them
// (`Stripe::Account.retrieve(id, opts)` is `Account.retrieve(id, opts)`). Responses are the
// parsed JSON; stripe-node's types describe them for API version 2023-10-16.
import type Stripe from "stripe";

import { type RequestOptions, stripeClient } from "./client.ts";
import { cgiEscape, type StripeParams } from "./encode.ts";

async function call<T>(
  method: "get" | "post" | "delete",
  path: string,
  params: StripeParams,
  opts: RequestOptions,
): Promise<T> {
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

function create<T>(collectionPath: string) {
  return (params: StripeParams = {}, opts: RequestOptions = {}): Promise<T> =>
    call<T>("post", collectionPath, params, opts);
}

function list<T>(collectionPath: string) {
  return (filters: StripeParams = {}, opts: RequestOptions = {}): Promise<Stripe.ApiList<T>> =>
    call<Stripe.ApiList<T>>("get", collectionPath, filters, opts);
}

// UpdateableAPIResource.update(id, params, opts): a POST to the member path.
function update<T>(collectionPath: string) {
  return (id: string | null | undefined, params: StripeParams = {}, opts: RequestOptions = {}): Promise<T> =>
    call<T>("post", `${collectionPath}/${escapeId(id)}`, params, opts);
}

// DeletableAPIResource.delete(id, params, opts).
function remove<T>(collectionPath: string) {
  return (id: string | null | undefined, params: StripeParams = {}, opts: RequestOptions = {}): Promise<T> =>
    call<T>("delete", `${collectionPath}/${escapeId(id)}`, params, opts);
}

// A custom member action such as `confirm`: POST /v1/payment_intents/:id/confirm.
function action<T>(collectionPath: string, name: string) {
  return (id: string | null | undefined, params: StripeParams = {}, opts: RequestOptions = {}): Promise<T> =>
    call<T>("post", `${collectionPath}/${escapeId(id)}/${name}`, params, opts);
}

// APIOperations::NestedResource: `Account.create_person(id, params, opts)` and its siblings.
function nested<T, D>(parentPath: string, child: string) {
  const base = (id: string | null | undefined) => `${parentPath}/${escapeId(id)}/${child}`;
  const member = (id: string | null | undefined, nestedId: string | null | undefined) =>
    `${base(id)}/${escapeId(nestedId)}`;
  return {
    create: (id: string | null | undefined, params: StripeParams = {}, opts: RequestOptions = {}) =>
      call<T>("post", base(id), params, opts),
    retrieve: (
      id: string | null | undefined,
      nestedId: string | null | undefined,
      params: StripeParams = {},
      opts: RequestOptions = {},
    ) => call<T>("get", member(id, nestedId), params, opts),
    update: (
      id: string | null | undefined,
      nestedId: string | null | undefined,
      params: StripeParams = {},
      opts: RequestOptions = {},
    ) => call<T>("post", member(id, nestedId), params, opts),
    delete: (
      id: string | null | undefined,
      nestedId: string | null | undefined,
      params: StripeParams = {},
      opts: RequestOptions = {},
    ) => call<D>("delete", member(id, nestedId), params, opts),
    list: (id: string | null | undefined, filters: StripeParams = {}, opts: RequestOptions = {}) =>
      call<Stripe.ApiList<T>>("get", base(id), filters, opts),
  };
}

const persons = nested<Stripe.Person, Stripe.DeletedPerson>("/v1/accounts", "persons");
const externalAccounts = nested<Stripe.BankAccount | Stripe.Card, Stripe.DeletedBankAccount | Stripe.DeletedCard>(
  "/v1/accounts",
  "external_accounts",
);

export const Account = {
  // A nil id retrieves the platform's own account (`/v1/account`).
  retrieve: (id: IdOrParams | null | undefined, opts: RequestOptions = {}) =>
    id == null
      ? call<Stripe.Account>("get", "/v1/account", {}, opts)
      : retrieve<Stripe.Account>("/v1/accounts")(id, opts),
  create: create<Stripe.Account>("/v1/accounts"),
  update: update<Stripe.Account>("/v1/accounts"),
  delete: remove<Stripe.DeletedAccount>("/v1/accounts"),
  reject: action<Stripe.Account>("/v1/accounts", "reject"),
  createPerson: persons.create,
  retrievePerson: persons.retrieve,
  updatePerson: persons.update,
  deletePerson: persons.delete,
  listPersons: persons.list,
  createExternalAccount: externalAccounts.create,
  retrieveExternalAccount: externalAccounts.retrieve,
  updateExternalAccount: externalAccounts.update,
  deleteExternalAccount: externalAccounts.delete,
  listExternalAccounts: externalAccounts.list,
};

export const AccountLink = {
  create: create<Stripe.AccountLink>("/v1/account_links"),
};

export const Payout = {
  create: create<Stripe.Payout>("/v1/payouts"),
  retrieve: retrieve<Stripe.Payout>("/v1/payouts"),
  update: update<Stripe.Payout>("/v1/payouts"),
  list: list<Stripe.Payout>("/v1/payouts"),
  cancel: action<Stripe.Payout>("/v1/payouts", "cancel"),
  reverse: action<Stripe.Payout>("/v1/payouts", "reverse"),
};

export const PaymentIntent = {
  create: create<Stripe.PaymentIntent>("/v1/payment_intents"),
  retrieve: retrieve<Stripe.PaymentIntent>("/v1/payment_intents"),
  update: update<Stripe.PaymentIntent>("/v1/payment_intents"),
  list: list<Stripe.PaymentIntent>("/v1/payment_intents"),
  confirm: action<Stripe.PaymentIntent>("/v1/payment_intents", "confirm"),
  capture: action<Stripe.PaymentIntent>("/v1/payment_intents", "capture"),
  cancel: action<Stripe.PaymentIntent>("/v1/payment_intents", "cancel"),
};

export const SetupIntent = {
  create: create<Stripe.SetupIntent>("/v1/setup_intents"),
  retrieve: retrieve<Stripe.SetupIntent>("/v1/setup_intents"),
  update: update<Stripe.SetupIntent>("/v1/setup_intents"),
  confirm: action<Stripe.SetupIntent>("/v1/setup_intents", "confirm"),
  cancel: action<Stripe.SetupIntent>("/v1/setup_intents", "cancel"),
};

export const Charge = {
  retrieve: retrieve<Stripe.Charge>("/v1/charges"),
  update: update<Stripe.Charge>("/v1/charges"),
  list: list<Stripe.Charge>("/v1/charges"),
  capture: action<Stripe.Charge>("/v1/charges", "capture"),
};

export const Refund = {
  create: create<Stripe.Refund>("/v1/refunds"),
  retrieve: retrieve<Stripe.Refund>("/v1/refunds"),
  update: update<Stripe.Refund>("/v1/refunds"),
  list: list<Stripe.Refund>("/v1/refunds"),
  cancel: action<Stripe.Refund>("/v1/refunds", "cancel"),
};

export const Dispute = {
  retrieve: retrieve<Stripe.Dispute>("/v1/disputes"),
  update: update<Stripe.Dispute>("/v1/disputes"),
  list: list<Stripe.Dispute>("/v1/disputes"),
  close: action<Stripe.Dispute>("/v1/disputes", "close"),
};

export const Customer = {
  create: create<Stripe.Customer>("/v1/customers"),
  retrieve: retrieve<Stripe.Customer>("/v1/customers"),
  update: update<Stripe.Customer>("/v1/customers"),
  delete: remove<Stripe.DeletedCustomer>("/v1/customers"),
};

export const PaymentMethod = {
  create: create<Stripe.PaymentMethod>("/v1/payment_methods"),
  retrieve: retrieve<Stripe.PaymentMethod>("/v1/payment_methods"),
  update: update<Stripe.PaymentMethod>("/v1/payment_methods"),
  list: list<Stripe.PaymentMethod>("/v1/payment_methods"),
  attach: action<Stripe.PaymentMethod>("/v1/payment_methods", "attach"),
  detach: action<Stripe.PaymentMethod>("/v1/payment_methods", "detach"),
};

export const Token = {
  create: create<Stripe.Token>("/v1/tokens"),
  retrieve: retrieve<Stripe.Token>("/v1/tokens"),
};

export const BalanceTransaction = {
  retrieve: retrieve<Stripe.BalanceTransaction>("/v1/balance_transactions"),
  list: list<Stripe.BalanceTransaction>("/v1/balance_transactions"),
};

export const Balance = {
  // SingletonAPIResource.retrieve(opts), or retrieve(params, opts) as the instant payout lookup calls it.
  retrieve: (paramsOrOpts: RequestOptions | StripeParams = {}, opts?: RequestOptions) =>
    opts === undefined
      ? call<Stripe.Balance>("get", "/v1/balance", {}, paramsOrOpts as RequestOptions)
      : call<Stripe.Balance>("get", "/v1/balance", paramsOrOpts as StripeParams, opts),
};

export const Transfer = {
  create: (params: StripeParams, opts: RequestOptions = {}) =>
    call<Stripe.Transfer>("post", "/v1/transfers", params, opts),
  retrieve: retrieve<Stripe.Transfer>("/v1/transfers"),
  list: (filters: StripeParams = {}, opts: RequestOptions = {}) =>
    call<Stripe.ApiList<Stripe.Transfer>>("get", "/v1/transfers", filters, opts),
  createReversal: (id: string, params: StripeParams = {}, opts: RequestOptions = {}) =>
    call<Stripe.TransferReversal>("post", `/v1/transfers/${cgiEscape(id)}/reversals`, params, opts),
};

export const PaymentMethodDomain = {
  create: (params: StripeParams, opts: RequestOptions = {}) =>
    call<Stripe.PaymentMethodDomain>("post", "/v1/payment_method_domains", params, opts),
  validate: (id: string, params: StripeParams = {}, opts: RequestOptions = {}) =>
    call<Stripe.PaymentMethodDomain>("post", `/v1/payment_method_domains/${cgiEscape(id)}/validate`, params, opts),
};

export const ApplePayDomain = {
  create: (params: StripeParams, opts: RequestOptions = {}) =>
    call<Stripe.ApplePayDomain>("post", "/v1/apple_pay/domains", params, opts),
  retrieve: retrieve<Stripe.ApplePayDomain>("/v1/apple_pay/domains"),
  delete: (id: string, params: StripeParams = {}, opts: RequestOptions = {}) =>
    call<Stripe.DeletedApplePayDomain>("delete", `/v1/apple_pay/domains/${cgiEscape(id)}`, params, opts),
};
