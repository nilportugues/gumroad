// Checkout::FormPresenter#form_props (app/presenters/checkout/form_presenter.rb) for Checkout::FormController#show.
//
// The cart item and the card are CheckoutPresenter and ProductPresenter output for the seller's newest product (presenters/checkout-product.ts
// hands back the products it cannot prove). The PayPal Connect card is in ./paypal-connect.ts.
import { Prisma, type User } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { CustomFieldFlags } from "../../models/custom-field.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { aliveUserComplianceInfoRow } from "../../models/user-compliance-info.ts";
import { UserFlags } from "../../models/user.ts";
import { type SellerContext } from "../../policies/seller-context.ts";
import { checkoutProduct } from "../../presenters/checkout-product.ts";
import { findLink } from "../../presenters/product-reads.ts";
import { cardForWeb } from "../../presenters/product.ts";
import { NotPortedError } from "../not-ported.ts";
import { connectAccountFeeInfo } from "../settings/payments.ts";
import { type ComplianceInfoRow } from "../signed-in/reads.ts";

import { assertPaypalAccountSupported, paypalConnect } from "./paypal-connect.ts";

// CheckoutDashboardHelper#pages
const PAGES = ["discounts", "form", "upsells"];

type FieldRow = {
  id: bigint;
  field_type: string | null;
  name: string | null;
  required: boolean | number | null;
  global: boolean | number | null;
  flags: bigint | number;
};

const bool = (value: boolean | number | null) => (value === null ? null : Boolean(value));

// `seller.custom_fields.not_is_post_purchase.map(&:as_json)`
async function customFieldsProps(seller: User) {
  const fields = await selectRows<FieldRow>(
    Prisma.sql`SELECT ${column("custom_fields", "id")}, ${column("custom_fields", "field_type")}, ${column("custom_fields", "name")}, ${column("custom_fields", "required")}, ${column("custom_fields", "global")}, ${column("custom_fields", "flags")} FROM ${table("custom_fields")} WHERE ${column("custom_fields", "seller_id")} = ${seller.id} AND ${CustomFieldFlags.condition("is_post_purchase", false)} ORDER BY ${column("custom_fields", "id")} ASC`,
  );
  const props = [];
  for (const field of fields) {
    // `field.products` is a habtm read with no ORDER BY: MySQL walks `links` by id on small tables and the join rows by id on large ones.
    // assertFormSupported hands the request back unless the two agree, so id order is the order.
    const products = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${table("links")}.* FROM ${table("links")} INNER JOIN ${table("custom_fields_products")} ON ${column("links", "id")} = ${column("custom_fields_products", "product_id")} WHERE ${column("custom_fields_products", "custom_field_id")} = ${field.id} ORDER BY ${column("links", "id")} ASC`,
    );
    props.push({
      id: externalId(field.id),
      type: field.field_type,
      name: field.name,
      required: bool(field.required),
      global: bool(field.global),
      collect_per_product: CustomFieldFlags.isSet(field.flags, "collect_per_product"),
      products: products.map((row) => externalId(row.id)),
    });
  }
  return props;
}

async function exists(sql: Prisma.Sql) {
  return (await selectRows(sql)).length > 0;
}

// The seller's products, newest first, and the cart item and card Rails builds from the newest one.
async function checkoutPreview(seller: User) {
  // `seller.products.visible.order(created_at: :desc)`
  const products = await selectRows<{ id: bigint; name: string | null; flags: bigint | number }>(
    Prisma.sql`SELECT ${table("links")}.* FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL ORDER BY ${column("links", "created_at")} DESC`,
  );
  // Products created in the same second have no ORDER BY tie-break, so the first one (the preview) is whichever MySQL returns. Selecting
  // `links.*` with Rails' exact statement leaves it the same plan, hence the same order, over the same rows.
  const newest = products[0] === undefined ? null : await findLink(products[0].id);
  return {
    products,
    cartItem:
      newest === null ? null : { ...(await checkoutProduct(newest)), quantity: 1, url_parameters: {}, referrer: "" },
    cardProduct: newest === null ? null : await cardForWeb(newest.id),
  };
}

// Run by the page's guard, after authorization, so a refusal still redirects from Node.
export async function assertFormSupported(seller: User): Promise<void> {
  // A NotPortedError thrown while the page loads would be a 500, so the preview is built once here to hand the request back instead.
  try {
    await checkoutPreview(seller);
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
  await assertPaypalAccountSupported(seller);
  // A listed field linked to a later product before an earlier one: its products' order depends on the plan MySQL picks.
  if (
    await exists(
      Prisma.sql`SELECT 1 FROM ${table("custom_fields")} INNER JOIN ${Prisma.raw("`custom_fields_products` `earlier`")} ON ${column("earlier", "custom_field_id")} = ${column("custom_fields", "id")} INNER JOIN ${Prisma.raw("`custom_fields_products` `later`")} ON ${column("later", "custom_field_id")} = ${column("custom_fields", "id")} AND ${column("later", "id")} > ${column("earlier", "id")} AND ${column("later", "product_id")} < ${column("earlier", "product_id")} INNER JOIN ${Prisma.raw("`links` `earlier_link`")} ON ${column("earlier_link", "id")} = ${column("earlier", "product_id")} INNER JOIN ${Prisma.raw("`links` `later_link`")} ON ${column("later_link", "id")} = ${column("later", "product_id")} WHERE ${column("custom_fields", "seller_id")} = ${seller.id} AND ${CustomFieldFlags.condition("is_post_purchase", false)} LIMIT 1`,
    )
  ) {
    throw new HandBackToRails("a custom field linked to its products against their ids");
  }
}

export async function formProps(seller: User, context: SellerContext) {
  const flag = (name: Parameters<typeof UserFlags.isSet>[1]) => UserFlags.isSet(seller.flags, name);
  const complianceRow = await aliveUserComplianceInfoRow(seller.id);
  const info: ComplianceInfoRow | null = complianceRow && {
    country: complianceRow.country,
    business_country: complianceRow.business_country,
    is_business: complianceRow.is_business,
    birthday: complianceRow.birthday,
    guardian_id: complianceRow.guardian_id === null ? null : BigInt(complianceRow.guardian_id),
  };

  const { products, cartItem, cardProduct } = await checkoutPreview(seller);

  return {
    pages: PAGES,
    user: {
      display_offer_code_field: flag("display_offer_code_field"),
      recommendation_type: seller.recommendation_type,
      tipping_enabled: flag("tipping_enabled"),
      ach_payments_enabled: flag("ach_payments_enabled"),
      gifting_disabled: flag("gifting_disabled"),
      link_disabled: flag("link_disabled"),
      paypal_card_funding_disabled: flag("paypal_card_funding_disabled"),
    },
    cart_item: cartItem,
    custom_fields: await customFieldsProps(seller),
    card_product: cardProduct,
    products: products.map((product) => ({
      id: externalId(product.id),
      name: product.name,
      archived: LinkFlags.isSet(product.flags, "archived"),
    })),
    paypal_connect: await paypalConnect(seller, context, info),
    connect_account_fee_info: await connectAccountFeeInfo(seller),
  };
}
