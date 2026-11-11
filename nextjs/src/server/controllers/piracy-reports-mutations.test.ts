import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  remoteIp: vi.fn(),
  guard: vi.fn(),
  findProduct: vi.fn(),
  findReport: vi.fn(),
  eligibilityErrors: vi.fn(),
  gumroadHosted: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  locked: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
  remoteIp: mocks.remoteIp,
}));
vi.mock("../../lib/db.ts", () => ({
  db: {
    piracyReport: { count: mocks.count },
    $transaction: (block: (tx: unknown) => unknown) =>
      block({ $queryRaw: vi.fn(), piracyReport: { findUniqueOrThrow: mocks.locked, update: mocks.update } }),
  },
}));
vi.mock("@/lib/navigation/routes", () => ({
  new_piracy_report_path: ({ product_id }: { product_id: string }) =>
    `/dashboard/piracy_reports/new?product_id=${product_id}`,
  piracy_report_path: (id: string) => `/dashboard/piracy_reports/${id}`,
}));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../models/user.ts", () => ({
  NotPortedError: class extends Error {
    constructor(what: string) {
      super(what);
      this.name = "NotPortedError";
    }
  },
}));
vi.mock("./internal-admin/piracy-report-writes.ts", () => ({
  gumroadHosted: mocks.gumroadHosted,
  parseHttpUrl: (url: string) => {
    const match = /^(https?):\/\/([^/?#:]+)(\/[^?#]*)?(?:\?(.*))?$/u.exec(url);
    return match
      ? {
          scheme: match[1],
          host: match[2],
          port: match[1] === "https" ? 443 : 80,
          path: match[3] ?? "",
          query: match[4] ?? null,
        }
      : null;
  },
  normalizeUrl: (uri: { host: string; path: string }) => `${uri.host}${uri.path || "/"}`,
}));
vi.mock("../page-props/piracy-reports/pages.ts", () => ({
  CANCELLABLE_STATES: ["requested", "screening", "awaiting_signature", "signed"],
  MONTHLY_LIMIT: 5,
  SIGNATURE_STATEMENT_VERSION: "2026-10-07",
  SIGNATURE_CONFIRMATIONS: [
    ["a", "A"],
    ["b", "B"],
  ],
  eligibilityErrors: mocks.eligibilityErrors,
  findProduct: mocks.findProduct,
  findReport: mocks.findReport,
  guard: mocks.guard,
  policyAdmin: () => true,
  policyCreate: () => true,
  productsRedirect: (alert: string) => ({ status: 302, location: "/products", flash: { alert } }),
}));

await import("./piracy-reports-mutations.ts");

const find = (pattern: string) => mocks.specs.find((spec) => spec.method === "POST" && spec.pattern === pattern)!.run;
const call = (
  run: MutationSpec["run"],
  params: Record<string, unknown> = {},
  routeParams: Record<string, string> = { id: "rep1" },
) => run({ params, routeParams, request: {}, context: { currentSeller: { id: 3n } } } as unknown as MutationInput);

const awaiting = {
  id: 9n,
  state: "awaiting_signature",
  url: "https://example.net/pirated",
  recipient_email: null,
  notice_text: "Notice text\n\n",
};
const signParams = (overrides: Record<string, unknown> = {}) => ({
  signed_by_name: "Jane Doe",
  confirmations: ["a", "b"],
  confirmations_version: "2026-10-07",
  ...overrides,
});
const ALERT = (location: string, message: string) => ({ status: 302, location, flash: { alert: message } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guard.mockResolvedValue(null);
  mocks.findProduct.mockResolvedValue({ id: 5n, unique_permalink: "abc" });
  mocks.findReport.mockResolvedValue({ id: 9n });
  mocks.locked.mockResolvedValue({ ...awaiting });
  mocks.eligibilityErrors.mockResolvedValue([]);
  mocks.gumroadHosted.mockResolvedValue(false);
  mocks.count.mockResolvedValue(0);
  mocks.remoteIp.mockReturnValue("203.0.113.7");
});

describe("POST /dashboard/piracy_reports", () => {
  const run = find("/dashboard/piracy_reports");
  const params = (overrides: Record<string, unknown> = {}) => ({
    product_id: "abc",
    url: "https://example.net/pirated",
    ...overrides,
  });

  it("returns the guard's redirect untouched", async () => {
    const redirect = { status: 302, location: "/products", flash: { alert: "Product not found" } };
    mocks.guard.mockResolvedValue(redirect);
    expect(await call(run, params())).toBe(redirect);
  });

  it("lists the eligibility, address and monthly limit errors in that order", async () => {
    mocks.eligibilityErrors.mockResolvedValue(["The product has no successful sales"]);
    mocks.count.mockResolvedValueOnce(1).mockResolvedValueOnce(5);
    expect(await call(run, params())).toEqual(
      ALERT(
        "/dashboard/piracy_reports/new?product_id=abc",
        "The product has no successful sales, This page has already been reported for this product, and The monthly limit of 5 reports has been reached",
      ),
    );
  });

  it("refuses an address that is not a web address", async () => {
    expect(await call(run, params({ url: " ftp://example.net/x " }))).toEqual(
      ALERT("/dashboard/piracy_reports/new?product_id=abc", "The URL must start with http:// or https://"),
    );
  });

  it("refuses a page hosted on Gumroad", async () => {
    mocks.gumroadHosted.mockResolvedValue(true);
    expect(await call(run, params())).toEqual(
      ALERT(
        "/dashboard/piracy_reports/new?product_id=abc",
        "Pages hosted on Gumroad are reported through the terms of service process",
      ),
    );
  });

  it("hands a report that passes every check to Rails", async () => {
    await expect(call(run, params())).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a parameter that is not text", async () => {
    await expect(call(run, params({ url: ["https://example.net"] }))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("POST /dashboard/piracy_reports/:id/sign", () => {
  const run = find("/dashboard/piracy_reports/:id/sign");
  const REPORT = "/dashboard/piracy_reports/rep1";

  it("returns the guard's redirect untouched", async () => {
    const redirect = { status: 302, location: "/dashboard", flash: { alert: "no" } };
    mocks.guard.mockResolvedValue(redirect);
    expect(await call(run, signParams())).toBe(redirect);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("appends the signature to the notice with trailing whitespace removed and stores its digest", async () => {
    expect(await call(run, signParams())).toEqual({
      status: 302,
      location: REPORT,
      flash: { notice: "Signed. We will send the notice." },
    });
    const data = mocks.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      state: "signed",
      signed_by_name: "Jane Doe",
      signed_ip: "203.0.113.7",
      signature_statement_version: "2026-10-07",
    });
    expect(data.notice_text).toMatch(/^Notice text\n\nSigned: \/s\/ Jane Doe, [A-Z][a-z]+ \d{1,2}, \d{4}\n$/u);
    expect(data.notice_digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("drops invisible characters and collapses the spaces of the typed name", async () => {
    await call(run, signParams({ signed_by_name: "  Jane​   Q.\tDoe\n" }));
    expect(mocks.update.mock.calls[0]![0].data.signed_by_name).toBe("Jane Q. Doe");
  });

  it("lists every problem at once without writing", async () => {
    expect(await call(run, { signed_by_name: " ​ ", confirmations: ["a"], confirmations_version: "old" })).toEqual(
      ALERT(
        REPORT,
        "Check every confirmation to sign, The confirmations changed. Reload the page and read them again., and Signed by name must be your full legal name",
      ),
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("accepts a single confirmation sent as text and finds it short", async () => {
    expect(await call(run, signParams({ confirmations: "a" }))).toEqual(
      ALERT(REPORT, "Check every confirmation to sign"),
    );
  });

  it("refuses a name longer than 255 characters", async () => {
    expect(await call(run, signParams({ signed_by_name: "あ".repeat(256) }))).toEqual(
      ALERT(REPORT, "Signed by name is too long"),
    );
  });

  it("refuses a report that is not waiting for a signature", async () => {
    mocks.locked.mockResolvedValue({ ...awaiting, state: "signed" });
    expect(await call(run, signParams())).toEqual(ALERT(REPORT, "This report is not ready to sign"));
  });

  it("refuses a report whose notice is blank", async () => {
    mocks.locked.mockResolvedValue({ ...awaiting, notice_text: " \n" });
    expect(await call(run, signParams())).toEqual(ALERT(REPORT, "The notice has not been generated yet"));
  });

  it("hands back a request with no client address", async () => {
    mocks.remoteIp.mockReturnValue(null);
    await expect(call(run, signParams())).rejects.toThrow(/client address/u);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("hands back a report whose address the model would refuse to save", async () => {
    mocks.locked.mockResolvedValue({ ...awaiting, url: "https://example.net/a?u=https://example.org" });
    await expect(call(run, signParams())).rejects.toThrow(/refuse to save/u);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("hands back a name that is not text and confirmations that are not a list of text", async () => {
    await expect(call(run, signParams({ signed_by_name: ["Jane"] }))).rejects.toBeInstanceOf(HandBackToRails);
    await expect(call(run, signParams({ confirmations: { a: "1" } }))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("POST /dashboard/piracy_reports/:id/cancel", () => {
  const run = find("/dashboard/piracy_reports/:id/cancel");
  const REPORT = "/dashboard/piracy_reports/rep1";
  const CANCELLED = { status: 302, location: REPORT, flash: { notice: "Report cancelled. Nothing was sent." } };

  it("cancels a report that has not been sent", async () => {
    expect(await call(run)).toEqual(CANCELLED);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 9n },
      data: { state: "cancelled", updated_at: expect.any(Date) },
    });
  });

  it("answers success again for a report already cancelled, without a write", async () => {
    mocks.locked.mockResolvedValue({ ...awaiting, state: "cancelled" });
    expect(await call(run)).toEqual(CANCELLED);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("explains that a declined report was never sent", async () => {
    mocks.locked.mockResolvedValue({ ...awaiting, state: "declined" });
    expect(await call(run)).toEqual(ALERT(REPORT, "We did not send this report, so there is nothing to cancel."));
  });

  it.each(["sent", "resolved", "counter_noticed"])("refuses to cancel a %s report", async (state) => {
    mocks.locked.mockResolvedValue({ ...awaiting, state });
    expect(await call(run)).toEqual(ALERT(REPORT, "This notice was already sent, so the report cannot be cancelled."));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("hands back a report the model would refuse to save", async () => {
    mocks.locked.mockResolvedValue({ ...awaiting, url: "ftp://example.net" });
    await expect(call(run)).rejects.toThrow(/refuse to save/u);
  });
});
