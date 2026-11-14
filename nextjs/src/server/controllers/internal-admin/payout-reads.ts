// Api::Internal::Admin::ScheduledPayoutsController#index, StrandedBuyersController#scan and PayoutsController#pause/#resume.
// A pause that needs the payout schedule (#index) and a scan that finds candidates (the declining-block lookups) go to Rails whole.
import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { rubyStrip } from "../../content-moderation/ruby.ts";
import { Comments, COMMENT_TYPES } from "../../models/comment.ts";
import { moneyFormatWithGemSymbol } from "../../models/concerns/money-formatter.ts";
import { recordSocialConnectHoldReleased } from "../../models/user-risk.ts";
import {
  findUserBang,
  isFlagSet,
  isPayoutsPaused,
  NotPortedError,
  payoutsPausedBy,
  setFlag,
  setJsonDataForAttr,
  Users,
} from "../../models/user.ts";
import { rubyToI } from "../../page-props/payouts/payouts.ts";

import {
  failure,
  halted,
  isBlank,
  jsonRendered,
  paramToS,
  recordAdminWrite,
  timeJson,
  type AdminRequest,
} from "./base.ts";
import { handBack } from "./hand-back.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForWrite } from "./user-writes.ts";
import { findUserForRead } from "./users.ts";

const SCHEDULED_SOURCE = "app/controllers/api/internal/admin/scheduled_payouts_controller.rb";
const STRANDED_SOURCE = "app/controllers/api/internal/admin/stranded_buyers_controller.rb";
const PAYOUTS_SOURCE = "app/controllers/api/internal/admin/payouts_controller.rb";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TOP_CATEGORIES_LIMIT = 3;
const ENRICHED_AFFILIATE_TYPES = ["DirectAffiliate", "Collaborator"];
// ScheduledPayout::STATUSES
const SCHEDULED_STATUSES = ["pending", "executed", "cancelled", "flagged", "held"];
const RISK_STATE_COMMENT_TYPES = ["compliant", "not_reviewed", "on", "flagged", "suspended"];
const SUSPENDED_STATES = ["suspended_for_tos_violation", "suspended_for_fraud"];
const FLAGGED_STATES = ["flagged_for_tos_violation", "flagged_for_fraud"];
// Risk::StrandedBuyerScanService::BLOCK_ERROR_CODES and FAILURE_LOOKBACK
const BLOCK_ERROR_CODES = ["blocked_browser_guid", "blocked_email_domain", "blocked_ip_address"];
const FAILURE_LOOKBACK_MS = 30 * 86_400_000;
const PAUSE_SOURCES_SET_BY_SYSTEMS = ["stripe", "system"];
const WRAPPER = { key: "payout" };

// User#payouts_paused_by_source == PAYOUT_PAUSE_SOURCE_ADMIN: paused internally by anything but Stripe or the system.
function isPausedByAdmin(record: Awaited<ReturnType<typeof findUserBang>>) {
  const pausedBy = payoutsPausedBy(record);
  return (
    isFlagSet(record, "payouts_paused_internally") &&
    !(typeof pausedBy === "string" && PAUSE_SOURCES_SET_BY_SYSTEMS.includes(pausedBy))
  );
}

type ScheduledRow = {
  id: bigint;
  user_id: bigint;
  action: string;
  processor: string | null;
  status: string;
  delay_days: number;
  scheduled_at: Date;
  executed_at: Date | null;
  payout_amount_cents: bigint;
  created_at: Date;
  created_by_id: bigint | null;
};

type Enrichment = {
  product_count: number;
  incoming_affiliate_count: number;
  risk_state: Record<string, unknown>;
  top_categories: { slug: string; product_count: number }[];
  unpaid_balance_cents: number;
  unpaid_balance_formatted: string;
};

const ids = (rows: { user_id: bigint | number }[]) => rows.map((row) => BigInt(row.user_id));

// Admin::ScheduledPayoutEnrichmentService#call
async function enrich(userIds: bigint[]): Promise<Map<bigint, Enrichment>> {
  if (userIds.length === 0) return new Map();
  const numericIds = userIds.map(Number);
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, user_risk_state: true } });
  const comments = await db.comment.groupBy({
    by: ["commentable_id"],
    where: {
      commentable_type: "User",
      commentable_id: { in: userIds },
      comment_type: { in: RISK_STATE_COMMENT_TYPES },
    },
    _max: { created_at: true },
  });
  const changedAt = new Map(comments.map((row) => [row.commentable_id, row._max.created_at]));
  const products = await db.link.groupBy({
    by: ["user_id"],
    where: { user_id: { in: userIds }, purchase_disabled_at: null, banned_at: null, deleted_at: null },
    _count: { _all: true },
  });
  const affiliates = await db.affiliate.groupBy({
    by: ["seller_id"],
    where: { seller_id: { in: numericIds }, type: { in: ENRICHED_AFFILIATE_TYPES }, deleted_at: null },
    _count: { _all: true },
  });
  const balances = await db.balance.groupBy({
    by: ["user_id"],
    where: { user_id: { in: numericIds }, state: "unpaid" },
    _sum: { amount_cents: true },
  });
  const categoryCounts = await db.link.groupBy({
    by: ["user_id", "taxonomy_id"],
    where: {
      user_id: { in: userIds },
      purchase_disabled_at: null,
      banned_at: null,
      deleted_at: null,
      taxonomy_id: { not: null },
    },
    _count: { _all: true },
  });
  const taxonomyIds = [...new Set(categoryCounts.map((row) => row.taxonomy_id!))];
  const taxonomies =
    taxonomyIds.length === 0
      ? []
      : await db.taxonomy.findMany({ where: { id: { in: taxonomyIds } }, select: { id: true, slug: true } });
  const slugs = new Map(taxonomies.map((row) => [row.id, row.slug]));

  const result = new Map<bigint, Enrichment>();
  for (const user of users) {
    const state = user.user_risk_state;
    const suspended = state !== null && SUSPENDED_STATES.includes(state);
    const flagged = state !== null && FLAGGED_STATES.includes(state);
    const unpaid = Number(balances.find((row) => row.user_id === Number(user.id))?._sum.amount_cents ?? 0);
    // Money#format puts the minus sign inside the symbol in a way Node does not model.
    if (unpaid < 0) throw new NotPortedError("a negative unpaid balance", SCHEDULED_SOURCE);
    const categories = categoryCounts
      .filter((row) => row.user_id === user.id && slugs.has(row.taxonomy_id!))
      .map((row) => ({ id: row.taxonomy_id!, slug: slugs.get(row.taxonomy_id!)!, count: row._count._all }))
      .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, TOP_CATEGORIES_LIMIT);
    result.set(user.id, {
      product_count: products.find((row) => row.user_id === user.id)?._count._all ?? 0,
      incoming_affiliate_count: affiliates.find((row) => row.seller_id === Number(user.id))?._count._all ?? 0,
      // Admin::UserRiskStatePresenter#props
      risk_state: {
        status: suspended ? "Suspended" : flagged ? "Flagged" : "Compliant",
        user_risk_state: state,
        suspended,
        flagged_for_fraud: state === "flagged_for_fraud",
        flagged_for_tos_violation: state === "flagged_for_tos_violation",
        on_probation: state === "on_probation",
        compliant: state === "compliant",
        last_status_changed_at: timeJson(changedAt.get(user.id) ?? null),
      },
      top_categories: categories.map((row) => ({ slug: row.slug, product_count: row.count })),
      unpaid_balance_cents: unpaid,
      unpaid_balance_formatted: moneyFormatWithGemSymbol(unpaid, "usd"),
    });
  }
  return result;
}

// Array.wrap(params[:status]).reject(&:blank?)
function requestedStatuses(raw: unknown): unknown[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.filter((item) => !isBlank(item));
}

// `params[:limit].to_i`; a value that is not text or a whole number is cast in ways Node does not model.
function limitParam(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "string") return rubyToI(raw);
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  throw new NotPortedError("a limit that is not text or an integer", SCHEDULED_SOURCE);
}

const hasUserLookup = (admin: AdminRequest) =>
  ["user_id", "external_id", "email", "username"].some((name) => !isBlank(admin.params[name]));

// Admin::ScheduledPayoutPresenter#props
function serialize(
  row: ScheduledRow,
  user: { external_id: string | null; email: string | null; unconfirmed_email: string | null; name: string | null },
  creator: { name: string | null } | undefined,
  enrichment: Enrichment,
) {
  return {
    external_id: encrypt(row.id),
    action: row.action,
    processor: row.processor,
    status: row.status,
    delay_days: row.delay_days,
    scheduled_at: timeJson(row.scheduled_at),
    executed_at: timeJson(row.executed_at),
    payout_amount_cents: Number(row.payout_amount_cents),
    created_at: timeJson(row.created_at),
    user: {
      external_id: user.external_id,
      email: isBlank(user.unconfirmed_email) ? user.email : user.unconfirmed_email,
      name: user.name,
    },
    created_by: creator === undefined ? null : { name: creator.name },
    ...enrichment,
  };
}

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/scheduled_payouts",
    run: async (admin) => {
      let userId: bigint | null = null;
      if (hasUserLookup(admin)) {
        const found = await findUserForRead(admin, false);
        if ("refusal" in found) return found.refusal;
        userId = found.user.id;
      }
      const statuses = requestedStatuses(admin.params.status);
      if (statuses.some((status) => typeof status !== "string" || !SCHEDULED_STATUSES.includes(status)))
        return failure("status is invalid", 400);
      let limit = limitParam(admin.params.limit);
      if (limit <= 0) limit = DEFAULT_LIMIT;
      limit = Math.min(limit, MAX_LIMIT);

      const rows = await db.scheduledPayout.findMany({
        where: {
          ...(userId === null ? {} : { user_id: userId }),
          ...(statuses.length > 0 ? { status: { in: statuses as string[] } } : {}),
        },
        orderBy: { id: "desc" },
        take: limit,
      });
      const userIds = [...new Set(ids(rows))];
      const users =
        userIds.length === 0
          ? []
          : await db.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, external_id: true, email: true, unconfirmed_email: true, name: true },
            });
      const creatorIds = [...new Set(rows.map((row) => row.created_by_id).filter((id): id is bigint => id !== null))];
      const creators =
        creatorIds.length === 0
          ? []
          : await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } });
      const enrichment = await enrich(userIds);
      const scheduledPayouts = rows.map((row) => {
        const user = users.find((candidate) => candidate.id === row.user_id);
        const extra = enrichment.get(row.user_id);
        if (user === undefined || extra === undefined)
          throw new NotPortedError("a scheduled payout whose user is missing", SCHEDULED_SOURCE);
        return serialize(
          row as ScheduledRow,
          user,
          creators.find((candidate) => candidate.id === row.created_by_id),
          extra,
        );
      });
      return jsonRendered({ success: true, scheduled_payouts: scheduledPayouts, limit });
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/stranded_buyers/scan",
    run: async () => {
      // Risk::StrandedBuyerScanService#candidate_emails is empty: nothing to count, nothing stranded.
      const since = new Date(Date.now() - FAILURE_LOOKBACK_MS);
      const candidate = await db.purchase.findFirst({
        where: {
          purchase_state: "failed",
          error_code: { in: BLOCK_ERROR_CODES },
          created_at: { gte: since },
          email: { not: null },
        },
        select: { id: true },
      });
      if (candidate !== null) return handBack("a stranded-buyer scan with candidates", STRANDED_SOURCE);
      return jsonRendered({ success: true, candidates: [], count: 0, total: 0, truncated: false });
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/payouts",
    run: async (admin) => {
      const found = await findUserForRead(admin, false);
      // fetch_user_for_read is a before_action: a refusal halts the chain.
      if ("refusal" in found) return halted(found.refusal);
      // next_payout_date and the balance for it come from the payout schedule and the seller's rail.
      return handBack("a payout list", PAYOUTS_SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/payouts/pause",
    run: async (admin) => {
      const found = await findUserForWrite(admin, false);
      // fetch_user_for_write is a before_action: a refusal halts the chain.
      if ("refusal" in found) return halted(found.refusal);
      const { user } = found;
      return recordAdminWrite(
        admin,
        {
          action: "payouts.pause",
          target: { type: "User", id: user.id, externalId: user.external_id },
          wrapper: WRAPPER,
        },
        async () => {
          const reason = rubyStrip(paramToS(admin.params.reason, PAYOUTS_SOURCE));
          const record = await findUserBang(user.id);
          // Locking reloads the row, so the check reads what a concurrent pause committed.
          const alreadyPaused = await Users.withLock(record, async () => {
            if (isPausedByAdmin(record)) return true;
            setFlag(record, "payouts_paused_internally", true);
            setJsonDataForAttr(record, "payouts_paused_by", Number(admin.admin.actor.id));
            await Users.saveBang(record);
            if (reason !== "")
              await Comments.createBang({
                commentable_id: user.id,
                commentable_type: "User",
                author_id: admin.admin.actor.id,
                comment_type: COMMENT_TYPES.PAYOUTS_PAUSED,
                content: reason,
              } as never);
            return false;
          });
          if (alreadyPaused)
            return jsonRendered({
              success: true,
              user_id: user.external_id,
              status: "already_paused",
              message: "Payouts are already paused by admin",
              payouts_paused: true,
            });
          return jsonRendered({
            success: true,
            user_id: user.external_id,
            message: `Payouts paused for ${user.external_id}`,
            payouts_paused: true,
          });
        },
      );
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/payouts/resume",
    run: async (admin) => {
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return halted(found.refusal);
      const { user } = found;
      return recordAdminWrite(
        admin,
        {
          action: "payouts.resume",
          target: { type: "User", id: user.id, externalId: user.external_id },
          wrapper: WRAPPER,
        },
        async () => {
          const record = await findUserBang(user.id);
          if (!isFlagSet(record, "payouts_paused_internally"))
            return jsonRendered({
              success: true,
              user_id: user.external_id,
              status: "not_paused",
              message: "Payouts are not paused by admin",
              payouts_paused: isPayoutsPaused(record),
            });
          await Users.withLock(record, async () => {
            setFlag(record, "payouts_paused_internally", false);
            setJsonDataForAttr(record, "payouts_paused_by", null);
            await Users.saveBang(record);
            await Comments.createBang({
              commentable_id: user.id,
              commentable_type: "User",
              author_id: admin.admin.actor.id,
              comment_type: COMMENT_TYPES.PAYOUTS_RESUMED,
              content: "Payouts resumed.",
            } as never);
          });
          await recordSocialConnectHoldReleased(record, () => new Date(), "payouts_resume");
          return jsonRendered({
            success: true,
            user_id: user.external_id,
            message: `Payouts resumed for ${user.external_id}`,
            payouts_paused: isPayoutsPaused(await findUserBang(user.id)),
          });
        },
      );
    },
  },
);
