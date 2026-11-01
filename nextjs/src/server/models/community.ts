// Port of User#accessible_communities_ids (app/models/user.rb) and the Community reads around it.
// Reads go through sql.ts, so a statement the query cache answers in Rails is answered here too.
import { Prisma } from "@prisma/client";

import { LinkFlags } from "./link.ts";
import { column, columnIn, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

type Id = number | bigint;
type CommunityRow = { id: Id; resource_type: string; resource_id: Id };
type LinkRow = { id: Id; purchase_disabled_at: Date | null; banned_at: Date | null; deleted_at: Date | null; flags: Id | null };

export const COMMUNITIES = "communities";

// Ruby's NoMethodError on a nil resource; the job's rescue-all reports it.
export class NilResourceError extends Error {
  constructor(method: string) {
    super(`undefined method '${method}' for nil`);
    this.name = "NoMethodError";
  }
}

const allColumns = (name: string) => Prisma.raw(`\`${name}\`.*`);
const alive = () => Prisma.sql`${column(COMMUNITIES, "deleted_at")} IS NULL`;

// `includes(:resource)` on loaded communities. The polymorphic preloader queries one table per
// resource_type; products are the only resource a community has, so any other type is left to Rails.
async function preloadLinks(communities: CommunityRow[]): Promise<Map<string, LinkRow>> {
  const other = communities.find((community) => community.resource_type !== "Link");
  if (other) throw new NotPortedError(`a community whose resource is a ${other.resource_type}`, "app/models/community.rb:7");
  const ids = [...new Map(communities.map((community) => [String(community.resource_id), community.resource_id])).values()];
  if (ids.length === 0) return new Map();
  const links = await selectRows<LinkRow>(Prisma.sql`SELECT ${allColumns("links")} FROM ${table("links")} WHERE ${columnIn("links", "id", ids)}`);
  return new Map(links.map((link) => [String(link.id), link]));
}

// `resource.alive? && resource.community_chat_enabled?`
function chatEnabled(community: CommunityRow, links: Map<string, LinkRow>): boolean {
  const link = links.get(String(community.resource_id));
  if (!link) throw new NilResourceError("alive?");
  const isAlive = link.purchase_disabled_at === null && link.banned_at === null && link.deleted_at === null;
  return isAlive &&LinkFlags.isSet(link.flags, "community_chat_enabled");
}

// The ids of the communities whose chat `user` can open: the ones they sell in plus the ones of
// products they bought, in that order and without repeats.
export async function accessibleCommunitiesIds(user: { id: Id; email: string | null }): Promise<Id[]> {
  const sellerCommunities = await selectRows<CommunityRow>(
    Prisma.sql`SELECT ${allColumns(COMMUNITIES)} FROM ${table(COMMUNITIES)} WHERE ${column(COMMUNITIES, "seller_id")} = ${user.id} AND ${alive()}`,
  );
  const sellerLinks = await preloadLinks(sellerCommunities);

  // The id is bound as a string: `where("... = ?", id, email)` quotes the user's id that way.
  const buyerCommunities = await selectRows<CommunityRow>(
    Prisma.sql`SELECT ${allColumns(COMMUNITIES)} FROM ${table(COMMUNITIES)} INNER JOIN links ON communities.resource_type = 'Link' AND communities.resource_id = links.id INNER JOIN purchases ON purchases.link_id = links.id WHERE ${alive()} AND (purchases.purchase_state = 'successful' AND (purchases.purchaser_id = ${String(user.id)} OR purchases.email = ${user.email}))`,
  );
  const buyerLinks = await preloadLinks(buyerCommunities);

  const ids: Id[] = [];
  for (const [communities, links] of [[sellerCommunities, sellerLinks] as const, [buyerCommunities, buyerLinks] as const]) {
    for (const community of communities) if (chatEnabled(community, links)) ids.push(community.id);
  }
  return [...new Map(ids.map((id) => [String(id), id])).values()];
}
