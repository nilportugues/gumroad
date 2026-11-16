// Api::V2::Partner::SellersController#create: a seller who authorized a partner application links their account to the partner's user id.
import { Prisma } from "@prisma/client";

import { transaction } from "../../models/runtime/transaction.ts";
import { execute, selectRows, column, table } from "../../models/sql.ts";
import { isAccountActive, Users } from "../../models/user.ts";
import { HandBackToRails } from "../application-controller.ts";

import { json, present, registerApiV2, type ApiV2Input } from "./base.ts";

const PARTNER_SCOPE = "partner_api";
// PartnerMigration::MAX_EXTERNAL_USER_ID_LENGTH
const MAX_EXTERNAL_USER_ID_LENGTH = 255;

const forbidden = (message: string) => json({ success: false, message }, 403);

// before_action :require_seller_of_partner_application!
async function requireSellerOfPartnerApplication({ token }: ApiV2Input) {
  const [application] = await selectRows<{ is_partner: unknown; confidential: unknown }>(
    Prisma.sql`SELECT ${column("oauth_applications", "is_partner")}, ${column("oauth_applications", "confidential")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} = ${token.application_id} AND ${column("oauth_applications", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (
    token.resource_owner_id === null ||
    application === undefined ||
    Number(application.is_partner) === 0 ||
    Number(application.confidential) === 0
  )
    return forbidden("This endpoint needs a seller's token from a partner application.");
  return undefined;
}

type LinkRow = { id: unknown; user_id: unknown; external_user_id: string; deleted_at: Date | null };

// PartnerSeller.link!, under OauthApplication#with_lock. Null when the seller revoked the token while the request waited for the lock.
async function link(
  applicationId: number,
  tokenId: number,
  userId: bigint,
  externalUserId: string,
  applicationName: string,
) {
  return transaction(async () => {
    await selectRows(
      Prisma.sql`SELECT ${column("oauth_applications", "id")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} = ${applicationId} LIMIT 1 FOR UPDATE`,
    );
    const now = new Date();
    const accessible = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("oauth_access_tokens")} WHERE ${column("oauth_access_tokens", "id")} = ${tokenId} AND (${column("oauth_access_tokens", "revoked_at")} IS NULL OR ${column("oauth_access_tokens", "revoked_at")} > ${now}) AND (${column("oauth_access_tokens", "expires_in")} IS NULL OR DATE_ADD(${column("oauth_access_tokens", "created_at")}, INTERVAL ${column("oauth_access_tokens", "expires_in")} SECOND) >= ${now}) LIMIT 1`,
    );
    if (accessible.length === 0) return { outcome: "revoked" as const };

    const sellers = (clause: Prisma.Sql) =>
      selectRows<LinkRow>(
        Prisma.sql`SELECT id, user_id, external_user_id, deleted_at FROM ${table("partner_sellers")} WHERE ${column("partner_sellers", "oauth_application_id")} = ${applicationId} AND ${clause} LIMIT 1`,
      );
    const [byExternalUser] = await sellers(
      Prisma.sql`${column("partner_sellers", "external_user_id")} = ${externalUserId}`,
    );
    const [byUser] = await sellers(Prisma.sql`${column("partner_sellers", "user_id")} = ${userId}`);

    if (byExternalUser?.user_id != null && BigInt(byExternalUser.user_id as bigint | number) !== userId)
      return {
        outcome: "conflict" as const,
        message: `This ${applicationName} account is already linked to a different Gumroad account.`,
      };
    if (byUser !== undefined && byUser.external_user_id !== externalUserId)
      return {
        outcome: "conflict" as const,
        message: `Your Gumroad account is already linked to a different ${applicationName} account.`,
      };

    if (byUser === undefined) {
      await execute(
        Prisma.sql`INSERT INTO ${table("partner_sellers")} (${Prisma.raw("`oauth_application_id`, `user_id`, `external_user_id`, `created_at`, `updated_at`")}) VALUES (${applicationId}, ${userId}, ${externalUserId}, ${now}, ${now})`,
      );
      return { outcome: "linked" as const, created: true };
    }
    // `deleted_at = nil; save!` writes only when the link was removed.
    if (byUser.deleted_at !== null)
      await execute(
        Prisma.sql`UPDATE ${table("partner_sellers")} SET ${column("partner_sellers", "deleted_at")} = NULL, ${column("partner_sellers", "updated_at")} = ${now} WHERE ${column("partner_sellers", "id")} = ${byUser.id}`,
      );
    return { outcome: "linked" as const, created: false };
  });
}

registerApiV2({
  method: "POST",
  pattern: "/v2/partner/sellers",
  scopes: [PARTNER_SCOPE],
  requireScope: [PARTNER_SCOPE],
  ownerless: true,
  before: requireSellerOfPartnerApplication,
  async run({ token, owner, params }) {
    const externalUserId = params.external_user_id;
    if (
      typeof externalUserId !== "string" ||
      !present(externalUserId) ||
      Array.from(externalUserId).length > MAX_EXTERNAL_USER_ID_LENGTH
    )
      return json(
        {
          success: false,
          message: `external_user_id must be a string with 1 to ${MAX_EXTERNAL_USER_ID_LENGTH} characters, not only spaces.`,
        },
        400,
      );
    if (/\p{Surrogate}/u.test(externalUserId)) throw new HandBackToRails("a partner user id that is not valid text");
    if (!isAccountActive(Users.load(owner))) return forbidden("This account cannot be linked.");

    const [application] = await selectRows<{ name: string }>(
      Prisma.sql`SELECT ${column("oauth_applications", "name")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} = ${token.application_id} LIMIT 1`,
    );
    const result = await link(
      Number(token.application_id),
      Number(token.id),
      BigInt(owner.id),
      externalUserId,
      application?.name ?? "",
    );
    if (result.outcome === "revoked")
      return json({ success: false, message: "The seller revoked access for this application." }, 401);
    if (result.outcome === "conflict") return json({ success: false, message: result.message }, 409);
    return json({ success: true, external_user_id: externalUserId }, result.created ? 201 : 200);
  },
});
