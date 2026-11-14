// CommunitiesPresenter, CommunityPresenter, CommunityChatMessagePresenter,
// CommunityNotificationSettingPresenter and PaginatedCommunityChatMessagesPresenter: the props of
// CommunitiesController#index and #show.
import { Prisma, type Link, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { accessibleCommunitiesIds } from "../../models/community.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, columnIn, selectRows, table } from "../../models/sql.ts";
import { domainConfig, assetHost } from "../domain.ts";
import { avatarUrl, displayName } from "../signed-in/presenters.ts";
import { thumbnailUrl } from "../buyer/products.ts";

export const MESSAGES_PER_PAGE = 100;
export type FetchType = "older" | "newer" | "around";

type Id = bigint | number;
type CommunityRow = { id: Id; resource_id: Id; seller_id: Id };
type MessageRow = { id: Id; community_id: Id; user_id: Id; content: string; created_at: Date | string; updated_at: Date | string };

// Time#iso8601 on a UTC time.
export const iso8601 = (value: Date | string): string => new Date(value).toISOString().replace(/\.\d{3}Z$/u, "Z");

// Community#thumbnail_url: `resource.for_email_thumbnail_url`.
async function thumbnailOf(product: Link): Promise<string> {
  const uploaded = await thumbnailUrl(product.id);
  if (uploaded !== null) return uploaded;
  return `${assetHost(domainConfig(process.env)) ?? ""}/images/native_types/thumbnails/${product.native_type}.png`;
}

// current_user.products.visible_and_not_archived.exists?
export async function hasProducts(seller: User): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", false)} LIMIT 1`,
  );
  return rows.length > 0;
}

// Community.where(id: ids).includes(:resource, :seller), in primary key order.
async function loadCommunities(ids: Id[]): Promise<CommunityRow[]> {
  if (ids.length === 0) return [];
  return selectRows<CommunityRow>(Prisma.sql`SELECT ${column("communities", "id")}, ${column("communities", "resource_id")}, ${column("communities", "seller_id")} FROM ${table("communities")} WHERE ${columnIn("communities", "id", ids)} ORDER BY ${column("communities", "id")} ASC`);
}

async function lastReadTimestamps(userId: Id, communityIds: Id[]): Promise<Map<string, Date>> {
  if (communityIds.length === 0) return new Map();
  const rows = await selectRows<{ community_id: Id; created_at: Date | string }>(
    Prisma.sql`SELECT ${column("last_read_community_chat_messages", "community_id")}, ${column("community_chat_messages", "created_at")} FROM ${table("last_read_community_chat_messages")} INNER JOIN ${table("community_chat_messages")} ON ${column("community_chat_messages", "id")} = ${column("last_read_community_chat_messages", "community_chat_message_id")} WHERE ${column("last_read_community_chat_messages", "user_id")} = ${userId} AND ${columnIn("last_read_community_chat_messages", "community_id", communityIds)} ORDER BY ${column("last_read_community_chat_messages", "created_at")} DESC`,
  );
  return new Map(rows.map((row) => [String(row.community_id), new Date(row.created_at)]));
}

// CommunitiesPresenter#calculate_unread_counts: the messages of other users after the last one read.
async function unreadCounts(userId: Id, communityIds: Id[], lastRead: Map<string, Date>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const communityId of communityIds) {
    const since = lastRead.get(String(communityId)) ?? new Date(Date.UTC(1970, 0, 1));
    const [row] = await selectRows<{ unread: Id }>(
      Prisma.sql`SELECT COUNT(*) AS unread FROM ${table("community_chat_messages")} WHERE ${column("community_chat_messages", "community_id")} = ${communityId} AND ${column("community_chat_messages", "deleted_at")} IS NULL AND ${column("community_chat_messages", "created_at")} > ${since} AND ${column("community_chat_messages", "user_id")} != ${userId}`,
    );
    if (Number(row?.unread ?? 0) > 0) counts.set(String(communityId), Number(row!.unread));
  }
  return counts;
}

export type CommunitiesReader = Awaited<ReturnType<typeof communitiesReader>>;

// CommunitiesPresenter.new(current_user: current_seller)
export async function communitiesReader(seller: User) {
  const communities = await loadCommunities(await accessibleCommunitiesIds(seller));
  const ids = communities.map((community) => community.id);

  return {
    communities,
    firstCommunity: communities[0] ?? null,

    async communitiesProps() {
      const lastRead = await lastReadTimestamps(seller.id, ids);
      const unread = ids.length > 0 ? await unreadCounts(seller.id, ids, lastRead) : new Map<string, number>();
      const products = new Map((await db.link.findMany({ where: { id: { in: communities.map((community) => BigInt(community.resource_id)) } } })).map((product) => [product.id, product]));
      const sellers = new Map((await db.user.findMany({ where: { id: { in: communities.map((community) => BigInt(community.seller_id)) } } })).map((user) => [user.id, user]));
      const props = [];
      for (const community of communities) {
        const product = products.get(BigInt(community.resource_id))!;
        const owner = sellers.get(BigInt(community.seller_id))!;
        const read = lastRead.get(String(community.id));
        props.push({
          id: encrypt(community.id),
          name: product.name,
          thumbnail_url: await thumbnailOf(product),
          seller: { id: owner.external_id ?? encrypt(owner.id), name: displayName(owner), avatar_url: await avatarUrl(owner) },
          last_read_community_chat_message_created_at: read ? iso8601(read) : null,
          unread_count: unread.get(String(community.id)) ?? 0,
        });
      }
      return props;
    },

    async notificationSettingsProps() {
      const sellerIds = [...new Set(communities.map((community) => BigInt(community.seller_id)))];
      const settings = await db.communityNotificationSetting.findMany({ where: { user_id: seller.id, seller_id: { in: sellerIds } }, orderBy: { seller_id: "asc" } });
      const owners = new Map((await db.user.findMany({ where: { id: { in: settings.map((setting) => setting.seller_id) } } })).map((user) => [user.id, user]));
      const props: Record<string, { recap_frequency: string | null }> = {};
      for (const setting of settings) {
        const owner = owners.get(setting.seller_id);
        if (owner) props[owner.external_id ?? encrypt(owner.id)] = { recap_frequency: setting.recap_frequency };
      }
      return props;
    },
  };
}

// PaginatedCommunityChatMessagesPresenter#props. The cursor goes to MySQL as the string it is.
export async function paginatedMessages(communityId: Id, sellerId: Id, timestamp: string, fetchType: FetchType) {
  const messages = column("community_chat_messages", "created_at");
  const query = (comparison: Prisma.Sql, direction: "ASC" | "DESC", limit: number) =>
    selectRows<MessageRow>(
      Prisma.sql`SELECT ${Prisma.raw("`community_chat_messages`.*")} FROM ${table("community_chat_messages")} WHERE ${column("community_chat_messages", "community_id")} = ${communityId} AND ${column("community_chat_messages", "deleted_at")} IS NULL AND ${comparison} ORDER BY ${messages} ${Prisma.raw(direction)} LIMIT ${Prisma.raw(String(limit))}`,
    );
  const before = (operator: "<" | "<=") => Prisma.sql`${messages} ${Prisma.raw(operator)} ${timestamp}`;
  const after = (operator: ">" | ">=") => Prisma.sql`${messages} ${Prisma.raw(operator)} ${timestamp}`;
  const stamp = (row: MessageRow | undefined) => (row ? iso8601(row.created_at) : null);

  let rows: MessageRow[];
  let nextOlder: string | null;
  let nextNewer: string | null;
  if (fetchType === "older") {
    const result = await query(before("<="), "DESC", MESSAGES_PER_PAGE + 1);
    rows = result.slice(0, MESSAGES_PER_PAGE);
    nextOlder = result.length > MESSAGES_PER_PAGE ? stamp(result[result.length - 1]) : null;
    nextNewer = stamp((await query(after(">"), "ASC", 1))[0]);
  } else if (fetchType === "newer") {
    const result = await query(after(">="), "ASC", MESSAGES_PER_PAGE + 1);
    rows = result.slice(0, MESSAGES_PER_PAGE);
    nextOlder = stamp((await query(before("<"), "DESC", 1))[0]);
    nextNewer = result.length > MESSAGES_PER_PAGE ? stamp(result[result.length - 1]) : null;
  } else {
    const half = MESSAGES_PER_PAGE / 2;
    const older = await query(before("<"), "DESC", half + 1);
    const newer = await query(after(">="), "ASC", half + 1);
    rows = [...older.slice(0, half), ...newer.slice(0, half)].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    nextOlder = older.length > half ? stamp(older[older.length - 1]) : null;
    nextNewer = newer.length > half ? stamp(newer[newer.length - 1]) : null;
  }

  const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => BigInt(row.user_id)))] } } })).map((user) => [user.id, user]));
  const props = [];
  for (const row of rows) {
    const user = users.get(BigInt(row.user_id))!;
    props.push({
      id: encrypt(row.id),
      community_id: encrypt(communityId),
      content: row.content,
      created_at: iso8601(row.created_at),
      updated_at: iso8601(row.updated_at),
      user: { id: user.external_id ?? encrypt(user.id), name: displayName(user), avatar_url: await avatarUrl(user), is_seller: BigInt(row.user_id) === BigInt(sellerId) },
    });
  }
  return { messages: props, nextOlderTimestamp: nextOlder, nextNewerTimestamp: nextNewer };
}

// LastReadCommunityChatMessage...community_chat_message.created_at.iso8601 for the community's reader.
export async function lastReadTimestamp(userId: Id, communityId: Id): Promise<string | null> {
  const [row] = await selectRows<{ created_at: Date | string }>(
    Prisma.sql`SELECT ${column("community_chat_messages", "created_at")} FROM ${table("last_read_community_chat_messages")} INNER JOIN ${table("community_chat_messages")} ON ${column("community_chat_messages", "id")} = ${column("last_read_community_chat_messages", "community_chat_message_id")} WHERE ${column("last_read_community_chat_messages", "user_id")} = ${userId} AND ${column("last_read_community_chat_messages", "community_id")} = ${communityId} LIMIT 1`,
  );
  return row ? iso8601(row.created_at) : null;
}
