// Port of app/sidekiq/utm_link_sale_attribution_job.rb: the visits that led an order's purchases, newest visit per UTM link within
// seven days of the purchase, each claiming the purchases of its seller (of its product, for a product page link); then the
// visit's country (from the first purchase that claimed it) and the `utm_link_driven_sales` row, one purchase at a time.
// Golden: __fixtures__/utm-link-sale-attribution-job.golden.json (scripts/golden/utm-link-sale-attribution-job.rb).
import { Prisma, type Purchase, type UtmLink, type UtmLinkDrivenSale, type UtmLinkVisit } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { alpha2ByName } from "../../server/models/compliance-countries.ts";
import { setAssociation } from "../../server/models/concerns/rails-validations.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { quote } from "../../server/models/runtime/quoting.ts";
import type { ModelRecord } from "../../server/models/runtime/record.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { castRow, column, columnIn, selectRows, table } from "../../server/models/sql.ts";
import { NoMethodError } from "../../server/models/user.ts";
import { UtmLinkDrivenSales } from "../../server/models/utm-link-driven-sale.ts";
import { UtmLinkVisits } from "../../server/models/utm-link-visit.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

const UTM_LINK_VISITS = "utm_link_visits";
const UTM_LINK_DRIVEN_SALES = "utm_link_driven_sales";
// ATTRIBUTION_WINDOW
const ATTRIBUTION_WINDOW = { days: 7 };
const ONE_SECOND_MS = 1000;

type VisitRow = UtmLinkVisit & { utm_link: UtmLink };

// `time.utc.strftime("%Y-%m-%d %H:%M:%S")`
const strftime = (time: Date) => time.toISOString().slice(0, 19).replace("T", " ");

function beginningOfDay(time: Date): Date {
  return new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));
}

// UtmLinkVisit.includes(:utm_link): the visits, then their links in one query (none when there are no visits).
async function latestVisitsUntil(browserGuid: string, purchasedAt: Date, now: Date): Promise<VisitRow[]> {
  const visitsBefore = new Date(purchasedAt.getTime() + ONE_SECOND_MS);
  const windowStart = beginningOfDay(ago(ATTRIBUTION_WINDOW, now));
  const guid = Prisma.raw(quote(browserGuid));
  const latestVisits = Prisma.sql`SELECT utm_link_id, MAX(created_at) AS latest_visit_at FROM utm_link_visits WHERE browser_guid = ${guid} AND created_at >= '${Prisma.raw(strftime(windowStart))}' AND created_at < '${Prisma.raw(strftime(visitsBefore))}' GROUP BY utm_link_id`;
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`utm_link_visits`.*")} FROM ${table(UTM_LINK_VISITS)} INNER JOIN (${latestVisits}) AS latest_visits ON utm_link_visits.utm_link_id = latest_visits.utm_link_id AND utm_link_visits.created_at = latest_visits.latest_visit_at WHERE ${column(UTM_LINK_VISITS, "browser_guid")} = ${browserGuid} AND (utm_link_visits.created_at >= ${windowStart}) AND (utm_link_visits.created_at < ${visitsBefore}) ORDER BY ${column(UTM_LINK_VISITS, "created_at")} DESC, ${column(UTM_LINK_VISITS, "id")} DESC`,
  );
  const visits = rows.map((row) => castRow<UtmLinkVisit>("UtmLinkVisit", row));
  if (visits.length === 0) return [];
  const linkIds = [...new Set(visits.map((visit) => visit.utm_link_id))];
  const links = new Map(
    (
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`utm_links`.*")} FROM ${table("utm_links")} WHERE ${columnIn("utm_links", "id", linkIds)}`,
      )
    ).map((row) => {
      const link = castRow<UtmLink>("UtmLink", row);
      return [link.id, link] as const;
    }),
  );
  return visits.map((visit) => ({ ...visit, utm_link: links.get(visit.utm_link_id) as UtmLink }));
}

type Attribution = { visit: VisitRow; purchase: Purchase };

async function attributions(orderId: bigint, browserGuid: string, now: Date): Promise<Attribution[]> {
  await findByIdBang("Order", orderId);
  const purchases = (
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} INNER JOIN ${table("order_purchases")} ON ${column("purchases", "id")} = ${column("order_purchases", "purchase_id")} WHERE ${column("order_purchases", "order_id")} = ${orderId} AND ${column("purchases", "purchase_state")} = 'successful'`,
    )
  ).map((row) => castRow<Purchase>("Purchase", row));

  // `group_by(&:created_at)`: purchases in one order can land in different seconds, each with its own visit cutoff.
  const byTime = new Map<number, { purchasedAt: Date; purchases: Purchase[] }>();
  for (const purchase of purchases) {
    const createdAt = purchase.created_at as Date;
    const group = byTime.get(createdAt.getTime()) ?? { purchasedAt: createdAt, purchases: [] as Purchase[] };
    group.purchases.push(purchase);
    byTime.set(createdAt.getTime(), group);
  }

  const claimed = new Map<bigint, Attribution>();
  for (const { purchasedAt, purchases: group } of byTime.values()) {
    const bySeller = new Map<string, Purchase[]>();
    for (const purchase of group) {
      const key = String(purchase.seller_id);
      bySeller.set(key, [...(bySeller.get(key) ?? []), purchase]);
    }
    for (const visit of await latestVisitsUntil(browserGuid, purchasedAt, now)) {
      const utmLink = visit.utm_link;
      if (utmLink === undefined) throw new NoMethodError("undefined method 'seller_id' for nil");
      let qualified = bySeller.get(String(utmLink.seller_id));
      if (qualified === undefined || qualified.length === 0) continue;
      // A copy: the seller's list is shared by every visit.
      if (utmLink.target_resource_type === "product_page") {
        qualified = qualified.filter((purchase) => purchase.link_id === utmLink.target_resource_id);
      }
      for (const purchase of qualified) if (!claimed.has(purchase.id)) claimed.set(purchase.id, { visit, purchase });
    }
  }
  return [...claimed.values()];
}

// One instance per loaded visit, so the purchases it claims see the country the first of them set.
const visitRecords = new WeakMap<VisitRow, ModelRecord<UtmLinkVisit>>();

function visitRecordOf(visit: VisitRow): ModelRecord<UtmLinkVisit> {
  let visitRecord = visitRecords.get(visit);
  if (visitRecord === undefined) {
    const { utm_link: utmLink, ...attributes } = visit;
    visitRecord = UtmLinkVisits.load(attributes);
    setAssociation(visitRecord, "utm_link", visit.utm_link_id, utmLink);
    visitRecords.set(visit, visitRecord);
  }
  return visitRecord;
}

async function record({ visit, purchase }: Attribution, deps: JobDeps): Promise<void> {
  const options = { now: deps.now };
  const utmLink = visit.utm_link;
  const visitRecord = visitRecordOf(visit);
  if (isBlank(visitRecord.get("country_code")) && !isBlank(purchase.country)) {
    await UtmLinkVisits.updateBang(visitRecord, { country_code: alpha2ByName(purchase.country) }, options);
  }

  // `utm_link.utm_link_driven_sales.where(utm_link_visit: visit, purchase:).first_or_create!`
  const [existing] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`utm_link_driven_sales`.*")} FROM ${table(UTM_LINK_DRIVEN_SALES)} WHERE ${column(UTM_LINK_DRIVEN_SALES, "utm_link_id")} = ${utmLink.id} AND ${column(UTM_LINK_DRIVEN_SALES, "utm_link_visit_id")} = ${visit.id} AND ${column(UTM_LINK_DRIVEN_SALES, "purchase_id")} = ${purchase.id} ORDER BY ${column(UTM_LINK_DRIVEN_SALES, "id")} ASC LIMIT 1`,
  );
  if (existing !== undefined) return;
  const sale = UtmLinkDrivenSales.build({
    utm_link_id: utmLink.id,
    utm_link_visit_id: visit.id,
    purchase_id: purchase.id,
  } as Partial<UtmLinkDrivenSale>);
  setAssociation(sale, "utm_link", utmLink.id, utmLink);
  await UtmLinkDrivenSales.saveBang(sale, options);
}

export const utmLinkSaleAttributionJobWith = modelJob({ min: 2, max: 2 }, async ([orderId, browserGuid], deps) => {
  const id = await beforeSideEffects(() => recordIdFrom(orderId, "Order.find"));
  // `quote_string` of anything else is a Ruby error Node does not reproduce.
  if (typeof browserGuid !== "string") throw new HandBackToRuby("a browser_guid that is not a String");
  for (const attribution of await attributions(id, browserGuid, deps.now())) await record(attribution, deps);
});

export const utmLinkSaleAttributionJob = utmLinkSaleAttributionJobWith();
