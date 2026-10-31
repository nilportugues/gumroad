import type { User } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { authorizePassword, LoginError } from "./credentials";
import { digestPassword } from "./devise-password";
import { UserFlags } from "../models/user";

const config = { pepper: "pepper", stretches: 4 };
let hash: string;
beforeAll(async () => {
  hash = await digestPassword("right password", config);
});

const user = (attributes: Partial<User> = {}) => ({ id: 1n, email: "seller@example.com", username: "seller", encrypted_password: hash, deleted_at: null, flags: 1n, ...attributes }) as User;
const storeWith = (found: User | null) => ({ findUserForLogin: async () => found });

async function codeFor(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof LoginError) return error.code;
    throw error;
  }
}

describe("authorizePassword (LoginsController#create)", () => {
  it("returns the user for the right password", async () => {
    const found = user();
    expect(await authorizePassword({ login_identifier: "seller@example.com", password: "right password" }, storeWith(found), config)).toBe(found);
  });

  it("refuses an unknown or blank identifier before checking anything else", async () => {
    expect(await codeFor(authorizePassword({ login_identifier: "nobody@example.com", password: "x" }, storeWith(null), config))).toBe("account_not_found");
    expect(await codeFor(authorizePassword({ login_identifier: "  ", password: "right password" }, storeWith(user()), config))).toBe("account_not_found");
  });

  it("refuses a wrong password", async () => {
    expect(await codeFor(authorizePassword({ login_identifier: "seller", password: "wrong" }, storeWith(user()), config))).toBe("invalid_password");
  });

  it("checks the password before telling anyone the account was deleted", async () => {
    const deleted = user({ deleted_at: new Date() });
    expect(await codeFor(authorizePassword({ login_identifier: "seller", password: "wrong" }, storeWith(deleted), config))).toBe("invalid_password");
    expect(await codeFor(authorizePassword({ login_identifier: "seller", password: "right password" }, storeWith(deleted), config))).toBe("deleted_account");
  });

  it("sends two-factor users to Rails rather than skipping their challenge", async () => {
    const twoFactor = user({ flags: UserFlags.set(1n, "two_factor_authentication_enabled", true) });
    expect(await codeFor(authorizePassword({ login_identifier: "seller", password: "right password" }, storeWith(twoFactor), config))).toBe("two_factor_required");
  });
});
