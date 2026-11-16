// Port of app/sidekiq/compile_gumroad_daily_analytics_job.rb, GumroadDailyAnalytic.import and GumroadDailyAnalyticsCompiler: for each of
// the last 45 days and today, the day's paid sales, fees, discover sales and number of selling creators are summed and stored in the
// `gumroad_daily_analytics` row that ends the day. Golden: __fixtures__/compile-gumroad-daily-analytics-job.golden.json
// (scripts/golden/compile-gumroad-daily-analytics-job.rb).
//
// `Date.today` is the server's local date and `date.all_day` runs in Time.zone; Rails runs in UTC here (config.time_zone is unset and the
// workers' TZ is UTC), so both are UTC dates. purchases.created_at and service_charges.created_at are datetime(0): the day's bounds are cast to
// whole seconds before they are sent, as ActiveRecord does.
import { Prisma, type GumroadDailyAnalytic } from "@prisma/client";

import {
  addDays,
  beginningOfDay,
  endOfDay,
  toCalendarDate,
  type CalendarDate,
} from "../../server/models/concerns/ruby-time.ts";
import { GUMROAD_DAILY_ANALYTICS, GumroadDailyAnalytics } from "../../server/models/gumroad-daily-analytic.ts";
import { castRow, column, quoteName, selectRows, table } from "../../server/models/sql.ts";
import { PurchaseFlags } from "../../server/search/flags.ts";

import { modelJob } from "./support/job-deps.ts";

// REFRESH_PERIOD
const REFRESH_PERIOD_DAYS = 45;
// ActiveModel::Type::Integer's limit: 4 bytes
const INTEGER_LIMIT = 2 ** 31;
// where("purchases.price_cents >= ?", 100) is quoted as a string by the sanitizer.
const MIN_PRICE_CENTS_FOR_CREATOR_COUNT = "100";

const PURCHASES = "purchases";
const SERVICE_CHARGES = "service_charges";
const USERS = "users";

// A day's bounds as the datetime(0) columns receive them: whole seconds, the end truncated from .999999999.
const wholeSeconds = (time: Date) => new Date(Math.floor(time.getTime() / 1000) * 1000);

class RangeError extends Error {
  readonly rubyClass = "ActiveModel::RangeError";
  constructor(value: number) {
    super(`${value} is out of range for ActiveModel::Type::Integer with limit 4 bytes`);
    this.name = "RangeError";
  }
}

// An Integer attribute that does not fit its 4-byte column raises ActiveModel::RangeError when the row is written.
const assertFits = (value: number): void => {
  if (value >= INTEGER_LIMIT || value < -INTEGER_LIMIT) throw new RangeError(value);
};

// A SUM or COUNT as ActiveRecord returns it: an Integer, 0 for a SUM over no rows.
async function integerOf(sql: Prisma.Sql): Promise<number> {
  const [row] = await selectRows(sql);
  const value = row ? Object.values(row)[0] : null;
  return value === null || value === undefined ? 0 : Number(value);
}

const paidPurchases = (bounds: Prisma.Sql) =>
  Prisma.sql`${column(PURCHASES, "purchase_state")} = 'successful' AND (purchases.price_cents > 0) AND (stripe_refunded is null OR stripe_refunded = 0) AND ${column(PURCHASES, "created_at")} BETWEEN ${bounds}`;

async function importDay(day: CalendarDate, now: () => Date): Promise<void> {
  const periodEndedAt = endOfDay(day);
  const start = wholeSeconds(beginningOfDay(day));
  const end = wholeSeconds(periodEndedAt);
  const bounds = Prisma.sql`${start} AND ${end}`;

  const [existing] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(GUMROAD_DAILY_ANALYTICS)}.*`)} FROM ${table(GUMROAD_DAILY_ANALYTICS)} WHERE ${column(GUMROAD_DAILY_ANALYTICS, "period_ended_at")} = ${periodEndedAt} LIMIT 1`,
  );
  const analytic = existing
    ? GumroadDailyAnalytics.load(castRow<GumroadDailyAnalytic>("GumroadDailyAnalytic", existing))
    : GumroadDailyAnalytics.build({ period_ended_at: periodEndedAt } as Partial<GumroadDailyAnalytic>);

  // compile_gumroad_price_cents
  analytic.set(
    "gumroad_price_cents",
    await integerOf(
      Prisma.sql`SELECT SUM(${column(PURCHASES, "price_cents")}) FROM ${table(PURCHASES)} WHERE ${paidPurchases(bounds)}`,
    ),
  );
  // compile_gumroad_fee_cents: the purchases' fees plus the service charges
  const purchaseFees = await integerOf(
    Prisma.sql`SELECT SUM(${column(PURCHASES, "fee_cents")}) FROM ${table(PURCHASES)} WHERE ${paidPurchases(bounds)}`,
  );
  const serviceCharges = await integerOf(
    Prisma.sql`SELECT SUM(${column(SERVICE_CHARGES, "charge_cents")}) FROM ${table(SERVICE_CHARGES)} WHERE ${column(SERVICE_CHARGES, "state")} = 'successful' AND (service_charges.charge_processor_refunded = 0) AND ${column(SERVICE_CHARGES, "created_at")} BETWEEN ${bounds}`,
  );
  analytic.set("gumroad_fee_cents", purchaseFees + serviceCharges);
  // compile_creators_with_sales: User.not_suspended.joins(:sales).merge(paid).where("purchases.price_cents >= ?", 100)
  analytic.set(
    "creators_with_sales",
    await integerOf(
      Prisma.sql`SELECT COUNT(distinct users.id) FROM ${table(USERS)} INNER JOIN ${table(PURCHASES)} ON ${column(PURCHASES, "seller_id")} = ${column(USERS, "id")} WHERE (${column(USERS, "user_risk_state")} NOT IN ('suspended_for_fraud', 'suspended_for_tos_violation')) AND ${paidPurchases(bounds)} AND (purchases.price_cents >= ${MIN_PRICE_CENTS_FOR_CREATOR_COUNT})`,
    ),
  );
  // compile_gumroad_discover_price_cents
  analytic.set(
    "gumroad_discover_price_cents",
    await integerOf(
      Prisma.sql`SELECT SUM(${column(PURCHASES, "price_cents")}) FROM ${table(PURCHASES)} WHERE ${paidPurchases(bounds)} AND (${PurchaseFlags.condition("was_product_recommended")})`,
    ),
  );

  // ActiveRecord serializes the attributes when it writes the row: before the transaction opens, so nothing is sent.
  for (const name of [
    "gumroad_price_cents",
    "gumroad_fee_cents",
    "creators_with_sales",
    "gumroad_discover_price_cents",
  ] as const)
    assertFits(analytic.get(name));
  await GumroadDailyAnalytics.saveBang(analytic, { now });
}

export const compileGumroadDailyAnalyticsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const today = toCalendarDate(deps.now());
  for (let offset = REFRESH_PERIOD_DAYS; offset >= 0; offset--) await importDay(addDays(today, -offset), deps.now);
});

export const compileGumroadDailyAnalyticsJob = compileGumroadDailyAnalyticsJobWith();
