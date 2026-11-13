import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Purchase } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { resolveTimeToken } from "../../../../parity/src/canonical.ts";
import { castRow } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";

import {
  escalationDeadlineFrom,
  formatDeadline,
  ineligibility,
  refundRequestPageProps,
  REFUND_REQUEST_COMPONENT,
  type RefundRequestRow,
} from "./refund-request.ts";

// Rails' own answers, recorded in spec/requests/purchase_refund_request_page_parity_spec.rb (GET /purchases/:id/refund_request).
const DIR = path.join(
  import.meta.dirname,
  "../../../../parity/fixtures/requests/purchase_refund_request_page_parity_spec",
);

type Row = Record<string, unknown>;
type Recorded = {
  example: string;
  recordedOn: string;
  exchanges: {
    request: { path: string };
    seed: { tables: Record<string, { rows: Row[] } | undefined> };
    response: { status: number; inertia?: { component: string; props: Record<string, unknown> } };
  }[];
};

const recorded = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Recorded);
const pages = recorded.filter(({ exchanges }) => exchanges.at(-1)!.response.status === 200);

// The recording's "<now>" is some instant of `recordedOn`; a deadline is a date, so noon UTC reads the same day Rails did.
const nowOf = (fixture: Recorded) => new Date(`${fixture.recordedOn}T12:00:00Z`);

// A recorded row as `SELECT *` returns it: "<now-95h>" tokens resolved, columns cast.
function seeded<R>(fixture: Recorded, model: "Purchase", table: string): R[] {
  const now = nowOf(fixture);
  const rows = fixture.exchanges.at(-1)!.seed.tables[table]?.rows ?? [];
  return rows.map((row) =>
    castRow<never>(
      model,
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" && value.startsWith("<now")
            ? (resolveTimeToken(value, now)?.toISOString() ?? value)
            : value,
        ]),
      ),
    ),
  ) as R[];
}

function build(fixture: Recorded) {
  const exchange = fixture.exchanges.at(-1)!;
  const now = nowOf(fixture);
  const [purchase] = seeded<Purchase>(fixture, "Purchase", "purchases");
  const policies = exchange.seed.tables.purchase_refund_policies?.rows ?? [];
  // PurchaseRefundRequest.refund_period_in_days: the purchase's own policy, else its subscription's original purchase's.
  const policy = policies.find((row) => row.purchase_id === Number(purchase!.id));
  const requestRow = exchange.seed.tables.purchase_refund_requests?.rows[0];
  const refundRequest: RefundRequestRow | null = requestRow
    ? {
        email: requestRow.email as string,
        reason: requestRow.reason as string,
        escalated_at: requestRow.escalated_at ? resolveTimeToken(requestRow.escalated_at as string, now) : null,
        created_at: resolveTimeToken(requestRow.created_at as string, now)!,
      }
    : null;
  const routeId = exchange.request.path.split("/")[2]!;
  return () =>
    refundRequestPageProps({
      purchaseRouteId: routeId,
      purchase: purchase!,
      productName: exchange.seed.tables.links!.rows[0]!.name as string,
      sellerName: exchange.seed.tables.users!.rows[0]!.name as string,
      refundRequest,
      maxRefundPeriodInDays: (policy?.max_refund_period_in_days as number | undefined) ?? null,
      now,
    });
}

const OWN_KEYS = [
  "purchase_route_id",
  "product_name",
  "seller_name",
  "formatted_price",
  "respond_by",
  "max_message_length",
  "reasons",
  "refund_request",
  "ineligibility",
  "refund_window_ended_on",
];

describe("Purchases/RefundRequest/Show props", () => {
  it("covers every state the page renders", () => {
    expect(pages.map(({ example }) => example.replace(/^Purchase refund request page /u, "")).sort()).toEqual([
      "explains a free purchase",
      "explains a partly refunded purchase",
      "explains a purchase outside the refund window",
      "explains a seller who offers no refunds",
      "hands a renewal of a subscription to Rails, which takes its refund window from the original purchase",
      "renders the form for an eligible purchase",
      "shows a request of a disputed purchase",
      "shows a request of a refunded purchase",
      "shows an escalated request and its own deadline",
      "shows the request a buyer made",
    ]);
  });

  it.each(
    pages
      .filter((fixture) => !fixture.example.includes("subscription"))
      .map((fixture) => [fixture.example, fixture] as const),
  )("builds what Rails rendered: %s", (_, fixture) => {
    const { component, props } = fixture.exchanges.at(-1)!.response.inertia!;
    expect(component).toBe(REFUND_REQUEST_COMPONENT);

    const recordedOwn = Object.fromEntries(OWN_KEYS.map((key) => [key, props[key]]));
    expect(JSON.stringify(build(fixture)())).toBe(JSON.stringify(recordedOwn));
  });

  it("hands back the purchase of a subscription, whose price carries a recurrence the port does not format", () => {
    const fixture = pages.find((candidate) => candidate.example.includes("subscription"))!;
    expect(fixture.exchanges.at(-1)!.response.inertia!.props.formatted_price).toBe("$15 a month");
    expect(build(fixture)).toThrow(NotPortedError);
  });

  it("answers 404 for a seller without the buyer_refund_requests flag", () => {
    expect(recorded.filter(({ exchanges }) => exchanges.at(-1)!.response.status === 404)).toHaveLength(1);
  });

  describe("PurchaseRefundRequest rules", () => {
    const friday = new Date("2026-11-06T12:00:00Z");

    it("gives a deadline two weekdays on, to the end of the day", () => {
      expect(escalationDeadlineFrom(friday).toISOString()).toBe("2026-11-10T23:59:59.999Z");
      expect(formatDeadline(escalationDeadlineFrom(friday))).toBe("Tuesday, November 10");
      expect(formatDeadline(new Date("2026-10-09T08:00:00Z"))).toBe("Friday, October 9");
    });

    it("reads a purchase that is refunded, then disputed, as ineligible in that order", () => {
      const purchase = {
        purchase_state: "successful",
        price_cents: 100,
        stripe_refunded: true,
        chargeback_date: new Date(),
      } as Purchase;
      expect(ineligibility(purchase, 30, friday)).toBe("refunded");
      expect(ineligibility({ ...purchase, stripe_refunded: false }, 30, friday)).toBe("disputed");
    });
  });
});
