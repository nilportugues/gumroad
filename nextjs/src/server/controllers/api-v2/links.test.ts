import type { Link, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17v-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({
  productsApiJson: vi.fn(() => Promise.resolve([{}])),
  load: vi.fn(() => {
    throw new Error("the validation answers come before the product is locked");
  }),
}));
vi.mock("./product-json.ts", () => ({ productsApiJson: mocks.productsApiJson }));
vi.mock("../products-mutations.ts", () => ({ deleteProductBang: vi.fn() }));
vi.mock("../../models/link.ts", () => ({ Links: { load: mocks.load }, productSections: vi.fn() }));
vi.mock("../../../lib/db.ts", () => ({ db: {} }));

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

  it.each([{}, { sections: "x" }, { sections: [1, 2] }, [1]])("asks for a list of section ids for %j", async (body) => {
    expect(await messageOf(body)).toBe("sections must be an array of section ids.");
  });

  it("reads a list in the raw body even when the params dropped a null from it", async () => {
    expect(await messageOf({ sections: [null] }, { sections: [] })).toBe("sections must be an array of section ids.");
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
