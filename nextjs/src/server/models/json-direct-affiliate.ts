import { NotPortedError } from "./user.ts";

// direct_affiliate_id lives in json_data, not in a column.
export function hasDirectAffiliateId(jsonData: string | null): boolean {
  return jsonDataHas(jsonData, "direct_affiliate_id");
}

// direct_affiliate_credit_cents: the part of affiliate_credit_cents that belongs to the direct affiliate (Purchase#own_affiliate_credit_cents).
export function hasDirectAffiliateCredit(jsonData: string | null): boolean {
  return jsonDataHas(jsonData, "direct_affiliate_credit_cents");
}

function jsonDataHas(jsonData: string | null, key: string): boolean {
  if (jsonData === null || jsonData === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonData);
  } catch {
    throw new NotPortedError("a purchase whose json_data is not JSON", "Purchase#as_json");
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const id = (parsed as Record<string, unknown>)[key];
  return id !== undefined && id !== null && id !== "";
}
