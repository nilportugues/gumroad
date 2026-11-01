// CreatorAnalytics::Following (app/services/creator_analytics/following.rb), the follower chart behind
// the Audience page, and the ConfirmedFollowerEvent search of CreatorHomePresenter's activity feed.
// Proven by following.golden.json.
import { indexName } from "../infra/elasticsearch.ts";
import { search } from "./api.ts";
import { addDays, civilDateInZone, dateDomain, dayStartIso, formattedDate, timezoneId, TimeZoneNotPortedError } from "./civil-time.ts";
import type { JsonValue } from "./es-json.ts";

const ADDED = "added";
const REMOVED = "removed";
const ADDED_AND_REMOVED = [ADDED, REMOVED] as const;

export type FollowingUser = { id: number | bigint; timezone: string | null };
export type FollowingDeps = { now: () => Date };

type Aggregations = Record<string, { count?: { value?: number | null } } | undefined>;

const response = async (body: JsonValue) => (await search({ index: indexName("ConfirmedFollowerEvent"), body })).body as {
  hits?: { hits?: Array<{ _source: Record<string, unknown> }> };
  aggregations?: Record<string, unknown>;
};

const userId = (user: FollowingUser): number => Number(user.id);

// ADDED_AND_REMOVED.index_with { { filter: { term: { name: } }, aggs: { count: { value_count: { field: "name" } } } } }
function namesAggs(): JsonValue {
  return Object.fromEntries(ADDED_AND_REMOVED.map((name) => [name, { filter: { term: { name } }, aggs: { count: { value_count: { field: "name" } } } }]));
}

const countOf = (aggregations: Aggregations, name: string): number => aggregations[name]?.count?.value ?? 0;

// CreatorAnalytics::Following#net_total
export async function netTotal(user: FollowingUser, beforeDate: string | null = null): Promise<number> {
  const iana = timezoneId(user.timezone);
  const must = beforeDate === null ? null : [{ range: { timestamp: { lt: dayStartIso(beforeDate, iana) } } }];
  const body = { query: { bool: { filter: [{ term: { followed_user_id: userId(user) } }], must } }, aggs: namesAggs(), size: 0 };
  const aggregations = (await response(body)).aggregations as Aggregations;
  return countOf(aggregations, ADDED) - countOf(aggregations, REMOVED);
}

// CreatorAnalytics::Following#first_follower_date: a civil date, or null without followers.
export async function firstFollowerDate(user: FollowingUser): Promise<string | null> {
  const iana = timezoneId(user.timezone);
  const body = {
    query: { bool: { filter: [{ term: { followed_user_id: userId(user) } }] } },
    sort: [{ timestamp: { order: "asc" } }],
    _source: ["timestamp"],
    size: 1,
  };
  const first = (await response(body)).hits?.hits?.[0];
  if (!first) return null;
  const timestamp = String(first._source.timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)) throw new TimeZoneNotPortedError(`Time.parse of ${JSON.stringify(timestamp)}`);
  return civilDateInZone(Date.parse(timestamp), iana);
}

type Counts = { new_followers: number[]; followers_removed: number[]; totals: number[] };

async function counts(user: FollowingUser, dates: string[]): Promise<Counts> {
  const iana = timezoneId(user.timezone);
  const startDate = dates[0]!;
  const endDate = dates[dates.length - 1]!;
  const body = {
    query: {
      bool: {
        filter: [{ term: { followed_user_id: userId(user) } }],
        must: [{ range: { timestamp: { gte: dayStartIso(startDate, iana), lt: dayStartIso(addDays(endDate, 1), iana) } } }],
      },
    },
    aggs: { dates: { date_histogram: { time_zone: iana, field: "timestamp", calendar_interval: "day" }, aggs: namesAggs() } },
    size: 0,
  };
  const histogram = ((await response(body)).aggregations as { dates: { buckets: Array<Record<string, unknown>> } }).dates.buckets;
  const byDate = new Map<string, Aggregations>();
  for (const bucket of histogram) byDate.set(String(bucket.key_as_string).slice(0, 10), bucket as Aggregations);

  const netTotalBeforeStart = await netTotal(user, startDate);
  const result: Counts = { new_followers: [], followers_removed: [], totals: [] };
  for (const date of dates) {
    const bucket = byDate.get(date);
    result.new_followers.push(bucket ? countOf(bucket, ADDED) : 0);
    result.followers_removed.push(bucket ? countOf(bucket, REMOVED) : 0);
    result.totals.push((result.totals.at(-1) ?? netTotalBeforeStart) + result.new_followers.at(-1)! - result.followers_removed.at(-1)!);
  }
  return result;
}

export type FollowingByDate = {
  dates: string[];
  start_date: string;
  end_date: string;
  by_date: Counts;
  first_follower_date: string | null;
  new_followers: number;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

// CreatorAnalytics::Following#by_date; `startDate` and `endDate` are civil dates with startDate <= endDate.
export async function followingByDate(user: FollowingUser, startDate: string, endDate: string, deps: FollowingDeps = { now: () => new Date() }): Promise<FollowingByDate> {
  if (endDate < startDate) throw new TimeZoneNotPortedError("by_date for an end date before the start date");
  const iana = timezoneId(user.timezone);
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
  const today = civilDateInZone(deps.now().getTime(), iana);
  const storedFirstFollowerDate = await firstFollowerDate(user);
  const countsData: Counts = storedFirstFollowerDate
    ? await counts(user, dates)
    : { new_followers: dates.map(() => 0), followers_removed: dates.map(() => 0), totals: dates.map(() => 0) };

  return {
    dates: dateDomain(dates),
    start_date: formattedDate(startDate, today),
    end_date: formattedDate(endDate, today),
    by_date: countsData,
    first_follower_date: storedFirstFollowerDate ? formattedDate(storedFirstFollowerDate, today) : null,
    new_followers: sum(countsData.new_followers) - sum(countsData.followers_removed),
  };
}

export const ACTIVITY_ITEMS_LIMIT = 10;

// CreatorHomePresenter#followers_activity_items' search: the latest events' _source, newest first.
export async function followerEventSources(sellerId: number | bigint): Promise<Array<Record<string, unknown>>> {
  const body = {
    query: { bool: { filter: [{ term: { followed_user_id: Number(sellerId) } }] } },
    sort: [{ timestamp: { order: "desc" } }],
    size: ACTIVITY_ITEMS_LIMIT,
    _source: ["name", "email", "timestamp", "follower_user_id"],
  };
  return ((await response(body)).hits?.hits ?? []).map((hit) => hit._source);
}
