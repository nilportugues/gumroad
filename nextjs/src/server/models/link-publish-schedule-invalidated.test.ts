// Replays link-publish-schedule-invalidated.golden.json (scripts/golden/link-publish-schedule-invalidated.rb): the real
// Link#publish_schedule_invalidated? after a save that changes one thing about a persisted product.
import { readFileSync } from "node:fs";

import type { Link } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { Links, publishScheduleInvalidated } from "./link.ts";

type Golden = {
  cases: { name: string; initial: Record<string, unknown>; change: Record<string, unknown>; invalidated: boolean }[];
};
const golden = JSON.parse(
  readFileSync(new URL("__fixtures__/link-publish-schedule-invalidated.golden.json", import.meta.url), "utf8"),
) as Golden;

const DATE_COLUMNS = new Set(["deleted_at", "purchase_disabled_at", "banned_at"]);
const value = (column: string, raw: unknown) =>
  DATE_COLUMNS.has(column) && typeof raw === "string"
    ? new Date(raw)
    : column === "flags"
      ? BigInt(raw as number)
      : raw;

describe("Link#publish_schedule_invalidated?", () => {
  for (const c of golden.cases) {
    it(`answers ${String(c.invalidated)} for ${c.name}`, () => {
      const row = {
        id: 5n,
        user_id: 1n,
        name: "Pencil",
        draft: false,
        deleted_at: null,
        purchase_disabled_at: null,
        banned_at: null,
        flags: 0n,
        ...Object.fromEntries(Object.entries(c.initial).map(([column, raw]) => [column, value(column, raw)])),
      } as unknown as Link;
      const link = Links.load(row);
      for (const [column, raw] of Object.entries(c.change)) link.set(column as never, value(column, raw) as never);
      link.changesApplied();

      expect(publishScheduleInvalidated(link)).toBe(c.invalidated);
    });
  }
});
