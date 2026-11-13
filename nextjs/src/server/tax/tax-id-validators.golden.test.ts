import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bahrainTrn,
  isBlank,
  kenyaKraPin,
  nigeriaFirsTin,
  omanVatNumber,
  regionalVatIdValidator,
  tanzaniaTraTin,
} from "./regional-vat-id-shape.ts";

// Recorded by scripts/golden/tax-id-validators.rb: the real service classes on edge-case ids, and
// RegionalVatIdValidationService#process routed over every ISO country, a state and blank ids.
type Golden = {
  validators: Record<string, { id: string | null; valid: boolean }[]>;
  routes: {
    id: string | null;
    country: string | null;
    state: string | null;
    service: string | null;
    result: boolean | null;
  }[];
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/tax-id-validators.golden.json", import.meta.url), "utf8"),
) as Golden;

const validators: Record<string, (value: string | null) => boolean> = {
  oman: omanVatNumber,
  bahrain: bahrainTrn,
  kenya: kenyaKraPin,
  nigeria: nigeriaFirsTin,
  tanzania: tanzaniaTraTin,
};

const LOCAL_SERVICE_BY_VALIDATOR = new Map<(value: string | null | undefined) => boolean, string>([
  [bahrainTrn, "TrnValidationService"],
  [kenyaKraPin, "KraPinValidationService"],
  [nigeriaFirsTin, "FirsTinValidationService"],
  [tanzaniaTraTin, "TraTinValidationService"],
  [omanVatNumber, "OmanVatNumberValidationService"],
]);

describe("offline tax-id validators against the Ruby golden", () => {
  it.each(Object.entries(golden.validators))("%s answers as the Ruby service does", (name, cases) => {
    const validate = validators[name]!;
    const mismatches = cases.filter(({ id, valid }) => validate(id) !== valid).map(({ id }) => id);
    expect(mismatches).toEqual([]);
    expect(cases.length).toBeGreaterThan(50);
    expect(cases.some(({ valid }) => valid)).toBe(true);
    expect(cases.some(({ valid }) => !valid)).toBe(true);
  });
});

describe("RegionalVatIdValidationService routing against the Ruby golden", () => {
  it("routes every recorded country, state and id to the service Rails called", () => {
    const mismatches = golden.routes
      .filter(({ id }) => id !== null && !isBlank(id))
      .flatMap(({ id, country, state, service, result }) => {
        const route = regionalVatIdValidator(country, state);
        const actual = route.kind === "local" ? LOCAL_SERVICE_BY_VALIDATOR.get(route.validate) : route.service;
        const local = route.kind === "local" ? route.validate(id) : undefined;
        const wrong = actual !== service || (local !== undefined && local !== result);
        return wrong ? [{ id, country, state, expected: { service, result }, actual: { service: actual, local } }] : [];
      });
    expect(mismatches).toEqual([]);
  });

  it("rejects a blank id before routing", () => {
    const blank = golden.routes.filter(({ id }) => id === null || isBlank(id));
    expect(blank.length).toBeGreaterThan(0);
    for (const route of blank) {
      expect(route.service).toBeNull();
      expect(route.result).toBe(false);
    }
  });

  it("covers every country and the Quebec split", () => {
    expect(new Set(golden.routes.map(({ country }) => country)).size).toBeGreaterThan(240);
    const quebec = golden.routes.filter(({ country, state }) => country === "CA" && state === "QC");
    expect(quebec.map(({ service }) => service)).toEqual(["QstValidationService"]);
  });
});
