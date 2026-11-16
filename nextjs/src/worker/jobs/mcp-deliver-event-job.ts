// Port of app/sidekiq/mcp/deliver_event_job.rb up to the delivery: the live lookup, and a connection that holds no token (the
// subscription is deleted, nothing is sent). A connection with any token left goes back to Rails whole, before any write: whether a
// token grants access reads its scopes and, for a team member's, the membership, and a grant ends in the outbound POST
// (Mcp::EventWebhook.post, signed, through SsrfFilter), which Node never makes. An argument whose shape the log line would trip on
// (an event that is not a Hash, an attempt that is not an Integer) goes back before any statement, so Rails raises where it did.
// Golden: __fixtures__/mcp-deliver-event-job.golden.json (scripts/golden/mcp-deliver-event-job.rb).
import { Prisma } from "@prisma/client";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { column, execute, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SUBSCRIPTIONS = "mcp_event_subscriptions";
const TOKENS = "oauth_access_tokens";

type Subscription = { id: bigint | number; user_id: bigint | number; oauth_application_id: bigint | number };

export const mcpDeliverEventJobWith = modelJob(
  { min: 2, max: 3 },
  async ([subscriptionId, event, attempt = 0], deps) => {
    if (typeof event !== "object" || event === null || Array.isArray(event))
      throw new HandBackToRuby("the event is not a Hash");
    if (typeof attempt !== "number" || !Number.isSafeInteger(attempt))
      throw new HandBackToRuby("the attempt is not an Integer");

    // `find_by(id: nil)` asks `id IS NULL`; a String is cast by the column.
    const id = await beforeSideEffects(() =>
      subscriptionId === null ? null : recordIdFrom(subscriptionId, "find_by"),
    );

    // The primary: a refresh can replace the secret, and an unsubscribe or a revocation can land, moments before.
    const subscription = await connectedTo("writing", async () => {
      const [row] = await selectRows<Subscription>(
        Prisma.sql`SELECT ${table(SUBSCRIPTIONS)}.* FROM ${table(SUBSCRIPTIONS)} WHERE (mcp_event_subscriptions.expires_at > ${deps.now()}) AND ${id === null ? Prisma.sql`${column(SUBSCRIPTIONS, "id")} IS NULL` : Prisma.sql`${column(SUBSCRIPTIONS, "id")} = ${id}`} LIMIT 1`,
      );
      return row ?? null;
    });
    if (subscription === null) return;

    // Doorkeeper::AccessToken.active_for(user_id).where(application_id:), as the first step of `access_granted?`.
    const tokens = await connectedTo("writing", () =>
      selectRows(
        Prisma.sql`SELECT ${table(TOKENS)}.* FROM ${table(TOKENS)} WHERE ${column(TOKENS, "resource_owner_id")} = ${subscription.user_id} AND ${column(TOKENS, "revoked_at")} IS NULL AND ${column(TOKENS, "application_id")} = ${subscription.oauth_application_id}`,
      ),
    );
    if (tokens.length > 0) throw new HandBackToRuby("a connection that still holds a token");

    // The secret has no use now. The client subscribes again once it holds a token with the scope.
    await execute(
      Prisma.sql`DELETE FROM ${table(SUBSCRIPTIONS)} WHERE ${column(SUBSCRIPTIONS, "id")} = ${subscription.id}`,
    );
  },
);
export const mcpDeliverEventJob = mcpDeliverEventJobWith();
