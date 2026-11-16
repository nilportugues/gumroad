// ActiveRecord::Core#inspect for a row, which is what lands in the X-GUM `mailer_args` of a mailer
// that takes a record. Columns are listed in table order.
import { inspectString, InspectedRecord } from "./ruby-value.ts";
import { MailViewNotPortedError } from "./views.ts";

export type InspectColumn = readonly [name: string, kind: "integer" | "string" | "datetime"];

// attribute_for_inspect truncates strings to 50 characters.
const INSPECT_STRING_LIMIT = 50;

// Time#to_fs(:inspect) is "%Y-%m-%d %H:%M:%S.%9N %z". A JavaScript Date holds milliseconds, so the
// microseconds of a datetime(6) column read back as .mmm000 (models/README.md, "Time").
function inspectTime(time: Date): string {
  const iso = time.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${iso.slice(20, 23)}000000 +0000`;
}

function inspectAttribute(kind: InspectColumn[1], value: unknown): string {
  if (value === null || value === undefined) return "nil";
  switch (kind) {
    case "integer":
      return String(value);
    case "string": {
      const chars = Array.from(String(value));
      return inspectString(chars.length > INSPECT_STRING_LIMIT ? `${chars.slice(0, INSPECT_STRING_LIMIT - 3).join("")}...` : chars.join(""));
    }
    case "datetime":
      if (!(value instanceof Date)) throw new MailViewNotPortedError("datetime that is not a Date");
      return `"${inspectTime(value)}"`;
  }
}

export function inspectRecord(className: string, columns: readonly InspectColumn[], row: Record<string, unknown>): InspectedRecord {
  const attributes = columns.map(([name, kind]) => `${name}: ${inspectAttribute(kind, row[name])}`).join(", ");
  return new InspectedRecord(`#<${className} ${attributes}>`);
}
