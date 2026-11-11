import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { performAsync, deliverLater, notifyError, selectRows } = vi.hoisted(() => ({
  performAsync: vi.fn(),
  deliverLater: vi.fn(),
  notifyError: vi.fn(),
  selectRows: vi.fn(),
}));

vi.mock("./concerns/job-runtime.ts", () => ({ performAsync, currentJobsRuntime: () => "runtime" }));
vi.mock("../mail/active-job.ts", () => ({
  deliverLater,
  record: (model: string, id: number) => ({ globalId: { model, id } }),
}));
vi.mock("../infra/error-reporting.ts", () => ({ notifyError }));
vi.mock("../infra/redis.ts", () => ({ getRedis: () => ({}) }));
vi.mock("./sql.ts", () => ({
  selectRows,
  table: (name: string) => name,
  column: (_table: string, name: string) => name,
}));

const {
  checkSendThrottle,
  deliverInvite,
  invitationExpiry,
  invitationLimitMessage,
  reportInvitationBurst,
  unreviewedLimitReached,
} = await import("./team-invitation-throttle.ts");

const SELLER_ID = 7n;
const seller = (state: string, deletedAt: Date | null = null) =>
  ({
    get: (name: string) =>
      ({
        id: SELLER_ID,
        user_risk_state: state,
        deleted_at: deletedAt,
        username: "teaminvites",
        email: "seller@example.com",
        external_id: "ext123",
      })[name],
  }) as never;

const fakeRedis = (overrides: { eval?: unknown; set?: unknown }) =>
  ({
    eval: vi.fn().mockResolvedValue(overrides.eval),
    set: vi.fn().mockResolvedValue(overrides.set),
  }) as unknown as Redis & { eval: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };

beforeEach(() => {
  performAsync.mockReset().mockResolvedValue("jid");
  deliverLater.mockReset().mockResolvedValue("job");
  notifyError.mockReset();
  selectRows.mockReset();
});

describe("checkSendThrottle", () => {
  it("runs the script on the seller's key with both windows and reserves a send when nothing restricts it", async () => {
    const redis = fakeRedis({ eval: [] });

    expect(await checkSendThrottle(SELLER_ID, redis)).toBeNull();

    const [script, keys, key, uuid, longest, ...windows] = redis.eval.mock.calls[0]!;
    expect(script).toContain('redis.call("ZADD", KEYS[1], now, ARGV[1])');
    expect([keys, key]).toEqual([1, "team_invitation_send_throttle:7"]);
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(longest).toBe("86400");
    expect(windows).toEqual(["hour", "10", "3600", "day", "50", "86400"]);
  });

  it("returns the restriction the script reports", async () => {
    const redis = fakeRedis({ eval: ["day", 50, 7200] });

    expect(await checkSendThrottle(SELLER_ID, redis)).toEqual({ window: "day", limit: 50, retry_after: 7200 });
  });
});

describe("unreviewedLimitReached", () => {
  it("never counts for a compliant, active seller", async () => {
    expect(await unreviewedLimitReached(seller("compliant"))).toBe(false);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it.each([
    [2n, false],
    [3n, true],
  ])("compares %s invitations, revoked ones included, with the total limit", async (count, reached) => {
    selectRows.mockResolvedValue([{ count }]);

    expect(await unreviewedLimitReached(seller("not_reviewed"))).toBe(reached);
  });

  it("counts for a compliant seller who was suspended", async () => {
    selectRows.mockResolvedValue([{ count: 5n }]);

    expect(await unreviewedLimitReached(seller("suspended_for_fraud"))).toBe(true);
  });
});

describe("invitationLimitMessage", () => {
  it.each([
    ["hour", 10, 1, "You've reached the limit of 10 team invitations per hour. You can invite again in 1 minute."],
    ["hour", 10, 61, "You've reached the limit of 10 team invitations per hour. You can invite again in 2 minutes."],
    ["day", 50, 3600, "You've reached the limit of 50 team invitations per day. You can invite again in 1 hour."],
    ["day", 50, 7201, "You've reached the limit of 50 team invitations per day. You can invite again in 3 hours."],
    ["hour", 10, 0, "You can invite again now."],
  ])("words %s window %s with %s seconds left", (name, limit, retryAfter, message) => {
    expect(invitationLimitMessage(name, limit, retryAfter)).toBe(message);
  });
});

describe("reportInvitationBurst", () => {
  it("sets the daily marker and enqueues the risk notification once", async () => {
    const redis = fakeRedis({ set: "OK" });

    await reportInvitationBurst(seller("compliant"), { window: "hour", limit: 10 }, redis);

    expect(redis.set).toHaveBeenCalledWith("team_invitation_burst_reported:7", "1", "EX", 86_400, "NX");
    expect(performAsync).toHaveBeenCalledWith("InternalNotificationWorker", [
      "risk",
      "Team invitations rate limited",
      "Seller teaminvites (seller@example.com) was refused team invitations past 10/hour. Admin: ext123",
    ]);
  });

  it("stays quiet when the seller was reported already", async () => {
    await reportInvitationBurst(seller("compliant"), { window: "hour", limit: 10 }, fakeRedis({ set: null }));

    expect(performAsync).not.toHaveBeenCalled();
  });

  it("reports a failing notification instead of raising", async () => {
    performAsync.mockRejectedValue(new Error("unavailable"));

    await reportInvitationBurst(seller("compliant"), { window: "account", limit: 3 }, fakeRedis({ set: "OK" }));

    expect(notifyError).toHaveBeenCalledWith(expect.objectContaining({ message: "unavailable" }));
  });
});

describe("invitationExpiry", () => {
  it("is the end of the day seven days out, to the microsecond", () => {
    const expiry = invitationExpiry(new Date("2026-11-11T08:30:00.123Z"));

    expect(expiry.toISOString()).toBe("2026-11-18T23:59:59.999999Z");
  });

  it("crosses a month end", () => {
    expect(invitationExpiry(new Date("2026-11-27T23:59:59.000Z")).toISOString()).toBe("2026-12-04T23:59:59.999999Z");
  });
});

describe("deliverInvite", () => {
  it("enqueues TeamMailer.invite with the invitation's global id on the default queue", async () => {
    await deliverInvite(42);

    expect(deliverLater).toHaveBeenCalledWith(
      "runtime",
      { mailer: "TeamMailer", method: "invite", args: [{ globalId: { model: "TeamInvitation", id: 42 } }] },
      "ruby",
    );
  });
});
