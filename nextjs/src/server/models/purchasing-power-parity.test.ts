// Replays purchasing-power-parity.golden.json (scripts/golden/purchasing-power-parity.rb): the real
// PurchasingPowerParityService against Redis, with the commands it sent. A fake Redis serves the seed and
// records the commands, so Node must send the same ones and answer the same factors.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { getAllCountriesFactors, getFactor, minPppFactor, setFactor, setPurchasingPowerParityDepsForTesting } from "./purchasing-power-parity.ts";

type Case = {
  name: string;
  seed: Record<string, string | string[]>;
  limit: number | null;
  down: "timeout" | "refused" | null;
  call: [string, ...unknown[]];
  factor_to_s: string | null;
  result: { value?: unknown; error?: { class: string; message: string } };
  commands: string[][];
  after: Record<string, string | string[]>;
};
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/purchasing-power-parity.golden.json", import.meta.url), "utf8")) as {
  min_ppp_factors: Array<{ limit: number | null; min_ppp_factor: number }>;
  cases: Case[];
};

// A Redis holding `seed`. A list at a key raises WRONGTYPE for GET; SET replaces whatever is there.
function fakeRedis(seed: Case["seed"], down: boolean) {
  const data = new Map(Object.entries(seed));
  const commands: string[][] = [];
  const wrongType = () => new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  const read = (key: string) => {
    const value = data.get(key);
    if (Array.isArray(value)) throw wrongType();
    return value ?? null;
  };
  const guard = () => {
    if (down) throw new Error("Redis is not reachable");
  };
  return {
    commands,
    data,
    redis: {
      async get(key: string) {
        guard();
        commands.push(["get", key]);
        return read(key);
      },
      async set(key: string, value: string) {
        guard();
        commands.push(["set", key, value]);
        data.set(key, value);
        return "OK" as const;
      },
      async mget(...keys: string[]) {
        guard();
        commands.push(["mget", ...keys]);
        // MGET answers nil for a key that holds something other than a string.
        return keys.map((key) => (Array.isArray(data.get(key)) ? null : read(key)));
      },
    },
  };
}

afterEach(() => setPurchasingPowerParityDepsForTesting(undefined));

// Ruby's JSON writes a non-finite Float as null.
const jsonNumber = (value: number) => (Number.isFinite(value) ? value : null);

describe("User#min_ppp_factor", () => {
  for (const { limit, min_ppp_factor } of golden.min_ppp_factors) {
    it(`purchasing_power_parity_limit ${String(limit)}`, () => {
      expect(minPppFactor({ purchasing_power_parity_limit: limit })).toBe(min_ppp_factor);
    });
  }
});

describe("PurchasingPowerParityService", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const fake = fakeRedis(c.seed, c.down !== null);
      setPurchasingPowerParityDepsForTesting({ redis: () => fake.redis as never });
      const seller = { purchasing_power_parity_limit: c.limit };
      const [method, ...args] = c.call;

      let value: unknown;
      if (method === "get_factor") value = jsonNumber(await getFactor(args[0] as string | null, seller));
      else if (method === "get_all_countries_factors") value = (await getAllCountriesFactors(seller)).map(([code, factor]) => [code, jsonNumber(factor)]);
      else if (method === "set_factor") value = await setFactor(args[0] as string, c.factor_to_s!).then(() => "OK");
      else throw new Error(`unknown call ${method}`);

      expect(c.result.error).toBeUndefined();
      expect(value).toEqual(c.result.value);
      expect(fake.commands).toEqual(c.commands);
      expect(Object.fromEntries(fake.data)).toEqual(c.after);
    });
  }
});
