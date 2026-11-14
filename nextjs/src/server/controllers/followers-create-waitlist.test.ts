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
  custom_permalink: null,
  unique_permalink: "abc",
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

  it("takes a draft with the waitlist on, and a product that was published and then unpublished", async () => {
    selectRows.mockResolvedValueOnce([row({ unique_permalink: "abc" })]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toEqual({ id: 5, permalink: "abc" });
    selectRows.mockResolvedValueOnce([row({ draft: 1, custom_permalink: "mine", unique_permalink: "abc" })]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toEqual({ id: 5, permalink: "mine" });
    selectRows.mockResolvedValueOnce([row({ draft: false, purchase_disabled_at: new Date() })]);
    await expect(waitlistProductFromParams("known", seller)).resolves.toMatchObject({ id: 5 });
  });

  it("ignores a banned or taken down product and a malformed id", async () => {
    for (const over of [{ banned_at: new Date() }, { flags: ADMIN_UNPUBLISHED }]) {
      selectRows.mockResolvedValueOnce([row(over)]);
      await expect(waitlistProductFromParams("known", seller)).resolves.toBeNull();
    }
    await expect(waitlistProductFromParams("unknown", seller)).resolves.toBeNull();
  });

  it("hands back a deleted product and a product id that is not a string", async () => {
    selectRows.mockResolvedValueOnce([row({ deleted_at: new Date() })]);
    await expect(waitlistProductFromParams("known", seller)).rejects.toThrow(/waitlist/u);
    await expect(waitlistProductFromParams(["x"], seller)).rejects.toThrow(/waitlist/u);
  });
});
