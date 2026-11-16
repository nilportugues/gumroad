// PostsController#show (WS-55). Registered in pages.ts through public-pages.ts.
//
// On the Gumroad domain (/:username/p/:slug) the action never renders: every user has a subdomain,
// so `check_if_needs_redirect` always sends the visitor to the seller's own host, or the request is a
// 404. The render itself, on a seller subdomain or custom domain (/p/:slug), is not ported: it needs
// ProfilePresenter#creator_profile, visible_posts_for, PaginatedCommentsPresenter and Post::SocialImage.
import { Prisma, type User } from "@prisma/client";

import { parseQuery, toQuery } from "../controllers/rails-query.ts";
import { isAccountActive, isSuspended, subdomainWithProtocol, Users } from "../models/user.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "./not-ported.ts";
import type { PageSpec } from "./pages.ts";
import { NOT_FOUND, type PreflightOutcome } from "./preflight.ts";

type PostRow = { seller_id: number | bigint | null; link_id: number | bigint | null };

async function findUser(where: Prisma.UserWhereInput): Promise<User | null> {
  const { db } = await import("../../lib/db.ts");
  return db.user.findFirst({ where, orderBy: { id: "asc" } });
}

const userById = async (id: number | bigint) => findUser({ id: BigInt(id) });

// `Installment.find_by_slug(slug)`, then PostsController#fetch_post(false)'s suspended-seller checks.
async function postIsViewable(slug: string): Promise<boolean> {
  const [post] = await selectRows<PostRow>(
    Prisma.sql`SELECT ${column("installments", "seller_id")}, ${column("installments", "link_id")} FROM ${table("installments")} WHERE ${column("installments", "slug")} = ${slug} LIMIT 1`,
  );
  if (!post) return false;
  // `@post.seller_id?` is true for a non-nil, non-zero id.
  if (post.seller_id) {
    const seller = await userById(post.seller_id);
    return !(seller && isSuspended(Users.load(seller)));
  }
  // A post with a product and no seller reaches `@post.link.seller`, and Link has no `seller`
  // method: Rails answers 500 (a Ruby bug, kept).
  if (post.link_id) throw new Error("undefined method 'seller' for an instance of Link");
  return true;
}

// PostsController#check_if_needs_redirect for a request that is not on a custom domain.
async function redirectToSellerHost(user: User, slug: string, search: string): Promise<PreflightOutcome> {
  const host = subdomainWithProtocol(Users.load(user));
  // Unreachable: a user always has a username (it falls back to the external id).
  if (!host) throw new NotPortedError("A post page for a user without a subdomain");
  const query = toQuery(parseQuery(search)).join("&");
  return { status: 301, location: `${host}/p/${encodeURIComponent(slug)}${query ? `?${query}` : ""}`, rescued: true };
}

export const POSTS_PAGES: Record<string, PageSpec> = {
  "/:username/p/:slug": {
    component: "Posts/Show",
    redirect: async ({ username, slug }, { url }) => {
      // CustomDomainConfig#set_user, then error_if_user_not_found
      const user = (await findUser({ username })) ?? (await findUser({ external_id: username }));
      if (!user || !isAccountActive(Users.load(user))) return NOT_FOUND;
      if (!(await postIsViewable(slug!))) return NOT_FOUND;
      return redirectToSellerHost(user, slug!, url.search);
    },
    props: () => {
      throw new NotPortedError("Posts#show on the Gumroad domain renders (it always redirects or 404s)");
    },
  },
};
