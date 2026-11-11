import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { esJson } from "../../search/es-json.ts";
import { setEsSender, type EsRequest } from "../../search/transport.ts";

import { installmentSearchBody, searchInstallments, type InstallmentListType } from "./installment-search.ts";

// Replays installment-search.golden.json, recorded from the real InstallmentSearchService against
// Elasticsearch by spec/services/installment_search_service_golden_spec.rb.
type Case = {
  name: string;
  seller_id: number;
  type: InstallmentListType;
  query: string;
  page: number;
  ids: number[];
  total: number;
  exchanges: { method: string; path: string; body: string; status: number; response: unknown }[];
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/installment-search.golden.json", import.meta.url), "utf8"),
) as { cases: Case[] };

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("installment search", () => {
  it("has recorded cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(5);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))(
    "sends the body Rails sent and reads the ids and total: %s",
    async (_name, recorded) => {
      const options = {
        sellerId: recorded.seller_id,
        type: recorded.type,
        q: recorded.query.trim(),
        from: (recorded.page - 1) * 25,
        size: 25,
      };
      expect(esJson(installmentSearchBody(options))).toBe(recorded.exchanges[0]!.body);

      const sent: EsRequest[] = [];
      restore = setEsSender(async (request) => {
        sent.push(request);
        return { status: recorded.exchanges[0]!.status, body: recorded.exchanges[0]!.response };
      });
      const result = await searchInstallments(options);

      expect(result).toEqual({ ids: recorded.ids, total: recorded.total });
      expect(sent[0]!.method).toBe("POST");
      expect(sent[0]!.path).toMatch(/\/_search$/);
    },
  );
});
