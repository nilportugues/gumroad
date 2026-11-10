// Bodies of the pure-read tools of app/services/mcp/server.rb: get_account and list_payouts. Every other tool still runs in Rails
// (toolBody returns undefined for it). A call whose token lacks the tool's scope also stays in Rails, which owns the
// 403 scope challenge and the batch variant of that error.
import type { OauthAccessToken, User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { domainConfig } from "../page-props/domain.ts";

const INVALID_PARAMS = -32602;
const MICROSECONDS_PER_SECOND = 1_000_000n;
// Mcp::Server::MAX_DATETIME_YEAR, as the first second of the year after it.
const FIRST_UNSUPPORTED_SECOND = 253_402_300_800n;
const DEFAULT_PAYOUTS = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

type Hash = Record<string, unknown>;

// An Mcp::Server::Error: the JSON-RPC error the caller gets. server.ts maps it to its McpError.
export class ToolRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export type PayoutRow = {
  id: bigint;
  amount_cents: bigint | null;
  currency: string | null;
  state: string | null;
  created_at: Date | null;
};
// `user.payments` in (created_at, id) descending order, strictly after `after` when given, at most `limit` rows.
export type PayoutReader = (
  userId: bigint,
  limit: number,
  after: { at: string; id: bigint } | null,
) => Promise<PayoutRow[]>;

export type ToolContext = { user: User; token: OauthAccessToken; payouts?: PayoutReader };

export const readPayouts: PayoutReader = (userId, limit, after) =>
  after === null
    ? db.payment.findMany({
        where: { user_id: userId },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: limit,
        select: { id: true, amount_cents: true, currency: true, state: true, created_at: true },
      })
    : // Raw so the microsecond cursor reaches MySQL as written, not rounded to a JavaScript millisecond.
      db.$queryRaw<PayoutRow[]>`SELECT id, amount_cents, currency, state, created_at FROM payments
        WHERE user_id = ${userId} AND (created_at < ${after.at} OR (created_at = ${after.at} AND id < ${after.id}))
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`;

// Mcp::Server#require_scopes!, for a token that passes. A failure is Rails's to answer.
function requireScopes(token: OauthAccessToken, scopes: string[]): void {
  const held = (token.scopes ?? "").split(/\s+/u).filter((scope) => scope !== "");
  if (!scopes.some((scope) => held.includes(scope)))
    throw new HandBackToRails("an MCP tool call without the scope the tool needs");
}

const iso8601 = (time: Date): string => `${time.toISOString().slice(0, 19)}Z`;

// Mcp::Server#limit_for
function limitFor(args: Hash, fallback: number): number {
  const limit = "limit" in args ? (args.limit as number) : fallback;
  if (!(limit >= MIN_LIMIT && limit <= MAX_LIMIT))
    throw new ToolRpcError("limit must be between 1 and 50", INVALID_PARAMS);
  return limit;
}

// The cursor of Mcp::Server#paginate: created_at in microseconds, an underscore, the row id.
function parseCursor(args: Hash): { at: string; id: bigint } | null {
  const cursor = args.cursor;
  if (typeof cursor !== "string" || cursor.trim() === "") return null;
  const separator = cursor.indexOf("_");
  const at = separator === -1 ? cursor : cursor.slice(0, separator);
  const id = separator === -1 ? "" : cursor.slice(separator + 1);
  if (!/^\d+$/u.test(at) || !/^\d+$/u.test(id)) throw new ToolRpcError("cursor is not valid", INVALID_PARAMS);
  const micros = BigInt(at);
  if (micros / MICROSECONDS_PER_SECOND >= FIRST_UNSUPPORTED_SECOND)
    throw new ToolRpcError("cursor is not valid", INVALID_PARAMS);
  const seconds = new Date(Number(micros / MICROSECONDS_PER_SECOND) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  return { at: `${seconds}.${(micros % MICROSECONDS_PER_SECOND).toString().padStart(6, "0")}`, id: BigInt(id) };
}

// tool_get_account. User#username falls back to the external id, so the storefront URL always has a subdomain.
function getAccount(user: User): Hash {
  const { protocol, rootDomain } = domainConfig(process.env);
  const username = user.username !== null && user.username.trim() !== "" ? user.username : user.external_id!;
  return {
    id: user.external_id,
    name: user.name,
    username,
    url: `${protocol}://${username.replaceAll("_", "-")}.${rootDomain}`,
    currency: user.currency_type,
  };
}

// tool_list_payouts, with `paginate`: one extra row tells whether another page exists.
async function listPayouts(args: Hash, context: ToolContext): Promise<Hash> {
  const limit = limitFor(args, DEFAULT_PAYOUTS);
  const rows = await (context.payouts ?? readPayouts)(BigInt(context.user.id), limit + 1, parseCursor(args));
  const page = rows.slice(0, limit);
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    if (last.created_at === null) throw new HandBackToRails("a payout without a creation time");
    nextCursor = `${BigInt(last.created_at.getTime()) * 1000n}_${last.id}`;
  }
  return {
    payouts: page.map((payout) => ({
      id: encrypt(payout.id),
      amount_cents: payout.amount_cents === null ? null : Number(payout.amount_cents),
      currency: payout.currency,
      state: payout.state,
      created_at: payout.created_at === null ? null : iso8601(payout.created_at),
    })),
    // `.compact` drops the cursor of a last page.
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  };
}

// The payload of a ported tool, or undefined for a tool that still runs in Rails.
export async function toolBody(name: string, args: Hash, context: ToolContext): Promise<Hash | undefined> {
  switch (name) {
    case "get_account":
      requireScopes(context.token, ["view_profile", "view_public", "view_sales", "account"]);
      return getAccount(context.user);
    case "list_payouts":
      requireScopes(context.token, ["view_payouts", "account"]);
      return listPayouts(args, context);
    default:
      return undefined;
  }
}
