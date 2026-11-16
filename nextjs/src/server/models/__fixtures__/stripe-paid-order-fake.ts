// Stripe as the paid-order golden recorded it, for a test that runs Node code against the same timeline: the status of each attempt is
// the recorded one (a dropped connection included) and the bodies are the ones the golden's WebMock answered with
// (scripts/golden/support/stripe_paid_order.rb), rewritten the same way per request. Never reaches a network.
import { readFileSync } from "node:fs";
import path from "node:path";

import { NetworkError, type Transport, type TransportRequest, type TransportResponse } from "../../stripe/client.ts";

export type Attempt = {
  method: string;
  path: string;
  query?: string | null;
  body?: string | null;
  status?: number;
  raised?: string;
};

const SUPPORT = path.join(import.meta.dirname, "../../../../scripts/golden/support/stripe_paid_order");
type Json = Record<string, unknown>;
const fixture = (name: string) => JSON.parse(readFileSync(path.join(SUPPORT, `${name}.json`), "utf8")) as Json;
const CREATED = 1_770_730_388;

// Rack's parse_nested_query for the shapes Stripe bodies have: `a[b]=1&a[c][0]=2` is {a: {b: 1, c: {"0": 2}}}.
export function parseForm(form: string | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of (form ?? "").split("&").filter(Boolean)) {
    const [rawKey, rawValue = ""] = pair.split("=");
    const decode = (text: string) => decodeURIComponent(text.replaceAll("+", " "));
    const keys = [...decode(rawKey!).matchAll(/[^[\]]+/gu)].map((match) => match[0]);
    let cursor = out;
    keys.slice(0, -1).forEach((key) => {
      cursor = (cursor[key] ??= {}) as Record<string, unknown>;
    });
    cursor[keys.at(-1)!] = decode(rawValue);
  }
  return out;
}

// WebMock records a query normalised: `expand[0]=` as `expand[]=`, decoded, and the pairs sorted.
export function normalizedQuery(search: string | null | undefined): string {
  return decodeURIComponent((search ?? "").replace(/^\?/u, ""))
    .replaceAll(/\[\d+\]/gu, "[]")
    .split("&")
    .filter(Boolean)
    .sort()
    .join("&");
}

export type ConfirmState = "succeeded" | "requires_action" | "processing";

const json = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});

function intentIn(intent: Record<string, unknown>, state: ConfirmState) {
  if (state === "succeeded")
    return { ...intent, status: "succeeded", amount_received: intent.amount, latest_charge: `ch_${String(intent.id)}` };
  if (state === "requires_action")
    return {
      ...intent,
      status: "requires_action",
      next_action: {
        type: "use_stripe_sdk",
        use_stripe_sdk: {
          type: "three_d_secure_redirect",
          stripe_js: "https://hooks.stripe.com/redirect/authenticate/src_golden",
        },
      },
    };
  return { ...intent, status: "processing", processing: { type: "card", card: {} } };
}

function chargeFor(intent: Record<string, unknown>, chargeId: string) {
  const amount = intent.amount as number;
  const fee = Math.round(amount * 0.029 + 30);
  const base = fixture("charge") as { balance_transaction: Json; payment_method_details: Json } & Json;
  const details = base.payment_method_details as { card: Json };
  const feeDetails = (base.balance_transaction.fee_details as Json[])[0];
  return {
    ...base,
    id: chargeId,
    amount,
    amount_captured: amount,
    payment_intent: intent.id,
    description: intent.description,
    metadata: intent.metadata,
    created: CREATED + 1,
    application_fee_amount: intent.application_fee_amount,
    balance_transaction: {
      ...base.balance_transaction,
      id: `txn_${chargeId}`,
      amount,
      fee,
      net: amount - fee,
      source: chargeId,
      created: CREATED + 1,
      fee_details: [{ ...feeDetails, amount: fee }],
    },
    payment_method_details: { ...details, card: { ...details.card, amount_authorized: amount } },
  };
}

// Answers the recorded attempts in order; a request that is not the next recorded one fails the test.
export function recordedStripe(
  attempts: Attempt[],
  options: { confirm?: ConfirmState; decline?: Record<string, unknown> } = {},
): { transport: Transport; sent: TransportRequest[] } {
  const confirm = options.confirm ?? "succeeded";
  const sent: TransportRequest[] = [];
  const intents = new Map<string, Record<string, unknown>>();
  const transport: Transport = (request) => {
    const index = sent.length;
    sent.push(request);
    const recorded = attempts[index];
    const url = new URL(request.url);
    if (!recorded || recorded.method !== request.method || recorded.path !== url.pathname)
      throw new Error(`unexpected ${request.method} ${url.pathname} as call ${index + 1}`);
    if (recorded.raised !== undefined) throw new NetworkError("read_timeout", recorded.raised);

    const status = recorded.status!;
    const confirmMatch = /^\/v1\/payment_intents\/([^/]+)\/confirm$/u.exec(url.pathname);
    if (request.method === "POST" && url.pathname === "/v1/payment_intents") {
      const form = parseForm(request.body) as Record<string, string | undefined>;
      const id = `pi_golden_${intents.size + 1}`;
      const intent = {
        ...fixture("payment_intent_create"),
        id,
        client_secret: `${id}_secret_golden`,
        amount: Number(form.amount),
        currency: form.currency,
        description: form.description,
        metadata: parseForm(request.body).metadata,
        transfer_group: form.transfer_group,
        payment_method: form.payment_method,
        statement_descriptor_suffix: form.statement_descriptor_suffix,
        application_fee_amount: form.application_fee_amount === undefined ? null : Number(form.application_fee_amount),
        created: CREATED,
      };
      intents.set(id, intent);
      return Promise.resolve(json(status, intent));
    }
    if (confirmMatch) {
      const intent = intents.get(confirmMatch[1]!)!;
      if (status === 402) {
        const decline = fixture("decline") as { error: Record<string, unknown> };
        return Promise.resolve(
          json(402, {
            error: {
              ...decline.error,
              charge: `ch_${String(intent.id)}`,
              payment_intent: { ...intent, status: "requires_payment_method" },
              ...options.decline,
            },
          }),
        );
      }
      return Promise.resolve(json(status, intentIn(intent, confirm)));
    }
    const chargeMatch = /^\/v1\/charges\/([^/]+)$/u.exec(url.pathname);
    if (chargeMatch) {
      const chargeId = chargeMatch[1]!;
      return Promise.resolve(json(status, chargeFor(intents.get(chargeId.replace(/^ch_/u, ""))!, chargeId)));
    }
    throw new Error(`no answer for ${request.method} ${url.pathname}`);
  };
  return { transport, sent };
}
