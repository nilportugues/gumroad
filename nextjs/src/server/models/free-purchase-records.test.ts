// The rows a plain free checkout writes around the purchase, saved through their model definitions and compared with
// the rows the Rails recording inserted (parity/fixtures/requests/orders_free_purchase_parity_spec).
import { beforeEach, describe, expect, it } from "vitest";

import { assigned, insertedRow, lastExchange, recorded, RECORDED_NOW } from "./__fixtures__/free-purchase-recording.ts";
import { ChargePurchases } from "./charge-purchase.ts";
import { Charges } from "./charge-record.ts";
import { Events } from "./event.ts";
import { OrderPurchases } from "./order-purchase.ts";
import { Orders } from "./order.ts";
import { PurchaseRefundPolicies } from "./purchase-refund-policy.ts";
import { PurchaseSalesTaxInfos } from "./purchase-sales-tax-info.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { setUrlRedirectTokenGenerator, UrlRedirects } from "./url-redirect.ts";

const now = () => RECORDED_NOW;
let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  db = fakeDatabase();
});

// What the recorded insert carries, without the id the database picks.
const written = () => {
  const { id: _id, ...data } = recorded(db.writes[0]!.data);
  return data;
};
const expected = (table: string) => {
  const { id: _id, ...row } = insertedRow(table);
  return row;
};
const exists = (count = 1) => db.queueQueryResults(...Array.from({ length: count }, () => [{ id: 2 }]));
const selects = () => db.queries.map((query) => query.sql.replace(/\s+/gu, " "));

describe("PurchaseRefundPolicy create", () => {
  it("inserts the recorded row, stripping the title and the fine print first", async () => {
    const row = insertedRow("purchase_refund_policies");
    db.queueQueryResults([{ id: 2 }], []);
    await PurchaseRefundPolicies.createBang(
      { ...assigned(row), title: `  ${String(row.title)} `, fine_print: "   " } as never,
      { now },
    );

    expect(written()).toEqual(expected("purchase_refund_policies"));
    expect(selects()).toEqual([
      "SELECT `purchases`.* FROM `purchases` WHERE `purchases`.`id` = ? LIMIT 1",
      "SELECT 1 AS one FROM `purchase_refund_policies` WHERE `purchase_refund_policies`.`purchase_id` = ? LIMIT 1",
    ]);
  });

  it("rejects a purchase that already has a policy", async () => {
    const row = insertedRow("purchase_refund_policies");
    db.queueQueryResults([{ id: 2 }], [{ one: 1 }]);
    await expect(PurchaseRefundPolicies.createBang(assigned(row) as never, { now })).rejects.toThrow(
      "Purchase has already been taken",
    );
    expect(db.writes).toEqual([]);
  });

  it("requires the period for a policy created after the cutoff, and a title always", async () => {
    const row = insertedRow("purchase_refund_policies");
    db.queueQueryResults([{ id: 2 }], []);
    const record = PurchaseRefundPolicies.build({
      ...assigned(row),
      title: "",
      max_refund_period_in_days: null,
    } as never);
    expect(await PurchaseRefundPolicies.save(record, { now })).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Title can't be blank", "Max refund period in days can't be blank"]);
  });
});

describe("PurchaseSalesTaxInfo create", () => {
  it("inserts the recorded row with no timestamps and no validation queries", async () => {
    await PurchaseSalesTaxInfos.createBang(assigned(insertedRow("purchase_sales_tax_infos")) as never, { now });
    expect(written()).toEqual(expected("purchase_sales_tax_infos"));
    expect(db.queries).toEqual([]);
  });
});

describe("Order create", () => {
  it("inserts the recorded row and looks for a cart before deciding on a review reminder", async () => {
    db.queueQueryResults([]);
    await Orders.createBang(assigned(insertedRow("orders")) as never, { now });
    expect(written()).toEqual(expected("orders"));
    expect(selects()).toEqual(["SELECT `carts`.* FROM `carts` WHERE `carts`.`order_id` = ? LIMIT 1"]);
  });

  it("hands back an order that belongs to a cart", async () => {
    db.queueQueryResults([{ id: 9 }]);
    await expect(Orders.createBang(assigned(insertedRow("orders")) as never, { now })).rejects.toThrow("not ported");
  });
});

describe("OrderPurchase and ChargePurchase create", () => {
  it("inserts the recorded order_purchases row loading each side once (the presence validators reuse the loaded association)", async () => {
    exists(2);
    await OrderPurchases.createBang(assigned(insertedRow("order_purchases")) as never, { now });
    expect(written()).toEqual(expected("order_purchases"));
    expect(selects().map((sql) => /FROM `(\w+)`/u.exec(sql)![1])).toEqual(["orders", "purchases"]);
  });

  it("inserts the recorded charge_purchases row after checking the charge and the purchase", async () => {
    exists(2);
    await ChargePurchases.createBang(assigned(insertedRow("charge_purchases")) as never, { now });
    expect(written()).toEqual(expected("charge_purchases"));
    expect(selects().map((sql) => /FROM `(\w+)`/u.exec(sql)![1])).toEqual(["charges", "purchases"]);
  });
});

describe("Charge create", () => {
  it("inserts the recorded row after checking the order and the seller", async () => {
    exists(2);
    await Charges.createBang(assigned(insertedRow("charges")) as never, { now });
    expect(written()).toEqual(expected("charges"));
    expect(selects().map((sql) => /FROM `(\w+)`/u.exec(sql)![1])).toEqual(["orders", "users"]);
  });

  it("refuses a charge whose order does not exist", async () => {
    db.queueQueryResults([], [{ id: 2 }]);
    await expect(Charges.createBang(assigned(insertedRow("charges")) as never, { now })).rejects.toThrow(
      "Order must exist",
    );
  });
});

describe("Event and UrlRedirect create", () => {
  it("inserts the recorded purchase event", async () => {
    await Events.createBang(assigned(insertedRow("events")) as never, { now });
    expect(written()).toEqual(expected("events"));
  });

  it("inserts the recorded url_redirects row, drawing the token after the uniqueness check", async () => {
    const row = insertedRow("url_redirects");
    setUrlRedirectTokenGenerator(() => String(row.token));
    db.queueQueryResults([]);
    try {
      await UrlRedirects.createBang({ ...assigned(row), token: null } as never, { now });
    } finally {
      setUrlRedirectTokenGenerator(null);
    }
    expect(written()).toEqual(expected("url_redirects"));
    expect(selects()).toEqual([
      "SELECT 1 AS one FROM `url_redirects` WHERE `url_redirects`.`token` = CAST(? AS BINARY) LIMIT 1",
    ]);
  });
});

describe("recorded write order of the free path", () => {
  it("is the order the handler must reproduce", () => {
    const writes = lastExchange().timeline.flatMap((entry) =>
      entry.type === "db" ? [`${entry.op} ${entry.table}`] : [],
    );
    expect(writes).toEqual([
      "insert purchases",
      "insert purchase_refund_policies",
      "update links",
      "insert purchase_sales_tax_infos",
      "insert orders",
      "insert order_purchases",
      "insert charges",
      "insert charge_purchases",
      "update purchases",
      "update purchases",
      "insert url_redirects",
      "insert events",
    ]);
  });
});
