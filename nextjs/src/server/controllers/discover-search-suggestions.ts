// Discover::SearchAutocompleteController#delete_search_suggestion: the "x" next to a recent search in the Discover search box.
import { Prisma } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";

import { HandBackToRails } from "./application-controller.ts";
import { guidOf } from "./discover-page.ts";
import { registerMutations } from "./mutation.ts";
import { noContent } from "./seller-json.ts";

const mysqlTime = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "000");

registerMutations({
  method: "DELETE",
  pattern: "/discover_search_autocomplete",
  // No Pundit here, so a JSON or XML request gets the same 204.
  formats: ["any"],
  run: async ({ request, context, chain, params }) => {
    const query = params.query;
    // `where(query: ["a", "b"])` is an IN list, and an empty one matches nothing.
    const isList = Array.isArray(query) && query.every((item) => typeof item === "string");
    if (query !== undefined && query !== null && typeof query !== "string" && !isList)
      throw new HandBackToRails("a query that is not a string or a list of strings");

    const user = railsLoggedInUser(context);
    // `where(discover_searches: { browser_guid:, user: nil })` for a visitor, `{ user: }` for a signed-in one.
    const guid = user === null ? guidOf(request, chain.guid) : null;
    const owner =
      user !== null
        ? Prisma.sql`${column("discover_searches", "user_id")} = ${user.id}`
        : Prisma.sql`${column("discover_searches", "browser_guid")} ${guid === null ? Prisma.sql`IS NULL` : Prisma.sql`= ${guid}`} AND ${column("discover_searches", "user_id")} IS NULL`;
    if (isList && query.length === 0) return noContent();
    const queryColumn = column("discover_searches", "query");
    const matching =
      query === undefined || query === null
        ? Prisma.sql`${queryColumn} IS NULL`
        : isList
          ? Prisma.sql`${queryColumn} IN (${Prisma.join(query as string[])})`
          : Prisma.sql`${queryColumn} = ${query as string}`;

    const suggestions = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("discover_search_suggestions", "id")} FROM ${table("discover_search_suggestions")} INNER JOIN ${table("discover_searches")} ON ${column("discover_searches", "id")} = ${column("discover_search_suggestions", "discover_search_id")} WHERE ${column("discover_search_suggestions", "deleted_at")} IS NULL AND ${owner} AND ${matching}`,
    );
    if (suggestions.length > 0) {
      const stamp = mysqlTime(new Date());
      await execute(
        Prisma.sql`UPDATE ${table("discover_search_suggestions")} SET ${column("discover_search_suggestions", "deleted_at")} = ${stamp}, ${column("discover_search_suggestions", "updated_at")} = ${stamp} WHERE ${column("discover_search_suggestions", "id")} IN (${Prisma.join(suggestions.map((row) => row.id))})`,
      );
    }
    return noContent();
  },
});
