// Ruby's `to_f` on a value that may be a CSV cell: nil and "" are 0.0, a string parses its leading number
// (so "1,234.56" is 1.0), and anything unparseable is 0.0.
import { RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";
import type { CsvCell } from "./csv-safe.ts";

export function rubyToF(cell: CsvCell): number {
  if (cell === null || cell === undefined || cell === "") return 0;
  if (cell instanceof RubyFloat) return cell.value;
  if (typeof cell === "number") return cell;
  if (typeof cell === "bigint") return Number(cell);
  if (typeof cell === "boolean") return cell ? 1 : 0;
  const parsed = Number.parseFloat(cell);
  return Number.isNaN(parsed) ? 0 : parsed;
}
