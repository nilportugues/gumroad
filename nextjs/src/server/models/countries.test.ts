// Replays countries.golden.json (scripts/golden/countries.rb), which Ruby recorded from the `countries` gem
// with config/initializers/countries.rb applied, and checks the generated data still matches the Ruby
// files and gem versions it was generated from.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import COUNTRY_DATA from "./countries.generated.json" with { type: "json" };
import {
  alpha2ByName,
  countryByAlpha2,
  countryByAlpha3,
  COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT,
  findByName,
  findCountryByAlpha3,
  historicalNames,
  isBlank,
  isBlockedCountry,
  isRiskPhysicalBlocked,
  mapping,
  parsedNameIndex,
  parseCountryName,
} from "./compliance-countries.ts";

const golden = JSON.parse(readFileSync(new URL("./__fixtures__/countries.golden.json", import.meta.url), "utf8")) as {
  index: Record<string, string>;
  mapping: Array<[string, string]>;
  codes: Array<[string, string, string | null, string | null, string | null]>;
  historical_names: Record<string, string[]>;
  find_by_name: Array<{ name: string | null; alpha2: string | null; common_name: string | null }>;
  find_by_alpha3: Array<[string | null, string | null]>;
  normalized: Array<[string, string]>;
  blocked: Array<[string, boolean, boolean]>;
};

const repoFile = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("generated country data", () => {
  const REGENERATE = "run `BUNDLE_GEMFILE=Gemfile bundle exec ruby nextjs/scripts/golden/countries.rb` and commit the result";

  it("was generated from the gem versions in Gemfile.lock", () => {
    const lock = repoFile("Gemfile.lock");
    for (const [gem, version] of Object.entries(COUNTRY_DATA.gems)) {
      expect(lock.includes(`\n    ${gem} (${version})\n`), `${gem} ${version} is not in Gemfile.lock: ${REGENERATE}`).toBe(true);
    }
  });

  for (const [path, expected] of Object.entries(COUNTRY_DATA.source_digests)) {
    it(`matches ${path}`, () => {
      let text = repoFile(path);
      // The manager is digested by its list of countries alone.
      if (path.endsWith("stripe_merchant_account_manager.rb")) {
        text = /COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT = (\[.*?\])\.map \{ \|country_name\|/su.exec(text)?.[1] ?? "";
      }
      expect(digest(text), `${path} changed: ${REGENERATE}`).toBe(expected);
    });
  }
});

describe("Compliance::Countries", () => {
  it("searches the names Ruby searches, parsed alike", () => {
    expect(Object.fromEntries(parsedNameIndex())).toEqual(golden.index);
  });

  it("lists the countries of Compliance::Countries.mapping in order", () => {
    expect(mapping()).toEqual(golden.mapping);
  });

  it("finds the country Ruby finds for each of the probes", () => {
    for (const { name, alpha2, common_name } of golden.find_by_name) {
      expect(alpha2ByName(name)).toBe(alpha2);
      expect(findByName(name)?.common_name ?? null).toBe(common_name);
    }
  });

  it("looks countries up by alpha2 and alpha3 in any case", () => {
    for (const [alpha2, alpha3, currency, byAlpha2, byAlpha3] of golden.codes) {
      expect(countryByAlpha2(alpha2.toLowerCase())?.alpha3).toBe(byAlpha2);
      expect(countryByAlpha3(alpha3.toLowerCase())?.alpha2).toBe(byAlpha3);
      expect(countryByAlpha2(alpha2)?.currency_code ?? null).toBe(currency);
    }
    expect(countryByAlpha2("ZZ")).toBeNull();
    expect(countryByAlpha3("ZZZ")).toBeNull();
  });

  it("finds a country by alpha3 as find_country_by_alpha3 does", () => {
    for (const [probe, alpha2] of golden.find_by_alpha3) expect(findCountryByAlpha3(probe)?.alpha2 ?? null, JSON.stringify(probe)).toBe(alpha2);
  });

  it("normalizes names as ISO3166::Country.parse_value does", () => {
    const wrong = golden.normalized.filter(([input, expected]) => parseCountryName(input) !== expected);
    expect(wrong).toEqual([]);
  });

  it("answers historical_names for every country", () => {
    for (const [alpha2, names] of Object.entries(golden.historical_names)) {
      const country = mapping().find(([code]) => code === alpha2)!;
      expect(historicalNames(country[1])).toEqual(names);
    }
    expect(historicalNames("Narnia")).toEqual([]);
    expect(historicalNames(null)).toEqual([]);
  });

  it("answers blocked? and risk_physical_blocked?", () => {
    for (const [alpha2, blocked, risk] of golden.blocked) {
      expect([isBlockedCountry(alpha2), isRiskPhysicalBlocked(alpha2)]).toEqual([blocked, risk]);
    }
  });

  it("treats whitespace the way String#blank? does", () => {
    for (const blank of ["", " ", "\t\n\r\f\v", " ", "　", "\u0085"]) expect(isBlank(blank)).toBe(true);
    for (const present of ["a", " a ", "﻿", "​"]) expect(isBlank(present)).toBe(false);
  });

  it("lists the Stripe Connect countries as alpha2 codes", () => {
    expect(COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT).toHaveLength(41);
    expect(COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT).toContain("HK");
    expect(COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT).not.toContain("IN");
  });
});
