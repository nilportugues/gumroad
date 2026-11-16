import { describe, expect, it } from "vitest";

import { decideManageAccess, secureCompare, type ManageFacts } from "./subscription-manage.ts";

const NOW = new Date("2026-03-01T12:00:00Z");
const facts = (overrides: Partial<ManageFacts> = {}): ManageFacts => ({
  subscription: { ended_at: null, token: "secret-token", token_expires_at: new Date("2026-03-02T12:00:00Z") },
  isInstallmentPlan: false,
  chargesCompleted: false,
  cookieValue: null,
  externalId: "ext-id==",
  signedInMayManage: false,
  tokenParam: null,
  now: NOW,
  ...overrides,
});

// SubscriptionsController#check_can_manage; the refusals are also replayed from Rails (subscriptions_manage_access_spec.rb).
describe("decideManageAccess", () => {
  it("allows a visitor holding the confirmation cookie", () => {
    expect(decideManageAccess(facts({ cookieValue: "ext-id==" }))).toEqual({ kind: "allow" });
  });

  it("ignores a cookie for another subscription", () => {
    expect(decideManageAccess(facts({ cookieValue: "other==" }))).toEqual({ kind: "magic_link", invalid: false });
  });

  it("allows the owner, a team member and the gifter", () => {
    expect(decideManageAccess(facts({ signedInMayManage: true }))).toEqual({ kind: "allow" });
  });

  it("allows a current token", () => {
    expect(decideManageAccess(facts({ tokenParam: "secret-token" }))).toEqual({ kind: "allow" });
  });

  it("refuses an expired token as invalid", () => {
    expect(decideManageAccess(facts({ tokenParam: "secret-token", subscription: { ended_at: null, token: "secret-token", token_expires_at: new Date("2026-02-28T00:00:00Z") } }))).toEqual({ kind: "magic_link", invalid: true });
  });

  it("raises like Ruby on a matching token without an expiry", () => {
    expect(() => decideManageAccess(facts({ tokenParam: "secret-token", subscription: { ended_at: null, token: "secret-token", token_expires_at: null } }))).toThrow(TypeError);
  });

  it("lets a cookie or an account win over a bad token", () => {
    expect(decideManageAccess(facts({ tokenParam: "wrong", cookieValue: "ext-id==" }))).toEqual({ kind: "allow" });
  });

  it("answers an ended subscription and a finished installment plan with a 404, whoever asks", () => {
    expect(decideManageAccess(facts({ cookieValue: "ext-id==", subscription: { ended_at: NOW, token: null, token_expires_at: null } }))).toEqual({ kind: "not_found" });
    expect(decideManageAccess(facts({ signedInMayManage: true, isInstallmentPlan: true, chargesCompleted: true }))).toEqual({ kind: "not_found" });
  });

  it("compares in constant time and by length", () => {
    expect(secureCompare("abc", "abc")).toBe(true);
    expect(secureCompare("abc", "abcd")).toBe(false);
  });
});
