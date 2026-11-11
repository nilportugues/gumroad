import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, findUnique, remove } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  findUnique: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./json-seller.ts", async (original) => ({
  ...(await original<typeof import("./json-seller.ts")>()),
  sellerJsonAction: (_input: unknown, _policy: unknown, run: (context: unknown) => unknown): unknown => run({}),
}));
vi.mock("../../lib/db.ts", () => ({ db: { totpCredential: { findUnique, delete: remove } } }));

await import("./settings-totp-mutations.ts");

const find = (method: string, pattern: string) =>
  specs.find((spec) => spec.method === method && spec.pattern === pattern)!;
const input = { context: { currentSeller: { id: 7n } } } as unknown as MutationInput;
const answer = async (spec: MutationSpec): Promise<unknown[]> => {
  const rendered = (await spec.run(input)) as unknown as { status: number; body: string };
  return [rendered.status, JSON.parse(rendered.body) as unknown];
};

const PENDING = { id: 1n, confirmed_at: null };
const CONFIRMED = { id: 1n, confirmed_at: new Date() };

beforeEach(() => {
  findUnique.mockReset();
  remove.mockReset();
});

describe("POST /settings/totp", () => {
  const create = find("POST", "/settings/totp");

  it("answers 422 when the authenticator app is already enabled", async () => {
    findUnique.mockResolvedValue(CONFIRMED);

    expect(await answer(create)).toEqual([
      422,
      { success: false, error_message: "Authenticator app is already enabled." },
    ]);
  });

  it.each([
    ["no credential", null],
    ["a pending credential", PENDING],
  ])("hands back the setup of an account with %s", async (_label, credential) => {
    findUnique.mockResolvedValue(credential);

    await expect(create.run(input)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("POST /settings/totp/confirm", () => {
  const confirm = find("POST", "/settings/totp/confirm");

  it.each([
    ["no credential", null],
    ["an already confirmed credential", CONFIRMED],
  ])("answers 422 with %s", async (_label, credential) => {
    findUnique.mockResolvedValue(credential);

    expect(await answer(confirm)).toEqual([422, { success: false, error_message: "No pending TOTP setup found." }]);
  });

  it("hands back a pending credential, whose code check depends on the clock", async () => {
    findUnique.mockResolvedValue(PENDING);

    await expect(confirm.run(input)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("DELETE /settings/totp", () => {
  const destroy = find("DELETE", "/settings/totp");

  it.each([
    ["no credential", null],
    ["a pending credential", PENDING],
  ])("answers 422 with %s", async (_label, credential) => {
    findUnique.mockResolvedValue(credential);

    expect(await answer(destroy)).toEqual([
      422,
      { success: false, error_message: "Authenticator app is not enabled." },
    ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes a confirmed credential", async () => {
    findUnique.mockResolvedValue(CONFIRMED);

    expect(await answer(destroy)).toEqual([200, { success: true }]);
    expect(remove).toHaveBeenCalledWith({ where: { id: 1n } });
  });
});

describe("POST /settings/totp/regenerate_recovery_codes", () => {
  const regenerate = find("POST", "/settings/totp/regenerate_recovery_codes");

  it("answers 422 when the authenticator app is not enabled", async () => {
    findUnique.mockResolvedValue(PENDING);

    expect(await answer(regenerate)).toEqual([
      422,
      { success: false, error_message: "Authenticator app is not enabled." },
    ]);
  });

  it("hands back the generation of random recovery codes", async () => {
    findUnique.mockResolvedValue(CONFIRMED);

    await expect(regenerate.run(input)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
