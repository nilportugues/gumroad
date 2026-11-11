import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionResult } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

type Run = (input: MutationInput) => Promise<ActionResult>;

const { specs, selectRows } = vi.hoisted(() => ({ specs: [] as MutationSpec[], selectRows: vi.fn() }));

vi.mock("./mutation.ts", async (original) => ({
  ...(await original<typeof import("./mutation.ts")>()),
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));

await import("./purchase-invoices.ts");
const { HandBackToRails, RoutingError } = await import("./application-controller.ts");

const find =
  (method: string, pattern: string): Run =>
  (input) =>
    specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run(input);
const confirmEmail = find("POST", "/purchases/:purchase_id/invoice/confirm");
const create = find("POST", "/purchases/:purchase_id/invoice");
const call = (run: Run, params: Record<string, unknown>, purchaseId = "5") =>
  run({ params, routeParams: { purchase_id: purchaseId } } as unknown as MutationInput);

const EMAIL = "buyer@example.com";
const address = { full_name: "Jane Doe", country_code: "US" };

beforeEach(() => {
  selectRows.mockReset().mockResolvedValue([{ email: EMAIL, purchase_state: "successful" }]);
});

describe("Purchases::InvoicesController#confirm_email", () => {
  it("redirects to the invoice form with the confirmed email, as a 303", async () => {
    selectRows.mockResolvedValue([{ email: "a b@example.com", purchase_state: "successful" }]);
    expect(await call(confirmEmail, { email: "a b@example.com" })).toEqual({
      status: 303,
      location: "/purchases/5/invoice/new?email=a+b%40example.com",
    });
  });

  it("answers 404 for a purchase that does not exist", async () => {
    selectRows.mockResolvedValue([]);
    await expect(call(confirmEmail, { email: EMAIL })).rejects.toBeInstanceOf(RoutingError);
    await expect(call(confirmEmail, { email: EMAIL }, "nope")).rejects.toBeInstanceOf(RoutingError);
  });

  it("sends a wrong email back to the confirm page with an alert", async () => {
    expect(await call(confirmEmail, { email: "other@example.com" })).toEqual({
      status: 302,
      location: "/purchases/5/invoice/confirm",
      flash: { alert: "Incorrect email address. Please try again." },
      rescued: true,
    });
  });

  it.each([{}, { email: "" }, { email: "  " }, { email: null }])(
    "sends a blank email %j back with a warning",
    async (params) => {
      expect(await call(confirmEmail, params)).toMatchObject({
        status: 302,
        flash: { warning: "Please enter the purchase's email address to generate the invoice." },
      });
    },
  );

  it("compares the email byte for byte", async () => {
    expect(await call(confirmEmail, { email: "Buyer@example.com" })).toMatchObject({ status: 302 });
  });

  it.each([
    ["a list", ["x"]],
    ["a number", 3],
    ["an object", { a: 1 }],
  ])("hands back an email that is %s", async (_name, email) => {
    await expect(call(confirmEmail, { email })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a purchase with no email to compare", async () => {
    selectRows.mockResolvedValue([{ email: null, purchase_state: "successful" }]);
    await expect(call(confirmEmail, {})).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("Purchases::InvoicesController#create", () => {
  const form = { email: EMAIL, address_fields: address };

  it("applies the same email confirmation", async () => {
    expect(await call(create, { ...form, email: "other@example.com" })).toMatchObject({
      location: "/purchases/5/invoice/confirm",
      flash: { alert: "Incorrect email address. Please try again." },
    });
  });

  it("refuses a VAT id on a purchase PayPal has not completed", async () => {
    selectRows.mockResolvedValue([{ email: EMAIL, purchase_state: "in_progress" }]);
    expect(await call(create, { ...form, vat_id: "GB123" })).toEqual({
      status: 302,
      location: "/purchases/5/invoice/new?email=buyer%40example.com",
      flash: { alert: "Your purchase has not been completed by PayPal yet. Please try again soon." },
    });
  });

  it("does not count a blank VAT id as given", async () => {
    selectRows.mockResolvedValue([{ email: EMAIL, purchase_state: "in_progress" }]);
    await expect(call(create, { ...form, vat_id: " " })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each([
    ["missing", undefined],
    ["a string", "Main St"],
    ["an empty hash", {}],
    ["a hash of unlisted keys", { company: "Acme" }],
    ["a hash of nested values", { full_name: { first: "Jane" } }],
  ])("asks for the address when it is %s", async (_name, address_fields) => {
    expect(await call(create, { email: EMAIL, address_fields })).toMatchObject({
      status: 302,
      location: "/purchases/5/invoice/new?email=buyer%40example.com",
      flash: { alert: "Address information is required to generate an invoice." },
    });
  });

  it("checks the VAT id before the address", async () => {
    selectRows.mockResolvedValue([{ email: EMAIL, purchase_state: "in_progress" }]);
    expect(await call(create, { email: EMAIL, vat_id: "GB123" })).toMatchObject({
      flash: { alert: "Your purchase has not been completed by PayPal yet. Please try again soon." },
    });
  });

  it("hands back an address that passes, since the invoice is rendered and uploaded", async () => {
    await expect(call(create, form)).rejects.toBeInstanceOf(HandBackToRails);
    await expect(call(create, { ...form, address_fields: { state: null } })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each([
    ["a list", [{ full_name: "x" }]],
    ["a hash keyed by numbers", { "0": { full_name: "x" } }],
  ])("hands back an address given as %s", async (_name, address_fields) => {
    await expect(call(create, { email: EMAIL, address_fields })).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("Purchases::InvoicesController#new", () => {
  const newForm = find("GET", "/purchases/:purchase_id/invoice/new");
  const visit = (params: Record<string, unknown>, accept = "text/html") =>
    newForm({
      params,
      routeParams: { purchase_id: "5" },
      request: { headers: new Headers({ accept }) },
    } as unknown as MutationInput);

  it("sends a wrong email to the confirm page with the noindex header", async () => {
    expect(await visit({ email: "other@example.com" })).toEqual({
      status: 302,
      location: "/purchases/5/invoice/confirm",
      flash: { alert: "Incorrect email address. Please try again." },
      rescued: true,
      headers: { "x-robots-tag": "noindex" },
    });
  });

  it("answers 404 for a purchase that does not exist", async () => {
    selectRows.mockResolvedValue([]);
    await expect(visit({ email: EMAIL })).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands back the form of a purchase whose email was confirmed", async () => {
    await expect(visit({ email: EMAIL })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a request that does not ask for HTML", async () => {
    await expect(visit({ email: EMAIL }, "application/json")).rejects.toBeInstanceOf(HandBackToRails);
  });
});
