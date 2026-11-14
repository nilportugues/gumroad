import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, selectRows, save, set, findForCustomField, buildFromCustomField } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  save: vi.fn(),
  set: vi.fn(),
  findForCustomField: vi.fn(),
  buildFromCustomField: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../models/purchase-custom-field.ts", async (original) => ({
  ...(await original<typeof import("../models/purchase-custom-field.ts")>()),
  PurchaseCustomFields: { save },
  findForCustomField,
  buildFromCustomField,
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));

await import("./purchase-custom-fields.ts");
const { HandBackToRails, RoutingError } = await import("./application-controller.ts");
const { normalizeValue } = await import("../models/purchase-custom-field.ts");

const run = (params: Record<string, unknown>) => specs[0]!.run({ params } as unknown as MutationInput);
const valid = { purchase_id: "5", custom_field_id: "9", token: "abc", value: "Blue" };
const textField = { id: 9n, name: "Colour", field_type: "text" };

// selectRows answers, in order: the purchase, the URL redirect, the custom field.
const answers = (...rows: unknown[][]) => {
  selectRows.mockReset();
  for (const result of rows) selectRows.mockResolvedValueOnce(result);
};

beforeEach(() => {
  save.mockReset().mockResolvedValue(true);
  set.mockReset();
  findForCustomField.mockReset().mockResolvedValue(null);
  buildFromCustomField.mockReset().mockReturnValue({ built: true });
  answers([{ id: 5n, link_id: 3n }], [{ one: 1 }], [textField]);
});

describe("PurchaseCustomFieldsController#create", () => {
  it("registers POST /purchase_custom_fields as a JSON action", () => {
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ method: "POST", pattern: "/purchase_custom_fields", json: true });
  });

  it("builds and saves the answer of a purchase without one and answers 204", async () => {
    const result = await run(valid);

    expect(buildFromCustomField).toHaveBeenCalledWith(5n, textField, "Blue");
    expect(save).toHaveBeenCalledWith({ built: true });
    expect(result).toMatchObject({ status: 204, body: "" });
  });

  it("updates the existing answer with the normalised value", async () => {
    findForCustomField.mockResolvedValue({ set, existing: true });

    const result = await run({ ...valid, value: "  Dark   green " });

    expect(set).toHaveBeenCalledWith("value", "Dark green");
    expect(buildFromCustomField).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 204 });
  });

  it("answers 404 with an empty body when the token is missing", async () => {
    const result = await run({ ...valid, token: undefined });

    expect(result).toMatchObject({ status: 404, body: "", contentType: "application/json" });
    expect(save).not.toHaveBeenCalled();
  });

  it("answers 404 when no URL redirect of the purchase carries the token", async () => {
    answers([{ id: 5n, link_id: 3n }], []);

    expect(await run(valid)).toMatchObject({ status: 404 });
    expect(save).not.toHaveBeenCalled();
  });

  it("answers 404 when the token is not text", async () => {
    expect(await run({ ...valid, token: 12 })).toMatchObject({ status: 404 });
  });

  it("raises a routing error for a purchase that does not exist", async () => {
    answers([]);

    await expect(run(valid)).rejects.toBeInstanceOf(RoutingError);
    await expect(run({ ...valid, purchase_id: "nope" })).rejects.toBeInstanceOf(RoutingError);
  });

  it("raises a routing error for a field that is not a post-purchase answer field of the product", async () => {
    answers([{ id: 5n, link_id: 3n }], [{ one: 1 }], []);

    await expect(run(valid)).rejects.toBeInstanceOf(RoutingError);
    expect(save).not.toHaveBeenCalled();
  });

  it("hands a missing purchase_id or custom_field_id back to Rails", async () => {
    await expect(run({ ...valid, purchase_id: "  " })).rejects.toBeInstanceOf(HandBackToRails);
    answers([{ id: 5n, link_id: 3n }], [{ one: 1 }]);
    await expect(run({ ...valid, custom_field_id: undefined })).rejects.toBeInstanceOf(HandBackToRails);
    expect(save).not.toHaveBeenCalled();
  });

  it("hands a file field back to Rails before writing", async () => {
    answers([{ id: 5n, link_id: 3n }], [{ one: 1 }], [{ ...textField, field_type: "file" }]);

    await expect(run(valid)).rejects.toBeInstanceOf(HandBackToRails);
    expect(save).not.toHaveBeenCalled();
  });

  it("hands a value that is not text back to Rails", async () => {
    await expect(run({ ...valid, value: 12 })).rejects.toBeInstanceOf(HandBackToRails);
    expect(save).not.toHaveBeenCalled();
  });

  it("hands a value over the TEXT column's size back to Rails", async () => {
    await expect(run({ ...valid, value: "x".repeat(65_536) })).rejects.toBeInstanceOf(HandBackToRails);
    expect(save).not.toHaveBeenCalled();
  });

  it("hands a record that fails validation back to Rails", async () => {
    save.mockResolvedValue(false);

    await expect(run(valid)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("PurchaseCustomField value normalisation", () => {
  it.each([
    ["  a   b  ", "a b"],
    ["\t\n x \0", "x"],
    ["   ", null],
    [" ", null],
    ["", null],
    ["a\nb", "a\nb"],
    [null, null],
  ])("turns %j into %j", (input, expected) => {
    expect(normalizeValue(input)).toBe(expected);
  });
});
