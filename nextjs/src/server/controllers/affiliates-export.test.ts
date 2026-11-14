import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationInput, MutationSpec } from "./mutation.ts";
import { railsRequest } from "./rails-request.ts";

const mocks = vi.hoisted(() => ({ specs: [] as MutationSpec[], selectRows: vi.fn(), enqueue: vi.fn() }));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("./users-controller.ts", () => ({ requireHtml: () => undefined }));
vi.mock("../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selectRows: mocks.selectRows,
}));
vi.mock("../exports/enqueue.ts", () => ({ exportAffiliatesOrEnqueue: mocks.enqueue }));
vi.mock("../page-props/audience/seller-guard.ts", () => ({ sellerGuard: () => Promise.resolve(null) }));

await import("./affiliates-export.ts");

const run = (input: MutationInput) => mocks.specs[0]!.run(input);
const ASYNC_AFFILIATE_COUNT = 501n;

const call = (referer?: string) =>
  run({
    request: railsRequest(
      new Request("https://app.test.gumroad.com/affiliates/export", referer ? { headers: { referer } } : {}),
    ),
    context: { currentSeller: { id: 3n } },
    url: new URL("https://app.test.gumroad.com/affiliates/export"),
    routeParams: {},
  } as unknown as MutationInput);

beforeEach(() => {
  mocks.selectRows.mockReset().mockResolvedValue([{ count: ASYNC_AFFILIATE_COUNT }]);
  mocks.enqueue.mockReset().mockResolvedValue({ synchronous: false });
});

describe("AffiliatesController#export past the synchronous threshold", () => {
  it("redirects to the affiliates page without a Referer", async () => {
    expect(await call()).toMatchObject({ status: 302, location: "/affiliates" });
  });

  it("redirects back to a Referer on the request's host", async () => {
    const referer = "https://app.test.gumroad.com/affiliates?query=a";

    expect(await call(referer)).toMatchObject({ status: 302, location: referer });
  });

  it("redirects back to a Referer that is a path", async () => {
    expect(await call("/dashboard?tab=1")).toMatchObject({ location: "/dashboard?tab=1" });
  });

  it("ignores a Referer on another host", async () => {
    expect(await call("https://example.com/affiliates")).toMatchObject({ location: "/affiliates" });
  });

  it("queues the export before redirecting", async () => {
    await call("https://app.test.gumroad.com/affiliates");

    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
});
