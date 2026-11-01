import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { isLockWaitTimeout, isRecordNotUnique } from "./sql.ts";

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("failed", { code, clientVersion: Prisma.prismaVersion.client, meta });

describe("isLockWaitTimeout", () => {
  it("recognises MySQL's ER_LOCK_WAIT_TIMEOUT from a raw query or a driver error", () => {
    expect(isLockWaitTimeout(known("P2010", { code: "1205" }))).toBe(true);
    expect(isLockWaitTimeout(Object.assign(new Error("Lock wait timeout exceeded"), { errno: 1205 }))).toBe(true);
  });

  it("does not confuse it with other failures", () => {
    expect(isLockWaitTimeout(known("P2010", { code: "1062" }))).toBe(false);
    expect(isLockWaitTimeout(known("P2002"))).toBe(false);
    expect(isLockWaitTimeout(new Error("boom"))).toBe(false);
    expect(isRecordNotUnique(known("P2010", { code: "1205" }))).toBe(false);
  });
});
