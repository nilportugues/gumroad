import { describe, expect, it } from "vitest";

import { modelForRubyClass, reflectOnAssociation } from "./associations.ts";

describe("association manifest", () => {
  it("models a plain belongs_to with its Prisma field", () => {
    expect(reflectOnAssociation("Link", "user")).toMatchObject({ status: "modeled", prisma: { field: "user" }, foreign_key: "user_id", target_table: "users" });
  });

  it("records polymorphic and through associations it cannot model", () => {
    expect(reflectOnAssociation("Comment", "commentable")).toMatchObject({ status: "polymorphic", prisma: null, foreign_type: "commentable_type" });
    expect(reflectOnAssociation("Installment", "comments")).toMatchObject({ status: "polymorphic_inverse", foreign_key: "commentable_id" });
    expect(reflectOnAssociation("BaseVariant", "product_files")).toMatchObject({ status: "habtm", join_table: "base_variants_product_files" });
    expect(reflectOnAssociation("User", "affiliated_products")).toMatchObject({ status: "through", through: "affiliate_accounts", target_model: "Link" });
  });

  it("resolves STI subclasses to their base table and inherited associations", () => {
    expect(modelForRubyClass("Price")).toBe("BasePrice");
    expect(modelForRubyClass("Variant")).toBe("BaseVariant");
    expect(reflectOnAssociation("Variant", "variant_category").target_table).toBe("variant_categories");
  });

  it("names models after the Ruby class rather than the table", () => {
    expect(modelForRubyClass("ProductAffiliate")).toBe("ProductAffiliate");
    expect(modelForRubyClass("EarlyFraudWarning")).toBe("EarlyFraudWarning");
    expect(modelForRubyClass("Marketing::Action")).toBe("MarketingAction");
  });

  it("throws for an association Rails does not declare", () => {
    expect(() => reflectOnAssociation("User", "nope")).toThrow("No association nope on User");
  });
});
