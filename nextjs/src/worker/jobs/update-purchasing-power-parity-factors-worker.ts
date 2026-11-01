// Port of app/sidekiq/update_purchasing_power_parity_factors_worker.rb: downloads the World Bank's PPP
// conversion factors (a zip holding a CSV), turns each country's factor into a discount between 0.4 and 1
// and stores it in the `ppp` Redis namespace. Golden: __fixtures__/
// update-purchasing-power-parity-factors-job.golden.json (scripts/golden/update-purchasing-power-parity-factors-job.rb).
//
// Nothing is written until the whole file has been read and parsed, as in Ruby (`csv.read` parses every row
// before the first `set_factor`), so a file Node cannot read the way Ruby does is handed back to Rails.
import { csvField, CsvNotSupported, parseCsvWithHeaders, type CsvTable } from "../../lib/ruby-csv.ts";
import { openUriRead } from "../../lib/ruby-open-uri.ts";
import { readZipEntry, ZipNotSupported, zipEntries } from "../../lib/ruby-zip.ts";
import { rubyFloatToS } from "../../lib/ruby-to-s.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findCountryByAlpha3 } from "../../server/models/compliance-countries.ts";
import { getRate, rubyStringToF } from "../../server/models/concerns/currency-helper.ts";
import { rubyFloatRoundDigits } from "../../server/models/concerns/ruby-numeric.ts";
import { setFactor } from "../../server/models/purchasing-power-parity.ts";
import { NotPortedError } from "../../server/models/user.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const API_URL = "https://api.worldbank.org/v2/en/indicator/PA.NUS.PPP?downloadformat=csv";
const API_FILE_PREFIX = "API_PA";
const UPPER_THRESHOLD = 0.8;
const LOWER_THRESHOLD = 0.4;
// The CSV's metadata lines before the header
const METADATA_LINES = 4;
// The file may be this many years away from the current one
const MAX_YEAR_DISTANCE = 2;

// High-income countries that should never get PPP discounts
const PPP_EXCLUDED_COUNTRIES: ReadonlySet<string> = new Set([
  ...["AE", "QA", "KW", "BH", "OM", "SA"],
  ...["SG", "HK", "MO", "BN"],
  ...["JP", "KR", "TW"],
  ...["SE", "NO", "DK", "FI", "IS"],
  ...["CH", "LI", "LU"],
  ...["IE", "NL", "BE", "AT", "DE", "FR"],
  "GB",
  ...["AU", "NZ"],
  ...["US", "CA"],
  "IL",
  ...["IT", "ES", "PT"],
]);

export type UpdatePurchasingPowerParityFactorsDeps = {
  // Date.current
  now: () => Date;
  // URI.open(API_URL).read
  read: () => Promise<Uint8Array>;
};

const defaultDeps: UpdatePurchasingPowerParityFactorsDeps = { now: () => new Date(), read: () => openUriRead(API_URL) };

// `Integer(string, exception: false)` for a plain decimal; the other things Integer() reads (0x, 0b, leading
// zero octal, underscores) are not ported, and anything else is nil.
function integerOrNil(header: string | null): number | null {
  if (header === null) return null;
  if (/^[ \t\n\v\f\r]*[+-]?(?:0|[1-9]\d*)[ \t\n\v\f\r]*$/u.test(header)) return Number(header.trim());
  if (/\d/u.test(header)) throw new NotPortedError(`Integer(${JSON.stringify(header)})`, "app/sidekiq/update_purchasing_power_parity_factors_worker.rb:30");
  return null;
}

type Prepared = { table: CsvTable; year: number };

// Everything up to the first write.
function prepare(zip: Uint8Array, now: Date): Prepared {
  try {
    // zip.find { |entry| entry.name.start_with?(API_FILE_PREFIX) }.get_input_stream
    const entry = zipEntries(zip).find((candidate) => candidate.name.startsWith(API_FILE_PREFIX));
    if (entry === undefined) throw new TypeError("undefined method 'get_input_stream' for nil");
    // io.readlines[4..].join: the bytes are read as binary, so each byte is a character
    const lines = readZipEntry(zip, entry).toString("latin1").split(/(?<=\n)/u).filter((line) => line !== "");
    if (lines.length < METADATA_LINES) throw new TypeError("undefined method 'join' for nil");
    const table = parseCsvWithHeaders(lines.slice(METADATA_LINES).join(""));

    // Array#second_to_last
    const year = integerOrNil(table.headers.at(-2) ?? null);
    if (year === null || Math.abs(year - now.getUTCFullYear()) > MAX_YEAR_DISTANCE) throw new Error("Couldn't determine correct year");
    return { table, year };
  } catch (error) {
    if (error instanceof ZipNotSupported) throw new NotPortedError(`a zip Node cannot read: ${error.message}`, "rubyzip");
    if (error instanceof CsvNotSupported) throw new NotPortedError(`a CSV Node cannot read: ${error.message}`, "csv 3.3");
    throw error;
  }
}

export const updatePurchasingPowerParityFactorsWorkerWith =
  (overrides: Partial<UpdatePurchasingPowerParityFactorsDeps> = {}): JobHandler =>
  async (args) => {
    checkArity(args, 0);
    const deps = { ...defaultDeps, ...overrides };
    const { table, year } = await beforeSideEffects(async () => prepare(await deps.read(), deps.now()));

    for (const row of table.rows) {
      const country = findCountryByAlpha3(csvField(table, row, "Country Code"));
      if (country === null) continue;

      if (PPP_EXCLUDED_COUNTRIES.has(country.alpha2)) {
        await setFactor(country.alpha2, "1");
        continue;
      }

      // (ppp_data[year.to_s].presence || 1).to_f; the bytes are binary, so only ASCII spaces are blank
      const value = csvField(table, row, String(year));
      const pppRate = value === null || /^[\t-\r ]*$/u.test(value) ? 1 : rubyStringToF(value);
      // get_rate(country.currency_code).to_f; a country with no currency asks for the rate of "" (nil.to_s)
      const exchangeRate = rubyStringToF(await getRate(country.currency_code ?? ""));

      const factor = rubyFloatRoundDigits(pppRate / exchangeRate, 2);
      // `ppp_factor = 1 if ppp_factor > UPPER_THRESHOLD` is an Integer; the lower threshold is a Float
      if (factor > UPPER_THRESHOLD) await setFactor(country.alpha2, "1");
      else if (factor < LOWER_THRESHOLD) await setFactor(country.alpha2, rubyFloatToS(LOWER_THRESHOLD));
      else await setFactor(country.alpha2, rubyFloatToS(factor));
    }
  };

export const updatePurchasingPowerParityFactorsWorker = updatePurchasingPowerParityFactorsWorkerWith();
