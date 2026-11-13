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

import { requireNoWaitlistProduct } from "./followers-create.ts";

const seller = { get: () => 7n } as never;
const WAITLIST_FLAG = LinkFlags.set(0n, "waitlist_enabled", true);

beforeEach(() => selectRows.mockReset());

describe("requireNoWaitlistProduct", () => {
  it("lets a follow without a product through", async () => {
    await expect(requireNoWaitlistProduct(undefined, seller)).resolves.toBeUndefined();
    await expect(requireNoWaitlistProduct("", seller)).resolves.toBeUndefined();
  });

  it("ignores a product of the seller whose waitlist is off", async () => {
    selectRows.mockResolvedValueOnce([{ flags: 0n }]);
    await expect(requireNoWaitlistProduct("known", seller)).resolves.toBeUndefined();
  });

  it("hands back a product with the waitlist on, an unknown product and a missing seller", async () => {
    selectRows.mockResolvedValueOnce([{ flags: WAITLIST_FLAG }]);
    await expect(requireNoWaitlistProduct("known", seller)).rejects.toThrow(/waitlist/u);
    selectRows.mockResolvedValueOnce([]);
    await expect(requireNoWaitlistProduct("known", seller)).rejects.toThrow(/waitlist/u);
    await expect(requireNoWaitlistProduct("known", null)).rejects.toThrow(/waitlist/u);
    await expect(requireNoWaitlistProduct(["x"], seller)).rejects.toThrow(/waitlist/u);
  });
});
