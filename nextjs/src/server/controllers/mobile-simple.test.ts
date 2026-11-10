import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileInput } from "./mobile-api.ts";

const { actions, selectRows, findLicense, enableBang, disableBang } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  findLicense: vi.fn(),
  enableBang: vi.fn(),
  disableBang: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({ ...(await original<typeof import("../models/sql.ts")>()), selectRows }));
vi.mock("../models/license.ts", () => ({ findLicense, enableBang, disableBang }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: () => 7, encrypt: (value: number | bigint) => `enc${value}` }));

await import("./mobile-simple.ts");

const update = actions.find((action) => action.method === "PUT" && action.pattern === "/mobile/licenses/:id")!.run;
const auth = { owner: { id: 3n } } as never;
const input = (params: Record<string, unknown>) => ({ params }) as unknown as MobileInput;
const license = { get: () => 11 };

beforeEach(() => {
  vi.resetAllMocks();
  findLicense.mockResolvedValue(license);
  selectRows.mockResolvedValue([{ seller_id: 3n }]);
});

describe("PUT /mobile/licenses/:id enabled cast", () => {
  it.each([
    ["an array", ["false"]],
    ["a hash", { a: "false" }],
    ["an empty array", []],
  ])("enables the license when enabled is %s, as Rails casts it to true", async (_name, enabled) => {
    const result = (await update(input({ id: "x", enabled }), auth)) as { body: string };
    expect(JSON.parse(result.body)).toEqual({ success: true });
    expect(enableBang).toHaveBeenCalledWith(license);
    expect(disableBang).not.toHaveBeenCalled();
  });

  it.each(["false", "0", "off", undefined, null, ""])("disables the license when enabled is %j", async (enabled) => {
    await update(input({ id: "x", enabled }), auth);
    expect(disableBang).toHaveBeenCalledWith(license);
    expect(enableBang).not.toHaveBeenCalled();
  });

  it("enables the license when enabled is true", async () => {
    await update(input({ id: "x", enabled: "true" }), auth);
    expect(enableBang).toHaveBeenCalledWith(license);
  });
});
