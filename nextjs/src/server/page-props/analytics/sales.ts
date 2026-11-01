// AnalyticsPresenter#page_props: the products, time zone and constants behind /dashboard/sales.
import type { User } from "@prisma/client";

import ANALYTICS_DATA from "./analytics-data.generated.json" with { type: "json" };
import { civilDateInZone, timezoneId } from "../../search/civil-time.ts";
import { externalId } from "../audience/support.ts";
import { expectedFractionOfDay } from "./hourly-sales-curve.ts";
import { productsForCreatorAnalytics } from "./seller-analytics.ts";

type Seller = Pick<User, "id" | "timezone" | "created_at">;

export async function analyticsPageProps(seller: Seller, now: Date = new Date()) {
  const products = await productsForCreatorAnalytics(BigInt(seller.id));
  const createdOn = civilDateInZone(seller.created_at!.getTime(), timezoneId(seller.timezone));
  const trackingStarted = ANALYTICS_DATA.product_event_tracking_started_date;
  return {
    products: products.map((product) => ({ id: externalId(product.id), alive: product.deleted_at === null, unique_permalink: product.unique_permalink, name: product.name })),
    seller_time_zone: timezoneId(seller.timezone),
    earliest_date: createdOn > trackingStarted ? createdOn : trackingStarted,
    expected_sales_fraction_of_day: await expectedFractionOfDay(seller, now),
    country_codes: ANALYTICS_DATA.country_codes,
    state_names: ANALYTICS_DATA.state_names,
  };
}
