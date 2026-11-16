import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  findBundle: vi.fn(),
  isSet: vi.fn(),
  updateBang: vi.fn(),
  performAsync: vi.fn(),
  loggedIn: vi.fn(),
  format: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (id: string) => (id === "unknown" ? null : 5),
  encrypt: () => "ext",
}));
vi.mock("../models/link.ts", () => ({
  LinkFlags: { isSet: mocks.isSet, set: (flags: bigint) => flags },
  Links: { load: (row: unknown) => row, updateBang: mocks.updateBang },
}));
vi.mock("../models/concerns/job-runtime.ts", () => ({ performAsync: mocks.performAsync }));
vi.mock("../models/sql.ts", () => ({
  selectRows: mocks.selectRows,
  castRow: (_model: string, row: unknown) => row,
  column: () => "",
  table: () => "",
  quoteName: (name: string) => name,
}));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser: mocks.loggedIn }));
vi.mock("./wishlists-mutations.ts", () => ({
  signedOutRefusal: () =>
    mocks.loggedIn() === null ? { status: 404, body: { success: false, error: "Not found" }, rescued: true } : null,
}));
vi.mock("./rails-params.ts", () => ({ requestFormat: mocks.format }));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../page-props/bundles/pages.ts", () => ({ findBundle: mocks.findBundle }));
vi.mock("../policies/link.ts", () => ({
  collaboratingProductIds: async () => new Set(),
  linkPolicy: { update: () => true },
}));
vi.mock("./seller-json.ts", () => ({
  accountEmailRequired: () => null,
  authorizeJson: async (_input: unknown, check: (context: unknown) => Promise<void>) => {
    await check({});
    return null;
  },
  json: (body: unknown, status = 200) => ({ status, body }),
  NOT_FOUND: 404,
}));
vi.mock("../page-props/audience/seller-guard.ts", () => ({
  sellerGuard: async (_input: unknown, step: (context: unknown) => unknown) => {
    await step({});
    return null;
  },
}));

await import("./bundle-mutations.ts");

const run = (method: string, pattern: string) =>
  mocks.specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run;
const call = (spec: MutationSpec["run"], params: Record<string, unknown> = {}) =>
  spec({
    params,
    routeParams: { bundle_id: "abc" },
    request: {},
    context: {},
    url: new URL("https://example.com/"),
  } as unknown as MutationInput);

const bundle = { id: 5n, user_id: 1n, flags: 0n, draft: false, deleted_at: null, purchase_disabled_at: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findBundle.mockResolvedValue(bundle);
  mocks.loggedIn.mockReturnValue({ id: 1n });
  mocks.format.mockReturnValue("json");
});

describe("Bundles::ShareController#update", () => {
  const share = run("PATCH", "/bundles/:bundle_id/share");

  it("sends an unpublished bundle to the content editor without running the after actions", async () => {
    mocks.findBundle.mockResolvedValue({ ...bundle, draft: true });
    expect(await call(share)).toMatchObject({ status: 302, location: "/bundles/ext/content/edit", rescued: true });
  });

  it("treats a bundle with purchases disabled as unpublished", async () => {
    mocks.findBundle.mockResolvedValue({ ...bundle, purchase_disabled_at: new Date() });
    expect(await call(share)).toMatchObject({ rescued: true });
  });

  it("hands a published bundle back to Rails", async () => {
    await expect(call(share)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("Bundles::ContentController#update", () => {
  const content = run("PATCH", "/bundles/:bundle_id/content");

  it("refuses an index-keyed hash of products", async () => {
    const result = await call(content, { products: { "0": { product_id: "abc", quantity: "1" } } });
    expect(result).toMatchObject({ status: 302, flash: { alert: "Products must be an array." } });
  });

  it("hands a list of products back to Rails", async () => {
    await expect(call(content, { products: [{ product_id: "abc" }] })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a request without products back to Rails", async () => {
    await expect(call(content)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a hash whose keys are not form indexes back to Rails", async () => {
    await expect(call(content, { products: { first: { product_id: "abc" } } })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands text products back to Rails", async () => {
    await expect(call(content, { products: "abc" })).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("Bundles::ContentController#update_purchases_content", () => {
  const outdated = run("POST", "/bundles/:bundle_id/content/update_purchases_content");

  it("refuses a bundle with no outdated purchases", async () => {
    mocks.isSet.mockReturnValue(false);
    expect(await call(outdated)).toMatchObject({
      flash: { alert: "This bundle has no purchases with outdated content." },
    });
  });

  // The queued job and redirect are replayed against Rails in parity/__tests__/bundle-content.replay.test.ts.
  it("clears the flag and queues the update of the outdated purchases", async () => {
    mocks.isSet.mockReturnValue(true);
    mocks.selectRows.mockResolvedValue([{ id: 5n }]);
    expect(await call(outdated)).toMatchObject({
      status: 303,
      flash: { notice: "Queued an update to the content of all outdated purchases." },
    });
    expect(mocks.updateBang).toHaveBeenCalledOnce();
    expect(mocks.performAsync).toHaveBeenCalledWith("UpdateBundlePurchasesContentJob", [5]);
  });
});

describe("Bundles::ProductController#remove_file", () => {
  const removeFile = run("POST", "/bundles/:bundle_id/product/remove_file");

  it("hands a request that is not JSON back to Rails", async () => {
    mocks.format.mockReturnValue("html");
    await expect(call(removeFile, { file_id: "f" })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers a signed-out request with the 404 JSON of authenticate_user!", async () => {
    mocks.loggedIn.mockReturnValue(null);
    expect(await call(removeFile, { file_id: "f" })).toMatchObject({ status: 404, rescued: true });
  });

  it("hands a file id that is not text back to Rails", async () => {
    await expect(call(removeFile, { file_id: 3 })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers 404 for a file that is not attached", async () => {
    mocks.selectRows.mockResolvedValue([]);
    expect(await call(removeFile, { file_id: "f" })).toEqual({
      status: 404,
      body: { success: false, error_message: "That file is no longer attached to this bundle." },
    });
  });

  it("answers 404 for a file id that does not decrypt", async () => {
    expect(await call(removeFile, { file_id: "unknown" })).toMatchObject({ status: 404 });
  });

  it("hands the removal of an attached file back to Rails", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 9n }]);
    await expect(call(removeFile, { file_id: "f" })).rejects.toBeInstanceOf(HandBackToRails);
  });
});
