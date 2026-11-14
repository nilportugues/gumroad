import type { Link, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17v-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({
  productsApiJson: vi.fn(() => Promise.resolve([{}])),
  load: vi.fn(() => {
    throw new Error("the validation answers come before the product is locked");
  }),
  selectRows: vi.fn(() => Promise.resolve([{ product_id: 5n }])),
}));
vi.mock("./product-json.ts", () => ({ productsApiJson: mocks.productsApiJson }));
vi.mock("../products-mutations.ts", () => ({ deleteProductBang: vi.fn() }));
vi.mock("../../models/link.ts", () => ({ Links: { load: mocks.load }, productSections: vi.fn() }));
vi.mock("../../../lib/db.ts", () => ({ db: {} }));
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selectRows: mocks.selectRows,
}));

const { updateSections } = await import("./links.ts");
const { encrypt } = await import("../../../lib/obfuscate-ids.ts");
const { registeredApiV2Routes } = await import("./base.ts");

const JSON_HEADERS = new Headers({ "content-type": "application/json" });
const product = { id: 5n } as unknown as Link;
const run = (body: unknown, params: Record<string, unknown> = {}) =>
  updateSections({
    owner: { id: 1n } as User,
    token: { scopes: "edit_products" },
    request: { headers: JSON_HEADERS },
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
    params: { ...(typeof body === "object" && body !== null ? body : {}), ...params },
    state: { product },
  } as never);
const messageOf = async (body: unknown, params?: Record<string, unknown>) =>
  (JSON.parse(String(((await run(body, params)) as { body: string }).body)) as { message: string }).message;

describe("PUT /v2/products/:id/sections validation", () => {
  it("registers the route with the raw JSON body", () => {
    const route = registeredApiV2Routes().find((r) => r.method === "PUT" && r.pattern === "/v2/products/:id/sections");

    expect(route?.rawJsonBody).toBe(true);
  });

  it.each([{}, { sections: "x" }, [1]])("asks for a list of section ids or objects for %j", async (body) => {
    expect(await messageOf(body)).toBe("sections must be an array of section ids or objects.");
  });

  it.each([[[1, 2]], [[[]]], [[true]]])(
    "refuses the entries %j that are neither an id nor an object",
    async (entries) => {
      expect(await messageOf({ sections: entries })).toBe("sections must be an array of section ids or objects.");
    },
  );

  it("reads a list in the raw body even when the params dropped a null from it", async () => {
    expect(await messageOf({ sections: [null] }, { sections: [] })).toBe(
      "sections must be an array of section ids or objects.",
    );
  });

  it.each([
    [
      { bogus: 1 },
      "bogus is not a section field. Allowed: featured_product, shown_products, default_product_sort, show_filters, add_new_products, id, type, header.",
    ],
    [{ id: encrypt(7), header: 3 }, "header must be a string."],
    [{ id: encrypt(7), header: "x".repeat(256) }, "header must be at most 255 characters."],
    [
      { id: encrypt(7), type: "products" },
      "A section entry takes either id (an existing section) or type (a new one), not both.",
    ],
    [{}, "Each object in sections must have an id or a type."],
    [{ id: "  " }, "Each object in sections must have an id or a type."],
    [{ type: "rich_text" }, "type must be one of: featured_product, products."],
    [{ id: 7 }, "sections must be an array of section ids or objects."],
    [{ id: "nope" }, "One or more sections were not found."],
  ])("answers the object entry %j", async (entry, message) => {
    expect(await messageOf({ sections: [entry] })).toBe(message);
  });

  it("refuses a section of another product before it looks at the next entry", async () => {
    mocks.selectRows.mockResolvedValueOnce([{ product_id: 99n }]);

    expect(await messageOf({ sections: [encrypt(7), "nope"] })).toBe(
      "One or more sections do not belong to this product.",
    );
  });

  it("hands an entry that creates or changes a section to Rails", async () => {
    await expect(run({ sections: [{ type: "products" }] })).rejects.toThrow(/new profile section/u);
    await expect(run({ sections: [{ id: encrypt(7), show_filters: true }] })).rejects.toThrow(
      /contents of a profile section/u,
    );
  });

  it("hands a header change of a section that is not a plain rich text one to Rails", async () => {
    await expect(run({ sections: [{ id: encrypt(7), header: "New" }] })).rejects.toThrow(/header change/u);
    mocks.selectRows.mockResolvedValueOnce([
      { product_id: 5n, type: "SellerProfileRichTextSection", header: "Old", flags: 2n, json_data: '{"text": {}}' },
    ]);
    await expect(run({ sections: [{ id: encrypt(7), header: "New" }] })).rejects.toThrow(/header change/u);
  });

  it("reports an id that does not decrypt", async () => {
    expect(await messageOf({ sections: ["nope"] })).toBe("One or more sections were not found.");
  });

  it("refuses the same section twice", async () => {
    const id = encrypt(7);

    expect(await messageOf({ sections: [id, id] })).toBe("sections must not list the same section twice.");
  });

  it("refuses known_section_ids that are not a list of ids", async () => {
    expect(await messageOf({ sections: [encrypt(7)], known_section_ids: "x" })).toBe(
      "known_section_ids must be an array of section ids.",
    );
  });

  it.each([-1, "-1", 1.5, "abc", null, [1]])("refuses the main section index %j", async (index) => {
    expect(await messageOf({ sections: [encrypt(7)], main_section_index: index })).toBe(
      "main_section_index must be a non-negative integer.",
    );
  });
});
