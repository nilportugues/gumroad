// `CSV.new(text, headers: true)` with `read.headers` and `each`, for the well-formed input the csv gem 3.3
// parses without complaint: one kind of line break (CRLF or LF) outside quotes, quoted fields with doubled
// quotes, an unquoted empty field read as nil and a quoted one as "". Everything the gem raises
// CSV::MalformedCSVError for, and a bare carriage return as line break, raises CsvNotSupported, which jobs
// turn into a hand-back to Ruby. Golden: worker/jobs/__fixtures__/update-purchasing-power-parity-factors-job.golden.json.

export class CsvNotSupported extends Error {}

export type CsvField = string | null;
export type CsvTable = {
  // CSV::Table#headers: the first row's headers (padded with nil for fields beyond the header row), else the header row's.
  headers: CsvField[];
  // The header row, as CSV::Row#[] searches it
  headerRow: CsvField[];
  rows: CsvField[][];
};

type Row = CsvField[];

function splitRecords(text: string): Row[] {
  const records: Row[] = [];
  let fields: Row = [];
  // The gem takes the first line break anywhere in the text as the row separator.
  const firstBreak = /\r\n|\n|\r/u.exec(text)?.[0] ?? null;
  if (firstBreak === "\r") throw new CsvNotSupported("bare carriage return");
  const rowSeparator = firstBreak;
  let at = 0;
  const length = text.length;

  const endOfLine = (): "\r\n" | "\n" | null => {
    if (text[at] === "\n") return "\n";
    if (text[at] === "\r") {
      if (text[at + 1] === "\n") return "\r\n";
      throw new CsvNotSupported("bare carriage return");
    }
    return null;
  };
  // A different line break outside quotes is malformed to the gem.
  const takeLineBreak = (kind: "\r\n" | "\n") => {
    if (rowSeparator !== kind) throw new CsvNotSupported("mixed line breaks");
    at += kind.length;
  };

  while (at < length) {
    fields = [];
    let lineEnded = false;
    // A line: fields until a line break outside quotes.
    for (;;) {
      if (text[at] === '"') {
        // quoted field
        at += 1;
        let value = "";
        for (;;) {
          const quote = text.indexOf('"', at);
          if (quote < 0) throw new CsvNotSupported("unclosed quoted field");
          value += text.slice(at, quote);
          if (text[quote + 1] === '"') {
            value += '"';
            at = quote + 2;
          } else {
            at = quote + 1;
            break;
          }
        }
        fields.push(value);
        const kind = at < length ? endOfLine() : null;
        if (at < length && text[at] !== "," && kind === null) throw new CsvNotSupported("text after a closing quote");
      } else {
        // unquoted field
        const start = at;
        while (at < length && text[at] !== "," && text[at] !== "\n" && text[at] !== "\r") {
          if (text[at] === '"') throw new CsvNotSupported("quote inside an unquoted field");
          at += 1;
        }
        fields.push(at === start ? null : text.slice(start, at));
      }
      if (at >= length) break;
      if (text[at] === ",") {
        at += 1;
        // a trailing comma is a last, empty field
        if (at >= length) {
          fields.push(null);
          break;
        }
        continue;
      }
      const kind = endOfLine();
      if (kind === null) throw new CsvNotSupported("unexpected character");
      takeLineBreak(kind);
      lineEnded = true;
      break;
    }
    // a blank line is an empty row
    records.push(fields.length === 1 && fields[0] === null && lineEnded ? [] : fields);
  }
  return records;
}

export function parseCsvWithHeaders(text: string): CsvTable {
  const records = splitRecords(text);
  const headerRow = records[0] ?? [];
  const rows = records.slice(1);
  const first = rows[0];
  const headers = first !== undefined && first.length > headerRow.length ? [...headerRow, ...Array<CsvField>(first.length - headerRow.length).fill(null)] : headerRow;
  return { headers, headerRow, rows };
}

// CSV::Row#[](header): the field under the first header equal to `name`, nil when the row is shorter.
export function csvField(table: CsvTable, row: CsvField[], name: string): CsvField {
  const index = table.headerRow.indexOf(name);
  return index < 0 ? null : (row[index] ?? null);
}
