import { describe, expect, it } from "vitest";

import { NotPortedError } from "../../models/user.ts";
import { findAdminRoute } from "./registry.ts";
import { counterparty, lastEmailSentAt, taxIdLastFour } from "./users-reads.ts";

type Counterparty = NonNullable<Parameters<typeof counterparty>[0]>;

const user = (overrides: Partial<Counterparty> = {}): Counterparty => ({
  id: 1n,
  external_id: "ext123",
  email: "a@example.com",
  unconfirmed_email: null,
  name: null,
  username: null,
  ...overrides,
});

describe("counterparty", () => {
  it("answers null for a user that no longer exists", () => {
    expect(counterparty(undefined)).toBeNull();
  });

  it("prefers the name", () => {
    expect(counterparty(user({ name: "Ada", username: "ada" }))).toEqual({ id: "ext123", email: "a@example.com", name: "Ada" });
  });

  it("falls back to the email when the username is the default external id", () => {
    expect(counterparty(user({ username: "ext123" }))?.name).toBe("a@example.com");
    expect(counterparty(user())?.name).toBe("a@example.com");
  });

  it("prefers an unconfirmed email over the confirmed one when naming", () => {
    expect(counterparty(user({ unconfirmed_email: "new@example.com" }))?.name).toBe("new@example.com");
  });

  it("uses a chosen username before the email", () => {
    expect(counterparty(user({ username: "ada" }))?.name).toBe("ada");
  });
});

describe("lastEmailSentAt", () => {
  it("answers null without a stored list", () => {
    expect(lastEmailSentAt(null)).toBeNull();
    expect(lastEmailSentAt("{}")).toBeNull();
    expect(lastEmailSentAt('{"emails_sent_at":[]}')).toBeNull();
  });

  it("reads the last time of the list", () => {
    expect(lastEmailSentAt('{"emails_sent_at":["2026-01-01T00:00:00Z","2026-01-02T03:04:05Z"]}')).toBe("2026-01-02T03:04:05Z");
  });

  it("hands back a time that is not an ISO 8601 string", () => {
    expect(() => lastEmailSentAt('{"emails_sent_at":[12345]}')).toThrow(NotPortedError);
    expect(() => lastEmailSentAt('{"emails_sent_at":["last Tuesday"]}')).toThrow(NotPortedError);
  });
});

describe("taxIdLastFour", () => {
  it("answers null when no tax id was ever stored", () => {
    expect(taxIdLastFour(null)).toBeNull();
    expect(taxIdLastFour(new Uint8Array())).toBeNull();
  });
});

describe("user read routes", () => {
  it("serves affiliates, compliance_info and unpaid_balance as GETs on both hosts", () => {
    for (const action of ["affiliates", "compliance_info", "unpaid_balance"]) {
      expect(findAdminRoute("GET", `/internal/admin/users/${action}`)).not.toBeNull();
      expect(findAdminRoute("GET", `/api/internal/admin/users/${action}`)).not.toBeNull();
      expect(findAdminRoute("POST", `/internal/admin/users/${action}`)).toBeNull();
    }
  });
});
