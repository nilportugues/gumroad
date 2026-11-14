import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectRows } = vi.hoisted(() => ({ selectRows: vi.fn() }));

vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../lib/obfuscate-ids.ts", async (original) => ({
  ...(await original<typeof import("../../lib/obfuscate-ids.ts")>()),
  decrypt: (value: string) => (value === "known" ? 5 : null),
}));
vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));

import { LinkFlags } from "../models/link.ts";

import { waitlistProductFromParams } from "./followers-create.ts";

const seller = { get: () => 7n } as never;
const ON = LinkFlags.set(0n, "waitlist_enabled", true);
const ADMIN_UNPUBLISHED = LinkFlags.set(ON, "is_unpublished_by_admin", true);
const row = (over: Record<string, unknown> = {}) => ({
  flags: ON,
  draft: true,
  deleted_at: null,
  banned_at: null,
  purchase_disabled_at: null,
  ...over,
});

beforeEach(() => selectRows.mockReset());

describe("waitlistProductFromParams", () => {
  it("lets a follow without a product through", async () => {
    await expect(waitlistProductFromParams(undefined, seller)).resolves.toBeNull();
    await expect(waitlistProductFromParams("", seller)).resolves.toBeNull();
  });

  it("ignores a product of the seller whose waitlist is off, and one that is not the seller's", async () => {
    selectRows.mockResolvedValueOnce([row({ flags: 0n })]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toBeNull();
    selectRows.mockResolvedValueOnce([]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toBeNull();
  });

  it("ignores a published product even with the waitlist on", async () => {
    selectRows.mockResolvedValueOnce([row({ draft: false })]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toBeNull();
    selectRows.mockResolvedValueOnce([row({ draft: 0 })]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toBeNull();
  });

  it("takes the id of a draft with the waitlist on", async () => {
    selectRows.mockResolvedValueOnce([row()]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toBe(5);
    selectRows.mockResolvedValueOnce([row({ draft: 1 })]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toBe(5);
  });

  it("hands back states no recording covers, a malformed id and a missing seller", async () => {
    for (const over of [
      { deleted_at: new Date() },
      { banned_at: new Date() },
      { flags: ADMIN_UNPUBLISHED },
      { draft: false, purchase_disabled_at: new Date() },
    ]) {
      selectRows.mockResolvedValueOnce([row(over)]);
      await expect(waitlistProductFromParams("known", seller)).rejects.toThrow(/waitlist/u);
    }
    await expect(waitlistProductFromParams("unknown", seller)).rejects.toThrow(/waitlist/u);
    await expect(waitlistProductFromParams("known", null)).rejects.toThrow(/waitlist/u);
    await expect(waitlistProductFromParams(["x"], seller)).rejects.toThrow(/waitlist/u);
  });
});
