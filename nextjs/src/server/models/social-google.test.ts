import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { retryOnLock } from "./social-google.ts";

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("failed", { code, clientVersion: Prisma.prismaVersion.client, meta });
const deadlock = () => known("P2034");
const lockWait = () => known("P2010", { code: "1205" });

describe("retryOnLock", () => {
  it("answers what the first attempt answers", async () => {
    const attempt = vi.fn().mockResolvedValue("user");
    expect(await retryOnLock(attempt, vi.fn())).toBe("user");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("tries again after a deadlock or a lock wait timeout and answers the attempt that succeeds", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockRejectedValueOnce(lockWait())
      .mockResolvedValue("user");
    const giveUp = vi.fn();
    expect(await retryOnLock(attempt, giveUp)).toBe("user");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(giveUp).not.toHaveBeenCalled();
  });

  it("answers nil and reports the last error once the third attempt fails as well", async () => {
    const last = lockWait();
    const attempt = vi.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockRejectedValue(last);
    const giveUp = vi.fn();
    expect(await retryOnLock(attempt, giveUp)).toBeNull();
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(giveUp).toHaveBeenCalledExactlyOnceWith(last);
  });

  it("raises any other error at once", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("boom"));
    const giveUp = vi.fn();
    await expect(retryOnLock(attempt, giveUp)).rejects.toThrow("boom");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(giveUp).not.toHaveBeenCalled();
  });
});
