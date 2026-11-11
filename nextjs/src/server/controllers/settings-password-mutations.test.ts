import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  guardResult: vi.fn(),
  findUserBang: vi.fn(),
  validPassword: vi.fn(),
  confirmed: vi.fn(),
  attributes: {} as Record<string, unknown>,
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../page-props/settings/guard.ts", () => ({ settingsGuard: () => async () => mocks.guardResult() }));
vi.mock("../policies/settings/password-user.ts", () => ({ settingsPasswordUserPolicy: { update: () => true } }));
vi.mock("../auth/devise-password.ts", () => ({ validPassword: mocks.validPassword }));
vi.mock("../models/user.ts", () => ({
  findUserBang: mocks.findUserBang,
  isConfirmed: () => mocks.confirmed(),
}));

await import("./settings-password-mutations.ts");

const INCORRECT = { status: 302, location: "/settings/password", flash: { alert: "Incorrect password." } };
const CONFIRM = {
  status: 302,
  location: "/settings/password",
  flash: { alert: "You have to confirm your email address before you can do that." },
};

const call = (method: string, user: unknown) =>
  mocks.specs
    .find((spec) => spec.method === method)!
    .run({ params: user === undefined ? {} : { user }, context: { currentSeller: { id: 3n } } } as MutationInput);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.attributes = { provider: null, encrypted_password: "$2a$04$hash" };
  mocks.findUserBang.mockResolvedValue({ get: (name: string) => mocks.attributes[name] });
  mocks.guardResult.mockReturnValue(null);
  mocks.confirmed.mockReturnValue(true);
  mocks.validPassword.mockResolvedValue(true);
});

describe.each([["PUT"], ["PATCH"]])("%s /settings/password", (method) => {
  it("returns the redirect of a visitor the guard turns away", async () => {
    mocks.guardResult.mockReturnValue({ status: 302, location: "/dashboard" });
    expect(await call(method, { password: "a", new_password: "b" })).toEqual({ status: 302, location: "/dashboard" });
  });

  it("refuses a request with no user", async () => {
    expect(await call(method, undefined)).toEqual(INCORRECT);
  });

  it("refuses an empty user", async () => {
    expect(await call(method, {})).toEqual(INCORRECT);
  });

  it("refuses a blank user string", async () => {
    expect(await call(method, "  ")).toEqual(INCORRECT);
  });

  it("refuses a missing current password", async () => {
    expect(await call(method, { new_password: "b" })).toEqual(INCORRECT);
  });

  it("refuses a whitespace current password", async () => {
    expect(await call(method, { password: " ", new_password: "b" })).toEqual(INCORRECT);
  });

  it("refuses a current password that does not match", async () => {
    mocks.validPassword.mockResolvedValue(false);
    expect(await call(method, { password: "wrong", new_password: "b" })).toEqual(INCORRECT);
    expect(mocks.validPassword).toHaveBeenCalledWith("$2a$04$hash", "wrong");
  });

  it("hands a matching current password to Rails", async () => {
    await expect(call(method, { password: "right", new_password: "b" })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a current password that is not text to Rails", async () => {
    await expect(call(method, { password: 123, new_password: "b" })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a user that is a non-blank string to Rails", async () => {
    await expect(call(method, "password")).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("asks an unconfirmed OAuth account to confirm its email", async () => {
    mocks.attributes.provider = "google_oauth2";
    mocks.confirmed.mockReturnValue(false);
    expect(await call(method, { new_password: "b" })).toEqual(CONFIRM);
  });

  it("hands the first password of a confirmed OAuth account to Rails", async () => {
    mocks.attributes.provider = "google_oauth2";
    await expect(call(method, { new_password: "b" })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("treats a blank provider as no provider", async () => {
    mocks.attributes.provider = "";
    mocks.validPassword.mockResolvedValue(false);
    expect(await call(method, { password: "wrong", new_password: "b" })).toEqual(INCORRECT);
  });
});
