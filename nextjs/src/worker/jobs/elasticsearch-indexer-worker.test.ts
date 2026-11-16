// Replays the ElasticsearchIndexerWorker cases of search.golden.json (generate-search-golden.rb):
// same SQL, same Elasticsearch requests byte for byte, same error, same Sidekiq pushes.
import { describe, it } from "vitest";

import { replayJobCase, rubyRegistry } from "../../server/search/__fixtures__/job-harness.ts";
import { searchGolden } from "../../server/search/__fixtures__/search-golden.ts";
import { elasticsearchIndexerWorkerWith } from "./elasticsearch-indexer-worker.ts";

describe("ElasticsearchIndexerWorker", () => {
  for (const golden of searchGolden.jobs.ElasticsearchIndexerWorker!) {
    it(golden.name, async () => {
      const ignore = golden.ignore_404 ?? [];
      const handler = elasticsearchIndexerWorkerWith({
        featureActive: async (name) => (golden.features ?? []).includes(name),
        smembers: async () => ignore,
        rand: () => searchGolden.rand,
        sleep: async () => {},
      });
      await replayJobCase(golden, handler, { registry: rubyRegistry("ElasticsearchIndexerWorker") });
    });
  }
});
