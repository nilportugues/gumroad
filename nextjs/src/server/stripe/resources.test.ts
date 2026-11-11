// The wrappers whose requests no VCR cassette records: the path and verb stripe-ruby 12.5.0 builds for them.
// cassettes.test.ts covers every wrapper a cassette exercises.
import { describe, expect, it } from "vitest";

import { StripeClient, type TransportRequest } from "./client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv } from "./config.ts";
import { Account, Charge, Dispute, PaymentIntent, PaymentMethod, Payout } from "./resources.ts";

function recordingClient() {
  const sent: TransportRequest[] = [];
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_x", apiVersion: STRIPE_API_VERSION },
    transport: async (request) => {
      sent.push(request);
      return { status: 200, headers: {}, body: "{}" };
    },
  });
  return { client, sent };
}

describe("Stripe resources that no cassette records", () => {
  it("builds the member and action paths", async () => {
    const { client, sent } = recordingClient();
    await Account.reject("acct_1", { reason: "fraud" }, { client });
    await Account.updateExternalAccount("acct_1", "ba_1", { default_for_currency: true }, { client });
    await Account.deletePerson("acct_1", "person_1", {}, { client });
    await Charge.update("ch_1", { description: "d" }, { client });
    await Charge.capture("ch_1", {}, { client });
    await Dispute.close("dp_1", {}, { client });
    await PaymentIntent.capture("pi_1", { amount_to_capture: 100 }, { client });
    await PaymentIntent.list({ limit: 1 }, { client });
    await PaymentMethod.attach("pm_1", { customer: "cus_1" }, { client });
    await Payout.cancel("po_1", {}, { client });

    expect(
      sent.map(
        (request) => `${request.method} ${request.url.replace("https://api.stripe.com", "")} ${request.body ?? ""}`,
      ),
    ).toEqual([
      "POST /v1/accounts/acct_1/reject reason=fraud",
      "POST /v1/accounts/acct_1/external_accounts/ba_1 default_for_currency=true",
      "DELETE /v1/accounts/acct_1/persons/person_1? ",
      "POST /v1/charges/ch_1 description=d",
      "POST /v1/charges/ch_1/capture ",
      "POST /v1/disputes/dp_1/close ",
      "POST /v1/payment_intents/pi_1/capture amount_to_capture=100",
      "GET /v1/payment_intents?limit=1 ",
      "POST /v1/payment_methods/pm_1/attach customer=cus_1",
      "POST /v1/payouts/po_1/cancel ",
    ]);
  });

  it("escapes ids and refuses a nil id like Ruby's CGI.escape", async () => {
    const { client, sent } = recordingClient();
    await Charge.update("a b", {}, { client });
    expect(sent[0]!.url).toBe("https://api.stripe.com/v1/charges/a+b");
    expect(() => Charge.update(null, {}, { client })).toThrow("no implicit conversion of nil into String");
  });
});
