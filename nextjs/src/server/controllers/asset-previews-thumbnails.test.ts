import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  find: vi.fn(),
  denied: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("./products-mutations.ts", () => ({ find: mocks.find }));
vi.mock("../models/sql.ts", () => ({ selectRows: mocks.selectRows, column: () => "", table: () => "" }));
vi.mock("../policies/authorize.ts", () => ({ authorize: () => undefined }));
vi.mock("../policies/link.ts", () => ({ linkPolicy: { create: () => true } }));
vi.mock("./seller-json.ts", () => ({
  authorizeJson: async () => mocks.denied(),
  json: (body: unknown, status = 200) => ({ status, body }),
}));

await import("./asset-previews-thumbnails.ts");

const run = (method: string, pattern: string) =>
  mocks.specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run;
const call = (spec: MutationSpec["run"], params: Record<string, unknown> = {}, id: string | undefined = "guid") =>
  spec({ params, routeParams: { link_id: "permalink", ...(id ? { id } : {}) } } as unknown as MutationInput);

const halted = { status: 404, body: "halted" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue({ halt: null, product: { get: () => 5n } });
  mocks.denied.mockReturnValue(null);
});

describe("AssetPreviewsController#create", () => {
  const create = run("POST", "/links/:link_id/asset_previews");

  it("returns the halt of the product fetch", async () => {
    mocks.find.mockResolvedValue({ halt: halted });
    expect(await call(create, { asset_preview: { url: "x" } })).toBe(halted);
  });

  it("hands a missing asset_preview back to Rails, where JSON wrapping fills it in", async () => {
    await expect(call(create)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("refuses an asset_preview that is not an object", async () => {
    expect(await call(create, { asset_preview: "x" })).toEqual({
      status: 200,
      body: { success: false, error: "Could not process your preview, please try again." },
    });
  });

  it("refuses a null asset_preview", async () => {
    expect(await call(create, { asset_preview: null })).toMatchObject({ body: { success: false } });
  });

  it("hands an object back to Rails", async () => {
    await expect(call(create, { asset_preview: { url: "x" } })).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("AssetPreviewsController#destroy", () => {
  const destroy = run("DELETE", "/links/:link_id/asset_previews/:id");

  it("answers a failed delete for a preview the product does not have, without authorizing", async () => {
    mocks.selectRows.mockResolvedValue([]);
    expect(await call(destroy)).toEqual({ status: 200, body: { success: false } });
    expect(mocks.denied).not.toHaveBeenCalled();
  });

  it("returns the refusal for a preview that exists", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 1n }]);
    mocks.denied.mockReturnValue(halted);
    expect(await call(destroy)).toBe(halted);
  });

  it("hands the deletion of an authorized preview back to Rails", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 1n }]);
    await expect(call(destroy)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("ThumbnailsController#create", () => {
  const create = run("POST", "/links/:link_id/thumbnails");

  it("refuses a thumbnail that is not an object with a 400", async () => {
    expect(await call(create, { thumbnail: null })).toEqual({
      status: 400,
      body: { success: false, error: "Invalid thumbnail parameter. Expected signed_blob_id." },
    });
  });

  it("hands a missing thumbnail back to Rails, where JSON wrapping fills it in", async () => {
    await expect(call(create)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands an object back to Rails", async () => {
    await expect(call(create, { thumbnail: { signed_blob_id: "x" } })).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("ThumbnailsController#destroy", () => {
  const destroy = run("DELETE", "/links/:link_id/thumbnails/:id");

  it("answers a failed delete when the guid is not the product's thumbnail", async () => {
    mocks.selectRows.mockResolvedValue([]);
    expect(await call(destroy)).toEqual({ status: 200, body: { success: false } });
  });

  it("hands the deletion of the product's thumbnail back to Rails", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 1n }]);
    await expect(call(destroy)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
