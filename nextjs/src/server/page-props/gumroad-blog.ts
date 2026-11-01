// GumroadBlog::PostsController (WS-55). Registered in pages.ts through public-pages.ts.
import { Prisma } from "@prisma/client";

import { getConfig } from "../infra/config.ts";
import { featuredImageUrl, messageSnippet, messageTags } from "../html/installment-message.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "./not-ported.ts";
import type { PageSpec } from "./pages.ts";
import { NOT_FOUND } from "./preflight.ts";

const DEFAULT_BLOG_OWNER_USERNAME = "gumroad";
// Installment's `shown_on_profile` is flag 8 (flag_shih_tzu stores flag n as 2**(n - 1)).
const SHOWN_ON_PROFILE_FLAG = 2 ** 7;
const AUDIENCE_TYPE = "audience";

type BlogOwner = { id: bigint };

// GumroadBlog::BaseController#set_blog_owner!: `User.find_by!(username:)`.
export async function blogOwner(): Promise<BlogOwner | null> {
  const username = getConfig("BLOG_OWNER_USERNAME", DEFAULT_BLOG_OWNER_USERNAME);
  const [owner] = await selectRows<BlogOwner>(Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "username")} = ${username} LIMIT 1`);
  return owner ?? null;
}

type PostRow = { slug: string | null; name: string | null; published_at: Date; message: string | null };

// `@blog_owner.installments.visible_on_profile.order(published_at: :desc)`
const visiblePosts = (ownerId: bigint) =>
  selectRows<PostRow>(
    Prisma.sql`SELECT ${column("installments", "slug")}, ${column("installments", "name")}, ${column("installments", "published_at")}, ${column("installments", "message")} FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${ownerId} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL AND ${column("installments", "installment_type")} = ${AUDIENCE_TYPE} AND ${column("installments", "flags")} & ${SHOWN_ON_PROFILE_FLAG} > 0 AND ${column("installments", "workflow_id")} IS NULL ORDER BY ${column("installments", "published_at")} DESC`,
  );

export const GUMROAD_BLOG_PAGES: Record<string, PageSpec> = {
  // The show page is not ported: PostPresenter#post_component_props needs ProfilePresenter#creator_profile,
  // visible_posts_for and PaginatedCommentsPresenter. Registered so the route cannot fall through to
  // the posts page (`/:username/p/:slug` with username "blog") if its flag is turned on.
  "/blog/p/:slug": {
    component: "GumroadBlog/Posts/Show",
    redirect: async ({ slug }) => {
      const owner = await blogOwner();
      if (!owner) return NOT_FOUND;
      const [post] = await selectRows(
        Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${owner.id} AND ${column("installments", "slug")} = ${slug!} LIMIT 1`,
      );
      if (!post) return NOT_FOUND;
      throw new NotPortedError("GumroadBlog::PostsController#show (PostPresenter props)");
    },
    props: () => {
      throw new NotPortedError("GumroadBlog::PostsController#show (PostPresenter props)");
    },
  },
  "/blog": {
    component: "GumroadBlog/Posts/Index",
    redirect: async () => ((await blogOwner()) ? null : NOT_FOUND),
    props: async () => {
      const owner = (await blogOwner())!;
      const posts = await visiblePosts(owner.id);
      return {
        posts: posts.map((post) => ({
          slug: post.slug,
          subject: post.name,
          published_at: post.published_at.toISOString(),
          featured_image_url: featuredImageUrl(post.message),
          message_snippet: messageSnippet(post.message),
          tags: messageTags(post.message),
        })),
      };
    },
  },
};
