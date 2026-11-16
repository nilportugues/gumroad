// Port of lib/utilities/csv_safe.rb (CsvSafe < CSV) and the writer behaviour of the csv gem it extends:
// nil is an empty field, "" is `""`, a field containing a quote, comma or line break is quoted, and rows end
// in "\n". Integers print as is; Floats (wrapped in RubyFloat) print via Float#to_s.
// Expectations in csv-safe.test.ts are the ones in spec/lib/utilities/csv_safe_spec.rb.
import { RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";
import { rubyFloatToS } from "./ruby-to-s.ts";

export type CsvCell = string | number | bigint | boolean | RubyFloat | null | undefined;

const FORMULA_PREFIXES = new Set(["=", "@", "|", "%", "\r", "\t"]);
const NUMERIC_PATTERN = /^\d+\.?\d*$/u;

function needsSanitization(text: string): boolean {
  if (text === "") return false;
  const first = text[0];
  if (first === "+" || first === "-") {
    return !NUMERIC_PATTERN.test(text.slice(1));
  }
  return FORMULA_PREFIXES.has(first!);
}

// Prefixes a `'` onto anything a spreadsheet would read as a formula. Numbers pass through untouched.
export function sanitizeCsvField(field: CsvCell): CsvCell {
  if (typeof field !== "string") return field;
  return needsSanitization(field) ? `'${field}` : field;
}

function formatField(field: CsvCell): string {
  if (field === null || field === undefined) return "";
  if (field instanceof RubyFloat) return rubyFloatToS(field.value);
  if (typeof field === "number" || typeof field === "bigint" || typeof field === "boolean") return String(field);
  if (field === "") return '""';
  if (/[",\r\n]/u.test(field)) return `"${field.replaceAll('"', '""')}"`;
  return field;
}

export function csvSafeLine(cells: readonly CsvCell[]): string {
  return `${cells.map((cell) => formatField(sanitizeCsvField(cell))).join(",")}\n`;
}

// CsvSafe.generate { |csv| rows.each { |row| csv << row } }
export function csvSafeGenerate(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map(csvSafeLine).join("");
}
