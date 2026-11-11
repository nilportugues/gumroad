// Port of app/sidekiq/submit_to_indexnow_job.rb: tells IndexNow about the products' pages, one POST per host because IndexNow wants every
// URL of a submission on the host it names. A non-2xx answer raises so Sidekiq retries. An id Ruby would cast (a float, a non-numeric
// string, a nested list), a key with characters URI.join would reject and a host with more than MAX_URLS_PER_SUBMISSION URLs (no golden
// case: it needs 10,001 products) are handed back before any statement or request.
// Golden: __fixtures__/submit-to-indexnow-job.golden.json (scripts/golden/submit-to-indexnow-job.rb), recorded with WebMock answering.
import { Prisma } from "@prisma/client";

import { getConfig } from "../../server/infra/config.ts";
import { domainConfig } from "../../server/infra/domain.ts";
import { outboundFetch } from "../../server/infra/outbound-http.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { columnIn, selectRows, table } from "../../server/models/sql.ts";
import { subdomainFromUsername } from "../../server/models/user.ts";
import { longUrl } from "../../server/presenters/product.ts";

import { modelJob } from "./support/job-deps.ts";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS_PER_SUBMISSION = 10_000;
const TIMEOUT_MS = 10_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const LINKS = "links";
const USERS = "users";

type LinkRow = Parameters<typeof longUrl>[0];
type UserRow = Parameters<typeof longUrl>[1];

function productIds(arg: JsonValue | undefined): bigint[] {
  // Array.wrap
  const list = arg === null || arg === undefined ? [] : Array.isArray(arg) ? arg : [arg];
  return list.map((id) => {
    if (typeof id === "number" && Number.isSafeInteger(id)) return BigInt(id);
    if (typeof id === "string" && /^[0-9]{1,15}$/u.test(id)) return BigInt(id);
    throw new HandBackToRuby("a product id Rails would cast");
  });
}

// User#subdomain_with_protocol, which falls back to the external id for a seller without a username.
function hostFor(seller: UserRow & { external_id: string | null }): string {
  const config = domainConfig();
  const name = isBlank(seller.username) ? seller.external_id : seller.username;
  const subdomain = subdomainFromUsername(name);
  return subdomain === null ? `${config.protocol}://${config.domain}` : `${config.protocol}://${subdomain}`;
}

export const submitToIndexnowJobWith = modelJob({ min: 1, max: 1 }, async (args) => {
  const key = getConfig("INDEXNOW_KEY");
  if (key === undefined || key === "") return;
  if (!KEY_PATTERN.test(key)) throw new HandBackToRuby("an IndexNow key that URI.join would not take as a path");

  const ids = productIds(args[0]);
  // `where(id: [])` is answered without a query.
  if (ids.length === 0) return;

  const links = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table(LINKS)} WHERE ${columnIn(LINKS, "id", ids)}`,
  );
  // `includes(:user)`: one query for the distinct, non-null user ids in the order the links came back.
  const userIds = [...new Set(links.map((link) => link.user_id).filter((id) => id !== null))];
  const sellers = new Map<string, UserRow & { external_id: string | null }>();
  if (userIds.length > 0) {
    const rows = await selectRows<UserRow & { id: bigint | number; external_id: string | null }>(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table(USERS)} WHERE ${columnIn(USERS, "id", userIds)}`,
    );
    for (const row of rows) sellers.set(String(row.id), row);
  }

  const urls = [
    ...new Set(
      links.map((link) => {
        const seller = link.user_id === null ? undefined : sellers.get(String(link.user_id));
        if (seller === undefined) throw new Error("undefined method 'subdomain_with_protocol' for nil");
        return longUrl(link, seller, { host: hostFor(seller) });
      }),
    ),
  ];
  if (urls.length === 0) return;

  const byHost = new Map<string, string[]>();
  for (const url of urls) {
    const host = new URL(url).hostname;
    byHost.set(host, [...(byHost.get(host) ?? []), url]);
  }
  for (const [host, hostUrls] of byHost) {
    if (hostUrls.length > MAX_URLS_PER_SUBMISSION)
      throw new HandBackToRuby("more URLs for one host than a single submission takes");
    const keyLocation = new URL(`/${key}.txt`, hostUrls[0]).toString();
    const response = await outboundFetch(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ host, key, keyLocation, urlList: hostUrls }),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Non-success responses must raise so Sidekiq retries; swallowing them drops the indexing signal.
    if (!response.ok) throw new Error(`IndexNow submission failed: ${response.status}`);
  }
});

export const submitToIndexnowJob = submitToIndexnowJobWith();
