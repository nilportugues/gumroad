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
  setPassword: vi.fn(),
  save: vi.fn(),
  invalidate: vi.fn(),
  errors: [] as string[],
  calls: [] as string[],
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../page-props/settings/guard.ts", () => ({ settingsGuard: () => async () => mocks.guardResult() }));
vi.mock("../policies/settings/password-user.ts", () => ({ settingsPasswordUserPolicy: { update: () => true } }));
vi.mock("../auth/devise-password.ts", () => ({
  validPassword: mocks.validPassword,
  authenticatableSalt: (hash: string) => hash.slice(0, 7),
}));
vi.mock("../models/user.ts", () => ({
  findUserBang: mocks.findUserBang,
  isConfirmed: () => mocks.confirmed(),
  setPassword: mocks.setPassword,
  Users: { save: mocks.save },
}));
vi.mock("../models/user-risk.ts", () => ({ invalidateActiveSessions: mocks.invalidate }));

await import("./settings-password-mutations.ts");

const INCORRECT = { status: 302, location: "/settings/password", flash: { alert: "Incorrect password." } };
const CONFIRM = {
  status: 302,
  location: "/settings/password",
  flash: { alert: "You have to confirm your email address before you can do that." },
};

const NOW = new Date("2026-01-01T00:00:00Z");
let session: { data: Record<string, unknown> };
let loggedInUser: { id: bigint } | null;
let impersonatedUser: unknown;

const call = (method: string, user: unknown) =>
  mocks.specs.find((spec) => spec.method === method)!.run({
    params: user === undefined ? {} : { user },
    context: { currentSeller: { id: 3n }, loggedInUser, impersonatedUser },
    chain: { now: NOW, session },
  } as unknown as MutationInput);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.attributes = { id: 3n, provider: null, encrypted_password: "$2a$04$hash" };
  mocks.calls = [];
  mocks.errors = [];
  session = { data: { "warden.user.user.session": { last_sign_in_at: 1 }, other: true } };
  loggedInUser = { id: 3n };
  impersonatedUser = null;
  mocks.findUserBang.mockResolvedValue({
    get: (name: string) => mocks.attributes[name],
    set: (name: string, value: unknown) => void (mocks.attributes[name] = value),
    errors: { on: () => mocks.errors },
  });
  mocks.setPassword.mockImplementation(async () => void mocks.calls.push("setPassword"));
  mocks.save.mockImplementation(async () => (mocks.calls.push("save"), mocks.errors.length === 0));
  mocks.invalidate.mockImplementation(async () => void mocks.calls.push("invalidate"));
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

  it("changes the password, signs the other sessions out and keeps this browser signed in", async () => {
    expect(await call(method, { password: "right", new_password: "b" })).toEqual({
      status: 303,
      location: "/settings/password",
      flash: { notice: "You have successfully changed your password." },
    });
    expect(mocks.calls).toEqual(["setPassword", "save", "invalidate"]);
    expect(session.data["warden.user.user.session"]).toEqual({ last_sign_in_at: Math.floor(NOW.getTime() / 1000) });
    expect(session.data["warden.user.user.key"]).toEqual([[3], "$2a$04$"]);
    expect(session.data.other).toBe(true);
  });

  it("answers the first error of a password that does not save and leaves the sessions alone", async () => {
    mocks.errors = ["is too short (minimum is 6 characters)"];
    expect(await call(method, { password: "right", new_password: "b" })).toEqual({
      status: 302,
      location: "/settings/password",
      flash: { alert: "New password is too short (minimum is 6 characters)" },
    });
    expect(mocks.calls).toEqual(["setPassword", "save"]);
    expect(session.data["warden.user.user.key"]).toBeUndefined();
  });

  it("hands a new password that is not text, and a change by someone other than the owner, to Rails", async () => {
    await expect(call(method, { password: "right", new_password: ["b"] })).rejects.toBeInstanceOf(HandBackToRails);
    impersonatedUser = { id: 9n };
    await expect(call(method, { password: "right", new_password: "b" })).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.calls).toEqual([]);
  });

  it("compares an integer current password as its digits and refuses it when it does not match", async () => {
    mocks.validPassword.mockResolvedValue(false);
    expect(await call(method, { password: 12345, new_password: "b" })).toEqual(INCORRECT);
    expect(mocks.validPassword).toHaveBeenCalledWith("$2a$04$hash", "12345");
    expect(mocks.calls).toEqual([]);
  });

  it("hands an integer current password that matches, and any other current password that is not text, to Rails", async () => {
    await expect(call(method, { password: 123, new_password: "b" })).rejects.toBeInstanceOf(HandBackToRails);
    mocks.validPassword.mockResolvedValue(false);
    await expect(call(method, { password: 1.5, new_password: "b" })).rejects.toBeInstanceOf(HandBackToRails);
    await expect(call(method, { password: ["a"], new_password: "b" })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("reads a user that is a string through String#[]: the substring password is the candidate, anything else is blank", async () => {
    mocks.validPassword.mockResolvedValue(false);
    expect(await call(method, "password")).toEqual(INCORRECT);
    expect(mocks.validPassword).toHaveBeenCalledWith("$2a$04$hash", "password");
    mocks.validPassword.mockClear();
    expect(await call(method, "something else")).toEqual(INCORRECT);
    expect(mocks.validPassword).not.toHaveBeenCalled();
  });

  it("hands a string user whose substring matches the stored password, and a user that is a number, to Rails", async () => {
    await expect(call(method, "password")).rejects.toBeInstanceOf(HandBackToRails);
    await expect(call(method, 5)).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.calls).toEqual([]);
  });

  it("asks an unconfirmed OAuth account to confirm its email", async () => {
    mocks.attributes.provider = "google_oauth2";
    mocks.confirmed.mockReturnValue(false);
    expect(await call(method, { new_password: "b" })).toEqual(CONFIRM);
  });

  it("sets the first password of a confirmed OAuth account and drops its provider", async () => {
    mocks.attributes.provider = "google_oauth2";
    expect(await call(method, { new_password: "b" })).toMatchObject({ status: 303 });
    expect(mocks.attributes.provider).toBeNull();
    expect(mocks.calls).toEqual(["setPassword", "save", "invalidate"]);
  });

  it("hands an OAuth account's request with no user hash to Rails", async () => {
    mocks.attributes.provider = "google_oauth2";
    await expect(call(method, undefined)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("treats a blank provider as no provider", async () => {
    mocks.attributes.provider = "";
    mocks.validPassword.mockResolvedValue(false);
    expect(await call(method, { password: "wrong", new_password: "b" })).toEqual(INCORRECT);
  });
});
