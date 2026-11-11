import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "../../lib/obfuscate-ids.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, jsonSellerGuard, legalGuardianRequired, findFirst } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  jsonSellerGuard: vi.fn(),
  legalGuardianRequired: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./seller-json-guard.ts", async (original) => ({
  ...(await original<typeof import("./seller-json-guard.ts")>()),
  jsonSellerGuard,
}));
vi.mock("../page-props/settings/payments.ts", () => ({ legalGuardianRequired }));
vi.mock("../../lib/db.ts", () => ({ db: { guardian: { findFirst } } }));
vi.mock("../policies/settings/payments-user.ts", () => ({ settingsPaymentsUserPolicy: { update: () => true } }));

await import("./settings-guardians-mutations.ts");

const spec = (method: string) => specs.find((candidate) => candidate.method === method)!;
const input = (id?: string) =>
  ({ routeParams: { id }, context: { currentSeller: { id: 7n } } }) as unknown as MutationInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as unknown;

beforeEach(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "a".repeat(32);
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "0";
  jsonSellerGuard.mockReset().mockResolvedValue(null);
  legalGuardianRequired.mockReset().mockResolvedValue(true);
  findFirst.mockReset().mockResolvedValue({ id: 3n });
});

describe("Settings::GuardiansController guards", () => {
  it("serves the refusal of the seller guard before asking whether a guardian is required", async () => {
    const refusal = { status: 401, body: "{}", contentType: "application/json", rescued: true };
    jsonSellerGuard.mockResolvedValue(refusal);

    expect(await spec("POST").run(input())).toEqual({ ...refusal, paramsRead: true });
    expect(legalGuardianRequired).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH", "PUT"])("answers 403 on %s when no guardian is required", async (method) => {
    legalGuardianRequired.mockResolvedValue(false);

    const result = await spec(method).run(input(encrypt(3)));

    expect(result).toMatchObject({ status: 403, rescued: true });
    expect(body(result)).toEqual({ error: "A legal guardian isn't required on this account." });
  });

  it("hands a create to Rails once the guards pass", async () => {
    await expect(spec("POST").run(input())).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands an update of the seller's own guardian to Rails", async () => {
    await expect(spec("PATCH").run(input(encrypt(3)))).rejects.toBeInstanceOf(HandBackToRails);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 3n, user_id: 7n, deleted_at: null },
      select: { id: true },
    });
  });

  it("answers 404 with an empty body for a guardian that is not the seller's alive one", async () => {
    findFirst.mockResolvedValue(null);

    expect(await spec("PUT").run(input(encrypt(3)))).toMatchObject({ status: 404, body: "" });
  });

  it("answers 404 for an id that does not decrypt, without querying", async () => {
    expect(await spec("PATCH").run(input("not-an-id"))).toMatchObject({ status: 404, body: "" });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
