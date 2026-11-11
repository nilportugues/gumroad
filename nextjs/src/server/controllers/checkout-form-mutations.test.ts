// Checkout::FormController#update: the parameters the port takes, and the ones it leaves to Rails.
import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { checkoutFormPolicy } from "../policies/checkout-form.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails } from "./application-controller.ts";
import { permittedParams } from "./checkout-form-mutations.ts";

describe("permittedParams", () => {
  it("takes no user and no fields from a body that sends neither", () => {
    expect(permittedParams({ other: "value" })).toEqual({ user: null, customFields: null });
  });

  it("keeps an empty list of fields, which deletes every field", () => {
    expect(permittedParams({ custom_fields: [] })).toEqual({ user: null, customFields: [] });
  });

  it("keeps the permitted keys of a field in the order they arrive and drops the others", () => {
    const { customFields } = permittedParams({
      custom_fields: [
        { unknown: 1, name: "Phone", type: "text", global: true, required: null, products: ["a", "b"], key: "-1" },
      ],
    });
    expect(customFields).toEqual([
      {
        id: undefined,
        attributes: [
          ["name", "Phone"],
          ["field_type", "text"],
          ["global", true],
          ["required", null],
        ],
        global: true,
        products: ["a", "b"],
      },
    ]);
  });

  it("casts an integer name to its digits and drops a hash under a scalar key", () => {
    const { customFields } = permittedParams({ custom_fields: [{ name: 5, type: { nested: true } }] });
    expect(customFields![0]!.attributes).toEqual([["name", "5"]]);
  });

  it("drops products that are not a list", () => {
    expect(permittedParams({ custom_fields: [{ name: "Phone", products: "abc" }] }).customFields![0]!.products).toEqual(
      [],
    );
  });

  it("treats a field that is not marked global as scoped to its products", () => {
    expect(permittedParams({ custom_fields: [{ name: "Phone", global: false }] }).customFields![0]!.global).toBe(false);
  });

  it("hands back custom fields that are not a list", () => {
    expect(() => permittedParams({ custom_fields: "Phone" })).toThrow(HandBackToRails);
    expect(() => permittedParams({ custom_fields: { "0": { name: "Phone" } } })).toThrow(HandBackToRails);
  });

  it("hands back a field that is not a hash", () => {
    expect(() => permittedParams({ custom_fields: ["Phone"] })).toThrow(HandBackToRails);
  });

  it("hands back flags sent as text or numbers", () => {
    expect(() => permittedParams({ custom_fields: [{ name: "Phone", required: "yes" }] })).toThrow(HandBackToRails);
    expect(() => permittedParams({ custom_fields: [{ name: "Phone", global: 1 }] })).toThrow(HandBackToRails);
    expect(() => permittedParams({ custom_fields: [{ name: "Phone", collect_per_product: "true" }] })).toThrow(
      HandBackToRails,
    );
  });

  it("hands back product ids that are not strings", () => {
    expect(() => permittedParams({ custom_fields: [{ name: "Phone", products: [1] }] })).toThrow(HandBackToRails);
  });

  it("hands back a float for a string attribute", () => {
    expect(() => permittedParams({ custom_fields: [{ name: 1.5 }] })).toThrow(HandBackToRails);
  });

  it("hands back a user that is not a hash", () => {
    expect(() => permittedParams({ user: "tipping_enabled" })).toThrow(HandBackToRails);
  });
});

describe("checkoutFormPolicy", () => {
  const seller = { id: 1n } as User;
  const asRole = (role: string): SellerContext => {
    const member = { id: 2n } as User;
    return {
      user: member,
      seller,
      memberships: [{ seller_id: seller.id, user_id: member.id, role } as TeamMembership],
    };
  };

  it("lets the owner see and save the form", () => {
    const context: SellerContext = { user: seller, seller, memberships: [] };
    expect(checkoutFormPolicy.show(context)).toBe(true);
    expect(checkoutFormPolicy.update(context)).toBe(true);
  });

  it("lets every team role see the form", () => {
    for (const role of ["accountant", "admin", "marketing", "support"])
      expect(checkoutFormPolicy.show(asRole(role))).toBe(true);
  });

  it("lets only admin and marketing save the form", () => {
    expect(
      ["accountant", "admin", "marketing", "support"].map((role) => checkoutFormPolicy.update(asRole(role))),
    ).toEqual([false, true, true, false]);
  });
});
