// app/models/utm_link.rb for the API's writes (Api::V2::UtmLinksController through SaveUtmLinkService): validations in the order Rails declares them,
// the permalink the model assigns, PaperTrail, and the soft delete.
import { Prisma, type UtmLink } from "@prisma/client";

import { generateUniquePermalink } from "../page-props/audience/utm-links.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { deletable } from "./concerns/deletable.ts";
import { defineModel } from "./runtime/define-model.ts";
import { isBlank, validatesFormatOf, validatesInclusionOf, validatesLengthOf, validatesPresenceOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";

export const MAX_UTM_PARAM_LENGTH = 200;
export const TARGET_RESOURCE_TYPES = ["profile_page", "subscribe_page", "product_page", "post_page"] as const;
const UTM_UNIQUENESS_ATTRIBUTES = ["seller_id", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "target_resource_type", "target_resource_id"] as const;
const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const paperTrail = hasPaperTrail<UtmLink>("UtmLink", { itemType: "UtmLink" });
const requiresResourceId = (type: string) => type === "product_page" || type === "post_page";

export const UtmLinks = defineModel<UtmLink>({
  rubyClass: "UtmLink",
  prismaModel: "UtmLink",
  delegate: (tx) => tx.utmLink as never,
  beforeValidation: [
    {
      name: "set_permalink",
      async run(record) {
        if (isBlank(record.get("permalink"))) record.set("permalink", await generateUniquePermalink());
      },
    },
  ],
  validations: [
    belongsToRequired<UtmLink>(SELLER),
    validatesInclusionOf<UtmLink>(["target_resource_type"], { in: TARGET_RESOURCE_TYPES }),
    validatesPresenceOf<UtmLink>(["title"]),
    validatesPresenceOf<UtmLink>(["target_resource_id"], { if: (record) => requiresResourceId(record.get("target_resource_type")) }),
    validatesPresenceOf<UtmLink>(["permalink"]),
    validatesFormatOf<UtmLink>(["permalink"], { with: /^[a-z0-9]{8}$/u }),
    {
      name: "validates_uniqueness_of permalink",
      async run(record, { tx }) {
        const permalink = record.get("permalink");
        if (permalink == null) return;
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT 1 AS one FROM ${table("utm_links")} WHERE ${column("utm_links", "permalink")} = ${permalink}${record.persisted ? Prisma.sql` AND ${column("utm_links", "id")} != ${record.get("id")}` : Prisma.empty} LIMIT 1`,
        );
        if (rows.length > 0) record.errors.add("permalink", "taken", { value: permalink });
      },
    },
    validatesPresenceOf<UtmLink>(["utm_campaign"]),
    validatesLengthOf<UtmLink>(["utm_campaign"], { maximum: MAX_UTM_PARAM_LENGTH }),
    validatesPresenceOf<UtmLink>(["utm_medium"]),
    validatesLengthOf<UtmLink>(["utm_medium"], { maximum: MAX_UTM_PARAM_LENGTH }),
    validatesPresenceOf<UtmLink>(["utm_source"]),
    validatesLengthOf<UtmLink>(["utm_source"], { maximum: MAX_UTM_PARAM_LENGTH }),
    validatesLengthOf<UtmLink>(["utm_term"], { maximum: MAX_UTM_PARAM_LENGTH }),
    validatesLengthOf<UtmLink>(["utm_content"], { maximum: MAX_UTM_PARAM_LENGTH }),
    {
      name: "last_click_at_is_same_or_after_first_click_at",
      run(record) {
        const last = record.get("last_click_at");
        const first = record.get("first_click_at");
        if (last != null && (first == null || first.getTime() > last.getTime())) record.errors.add("last_click_at", "must be same or after the first click at");
      },
    },
    {
      name: "utm_fields_are_unique_per_target_resource",
      async run(record, { tx }) {
        // Only while the identifying fields change, or a soft-deleted link is restored.
        const restored = record.attributeChanged("deleted_at") && record.get("deleted_at") == null;
        if (!record.newRecord && !restored && !UTM_UNIQUENESS_ATTRIBUTES.some((name) => record.attributeChanged(name))) return;
        const eq = (name: (typeof UTM_UNIQUENESS_ATTRIBUTES)[number]) => (record.get(name) == null ? Prisma.sql`${column("utm_links", name)} IS NULL` : Prisma.sql`${column("utm_links", name)} = ${record.get(name)}`);
        const alive = Prisma.sql`${column("utm_links", "deleted_at")} IS NULL`;
        const other = record.persisted ? Prisma.sql` AND ${column("utm_links", "id")} != ${record.get("id")}` : Prisma.empty;
        const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT 1 AS one FROM ${table("utm_links")} WHERE ${alive} AND ${Prisma.join(UTM_UNIQUENESS_ATTRIBUTES.map(eq), " AND ")}${other} LIMIT 1`);
        if (rows.length > 0) record.errors.add("target_resource_id", "A link with similar UTM parameters already exists for this destination!");
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
});

export const UtmLinkDeletable = deletable(UtmLinks);

// `seller.utm_links.alive.find_by_external_id(id)` for an id already decrypted.
export async function findAliveUtmLink(sellerId: bigint, id: number) {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`utm_links`.*")} FROM ${table("utm_links")} WHERE ${column("utm_links", "seller_id")} = ${sellerId} AND ${column("utm_links", "deleted_at")} IS NULL AND ${column("utm_links", "id")} = ${id} LIMIT 1`);
  return row ?? null;
}
