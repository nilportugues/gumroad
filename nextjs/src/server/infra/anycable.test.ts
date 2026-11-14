// Replays anycable.golden.json (scripts/golden/anycable.rb): the stream entry the real AnyCable redisx broadcaster wrote.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { broadcastToCommunity } from "./anycable.ts";

type Golden = { cases: { name: string; payload: unknown; stream_entries: { payload: string }[] }[] };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/anycable.golden.json", import.meta.url), "utf8")) as Golden;

describe("broadcastToCommunity", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const calls: unknown[][] = [];
      // The golden's channel is its own class (stream "golden:..."); the community channel differs only in that prefix.
      await broadcastToCommunity("zzz", c.payload, { xadd: (async (...args: unknown[]) => calls.push(args)) as never });
      const written = JSON.parse(calls[0]![3] as string) as { stream: string; data: string };
      const expected = JSON.parse(c.stream_entries[0]!.payload) as { stream: string; data: string };
      expect(written.stream).toBe("community:community_zzz");
      expect(expected.stream).toBe("golden:community_zzz");
      expect(written.data).toBe(expected.data);
      expect(Object.keys(written)).toEqual(Object.keys(expected));
    });
  }
});
