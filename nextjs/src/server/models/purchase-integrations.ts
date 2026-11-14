// Purchase#find_enabled_integration (app/models/purchase.rb) and the lookups under it: the first live integration of a given name on the
// purchase's first option, or on the product when it has no option or is physical (`find_integration_by_name`:
// `active_integrations.by_name(name).first`). Read-only; the services that act on the integration (Circle, Discord) are not ported.
import { Prisma, type Integration } from "@prisma/client";

import { LinkFlags } from "./link.ts";
import type { PurchaseRecord } from "./purchase-pricing.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NoMethodError, NotPortedError } from "./user.ts";

export const CIRCLE_INTEGRATION = "circle";
export const DISCORD_INTEGRATION = "discord";
// Integration::KEEP_INACTIVE_MEMBERS flag, `has_flags 1 => :keep_inactive_members`
const KEEP_INACTIVE_MEMBERS = 1n << 0n;

const INTEGRATIONS = "integrations";

// Integration.type_for(name): "#{name.capitalize.camelize}Integration"
const typeFor = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1).toLowerCase()}Integration`;

async function firstActiveIntegration(
  joinTable: string,
  ownerColumn: string,
  ownerId: bigint | number,
  name: string,
): Promise<Integration | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`integrations`.*")} FROM ${table(INTEGRATIONS)} INNER JOIN ${table(joinTable)} ON ${column(INTEGRATIONS, "id")} = ${column(joinTable, "integration_id")} WHERE ${column(joinTable, ownerColumn)} = ${ownerId} AND ${column(joinTable, "deleted_at")} IS NULL AND ${column(INTEGRATIONS, "type")} = ${typeFor(name)} ORDER BY ${column(INTEGRATIONS, "id")} ASC LIMIT 1`,
  );
  return row ? castRow<Integration>("Integration", row) : null;
}

export async function findEnabledIntegration(purchase: PurchaseRecord, name: string): Promise<Integration | null> {
  const variants = await purchase.variantAttributes();
  const product = await purchase.link();
  if (variants.length > 0 && product !== null && !LinkFlags.isSet(product.flags, "is_physical")) {
    return firstActiveIntegration("base_variant_integrations", "base_variant_id", variants[0]!.row.id, name);
  }
  if (product === null) {
    // Deliberate hand-back: a purchase row whose product row is gone is a data fault (no foreign keys). With options Ruby fails
    // earlier, in `link.is_physical?`, with a message a request spec cannot reproduce without a 500 page.
    if (variants.length > 0)
      throw new NotPortedError("a purchase with options whose product is gone", "Purchase#find_enabled_integration");
    throw new NoMethodError("undefined method 'find_integration_by_name' for nil");
  }
  return firstActiveIntegration("product_integrations", "product_id", product.id, name);
}

// Integration#keep_inactive_members?
export const keepsInactiveMembers = (integration: Pick<Integration, "flags">) =>
  (BigInt(integration.flags) & KEEP_INACTIVE_MEMBERS) !== 0n;

// `DiscordIntegration.discord_user_id_for(purchase)`: the Discord user id of the purchase's live membership of its Discord integration.
export async function discordUserIdFor(purchase: PurchaseRecord): Promise<string | null> {
  const integration = await findEnabledIntegration(purchase, DISCORD_INTEGRATION);
  if (integration === null) return null;

  const [row] = await selectRows<{ discord_user_id: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_integrations`.*")} FROM ${table("purchase_integrations")} WHERE ${column("purchase_integrations", "purchase_id")} = ${purchase.id} AND ${column("purchase_integrations", "deleted_at")} IS NULL AND ${column("purchase_integrations", "integration_id")} = ${integration.id} LIMIT 1`,
  );
  return row?.discord_user_id ?? null;
}
