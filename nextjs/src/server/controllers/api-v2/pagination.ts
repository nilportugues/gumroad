// Api::V2::BaseController's keyset pagination: #encode_page_key, #decode_page_key, #pagination_info and #next_page_url.
import { decryptNumeric, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../application-controller.ts";
import type { RailsRequest } from "../rails-request.ts";

const PAGE_KEY_DIGITS = 20;

// DATE_FORMAT(created_at, USEC_FORMAT): Prisma's Date keeps milliseconds, the page key keeps the column's microseconds.
export const USEC_FORMAT = "%Y%m%d%H%i%s%f";

// record.created_at.to_fs(:usec) + "-" + ObfuscateIds.encrypt_numeric(record.id)
export function encodePageKey(record: { created_usec: string; id: bigint | number }): string {
  return `${record.created_usec}-${encryptNumeric(Number(record.id))}`;
}

// decode_page_key; null for what Ruby answers with ArgumentError (-> "Invalid page_key."). `at` is the time as MySQL writes it.
export function decodePageKey(key: string): { at: string; id: number } | null {
  const [dateString, obfuscated] = key.split("-");
  const obfuscatedId = Number.parseInt(obfuscated ?? "", 10);
  if (!Number.isFinite(obfuscatedId) || obfuscatedId === 0) return null;
  const digits = (dateString ?? "").trim();
  if (!new RegExp(`^\\d{${PAGE_KEY_DIGITS}}$`, "u").test(digits)) throw new HandBackToRails("a page_key whose time Time.zone.parse reads in a way the port does not model");
  const at = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}.${digits.slice(14)}`;
  if (Number.isNaN(new Date(`${at.replace(" ", "T")}Z`).getTime())) throw new HandBackToRails("a page_key that is not a time");
  return { at, id: decryptNumeric(obfuscatedId) };
}

// next_page_url: the request's own path and query without access_token, page and page_key, plus the new page_key, keys sorted
// (Addressable's query_values=).
export function nextPageUrl(request: RailsRequest, pageKey: string): string {
  const pairs = [...new URLSearchParams(request.queryString).entries()].filter(([name]) => !["access_token", "page", "page_key"].includes(name));
  if (pairs.some(([name]) => name.includes("[") || name.includes("]"))) throw new HandBackToRails("a nested query parameter in a paginated URL");
  const merged = new Map<string, string>(pairs);
  merged.set("page_key", pageKey);
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const body = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${encode(name)}=${encode(value)}`).join("&");
  return `${request.path}?${body}`;
}

export function paginationInfo(request: RailsRequest, record: { created_usec: string; id: bigint | number }): { next_page_key: string; next_page_url: string } {
  const key = encodePageKey(record);
  return { next_page_key: key, next_page_url: nextPageUrl(request, key) };
}
