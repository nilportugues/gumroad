// Api::Internal::Admin::CursorPagination and the CursorPaginated concern: keyset pagination over (created_at DESC, id DESC) with the
// cursor signed by Rails.application.message_verifier(:admin_api_cursor).
import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { getConfig } from "../../infra/config.ts";
import { NotPortedError } from "../../models/user.ts";
import type { Params } from "../rails-body.ts";
import { failure, isBlank } from "./base.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VERIFIER_NAME = "admin_api_cursor";
const CURSOR_KEYS = ["created_at", "id"];
const ISO_MICROSECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const SOURCE = "app/services/api/internal/admin/cursor_pagination.rb";

export class InvalidCursor extends Error {}

const verifierKey = () => {
  const secretKeyBase = getConfig("SECRET_KEY_BASE");
  if (!secretKeyBase) throw new Error("Missing config SECRET_KEY_BASE (must match the Rails app)");
  return pbkdf2Sync(secretKeyBase, VERIFIER_NAME, 1000, 64, "sha256");
};

// verifier.generate(JSON.dump(payload)): the JSON text as a JSON string, signed, then URL-safe Base64.
export function encodeCursor(payload: { created_at: string; id: number }): string {
  const encoded = Buffer.from(JSON.stringify(JSON.stringify(payload)), "utf8").toString("base64");
  const signed = `${encoded}--${createHmac("sha1", verifierKey()).update(encoded).digest("hex")}`;
  return Buffer.from(signed, "utf8").toString("base64url").padEnd(Math.ceil(Buffer.byteLength(signed) / 3) * 4, "=");
}

function decodeCursor(token: unknown): { created_at: string; id: number } {
  if (typeof token !== "string" || isBlank(token)) throw new InvalidCursor();
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(token) || token.replace(/=+$/u, "").length % 4 === 1) throw new InvalidCursor();
  const signed = Buffer.from(token, "base64url").toString("utf8");
  const parts = signed.split("--");
  if (parts.length !== 2) throw new InvalidCursor();
  const [encoded, digest] = parts as [string, string];
  const expected = createHmac("sha1", verifierKey()).update(encoded).digest("hex");
  if (digest.length !== expected.length || !timingSafeEqual(Buffer.from(digest), Buffer.from(expected))) throw new InvalidCursor();
  let payload: unknown;
  try {
    payload = JSON.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as string);
  } catch {
    throw new InvalidCursor();
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new InvalidCursor();
  if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(CURSOR_KEYS)) throw new InvalidCursor();
  const { created_at: createdAt, id } = payload as Record<string, unknown>;
  // A cursor Rails signed holds what encode wrote; anything else is cast by ActiveRecord in ways Node does not model.
  if (typeof createdAt !== "string" || !ISO_MICROSECONDS.test(createdAt) || typeof id !== "number" || !Number.isSafeInteger(id)) throw new NotPortedError("a cursor with an unusual payload", SOURCE);
  return { created_at: createdAt, id };
}

// Integer(params[:limit], exception: false), then CursorPaginated#cursor_limit.
export function cursorLimit(raw: unknown): number {
  if (typeof raw !== "string" && raw !== undefined && raw !== null) throw new NotPortedError("a limit that is not a string", SOURCE);
  const text = raw ?? "";
  // Integer() reads 0x1F, 0b11, 0o7 and a leading zero as other bases.
  if (/^\s*[+-]?0[0-9xXbBoO_]/u.test(text)) throw new NotPortedError("a limit in another base", SOURCE);
  const requested = /^\s*[+-]?\d+(?:_\d+)*\s*$/u.test(text) ? Number.parseInt(text.replace(/_/gu, ""), 10) : null;
  return requested === null || requested <= 0 ? DEFAULT_LIMIT : Math.min(requested, MAX_LIMIT);
}

export type CursorPage<Row> = { rows: Row[]; pagination: { next: string | null; limit: number } };

// `table` and `where` are fixed by the caller; the cursor and limit come from the request.
export async function paginateWithCursor<Row extends { id: bigint | number; created_at_iso: string }>(
  table: "comments" | "credits",
  where: Prisma.Sql,
  params: Params,
  select: Prisma.Sql,
): Promise<CursorPage<Row> | { invalid: ReturnType<typeof failure> }> {
  const limit = cursorLimit(params.limit);
  let cursorCondition = Prisma.empty;
  if (!isBlank(params.cursor)) {
    let cursor: { created_at: string; id: number };
    try {
      cursor = decodeCursor(params.cursor);
    } catch (error) {
      if (error instanceof InvalidCursor) return { invalid: failure("invalid cursor", 400) };
      throw error;
    }
    // The column's own precision truncates the value, as the attribute cast does.
    const value = cursor.created_at.replace("T", " ").replace("Z", "").slice(0, 19);
    cursorCondition = Prisma.sql`AND (${Prisma.raw(`\`${table}\`.\`created_at\``)}, ${Prisma.raw(`\`${table}\`.\`id\``)}) < (${value}, ${cursor.id})`;
  }
  const tableSql = Prisma.raw(`\`${table}\``);
  const rows = await db.$queryRaw<Row[]>`SELECT ${select}, DATE_FORMAT(${tableSql}.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at_iso FROM ${tableSql} WHERE ${where} ${cursorCondition} ORDER BY ${tableSql}.created_at DESC, ${tableSql}.id DESC LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next = rows.length > limit && last !== undefined ? encodeCursor({ created_at: last.created_at_iso, id: Number(last.id) }) : null;
  return { rows: page, pagination: { next, limit } };
}
