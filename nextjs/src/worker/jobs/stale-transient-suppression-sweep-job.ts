// Port of app/sidekiq/stale_transient_suppression_sweep_job.rb up to the first suppression it could clear. For each subuser with an API
// key, Node pages through the bounce and block lists (SendGrid's suppression API, limit/offset over the 3-to-60-day window) exactly as
// Rails does and finishes when no list holds an entry with an email. An entry with one means classifying the reason, the owner's last
// sign-in and the DELETE, and a failed request, a non-array body or a body that is not JSON means Rails notifies and moves on; all of
// these hand back to Rails (nothing has been written by then: the sweep's only write is the DELETE).
// Golden: __fixtures__/stale-transient-suppression-sweep-job.golden.json (scripts/golden/stale-transient-suppression-sweep-job.rb).
import { getConfig } from "../../server/infra/config.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const SENDGRID_API = "https://api.sendgrid.com/v3/suppression";
// SWEPT_LISTS
const SWEPT_LISTS = ["bounces", "blocks"] as const;
const SECONDS_PER_DAY = 24 * 60 * 60;
// MIN_SUPPRESSION_AGE and LOOKBACK_WINDOW
const MIN_SUPPRESSION_AGE_SECONDS = 3 * SECONDS_PER_DAY;
const LOOKBACK_WINDOW_SECONDS = 60 * SECONDS_PER_DAY;
const PAGE_SIZE = 500;
const MAX_PAGES_PER_LIST = 20;
// EmailSuppressionManager.subuser_api_keys, in its order
const SUBUSER_KEY_VARIABLES = [
  "SENDGRID_GUMROAD_TRANSACTIONS_API_KEY",
  "SENDGRID_GUMROAD_FOLLOWER_CONFIRMATION_API_KEY",
  "SENDGRID_GR_CREATORS_API_KEY",
  "SENDGRID_GR_CUSTOMERS_API_KEY",
  "SENDGRID_GR_CUSTOMERS_LEVEL_2_API_KEY",
] as const;

export type SuppressionFetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
export type SweepDeps = {
  // Time.current
  now: () => Date;
  // GlobalConfig.get of the subuser keys
  apiKeys: () => (string | undefined)[];
  fetch: SuppressionFetch;
};

const defaultSweepDeps: SweepDeps = {
  now: () => new Date(),
  apiKeys: () => SUBUSER_KEY_VARIABLES.map((name) => getConfig(name)),
  fetch: (url, init) => fetch(url, init),
};

// Object#present? on an entry's email
function present(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// fetch_page and the usable entries of one page. Anything but a 2xx array is Rails' ErrorNotifier path.
async function usableEntriesOfPage(
  deps: SweepDeps,
  apiKey: string,
  list: string,
  offset: number,
): Promise<{ size: number; usable: number }> {
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const query = new URLSearchParams({
    end_time: String(nowSeconds - MIN_SUPPRESSION_AGE_SECONDS),
    limit: String(PAGE_SIZE),
    offset: String(offset),
    start_time: String(nowSeconds - LOOKBACK_WINDOW_SECONDS),
  });
  let response: Response;
  let page: unknown;
  try {
    response = await deps.fetch(`${SENDGRID_API}/${list}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    page = response.status >= 200 && response.status <= 299 ? ((await response.json()) as unknown) : null;
  } catch {
    throw new HandBackToRuby(`a SendGrid ${list} request that failed`);
  }
  if (!Array.isArray(page)) throw new HandBackToRuby(`a SendGrid ${list} response that is not a list`);
  const usable = page.filter(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      present((entry as { email?: unknown }).email),
  );
  return { size: page.length, usable: usable.length };
}

export const staleTransientSuppressionSweepJobWith =
  (overrides: Partial<SweepDeps> = {}): JobHandler =>
  async (args: JsonValue[]) => {
    checkArity(args, 0);
    const deps = { ...defaultSweepDeps, ...overrides };
    for (const apiKey of deps.apiKeys()) {
      if (apiKey === undefined || apiKey.trim() === "") continue;
      for (const list of SWEPT_LISTS) {
        for (let page = 0; page < MAX_PAGES_PER_LIST; page += 1) {
          const { size, usable } = await usableEntriesOfPage(deps, apiKey, list, page * PAGE_SIZE);
          if (usable > 0) throw new HandBackToRuby(`a stale ${list} suppression that may be cleared`);
          // A short page is the end of the list.
          if (size < PAGE_SIZE) break;
        }
      }
    }
  };
export const staleTransientSuppressionSweepJob = staleTransientSuppressionSweepJobWith();
