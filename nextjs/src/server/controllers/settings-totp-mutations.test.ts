import { beforeEach, describe, expect, it, vi } from "vitest";

import { totpAt } from "../../lib/rotp.ts";

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
const { locked, execute, generate } = vi.hoisted(() => ({ locked: vi.fn(), execute: vi.fn(), generate: vi.fn() }));
vi.mock("../models/runtime/transaction.ts", () => ({ transaction: (run: () => unknown) => run() }));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows: locked,
  execute,
}));
vi.mock("../models/totp-credential.ts", async (original) => ({
  ...(await original<typeof import("../models/totp-credential.ts")>()),
  generateRecoveryCodes: generate,
}));
vi.mock("../../lib/db.ts", () => ({ db: { totpCredential: { findUnique, delete: remove } } }));

await import("./settings-totp-mutations.ts");

const find = (method: string, pattern: string) =>
  specs.find((spec) => spec.method === method && spec.pattern === pattern)!;
const input = { context: { currentSeller: { id: 7n } } } as unknown as MutationInput;
const answer = async (
  spec: MutationSpec,
  params: Record<string, unknown> = {},
  seller: Record<string, unknown> = { id: 7n },
): Promise<unknown[]> => {
  const rendered = (await spec.run({
    ...input,
    context: { currentSeller: seller },
    params,
  } as unknown as MutationInput)) as unknown as { status: number; body: string };
  return [rendered.status, JSON.parse(rendered.body) as unknown];
};

const PENDING = { id: 1n, confirmed_at: null };
const CONFIRMED = { id: 1n, confirmed_at: new Date() };

beforeEach(() => {
  findUnique.mockReset();
  remove.mockReset();
  locked.mockReset();
  execute.mockReset();
  generate.mockReset();
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
    ["no credential", null, 1],
    ["a pending credential, which it replaces", PENDING, 2],
  ])("starts a setup for an account with %s", async (_label, credential, writes) => {
    findUnique.mockResolvedValue(credential);

    const [status, body] = (await answer(create, {}, { id: 7n, email: "seller@example.com" })) as [
      number,
      { success: boolean; secret: string; provisioning_uri: string; qr_svg: string },
    ];

    expect(status).toBe(200);
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(body.provisioning_uri).toBe(
      `otpauth://totp/Gumroad:seller%40example.com?secret=${body.secret}&issuer=Gumroad`,
    );
    expect(body.qr_svg).toMatch(/^<\?xml .*<\/svg>$/u);
    expect(execute).toHaveBeenCalledTimes(writes);
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

  const SECRET = "JBSWY3DPEHPK3PXP";

  it("confirms a pending credential with the current code and shows the recovery codes once", async () => {
    findUnique.mockResolvedValue(PENDING);
    locked.mockResolvedValue([{ otp_secret: SECRET, confirmed_at: null }]);
    generate.mockResolvedValue(["ABCD1234", "EFGH5678"]);

    expect(await answer(confirm, { code: totpAt(SECRET, new Date()) })).toEqual([
      200,
      { success: true, recovery_codes: ["ABCD-1234", "EFGH-5678"] },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a wrong code", { code: "000000" }],
    ["no code", {}],
    ["a blank code", { code: "" }],
  ])("answers 422 and writes nothing for %s", async (_label, params) => {
    findUnique.mockResolvedValue(PENDING);
    locked.mockResolvedValue([{ otp_secret: SECRET, confirmed_at: null }]);

    expect(await answer(confirm, params)).toEqual([
      422,
      { success: false, error_message: "Invalid code. Please try again." },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers that no setup is pending when a concurrent request confirmed the credential first", async () => {
    findUnique.mockResolvedValue(PENDING);
    locked.mockResolvedValue([{ otp_secret: SECRET, confirmed_at: new Date() }]);

    expect(await answer(confirm, { code: totpAt(SECRET, new Date()) })).toEqual([
      422,
      { success: false, error_message: "No pending TOTP setup found." },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands back a code that is not text", async () => {
    findUnique.mockResolvedValue(PENDING);

    await expect(
      confirm.run({ ...input, params: { code: 123456 } } as unknown as MutationInput),
    ).rejects.toBeInstanceOf(HandBackToRails);
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

  it("replaces the recovery codes of a confirmed credential", async () => {
    findUnique.mockResolvedValue(CONFIRMED);
    generate.mockResolvedValue(["ABCD1234"]);

    expect(await answer(regenerate)).toEqual([200, { success: true, recovery_codes: ["ABCD-1234"] }]);
  });
});
