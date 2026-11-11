import { beforeEach, describe, expect, it, vi } from "vitest";

import { StripeError } from "../../stripe/errors.ts";

const retrieve = vi.hoisted(() => vi.fn());
vi.mock("../../stripe/resources.ts", () => ({ Account: { retrieve } }));

import { findAdminRoute } from "./registry.ts";
import { stripeVerification } from "./user-info.ts";

describe("users info route", () => {
  it("serves GET /internal/admin/users/info ahead of the id route", () => {
    expect(findAdminRoute("GET", "/internal/admin/users/info")?.route.pattern).toBe("/internal/admin/users/info");
  });
});

describe("stripeVerification", () => {
  beforeEach(() => {
    retrieve.mockReset();
  });

  it("summarizes the account requirements as counts", async () => {
    retrieve.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements: {
        disabled_reason: "requirements.past_due",
        currently_due: ["a", "b"],
        past_due: ["a"],
        pending_verification: [],
      },
    });

    expect(await stripeVerification("acct_123abc")).toEqual({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      disabled_reason: "requirements.past_due",
      currently_due_count: 2,
      past_due_count: 1,
      pending_verification_count: 0,
    });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("reports zero counts and a null reason when the account has no requirements", async () => {
    retrieve.mockResolvedValue({ charges_enabled: true, payouts_enabled: true, details_submitted: true });

    expect(await stripeVerification("acct_1")).toMatchObject({
      disabled_reason: null,
      currently_due_count: 0,
      past_due_count: 0,
      pending_verification_count: 0,
    });
  });

  it("degrades to an error subfield when Stripe fails, after a single call", async () => {
    retrieve.mockImplementation(() => {
      throw new StripeError("access revoked");
    });

    expect(await stripeVerification("acct_revoked")).toEqual({ error: "access revoked" });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("rethrows an error that is not a Stripe error", async () => {
    retrieve.mockImplementation(() => {
      throw new TypeError("boom");
    });

    await expect(stripeVerification("acct_1")).rejects.toThrow("boom");
  });
});
