import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  findFirst: vi.fn(),
  selectRows: vi.fn(),
  findDirectAffiliate: vi.fn(),
  guardRedirect: vi.fn(),
  allowed: vi.fn(),
  isSet: vi.fn(),
  removalBlocker: vi.fn(),
  markDeletedBang: vi.fn(),
  deliverLater: vi.fn(),
  creationBlocker: vi.fn(),
  createDirectAffiliate: vi.fn(),
  updateBlocker: vi.fn(),
  updateDirectAffiliate: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("./users-controller.ts", () => ({ requireHtml: vi.fn() }));
vi.mock("../../lib/db.ts", () => ({ db: { user: { findFirst: mocks.findFirst } } }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (id: string) => (id === "unknown" ? null : 7),
  decryptNumeric: (id: number) => id,
  encrypt: (id: number) => `ext-${id}`,
}));
vi.mock("../models/sql.ts", () => ({
  selectRows: mocks.selectRows,
  column: () => "",
  table: () => "",
}));
vi.mock("../models/user.ts", () => ({ UserFlags: { isSet: mocks.isSet } }));
vi.mock("../page-props/dashboard/affiliates.ts", () => ({ findDirectAffiliate: mocks.findDirectAffiliate }));
vi.mock("../models/direct-affiliate-removal.ts", () => ({
  removalBlocker: mocks.removalBlocker,
  markDeletedBang: mocks.markDeletedBang,
  loadAffiliate: (row: unknown) => row,
}));
vi.mock("../models/direct-affiliate-create.ts", () => ({
  creationBlocker: mocks.creationBlocker,
  createDirectAffiliate: mocks.createDirectAffiliate,
  // The Ruby to_i itself is pinned by its golden in direct-affiliate-create.test.ts.
  rubyToI: (value: unknown) => Number.parseInt(String(value ?? 0), 10) || 0,
}));
vi.mock("../models/direct-affiliate-update.ts", () => ({
  updateBlocker: mocks.updateBlocker,
  updateDirectAffiliate: mocks.updateDirectAffiliate,
}));
vi.mock("../mail/active-job.ts", () => ({ deliverLater: mocks.deliverLater }));
vi.mock("../mail/delivery.ts", () => ({ mailRoute: () => "ruby" }));
vi.mock("../models/concerns/job-runtime.ts", () => ({ currentJobsRuntime: () => ({}) }));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../policies/direct-affiliate.ts", () => ({
  directAffiliatePolicy: {
    create: () => mocks.allowed(),
    update: () => mocks.allowed(),
    destroy: () => mocks.allowed(),
  },
}));
vi.mock("../page-props/audience/seller-guard.ts", () => ({
  sellerGuard: async (_input: unknown, step: (context: unknown) => unknown) => {
    if (mocks.guardRedirect()) return mocks.guardRedirect();
    await step({ seller: { id: 3n } });
    return null;
  },
}));

await import("./affiliates-mutations.ts");

const find = (method: string, pattern: string) =>
  mocks.specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run;
const create = find("POST", "/affiliates");
const update = find("PATCH", "/affiliates/:id");
const destroy = find("DELETE", "/affiliates/:id");
const subscribe = find("GET", "/affiliates/:id/subscribe_posts");

const product = { id: 11, enabled: true, fee_percent: 10 };
const affiliate = (overrides: Record<string, unknown> = {}) => ({
  email: "ada@example.com",
  apply_to_all_products: false,
  fee_percent: null,
  products: [product],
  ...overrides,
});
const call = (run: MutationSpec["run"], body: unknown, id = "abc") =>
  run({
    params: { affiliate: body },
    routeParams: { id },
    context: { currentSeller: { id: 3n } },
    url: new URL("https://example.com/"),
  } as unknown as MutationInput);

const refusal = (location: string, message: string) => ({
  status: 302,
  location,
  inertiaErrors: { base: [message] },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.allowed.mockReturnValue(true);
  mocks.findFirst.mockResolvedValue({ id: 9n, flags: 0n });
  mocks.isSet.mockReturnValue(false);
  mocks.findDirectAffiliate.mockResolvedValue({ id: 5 });
  mocks.selectRows.mockResolvedValueOnce([{ id: 11 }]).mockResolvedValue([]);
  mocks.creationBlocker.mockResolvedValue(null);
  mocks.updateBlocker.mockResolvedValue(null);
  mocks.findFirst.mockResolvedValue({ id: 9n, flags: 0n, email: "ada@example.com" });
});

describe("POST /affiliates", () => {
  it("returns the sign-in redirect for a signed-out visitor", async () => {
    mocks.guardRedirect.mockReturnValue({ status: 302, location: "/login" });
    expect(await call(create, affiliate())).toEqual({ status: 302, location: "/login" });
  });

  it("refuses a blank email", async () => {
    expect(await call(create, affiliate({ email: " " }))).toEqual(
      refusal("/affiliates/new", "Invalid affiliate parameters"),
    );
  });

  it("refuses all products without a fee", async () => {
    expect(await call(create, affiliate({ apply_to_all_products: true, fee_percent: "" }))).toEqual(
      refusal("/affiliates/new", "Invalid affiliate parameters"),
    );
  });

  it("refuses an enabled product without a fee", async () => {
    expect(await call(create, affiliate({ products: [{ ...product, fee_percent: "" }] }))).toEqual(
      refusal("/affiliates/new", "Invalid affiliate parameters"),
    );
  });

  it("refuses an email without an account", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await call(create, affiliate())).toEqual(
      refusal("/affiliates/new", "The affiliate has not created a Gumroad account with this email address."),
    );
  });

  it("refuses the acting seller", async () => {
    mocks.findFirst.mockResolvedValue({ id: 3n, flags: 0n });
    expect(await call(create, affiliate())).toEqual(
      refusal("/affiliates/new", "You found you. Good job. You can't be your own affiliate though."),
    );
  });

  it("refuses an account that opted out", async () => {
    mocks.isSet.mockReturnValue(true);
    expect(await call(create, affiliate())).toEqual(
      refusal("/affiliates/new", "This user has disabled being added as an affiliate."),
    );
  });

  it("refuses when no product is enabled", async () => {
    expect(await call(create, affiliate({ products: [{ ...product, enabled: false }] }))).toEqual(
      refusal("/affiliates/new", "Please enable at least one product."),
    );
  });

  it("refuses an affiliate the seller already has", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValueOnce([{ id: 11 }]).mockResolvedValueOnce([{ id: 2 }]);
    expect(await call(create, affiliate())).toEqual(refusal("/affiliates/new", "This affiliate already exists."));
  });

  it("saves a valid affiliate and redirects with the notice", async () => {
    expect(await call(create, affiliate())).toEqual({
      status: 303,
      location: "/affiliates",
      flash: { notice: "Affiliate created successfully" },
    });
    expect(mocks.createDirectAffiliate).toHaveBeenCalledWith({
      sellerId: 3,
      affiliateUserId: 9,
      affiliateUserEmail: "ada@example.com",
      basisPoints: 1000,
      productId: 11,
      productBasisPoints: 1000,
    });
  });

  it("takes the affiliate's fee from the top-level percentage, and the product's from its own", async () => {
    await call(create, affiliate({ fee_percent: "25" }));
    expect(mocks.createDirectAffiliate).toHaveBeenCalledWith(
      expect.objectContaining({ basisPoints: 2500, productBasisPoints: 1000 }),
    );
  });

  it("reads a fee the way Ruby's to_i does", async () => {
    await call(create, affiliate({ products: [{ ...product, fee_percent: "12abc" }] }));
    expect(mocks.createDirectAffiliate).toHaveBeenCalledWith(expect.objectContaining({ basisPoints: 1200 }));
  });

  it("hands a shape the model cannot prove to Rails before saving", async () => {
    mocks.creationBlocker.mockResolvedValue("an affiliate with several products");
    await expect(call(create, affiliate())).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.createDirectAffiliate).not.toHaveBeenCalled();
  });

  it("hands a seller's missing product to Rails, which raises on it", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValue([]);
    await expect(call(create, affiliate())).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a missing affiliate parameter to Rails", async () => {
    await expect(call(create, undefined)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a flag that is a string to Rails", async () => {
    await expect(call(create, affiliate({ apply_to_all_products: "false" }))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("PATCH /affiliates/:id", () => {
  it("answers 404 for an affiliate the seller does not have", async () => {
    mocks.findDirectAffiliate.mockResolvedValue(null);
    await expect(call(update, affiliate())).rejects.toBeInstanceOf(RoutingError);
  });

  it("sends a refusal to the edit page by external id", async () => {
    expect(await call(update, affiliate({ email: "" }))).toEqual(
      refusal("/affiliates/ext-5/edit", "Invalid affiliate parameters"),
    );
  });

  it("leaves the edited affiliate out of the already-exists check and saves the edit", async () => {
    expect(await call(update, affiliate())).toEqual({
      status: 303,
      location: "/affiliates",
      flash: { notice: "Affiliate updated successfully" },
    });
    expect(mocks.updateDirectAffiliate).toHaveBeenCalledWith({
      id: 5,
      sellerId: 3,
      affiliateUserId: 9,
      affiliateUserEmail: "ada@example.com",
      basisPoints: 1000,
      productId: 11,
      productBasisPoints: 1000,
    });
  });

  it("hands an edit the model cannot prove to Rails before saving", async () => {
    mocks.updateBlocker.mockResolvedValue("an edit that changes the products of the affiliate");
    await expect(call(update, affiliate())).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.updateDirectAffiliate).not.toHaveBeenCalled();
  });
});

describe("DELETE /affiliates/:id", () => {
  it("answers 404 for an id that does not decode", async () => {
    await expect(call(destroy, undefined, "unknown")).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands a removal Node cannot prove to Rails before writing", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValue([{ id: 7 }]);
    mocks.removalBlocker.mockResolvedValue("an affiliate that is already deleted");
    await expect(call(destroy, undefined)).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.markDeletedBang).not.toHaveBeenCalled();
    expect(mocks.deliverLater).not.toHaveBeenCalled();
  });

  it("soft deletes the affiliate, then queues the removal mail", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValue([{ id: 7 }]);
    mocks.removalBlocker.mockResolvedValue(null);
    const order: string[] = [];
    mocks.markDeletedBang.mockImplementation(async () => void order.push("delete"));
    mocks.deliverLater.mockImplementation(async () => void order.push("mail"));
    const result = await call(destroy, undefined);
    expect(order).toEqual(["delete", "mail"]);
    expect(mocks.deliverLater.mock.calls[0]![1]).toMatchObject({
      mailer: "AffiliateMailer",
      method: "direct_affiliate_removal",
      args: [7],
    });
    expect(result).toMatchObject({ location: "/affiliates", flash: { notice: "Affiliate deleted successfully" } });
  });
});

describe("GET /affiliates/:id/subscribe_posts", () => {
  it("answers 404 for an affiliate nobody has", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValue([]);
    await expect(call(subscribe, undefined)).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands the change of a known affiliate to Rails", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValue([{ id: 7 }]);
    await expect(call(subscribe, undefined)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
