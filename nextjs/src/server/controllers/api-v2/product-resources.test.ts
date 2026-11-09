import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { richContent: { findMany: vi.fn() } },
  aliveVariants: vi.fn(),
}));
vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("./records.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("./records.ts")>()), aliveVariants: mocks.aliveVariants }));

const { hidesVariantRichContent } = await import("./product-resources.ts");

const link = (flags = 0n) => ({ id: 3n, flags }) as never;
const emptyParagraph = [{ type: "paragraph" }];
const textParagraph = [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }];
const page = (title: string | null, description: unknown) => ({ title, description });

// Link#recoverable_hidden_variant_rich_content? with has_same_rich_content_for_all_variants? already true.
describe("hidesVariantRichContent", () => {
  beforeEach(() => {
    mocks.db.richContent.findMany.mockReset();
    mocks.aliveVariants.mockReset();
  });

  it("hides for a physical product without reading any page", async () => {
    const { linkFlag } = await import("./records.ts");
    const flags = Array.from({ length: 40 }, (_, i) => 1n << BigInt(i)).find((f) => linkFlag(link(f), "is_physical"))!;
    expect(await hidesVariantRichContent(link(flags))).toBe(true);
    expect(mocks.db.richContent.findMany).not.toHaveBeenCalled();
  });

  it("hides when a product page has a title", async () => {
    mocks.db.richContent.findMany.mockResolvedValueOnce([page("Intro", [])]);
    expect(await hidesVariantRichContent(link())).toBe(true);
  });

  it("hides when a product page body has text", async () => {
    mocks.db.richContent.findMany.mockResolvedValueOnce([page(null, textParagraph)]);
    expect(await hidesVariantRichContent(link())).toBe(true);
  });

  it("hides when there are no alive variants", async () => {
    mocks.db.richContent.findMany.mockResolvedValueOnce([page(null, emptyParagraph)]);
    mocks.aliveVariants.mockResolvedValueOnce([]);
    expect(await hidesVariantRichContent(link())).toBe(true);
  });

  it("hides when variant pages are all blank", async () => {
    mocks.db.richContent.findMany.mockResolvedValueOnce([page(null, emptyParagraph)]).mockResolvedValueOnce([page("", emptyParagraph)]);
    mocks.aliveVariants.mockResolvedValueOnce([{ id: 9n }]);
    expect(await hidesVariantRichContent(link())).toBe(true);
  });

  it("does not hide when a variant page has content and the product pages are blank", async () => {
    mocks.db.richContent.findMany.mockResolvedValueOnce([page(null, emptyParagraph)]).mockResolvedValueOnce([page(null, textParagraph)]);
    mocks.aliveVariants.mockResolvedValueOnce([{ id: 9n }]);
    expect(await hidesVariantRichContent(link())).toBe(false);
  });

  it("does not hide when a variant page only has a title", async () => {
    mocks.db.richContent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([page("Bonus", [])]);
    mocks.aliveVariants.mockResolvedValueOnce([{ id: 9n }]);
    expect(await hidesVariantRichContent(link())).toBe(false);
  });
});
