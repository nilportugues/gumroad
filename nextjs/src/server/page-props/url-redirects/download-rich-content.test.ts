import type { RichContent } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";

const mocks = vi.hoisted(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "rich-content-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";
  return { findMany: vi.fn() };
});

vi.mock("../../../lib/db.ts", () => ({ db: { richContent: { findMany: mocks.findMany } } }));

const { encrypt } = await import("../../../lib/obfuscate-ids.ts");
const { embeddedFileIds, hasPostsNode, productRichPages, richContentPagesJson } = await import(
  "./download-rich-content.ts"
);

const page = (id: bigint, position: number, description: unknown): RichContent =>
  ({
    id,
    position,
    title: `Page ${id}`,
    description,
    updated_at: new Date("2026-02-01T10:00:00.987Z"),
  }) as RichContent;
const embed = (id: number) => ({ type: "fileEmbed", attrs: { id: encrypt(id), uid: `u${id}` } });

beforeEach(() => vi.resetAllMocks());

describe("productRichPages", () => {
  it("sorts the alive pages by position", async () => {
    mocks.findMany.mockResolvedValue([page(1n, 5, []), page(2n, 1, [])]);

    expect((await productRichPages(9n)).map((row) => row.id)).toEqual([2n, 1n]);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entity_type: "Link", entity_id: 9n, deleted_at: null } }),
    );
  });

  it("hands back pages that share a position, since Ruby's sort_by is unstable", async () => {
    mocks.findMany.mockResolvedValue([page(1n, 1, []), page(2n, 1, [])]);

    await expect(productRichPages(9n)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("embeddedFileIds", () => {
  it("reads embeds at the top level, in groups, lists and quotes, once each and in page order", () => {
    const pages = [
      page(1n, 1, [
        embed(7),
        { type: "fileEmbedGroup", attrs: { name: "Folder" }, content: [embed(3), embed(7)] },
        {
          type: "blockquote",
          content: [{ type: "orderedList", content: [{ type: "listItem", content: [embed(5)] }] }],
        },
      ]),
      page(2n, 2, [embed(3), embed(9)]),
    ];

    expect(embeddedFileIds(pages)).toEqual([7n, 3n, 5n, 9n]);
  });

  it("ignores embeds without an id and nodes that Ruby does not descend into", () => {
    const pages = [
      page(1n, 1, [{ type: "fileEmbed", attrs: {} }, { type: "paragraph", content: [embed(4)] }, { type: "posts" }]),
    ];

    expect(embeddedFileIds(pages)).toEqual([]);
  });

  it("hands back an id that does not decode", () => {
    const pages = [page(1n, 1, [{ type: "fileEmbed", attrs: { id: "not an id" } }])];

    expect(() => embeddedFileIds(pages)).toThrow(HandBackToRails);
  });
});

describe("hasPostsNode", () => {
  it("finds a posts block at the top level or inside a list or quote only", () => {
    expect(hasPostsNode([page(1n, 1, [{ type: "posts" }])])).toBe(true);
    expect(
      hasPostsNode([
        page(1n, 1, [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "posts" }] }] }]),
      ]),
    ).toBe(true);
    expect(hasPostsNode([page(1n, 1, [{ type: "fileEmbedGroup", content: [{ type: "posts" }] }])])).toBe(false);
    expect(hasPostsNode([page(1n, 1, [{ type: "paragraph" }])])).toBe(false);
  });
});

describe("richContentPagesJson", () => {
  it("serializes a page the way RichContents#rich_content_json does, with the time cut to seconds", () => {
    const [entry] = richContentPagesJson([page(1n, 1, [{ type: "paragraph" }])]);

    expect(entry).toEqual({
      id: encrypt(1n),
      page_id: encrypt(1n),
      title: "Page 1",
      variant_id: null,
      description: { type: "doc", content: [{ type: "paragraph" }] },
      updated_at: "2026-02-01T10:00:00Z",
    });
  });
});
