import { NotPortedError } from "./user.ts";

// direct_affiliate_id lives in json_data, not in a column.
export function hasDirectAffiliateId(jsonData: string | null): boolean {
  if (jsonData === null || jsonData === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonData);
  } catch {
    throw new NotPortedError("a purchase whose json_data is not JSON", "Purchase#as_json");
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const id = (parsed as Record<string, unknown>).direct_affiliate_id;
  return id !== undefined && id !== null && id !== "";
}
