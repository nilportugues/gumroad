// Discover::SearchAutocompleteController#delete_search_suggestion: the "x" next to a recent search in the Discover search box.
import { Prisma } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { RubyFloat } from "../models/concerns/ruby-values.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";

import { HandBackToRails } from "./application-controller.ts";
import { guidOf } from "./discover-page.ts";
import { registerMutations } from "./mutation.ts";
import { requestParams } from "./rails-body.ts";
import { noContent } from "./seller-json.ts";
import { stringValue } from "./settings-mutations.ts";

const mysqlTime = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "000");

registerMutations({
  method: "DELETE",
  pattern: "/discover_search_autocomplete",
  // No Pundit here, so a JSON or XML request gets the same 204.
  formats: ["any"],
  run: async ({ request, context, chain, url, rawBody }) => {
    // A JSON number written as a float stays a RubyFloat, which the column's text cast spells like Float#to_s.
    const raw = requestParams(url, request.headers.get("content-type"), rawBody, true).query;
    // `where(query: 42)` compares the column's text cast (`'42'`, `true` is `'1'`); a list is an IN of those. A hash raises while
    // quoting and a list inside a list is Rails' call (a null in a list never gets here: the params parser hands it back).
    const castScalar = (value: unknown) => (typeof value === "string" ? value : (stringValue(value) as string));
    const isList = Array.isArray(raw);
    if (raw !== undefined && raw !== null && !isList && typeof raw === "object" && !(raw instanceof RubyFloat))
      throw new HandBackToRails("a query that is a hash");
    if (isList && raw.some((item) => item !== null && typeof item === "object" && !(item instanceof RubyFloat)))
      throw new HandBackToRails("a query list holding a list or a hash");
    const query: string | string[] | null | undefined = isList
      ? raw.map(castScalar)
      : raw === undefined || raw === null
        ? raw
        : castScalar(raw);

    const user = railsLoggedInUser(context);
    // `where(discover_searches: { browser_guid:, user: nil })` for a visitor, `{ user: }` for a signed-in one.
    const guid = user === null ? guidOf(request, chain.guid) : null;
    const owner =
      user !== null
        ? Prisma.sql`${column("discover_searches", "user_id")} = ${user.id}`
        : Prisma.sql`${column("discover_searches", "browser_guid")} ${guid === null ? Prisma.sql`IS NULL` : Prisma.sql`= ${guid}`} AND ${column("discover_searches", "user_id")} IS NULL`;
    if (Array.isArray(query) && query.length === 0) return noContent();
    const queryColumn = column("discover_searches", "query");
    const matching =
      query === undefined || query === null
        ? Prisma.sql`${queryColumn} IS NULL`
        : Array.isArray(query)
          ? Prisma.sql`${queryColumn} IN (${Prisma.join(query)})`
          : Prisma.sql`${queryColumn} = ${query}`;

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
