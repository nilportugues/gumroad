// CreatorAnalytics::Web (app/services/creator_analytics/web.rb): views and sales per product, merged into
// the shapes the analytics charts read (by date, by state, by referral).
import type { User } from "@prisma/client";

import { dateMonthDomain, formattedDateWithTimezone, hourKeyOf, hourMonthDomain, type DateAndMonth } from "../../search/d3.ts";
import { civilDateInZone, dayStartIso, formattedDate, timezoneId } from "../../search/civil-time.ts";
import { CreatorAnalyticsSales } from "../../search/creator-analytics-sales.ts";
import { CreatorAnalyticsProductPageViews } from "../../search/product-page-views.ts";
import ANALYTICS_DATA from "./analytics-data.generated.json" with { type: "json" };
import { firstSaleCreatedAtForAnalytics, productsForCreatorAnalytics, type AnalyticsProduct } from "./seller-analytics.ts";

// config/initializers/004_constants.rb
const REFERRER_DOMAIN_FOR_GUMROAD_RECOMMENDED_PRODUCTS = "recommended_by_gumroad";
const COMMON_REFERRERS_NAMES: Record<string, string> = {
  "dribbble.com": "Dribbble",
  "facebook.com": "Facebook",
  "google.com": "Google",
  "gumroad.com": "Gumroad",
  "pinterest.com": "Pinterest",
  "reddit.com": "Reddit",
  "shutterstock.com": "Shutterstock",
  "tumblr.com": "Tumblr",
  "api.twitter.com": "Twitter",
  "t.co": "Twitter",
  "twitter.com": "Twitter",
  "youtube.com": "Youtube",
};
const STATES_SUPPORTED_BY_ANALYTICS: string[] = ANALYTICS_DATA.state_codes;
const STATE_OTHER = "other";
const USA = "United States";

export type AnalyticsSeller = Pick<User, "id" | "timezone" | "created_at">;
export type Series = Record<string, number[]>;
export type ByDate = {
  dates_and_months: DateAndMonth[];
  start_date: string;
  end_date: string;
  first_sale_date?: string;
  by_date: { views: Series; sales: Series; totals: Series };
};
export type LocationValue = number | number[];
export type ByState = { by_state: { views: Record<string, Record<string, LocationValue>>; sales: Record<string, Record<string, LocationValue>>; totals: Record<string, Record<string, LocationValue>> } };
export type ByReferral = {
  dates_and_months: DateAndMonth[];
  start_date: string;
  end_date: string;
  first_sale_date?: string;
  by_referral: { views: Record<string, Series>; sales: Record<string, Series>; totals: Record<string, Series> };
};

const TYPES = ["views", "sales", "totals"] as const;
const key = (...parts: unknown[]) => JSON.stringify(parts);

function referrerDomainToName(domain: string | null | undefined): string {
  if (domain === null || domain === undefined || !/[^\s]/u.test(domain)) return "direct";
  if (domain === REFERRER_DOMAIN_FOR_GUMROAD_RECOMMENDED_PRODUCTS) return "Recommended by Gumroad";
  return Object.hasOwn(COMMON_REFERRERS_NAMES, domain) ? COMMON_REFERRERS_NAMES[domain]! : domain;
}

// A nil hash key reaches the JSON as "".
const locationKey = (country: string | null) => country ?? "";

export class CreatorAnalyticsWeb {
  private readonly user: AnalyticsSeller;
  private readonly dates: string[];
  private readonly interval: string;
  private preloaded: AnalyticsProduct[] | null;
  private hourly: Map<string, number> | null = null;

  // `dates`: civil dates, first to last. `products`: the caller's preloaded collection, shared across instances.
  constructor(user: AnalyticsSeller, dates: string[], products: AnalyticsProduct[] | null = null, interval: string = "day") {
    this.user = user;
    this.dates = dates;
    this.preloaded = products;
    this.interval = interval;
  }

  async byDate(): Promise<ByDate> {
    const products = await this.products();
    const views = await this.pageViews(products).byProductAndDate();
    const sales = new Map((await this.sales(products).byProductAndDate()).map((entry) => [key(...entry.key), entry.value]));
    const result = { ...(await this.resultMetadata()), by_date: { views: {}, sales: {}, totals: {} } } as ByDate;
    const dates = this.datesStrings();
    for (const type of TYPES) {
      for (const product of products) {
        result.by_date[type][product.unique_permalink!] = dates.map((date) => {
          const entry = sales.get(key(Number(product.id), date));
          if (type === "views") return views.get(key(Number(product.id), date)) ?? 0;
          return (type === "sales" ? entry?.count : entry?.total) ?? 0;
        });
      }
    }
    return result;
  }

  async byState(): Promise<ByState> {
    const products = await this.products();
    const permalinks = this.permalinks(products);
    const views = await this.pageViews(products).byProductAndCountryAndState();
    const sales = await this.sales(products).byProductAndCountryAndState();
    const result: ByState = { by_state: { views: {}, sales: {}, totals: {} } };
    for (const type of TYPES) {
      for (const permalink of permalinks.values()) result.by_state[type][permalink] = { [USA]: new Array<number>(STATES_SUPPORTED_BY_ANALYTICS.length).fill(0) };
    }
    const add = (type: (typeof TYPES)[number], permalink: string, country: string | null, state: string | null, count: number) => {
      const locations = result.by_state[type][permalink]!;
      if (country === USA) {
        let index = state === null ? -1 : STATES_SUPPORTED_BY_ANALYTICS.indexOf(state);
        if (index < 0) index = STATES_SUPPORTED_BY_ANALYTICS.indexOf(STATE_OTHER);
        (locations[USA] as number[])[index]! += count;
      } else {
        locations[locationKey(country)] = ((locations[locationKey(country)] as number | undefined) ?? 0) + count;
      }
    };
    for (const { key: [productId, country, state], count } of views) add("views", permalinks.get(productId)!, country, state, count);
    for (const { key: [productId, country, state], value } of sales) {
      add("sales", permalinks.get(productId)!, country, state, value.count);
      add("totals", permalinks.get(productId)!, country, state, value.total);
    }
    return result;
  }

  async byReferral(): Promise<ByReferral> {
    const products = await this.products();
    const permalinks = this.permalinks(products);
    const views = await this.pageViews(products).byProductAndReferrerAndDate();
    const sales = await this.sales(products).byProductAndReferrerAndDate();
    const result = { ...(await this.resultMetadata()), by_referral: { views: {}, sales: {}, totals: {} } } as ByReferral;
    const dates = this.datesStrings();
    const bump = (type: (typeof TYPES)[number], permalink: string, referrer: string, date: string, amount: number) => {
      const index = dates.indexOf(date);
      // `array[nil] += n` is a TypeError in Ruby.
      if (index < 0) throw new TypeError("no implicit conversion from nil to integer");
      const referrers = (result.by_referral[type][permalink] ??= {});
      (referrers[referrer] ??= new Array<number>(dates.length).fill(0))[index]! += amount;
    };
    for (const [encoded, count] of views) {
      const [productId, referrer, date] = JSON.parse(encoded) as [number, string, string];
      bump("views", permalinks.get(productId)!, referrerDomainToName(referrer), date, count);
    }
    for (const { key: [productId, referrer, date], value } of sales) {
      const permalink = permalinks.get(productId)!;
      const name = referrerDomainToName(referrer);
      bump("sales", permalink, name, date, value.count);
      bump("totals", permalink, name, date, value.total);
    }
    return result;
  }

  private async resultMetadata() {
    const iana = timezoneId(this.user.timezone);
    // "Today" is the seller's calendar day: the frontend keys the projected end-of-day overlay off the "Today" label.
    const today = civilDateInZone(Date.now(), iana);
    const dates = this.dateMonths(iana);
    const metadata: { dates_and_months: DateAndMonth[]; start_date: string; end_date: string; first_sale_date?: string } = {
      dates_and_months: dates,
      start_date: formattedDate(this.dates[0]!, today),
      end_date: formattedDate(this.dates.at(-1)!, today),
    };
    const firstSale = await firstSaleCreatedAtForAnalytics(BigInt(this.user.id));
    if (firstSale) metadata.first_sale_date = formattedDateWithTimezone(firstSale, iana);
    return metadata;
  }

  private dateMonths(iana: string): DateAndMonth[] {
    return this.interval === "hour" ? hourMonthDomain([...this.hourlyBuckets().values()], iana) : dateMonthDomain(this.dates);
  }

  private async products(): Promise<AnalyticsProduct[]> {
    this.preloaded ??= await productsForCreatorAnalytics(BigInt(this.user.id));
    return this.preloaded;
  }

  private permalinks(products: AnalyticsProduct[]): Map<number, string> {
    return new Map(products.map((product) => [Number(product.id), product.unique_permalink!]));
  }

  private pageViews(products: AnalyticsProduct[]) {
    return new CreatorAnalyticsProductPageViews(this.user, products, this.dates, this.interval);
  }

  private sales(products: AnalyticsProduct[]) {
    return new CreatorAnalyticsSales(this.user, this.dates, products, this.interval);
  }

  // The bucket keys the analytics services return for this interval, in order.
  private datesStrings(): string[] {
    return this.interval === "hour" ? [...this.hourlyBuckets().keys()] : this.dates;
  }

  // Every wall-clock hour of the requested dates in the seller's zone, as { key => first instant of that hour }.
  // Walking instants keeps DST straight: a spring-forward day has 23 keys, and the repeated hour of a fall-back
  // day keeps one key (the services merge its two buckets).
  private hourlyBuckets(): Map<string, number> {
    if (this.hourly) return this.hourly;
    const iana = timezoneId(this.user.timezone);
    const buckets = new Map<string, number>();
    const end = Date.parse(dayStartIso(this.addDay(this.dates.at(-1)!), iana));
    for (let time = Date.parse(dayStartIso(this.dates[0]!, iana)); time < end; time += 3_600_000) {
      const label = hourKeyOf(time, iana);
      if (!buckets.has(label)) buckets.set(label, time);
    }
    this.hourly = buckets;
    return buckets;
  }

  private addDay(date: string): string {
    const next = new Date(Date.parse(date) + 86_400_000);
    return next.toISOString().slice(0, 10);
  }
}
