// Port of app/sidekiq/record_utm_link_visit_job.rb up to the write: the seller and user lookups and the UtmLink lookup of
// UtmLinkVisitRecorder#record run in Node, and a visit to a link the seller paused ends there. A visit that would create the link or
// record the visit goes back to Rails whole: both write under PaperTrail's request metadata, and GeoIp, the link's validations and
// UpdateUtmLinkStatsJob's enqueue come with them. A visit whose shape Node does not reproduce goes back before any statement.
// Golden: __fixtures__/record-utm-link-visit-job.golden.json (scripts/golden/record-utm-link-visit-job.rb).
import { Prisma, type User, type UtmLink } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { findOneBy } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { TARGET_RESOURCE_TYPES } from "../../server/models/utm-link.ts";

import { modelJob } from "./support/job-deps.ts";

const UTM_LINKS = "utm_links";
const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
const INTEGER_TEXT = /^[0-9]{1,15}$/u;

type Visit = Record<string, unknown>;

const isObject = (value: unknown): value is Visit =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// An id as `find_by(id:)` / `where(target_resource_id:)` take it: an Integer or the digits of one.
function idFrom(value: unknown, what: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && INTEGER_TEXT.test(value)) return BigInt(value);
  throw new HandBackToRuby(`${what} is not an Integer`);
}

function utmParamsFrom(value: unknown): [string, string | null][] {
  if (!isObject(value)) throw new HandBackToRuby("utm_params is not a Hash");
  return Object.entries(value).map(([key, param]) => {
    if (!UTM_PARAMS.includes(key)) throw new HandBackToRuby(`utm_params has the key ${key}`);
    if (param !== null && typeof param !== "string") throw new HandBackToRuby(`${key} is not a String`);
    return [key, param];
  });
}

export const recordUtmLinkVisitJobWith = modelJob({ min: 1, max: 1 }, async ([visit]) => {
  if (!isObject(visit)) throw new HandBackToRuby("the visit is not a Hash");
  const sellerKey = visit.seller_id === null ? null : idFrom(visit.seller_id, "seller_id");
  const userKey =
    visit.user_id === null || visit.user_id === undefined || visit.user_id === false
      ? null
      : idFrom(visit.user_id, "user_id");
  const params = utmParamsFrom(visit.utm_params);
  const targetType = visit.target_resource_type;
  if (typeof targetType !== "string" || !(TARGET_RESOURCE_TYPES as readonly string[]).includes(targetType))
    throw new HandBackToRuby("target_resource_type is not a page type");
  const targetId = visit.target_resource_id === null ? null : idFrom(visit.target_resource_id, "target_resource_id");
  if (!isObject(visit.paper_trail)) throw new HandBackToRuby("paper_trail is not a Hash");
  if (typeof visit.visited_at_us !== "number" || !Number.isSafeInteger(visit.visited_at_us))
    throw new HandBackToRuby("visited_at_us is not an Integer");

  const seller = await findOneBy<User>("User", "id", sellerKey, true);
  if (seller === null) return;
  if (userKey !== null) await findOneBy<User>("User", "id", userKey);

  // UtmLink.alive.where(utm_params.merge(target_resource_type:, target_resource_id:)).order(:id).first_or_initialize; the seller is
  // not part of the lookup.
  const conditions = [
    ...params.map(([key, param]) =>
      param === null ? Prisma.sql`${column(UTM_LINKS, key)} IS NULL` : Prisma.sql`${column(UTM_LINKS, key)} = ${param}`,
    ),
    Prisma.sql`${column(UTM_LINKS, "target_resource_type")} = ${targetType}`,
    targetId === null
      ? Prisma.sql`${column(UTM_LINKS, "target_resource_id")} IS NULL`
      : Prisma.sql`${column(UTM_LINKS, "target_resource_id")} = ${targetId}`,
  ];
  const [row] = await selectRows(
    Prisma.sql`SELECT ${table(UTM_LINKS)}.* FROM ${table(UTM_LINKS)} WHERE ${column(UTM_LINKS, "deleted_at")} IS NULL AND ${Prisma.join(conditions, " AND ")} ORDER BY ${column(UTM_LINKS, "id")} ASC LIMIT 1`,
  );
  // A paused link is the seller's choice to stop tracking these parameters; anything else records the visit.
  if (row !== undefined && castRow<UtmLink>("UtmLink", row).disabled_at !== null) return;
  throw new HandBackToRuby(row === undefined ? "a visit that creates its link" : "a visit to record");
});
export const recordUtmLinkVisitJob = recordUtmLinkVisitJobWith();
