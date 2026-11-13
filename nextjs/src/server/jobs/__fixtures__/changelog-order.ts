import type { JsonValue } from "../sidekiq/ruby-json.ts";

type ChangelogView = { messages?: string[] };

// The changelog zset members share one score, so their order is the lexicographic order of the JSON the Lua writes with cjson.encode,
// and cjson orders object keys by the Lua build. The goldens were recorded on a server that put `message` first; Valkey 8.1.10 writes
// `digest, script, message, time, job_id`. The messages written are the contract, not their order.
export function withSortedChangelog<T>(state: T): T {
  const view = state as unknown as Record<string, ChangelogView | JsonValue>;
  const changelog = view["uniquejobs:changelog"] as ChangelogView | undefined;
  if (!changelog || !Array.isArray(changelog.messages)) return state;
  return {
    ...view,
    "uniquejobs:changelog": { ...changelog, messages: [...changelog.messages].sort() },
  } as unknown as T;
}
