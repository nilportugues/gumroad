// Loads search.golden.json (see generate-search-golden.rb).
import { readFileSync } from "node:fs";

import { type JsonValue, parseRubyJson } from "../../jobs/sidekiq/ruby-json.ts";
import type { RedisSnapshot } from "../../../worker/jobs/__fixtures__/golden.ts";
import type { Statement } from "../../../worker/jobs/__fixtures__/sql-replay.ts";

export type EsRequestRecord = { method: string; path: string; query: string | null; body: string | null };
export type SearchCase = {
  name: string;
  args?: JsonValue[];
  error: { class: string; message: string } | null;
  result: JsonValue;
  statements: Statement[];
  es: EsRequestRecord[];
  redis: RedisSnapshot;
  es_responses?: [number, JsonValue][];
  features?: string[];
  ignore_404?: string[];
};

export type SearchGolden = {
  now: number;
  rand: number;
  search_fields: Record<string, string[]>;
  attribute_to_search_fields: Record<string, Record<string, string | string[]>>;
  purchase_documents: SearchCase[];
  installment_documents: SearchCase[];
  audience_member_documents: SearchCase[];
  referrer_domains: [string | null, string | { error: string; message: string }][];
  plaintext_descriptions: [string | null, string][];
  html4_entity_count: number;
  es_requests: { name: string; ruby: EsRequestRecord[] }[];
  jobs: Record<string, SearchCase[]>;
};

export const searchGolden = parseRubyJson(readFileSync(new URL("search.golden.json", import.meta.url), "utf8")) as unknown as SearchGolden;
