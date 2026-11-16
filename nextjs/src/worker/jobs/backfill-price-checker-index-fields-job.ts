// Port of app/sidekiq/backfill_price_checker_index_fields_job.rb and Onetime::BackfillPriceCheckerIndexFields: every indexed product
// gets a SendToElasticsearchWorker update for the price checker fields, one page of the scroll per JOB_INTERVAL_SECONDS.
// Golden: __fixtures__/backfill-price-checker-index-fields-job.golden.json (scripts/golden/backfill-price-checker-index-fields-job.rb).
import { indexName } from "../../server/infra/elasticsearch.ts";
import { pushBulkWith } from "../../server/jobs/push-bulk.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { currentJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import { rubyStringToBigInt } from "../../server/models/concerns/ruby-numeric.ts";
import { clearScroll, scrollById, search } from "../../server/search/api.ts";
import type { EsResponse } from "../../server/search/transport.ts";

import { modelJob } from "./support/job-deps.ts";

const SEND_TO_ELASTICSEARCH_WORKER = "SendToElasticsearchWorker";
const SCROLL_SIZE = 5_000;
const SCROLL_SORT = ["_doc"];
const SCROLL_KEEP_ALIVE = "1m";
const JOB_INTERVAL_SECONDS = 10;
const ATTRIBUTES_TO_UPDATE = ["price_currency_type", "customizable_price", "native_type"];

type Body = { _scroll_id?: string | null; hits?: { hits?: { _id: string }[] | null } | null } | null;

const bodyOf = (response: EsResponse) => response.body as Body;
// `response.dig("hits", "hits") || []`
const hitsOf = (response: EsResponse) => bodyOf(response)?.hits?.hits ?? [];
const scrollIdOf = (response: EsResponse) => bodyOf(response)?._scroll_id ?? null;

export const backfillPriceCheckerIndexFieldsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  let response: EsResponse | null = null;
  try {
    response = await search({
      index: indexName("Link"),
      scroll: SCROLL_KEEP_ALIVE,
      body: { query: { match_all: {} } },
      size: SCROLL_SIZE,
      sort: SCROLL_SORT,
      source: false,
    });
    let secondsOffset = 0;
    for (;;) {
      const hits = hitsOf(response);
      if (hits.length === 0) break;

      const args: JsonValue[][] = hits.map((hit) => [
        rubyStringToBigInt(String(hit._id)),
        "update",
        ATTRIBUTES_TO_UPDATE,
      ]);
      const at = Math.floor(deps.now().getTime() / 1000) + secondsOffset;
      await pushBulkWith(currentJobsRuntime(), { class: SEND_TO_ELASTICSEARCH_WORKER, args, queue: "low", at });
      secondsOffset += JOB_INTERVAL_SECONDS;

      response = await scrollById({ scrollId: scrollIdOf(response), scroll: SCROLL_KEEP_ALIVE });
    }
  } finally {
    // Whichever scroll was answered last is cleared, also when a later request raised.
    const scrollId = response === null ? null : scrollIdOf(response);
    if (scrollId !== null) await clearScroll(scrollId);
  }
});

export const backfillPriceCheckerIndexFieldsJob = backfillPriceCheckerIndexFieldsJobWith();
