// Port of ThirdPartyAnalyticsController#profile (app/controllers/third_party_analytics_controller.rb): the seller's universal raw
// snippets for the profile page, served on the third-party analytics host. `index` (`/:link_id`) is not ported.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../models/sql.ts";

import { RoutingError, type ActionContext, type Rendered } from "./application-controller.ts";
import { deleteCookieHeader } from "./signed-in-filters.ts";

export const OVERRIDE_WINDOW_ACTIONS_CODE = `<script type="text/javascript">
try { window.alert = function() {}; } catch(error) { }
try { window.confirm = function() {}; } catch(error) { }
try { window.prompt = function() {}; } catch(error) { }
try { window.print = function() {}; } catch(error) { }
</script>`;

export const OVERRIDE_ON_CLOSE_CODE = `<script type="text/javascript">
try { window.onbeforeunload = null; } catch(error) { }
try { window.onabort = null; } catch(error) { }
</script>`;

// app/views/third_party_analytics/index.html.erb, rendered with `layout: false`.
const page = (snippets: string) => `<!DOCTYPE html>\n<html>\n  <body>\n    ${snippets}\n  </body>\n</html>\n`;

// after_action :erase_cookies_and_skip_session: `cookies.clear` expires the cookies the visitor sent and the guid this request minted.
// They come after the cookies the response set, so a minted guid is written and then erased.
export function erasedCookies({ request, chain }: Pick<ActionContext, "request" | "chain">): string[] {
  const names = [...request.cookies.keys()];
  if (chain.guid !== null) names.push("_gumroad_guid");
  return [...new Set(names)].map((name) => deleteCookieHeader(name, { httpOnly: true }));
}

export async function profile(username: string, action: ActionContext): Promise<Rendered> {
  const [user] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${Prisma.raw("`users`.`id`")} FROM ${table("users")} WHERE ${column("users", "username")} = ${username} AND ${column("users", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (!user) throw new RoutingError("Not Found");

  const rows = await selectRows<{ analytics_code: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`third_party_analytics`.`analytics_code`")} FROM ${table("third_party_analytics")} WHERE ${column("third_party_analytics", "user_id")} = ${user.id} AND ${column("third_party_analytics", "link_id")} IS NULL AND ${column("third_party_analytics", "deleted_at")} IS NULL AND ${column("third_party_analytics", "location")} = 'all'`,
  );
  const snippets = rows.map((row) => row.analytics_code ?? "").join("\n");
  const body = OVERRIDE_WINDOW_ACTIONS_CODE + snippets + OVERRIDE_ON_CLOSE_CODE;
  return { status: 200, body: page(body), contentType: "text/html; charset=utf-8", paramsRead: true, cookies: erasedCookies(action) };
}
