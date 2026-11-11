import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Exchange } from "../src/fixture";
import { standInDifferences, startStandIn, uncommittedReader, type StandIn } from "../src/stand-in";

// The stand-in's own proof, against a real database: it must see a write another connection has made inside an open transaction (Rails
// and Node write inside transactions), and attribute it to the call it preceded. Two probe tables stand for "the ledger" and "the rest".
const url = process.env.PARITY_DATABASE_URL;
const EARLY = "stand_in_probe_early";
const LATE = "stand_in_probe_late";
const STRIPE_URL = "https://api.stripe.com/v1/refunds";

describe.skipIf(!url)("stand-in write observation", () => {
  let client: PrismaClient;
  let stripe: StandIn;

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    for (const probe of [EARLY, LATE]) await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${probe} (id INT PRIMARY KEY)`);
    stripe = await startStandIn(uncommittedReader(client));
  });

  afterAll(async () => {
    await stripe?.close();
    for (const probe of [EARLY, LATE]) await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${probe}`);
    await client?.$disconnect();
  });

  const exchange = (timeline: Exchange["timeline"]) =>
    ({
      http: [{ method: "POST", url: STRIPE_URL, body: "charge=ch_1", headers: { "idempotency-key": "<uuid>" }, response: {} }],
      timeline,
    }) as unknown as Exchange;

  // An open transaction writes `before`, calls the stand-in, then writes `after`; nothing commits until the end.
  async function run(before: string | null, after: string | null) {
    await client.$executeRawUnsafe(`DELETE FROM ${EARLY}`);
    await client.$executeRawUnsafe(`DELETE FROM ${LATE}`);
    stripe.arm([{ method: "POST", url: STRIPE_URL, response: { status: 200, body: "{}" } }]);
    await stripe.baseline();
    await client.$transaction(async (tx) => {
      if (before) await tx.$executeRawUnsafe(`INSERT INTO ${before} VALUES (1)`);
      const response = await fetch(stripe.url + "/v1/refunds", {
        method: "POST",
        headers: { "x-parity-original-url": STRIPE_URL, "idempotency-key": "3f2b8f3e-5c0e-4f6b-9a39-0d1f4a6b7c8d" },
        body: "charge=ch_1",
      });
      expect(response.status).toBe(200);
      if (after) await tx.$executeRawUnsafe(`INSERT INTO ${after} VALUES (2)`);
    });
    return stripe.finish();
  }

  const callThenWrite: Exchange["timeline"] = [
    { type: "http", index: 0 },
    { type: "db", op: "insert", table: LATE },
  ];

  it("attributes an uncommitted write to the call it preceded", async () => {
    const seen = await run(EARLY, LATE);

    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]).toMatchObject({ method: "POST", url: STRIPE_URL, body: "charge=ch_1", headers: { "idempotency-key": "<uuid>" }, writtenBefore: [EARLY] });
    expect(seen.writtenAfter).toEqual([LATE]);
  });

  it("accepts a port that calls first and writes after, as the timeline says", async () => {
    expect(standInDifferences(exchange(callThenWrite), await run(null, LATE))).toEqual([]);
  });

  it("flags a port that writes before the call", async () => {
    expect(standInDifferences(exchange(callThenWrite), await run(EARLY, LATE))).toEqual([
      expect.stringContaining(`before call 1\n    rails: none\n    next:  ${EARLY}`),
    ]);
  });

  it("flags a port that never writes after the call", async () => {
    expect(standInDifferences(exchange(callThenWrite), await run(null, null))).toEqual([
      expect.stringContaining(`after the last call\n    rails: ${LATE}\n    next:  none`),
    ]);
  });
});
