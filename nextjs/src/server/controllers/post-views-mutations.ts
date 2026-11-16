// PostsController#increment_post_views (app/controllers/posts_controller.rb): the view a post page reports.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { isBot } from "../infra/bots.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";
import { UserFlags, isSuspended, Users } from "../models/user.ts";
import { createUserEvent } from "../page-props/audience/events.ts";
import { RoutingError } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";

const POST_VIEW = "post_view";
const COUNT_REFRESH_DELAY_SECONDS = 2;

type PostRow = { id: bigint; seller_id: bigint | null; link_id: bigint | null };
type UserRow = Parameters<typeof Users.load>[0];

registerMutations({
  method: "POST",
  pattern: "/posts/:id/increment_post_views",
  formats: ["any"],
  run: async ({ request, context, url, params, peekState, routeParams }) => {
    // fetch_post(false): `Installment.find_by_external_id`, then a suspended seller hides the post.
    const id = decrypt(routeParams.id!);
    const [post] = id === null ? [] : await selectRows<PostRow>(Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "id")} = ${id} LIMIT 1`);
    if (!post) throw new RoutingError("Not Found");
    const [link] = post.link_id === null ? [] : await selectRows<{ id: bigint; user_id: bigint | null; price_cents: number | null }>(Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} = ${post.link_id} LIMIT 1`);
    const sellerId = post.seller_id ?? null;
    const ownerId = sellerId ?? link?.user_id ?? null;
    if (ownerId !== null) {
      const [owner] = await selectRows<UserRow>(Prisma.sql`SELECT * FROM ${table("users")} WHERE ${column("users", "id")} = ${ownerId} LIMIT 1`);
      if (owner && isSuspended(Users.load(owner))) throw new RoutingError("Not Found");
    }

    const user = railsLoggedInUser(context);
    const skip =
      isBot(request.headers.get("user-agent"), params.user_agent_bot) ||
      (user !== null && ((sellerId !== null && context.currentSeller !== null && Number(sellerId) === Number(context.currentSeller.id)) || UserFlags.isSet(user.flags, "is_team_member"))) ||
      context.impersonatedUser !== null;
    if (!skip) {
      const eventId = await createUserEvent(POST_VIEW, { context, headers: request.headers, url, state: peekState(), params, product: link ? { id: link.id, price_cents: link.price_cents } : undefined });
      if (eventId !== null) {
        await execute(Prisma.sql`INSERT INTO ${table("installment_events")} (${column("installment_events", "installment_id")}, ${column("installment_events", "event_id")}) VALUES (${post.id}, ${eventId})`);
        // after_commit on create
        await performAsync("UpdateInstallmentEventsCountCacheWorker", [Number(post.id)], { delaySeconds: COUNT_REFRESH_DELAY_SECONDS });
      }
    }
    return jsonResponse({ success: true });
  },
});
