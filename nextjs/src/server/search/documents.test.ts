// Replays search.golden.json's documents: for each case the Node builder must send the statements
// Rails sent (given the same answers) and produce the same document, compared as the bytes EsClient
// would send.
import { describe, expect, it } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { searchGolden, type SearchCase } from "./__fixtures__/search-golden.ts";
import { PURCHASE_ATTRIBUTE_TO_SEARCH_FIELDS, PURCHASE_SEARCH_FIELDS, PurchaseRecord } from "./documents/purchase.ts";
import {
  AUDIENCE_MEMBER_ATTRIBUTE_TO_SEARCH_FIELDS,
  AUDIENCE_MEMBER_SEARCH_FIELDS,
  AudienceMemberRecord,
  INSTALLMENT_ATTRIBUTE_TO_SEARCH_FIELDS,
  INSTALLMENT_SEARCH_FIELDS,
  InstallmentRecord,
} from "./documents/simple.ts";
import { esJson, type JsonValue } from "./es-json.ts";
import { HTML4_ENTITIES } from "./html4-entities.generated.ts";
import { plaintextDescription } from "./plaintext.ts";
import { extractDomain } from "./referrer.ts";

type Loader = (id: number) => Promise<{ asIndexedJson(only?: readonly string[]): Promise<Record<string, JsonValue>> } | null>;

// The case names say which record and fields each golden block indexes.
const CALLS: Record<string, { id: number; only?: string[] }> = {
  "original subscription purchase": { id: 1 },
  "recurring charge of a recommended, chargeback-reversed sale": { id: 2 },
  "gift subscription whose member has no account": { id: 3 },
  "plain sale with no email": { id: 4 },
  "missing product": { id: 5 },
  "only some fields": { id: 1, only: ["email", "subscription_current_email", "subscription_current_email_domain", "variant_ids", "subscription_cancelled_at"] },
  installment: { id: 60 },
  "installment fields": { id: 60, only: ["selected_flags", "name"] },
  "audience member": { id: 90 },
  "audience member without details": { id: 90 },
};

async function replay(golden: SearchCase, load: Loader) {
  const replayer = sqlReplay(golden.statements);
  const call = CALLS[golden.name]!;
  let result: JsonValue = null;
  let error: { class: string; message: string } | null = null;
  try {
    const record = await load(call.id);
    if (!record) throw new Error("not found");
    result = await record.asIndexedJson(call.only);
  } catch (e) {
    error = { class: (e as Error).name, message: (e as Error).message };
    if (process.env.DEBUG_SEARCH) console.log(e);
  }
  expect(replayer.log).toEqual(replayer.expected);
  expect(error).toEqual(golden.error);
  if (!golden.error) expect(esJson(result)).toBe(esJson(golden.result));
}

describe("Purchase::Searchable#as_indexed_json", () => {
  it("lists the mapping's fields in Rails' order", () => {
    expect([...PURCHASE_SEARCH_FIELDS]).toEqual(searchGolden.search_fields.Purchase);
    expect(PURCHASE_ATTRIBUTE_TO_SEARCH_FIELDS).toEqual(searchGolden.attribute_to_search_fields.Purchase);
  });
  for (const golden of searchGolden.purchase_documents) {
    it(golden.name, () => replay(golden, (id) => PurchaseRecord.find(id)));
  }
});

describe("Installment::Searchable#as_indexed_json", () => {
  it("lists the mapping's fields in Rails' order", () => {
    expect([...INSTALLMENT_SEARCH_FIELDS]).toEqual(searchGolden.search_fields.Installment);
    expect(INSTALLMENT_ATTRIBUTE_TO_SEARCH_FIELDS).toEqual(searchGolden.attribute_to_search_fields.Installment);
  });
  for (const golden of searchGolden.installment_documents) {
    it(golden.name, () => replay(golden, (id) => InstallmentRecord.find(id)));
  }
});

describe("AudienceMember::Searchable#as_indexed_json", () => {
  it("lists the mapping's fields in Rails' order", () => {
    expect([...AUDIENCE_MEMBER_SEARCH_FIELDS]).toEqual(searchGolden.search_fields.AudienceMember);
    expect(AUDIENCE_MEMBER_ATTRIBUTE_TO_SEARCH_FIELDS).toEqual(searchGolden.attribute_to_search_fields.AudienceMember);
  });
  for (const golden of searchGolden.audience_member_documents) {
    it(golden.name, () => replay(golden, (id) => AudienceMemberRecord.find(id)));
  }
});

describe("Referrer.extract_domain", () => {
  for (const [url, expected] of searchGolden.referrer_domains) {
    it(JSON.stringify(url), () => {
      if (typeof expected === "string") expect(extractDomain(url)).toBe(expected);
      else expect(() => extractDomain(url)).toThrow(expected.message);
    });
  }
});

describe("Link#plaintext_description", () => {
  it("knows every entity libxml2 decodes", () => {
    expect(Object.keys(HTML4_ENTITIES)).toHaveLength(searchGolden.html4_entity_count);
  });
  for (const [description, expected] of searchGolden.plaintext_descriptions) {
    it(JSON.stringify(description), () => expect(plaintextDescription(description)).toBe(expected));
  }
});
