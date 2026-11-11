import { readFileSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { railsMessageVerifierVerified } from "../auth/message-verifier.ts";

import { issueRestartIntentToken, RESTART_INTENT_PURPOSE } from "./checkout-restart-intent-token.ts";

// Tokens Node issued with a fixed clock far in the future, which Rails verifies in
// spec/services/checkout/restart_intent_token_node_spec.rb (the file is read there as well). Regenerate with
// RESTART_INTENT_GOLDEN=write after a deliberate format change, then re-run that spec.
const GOLDEN_PATH = new URL("../../../../spec/support/fixtures/restart_intent_token_node.json", import.meta.url);
const SECRET_KEY_BASE = "restart-intent-node-golden-secret";
const CASES = [
  { product_id: 7, buyer_id: null, now: "2099-01-02T03:04:05.678Z" },
  { product_id: 12, buyer_id: 42, now: "2099-06-30T23:59:59.001Z" },
  { product_id: 98765, buyer_id: null, now: "2099-01-01T00:00:00.500Z" },
];

const saved = process.env.SECRET_KEY_BASE;
beforeEach(() => {
  process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SECRET_KEY_BASE;
  else process.env.SECRET_KEY_BASE = saved;
});

const issued = () =>
  CASES.map(({ product_id, buyer_id, now }) => ({
    product_id,
    buyer_id,
    issued_at: new Date(now).getTime() / 1000,
    token: issueRestartIntentToken(BigInt(product_id), buyer_id === null ? null : BigInt(buyer_id), new Date(now)),
  }));

describe("issueRestartIntentToken", () => {
  it("signs product_id, buyer_id and issued_at in Rails' order, valid for an hour", () => {
    const [guest] = issued();
    const envelope = JSON.parse(Buffer.from(guest!.token.split("--")[0]!, "base64").toString("utf8")) as unknown;
    expect(envelope).toEqual({
      _rails: {
        data: { product_id: 7, buyer_id: null, issued_at: guest!.issued_at },
        exp: "2099-01-02T04:04:05.678Z",
        pur: RESTART_INTENT_PURPOSE,
      },
    });
    expect(Object.keys((envelope as { _rails: { data: object } })._rails.data)).toEqual([
      "product_id",
      "buyer_id",
      "issued_at",
    ]);
  });

  it("verifies until the hour is up and not after", () => {
    const [guest] = issued();
    const at = (iso: string) =>
      railsMessageVerifierVerified(RESTART_INTENT_PURPOSE, guest!.token, RESTART_INTENT_PURPOSE, new Date(iso));
    expect(at("2099-01-02T04:04:05.677Z")).toMatchObject({ product_id: 7 });
    expect(at("2099-01-02T04:04:05.678Z")).toBeNull();
  });

  it("matches the golden Rails verifies", () => {
    if (process.env.RESTART_INTENT_GOLDEN === "write")
      writeFileSync(
        GOLDEN_PATH,
        `${JSON.stringify({ secret_key_base: SECRET_KEY_BASE, tokens: issued() }, null, 2)}\n`,
      );
    expect(JSON.parse(readFileSync(GOLDEN_PATH, "utf8"))).toEqual({
      secret_key_base: SECRET_KEY_BASE,
      tokens: issued(),
    });
  });
});
