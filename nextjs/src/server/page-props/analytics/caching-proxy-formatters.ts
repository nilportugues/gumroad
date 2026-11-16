// CreatorAnalytics::CachingProxy::Formatters::{Helpers,ByDate,ByState,ByReferral}: merge the per-day
// results (cached or computed) of CreatorAnalyticsWeb into one answer. Pure functions: no queries.
/* eslint-disable @typescript-eslint/no-explicit-any -- the days are JSON documents read back from the cache */
import { dateMonthDomain } from "../../search/d3.ts";
import { formattedDate } from "../../search/civil-time.ts";

type Day = Record<string, any>;
const TYPES = ["views", "sales", "totals"] as const;

// `rebuild_month_index_values!`: cached and fresh days do not share a month_index sequence.
function rebuildMonthIndexValues(datesAndMonths: Day[]): void {
  let lastMonth: unknown = null;
  let monthIndex = -1;
  for (const element of datesAndMonths) {
    if (element.month !== lastMonth) {
      lastMonth = element.month;
      monthIndex += 1;
    }
    element.month_index = monthIndex;
  }
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

// `merge_data_by_date`: the days are consecutive and sorted.
export function mergeDataByDate(daysData: Day[]): Day {
  const data: Day = {
    dates_and_months: [],
    start_date: daysData[0]!.start_date,
    end_date: daysData.at(-1)!.end_date,
    by_date: { views: {}, sales: {}, totals: {} },
  };
  for (const day of daysData) {
    if (!("first_sale_date" in data) && day.first_sale_date) data.first_sale_date = day.first_sale_date;
    data.dates_and_months.push(...day.dates_and_months);
  }
  rebuildMonthIndexValues(data.dates_and_months);

  // Some products may not have existed in previous days' data.
  const permalinks = unique(daysData.flatMap((day) => Object.keys(day.by_date.views)));
  for (const permalink of permalinks) {
    for (const day of daysData) {
      for (const type of TYPES) {
        const series: number[] = (data.by_date[type][permalink] ??= []);
        if (Object.hasOwn(day.by_date[type], permalink)) series.push(...day.by_date[type][permalink]);
        else series.push(...new Array<number>(day.dates_and_months.length).fill(0));
      }
    }
  }
  return data;
}

// `merge_data_by_state`
export function mergeDataByState(daysData: Day[]): Day {
  const data: Day = { by_state: { views: {}, sales: {}, totals: {} } };
  const permalinks = unique(daysData.flatMap((day) => Object.values<Day>(day.by_state).flatMap((byPermalink) => Object.keys(byPermalink))));
  for (const permalink of permalinks) {
    for (const day of daysData) {
      for (const type of TYPES) {
        const locations: Day = (data.by_state[type][permalink] ??= {});
        for (const [country, value] of Object.entries<any>(day.by_state[type][permalink] ?? {})) {
          if (Array.isArray(value)) {
            if (Object.hasOwn(locations, country)) value.forEach((element, index) => (locations[country][index] += element));
            else locations[country] = [...value];
          } else {
            locations[country] = (locations[country] ?? 0) + value;
          }
        }
      }
    }
  }
  return data;
}

// `merge_data_by_referral`: `today` is the seller's calendar day, so the labels match their day buckets.
export function mergeDataByReferral(daysData: Day[], dates: string[], today: string, firstSaleDate: string | null): Day {
  const data: Day = { by_referral: { views: {}, sales: {}, totals: {} } };
  const permalinks = unique(daysData.flatMap((day) => Object.values<Day>(day.by_referral).flatMap((byPermalink) => Object.keys(byPermalink))));
  for (const type of TYPES) for (const permalink of permalinks) data.by_referral[type][permalink] = {};

  let totalDayIndex = 0;
  for (const day of daysData) {
    const daysCount: number = day.dates_and_months.length;
    for (const type of TYPES) {
      for (const [permalink, referrers] of Object.entries<any>(day.by_referral[type] ?? {})) {
        for (const [referrer, values] of Object.entries<any>(referrers ?? {})) {
          const series: number[] = (data.by_referral[type][permalink][referrer] ??= new Array<number>(dates.length).fill(0));
          // `series[total_day_index, days_count] = values`
          if (values) series.splice(totalDayIndex, daysCount, ...values);
        }
      }
    }
    totalDayIndex += daysCount;
  }

  data.dates_and_months = dateMonthDomain(dates);
  data.start_date = formattedDate(dates[0]!, today);
  data.end_date = formattedDate(dates.at(-1)!, today);
  if (firstSaleDate !== null) data.first_sale_date = firstSaleDate;
  return data;
}
