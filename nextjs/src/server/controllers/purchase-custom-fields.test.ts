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
const { HandBackToRails, ParameterMissing, RoutingError } = await import("./application-controller.ts");
const { RecordInvalid } = await import("../models/runtime/errors.ts");
const { normalizeValue } = await import("../models/purchase-custom-field.ts");

const run = (params: Record<string, unknown>, body: string = JSON.stringify(params)) =>
  specs[0]!.run({
    params,
    url: new URL("http://example.com/purchase_custom_fields"),
    request: { headers: new Headers({ "content-type": "application/json" }) },
    rawBody: new TextEncoder().encode(body),
  } as unknown as MutationInput);
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

  it("raises ParameterMissing for a purchase_id or custom_field_id that is absent, blank, null, an array or a hash", async () => {
    for (const missing of [undefined, null, "  ", [], ["5"], { a: 1 }]) {
      answers([{ id: 5n, link_id: 3n }], [{ one: 1 }]);
      await expect(run({ ...valid, purchase_id: missing })).rejects.toBeInstanceOf(ParameterMissing);
      answers([{ id: 5n, link_id: 3n }], [{ one: 1 }]);
      await expect(run({ ...valid, custom_field_id: missing })).rejects.toBeInstanceOf(ParameterMissing);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("hands a purchase_id that is a number back to Rails", async () => {
    await expect(run({ ...valid, purchase_id: 5 })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a file field back to Rails before writing", async () => {
    answers([{ id: 5n, link_id: 3n }], [{ one: 1 }], [{ ...textField, field_type: "file" }]);

    await expect(run(valid)).rejects.toBeInstanceOf(HandBackToRails);
    expect(save).not.toHaveBeenCalled();
  });

  it("saves an integer answer as its decimal text", async () => {
    await run({ ...valid, value: 42 });

    expect(buildFromCustomField).toHaveBeenCalledWith(5n, textField, "42");
    expect(save).toHaveBeenCalledOnce();
  });

  it("hands a float, a boolean, a hash and an integer past 2**53 back to Rails", async () => {
    await expect(run({ ...valid, value: 4.5 }, '{"value":4.5}')).rejects.toBeInstanceOf(HandBackToRails);
    await expect(run({ ...valid, value: 42 }, '{"value":42.0}')).rejects.toBeInstanceOf(HandBackToRails);
    await expect(run({ ...valid, value: true })).rejects.toBeInstanceOf(HandBackToRails);
    await expect(run({ ...valid, value: { a: 1 } })).rejects.toBeInstanceOf(HandBackToRails);
    await expect(run({ ...valid, value: 1 }, '{"value":12345678901234567890}')).rejects.toBeInstanceOf(HandBackToRails);
    expect(save).not.toHaveBeenCalled();
  });

  it("hands a value over the TEXT column's size back to Rails", async () => {
    await expect(run({ ...valid, value: "x".repeat(65_536) })).rejects.toBeInstanceOf(HandBackToRails);
    expect(save).not.toHaveBeenCalled();
  });

  it("raises RecordInvalid for a record that fails validation, as save! does", async () => {
    save.mockResolvedValue(false);

    await expect(run(valid)).rejects.toBeInstanceOf(RecordInvalid);
  });
});
