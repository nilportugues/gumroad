import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvalidRequestError, APIError } from "../stripe/errors.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  createLink: vi.fn(),
  notify: vi.fn(),
  pausedBy: vi.fn(),
  flagSet: vi.fn(),
}));

vi.mock("../stripe/resources.ts", () => ({
  Account: { retrieve: mocks.retrieve },
  AccountLink: { create: mocks.createLink },
}));
vi.mock("../infra/error-reporting.ts", () => ({ notifyError: mocks.notify }));
vi.mock("../models/user.ts", () => ({
  payoutsPausedBy: mocks.pausedBy,
  UserFlags: { isSet: mocks.flagSet },
  Users: { load: (row: unknown) => row },
}));
vi.mock("../models/user-compliance-info.ts", () => ({
  jsonAttr: (row: { json_data: string | null }, key: string) =>
    row.json_data === null ? null : (JSON.parse(row.json_data)[key] ?? null),
}));

const { remediateStripeAccount, verifyStripeRemediation } = await import("./settings-payments-remediation.ts");

const input = {
  context: { currentSeller: { id: 3n, flags: 0n } },
  urlOptions: { protocol: "https", host: "example.com" },
} as unknown as MutationInput;
const account = {
  charge_processor_merchant_id: "acct_1",
  json_data: JSON.stringify({ stripe_disabled_reason: "x" }),
} as never;
const accountWithoutReason = { charge_processor_merchant_id: "acct_1", json_data: null } as never;
const LINK = "https://connect.stripe.com/setup/e/acct_1/x";
const rejectedLinkError = () =>
  new InvalidRequestError(
    "An account link cannot be created for this account because the account has been rejected.",
    null,
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.flagSet.mockReturnValue(false);
  mocks.createLink.mockResolvedValue({ url: LINK });
});

describe("remediateStripeAccount", () => {
  it("opens an account update link for information that is due, reading the account once", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: { currently_due: ["individual.id_number"] } });
    expect(await remediateStripeAccount(input, account, false)).toEqual({ status: 302, location: LINK });
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.createLink).toHaveBeenCalledWith({
      account: "acct_1",
      refresh_url: "https://example.com/settings/payments/remediation",
      return_url: "https://example.com/settings/payments/verify_stripe_remediation",
      type: "account_update",
    });
  });

  it("opens an onboarding link when a verification document is due", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: { past_due: ["individual.verification.additional_document"] } });
    await remediateStripeAccount(input, account, false);
    expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({ type: "account_onboarding" }));
  });

  it("skips the open requirements check when the seller has a request of their own", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: {} });
    expect(await remediateStripeAccount(input, account, true)).toEqual({ status: 302, location: LINK });
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
  });

  it("answers all set when nothing is open", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: {}, future_requirements: {} });
    expect(await remediateStripeAccount(input, account, false)).toEqual({
      status: 302,
      location: "/settings/payments",
      flash: { notice: "Thanks! You're all set." },
    });
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("answers that Stripe paused payouts when it did and listed nothing", async () => {
    mocks.flagSet.mockReturnValue(true);
    mocks.pausedBy.mockReturnValue("stripe");
    mocks.retrieve.mockResolvedValue({ requirements: {} });
    expect(await remediateStripeAccount(input, account, false)).toMatchObject({
      flash: { alert: expect.stringContaining("Stripe has paused payouts") },
    });
  });

  it("reports an account Stripe cannot read and treats it as having nothing open", async () => {
    const failure = new InvalidRequestError("No such account", null);
    mocks.retrieve.mockRejectedValue(failure);
    expect(await remediateStripeAccount(input, account, false)).toMatchObject({
      flash: { notice: "Thanks! You're all set." },
    });
    expect(mocks.notify).toHaveBeenCalledWith(failure, { user_id: 3 });
  });

  it("falls back to the update link when the link type cannot be read", async () => {
    mocks.retrieve.mockRejectedValue(new APIError("down"));
    await remediateStripeAccount(input, account, true);
    expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({ type: "account_update" }));
  });

  it("offers a link to a review Stripe left without a way out", async () => {
    mocks.retrieve.mockResolvedValue({
      charges_enabled: false,
      requirements: { pending_verification: ["a"], errors: [], current_deadline: null },
    });
    expect(await remediateStripeAccount(input, account, false)).toEqual({ status: 302, location: LINK });
  });

  it("sends a seller back to the payments page when Stripe refuses a link for a rejected account", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: { currently_due: ["a"] } });
    mocks.createLink.mockRejectedValue(rejectedLinkError());
    expect(await remediateStripeAccount(input, account, false)).toEqual({
      status: 302,
      location: "/settings/payments",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("reports any other refusal of the link and tells the seller", async () => {
    const failure = new InvalidRequestError("Something else", null);
    mocks.retrieve.mockResolvedValue({ requirements: { currently_due: ["a"] } });
    mocks.createLink.mockRejectedValue(failure);
    expect(await remediateStripeAccount(input, account, false)).toEqual({
      status: 302,
      location: "/settings/payments",
      flash: { alert: "We couldn't open the verification page. Please contact support." },
    });
    expect(mocks.notify).toHaveBeenCalledWith(failure, { user_id: 3 });
  });

  it("hands back a refused link for an account with no stored disabled reason, which Rails syncs", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: { currently_due: ["a"] } });
    mocks.createLink.mockRejectedValue(rejectedLinkError());
    await expect(remediateStripeAccount(input, accountWithoutReason, false)).rejects.toThrow(HandBackToRails);
  });

  it("lets an error that is not Stripe's through", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: { currently_due: ["a"] } });
    mocks.createLink.mockRejectedValue(new TypeError("boom"));
    await expect(remediateStripeAccount(input, account, false)).rejects.toThrow(TypeError);
  });
});

describe("verifyStripeRemediation", () => {
  const noPending = async () => false;

  it("returns to the payments page without a flash while information is due", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: { currently_due: ["a"] } });
    expect(await verifyStripeRemediation(input, account, async () => true)).toEqual({
      status: 302,
      location: "/settings/payments",
    });
  });

  it("answers all set when nothing is open", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: {}, future_requirements: {} });
    expect(await verifyStripeRemediation(input, account, noPending)).toMatchObject({
      flash: { notice: "Thanks! You're all set." },
    });
  });

  it("says Stripe is still reviewing when the review has no exit", async () => {
    mocks.retrieve.mockResolvedValue({
      charges_enabled: false,
      requirements: { pending_verification: ["a"], errors: [] },
    });
    expect(await verifyStripeRemediation(input, account, noPending)).toMatchObject({
      flash: { info: expect.stringContaining("still reviewing") },
    });
  });

  it("leaves the notice off while only eventual requirements are open", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: { eventually_due: ["a"] } });
    expect(await verifyStripeRemediation(input, account, noPending)).toEqual({
      status: 302,
      location: "/settings/payments",
    });
  });

  it("hands back when requests Stripe no longer asks for would be marked as provided", async () => {
    mocks.retrieve.mockResolvedValue({ requirements: {} });
    await expect(verifyStripeRemediation(input, account, async () => true)).rejects.toThrow(HandBackToRails);
  });

  it("hands back an account Stripe cannot read, which Rails does not rescue", async () => {
    mocks.retrieve.mockRejectedValue(new InvalidRequestError("No such account", null));
    await expect(verifyStripeRemediation(input, account, noPending)).rejects.toThrow(HandBackToRails);
  });
});
