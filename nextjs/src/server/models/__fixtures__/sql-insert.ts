// Reads the INSERT statements a golden recorded back into rows, for tests that start Node from the state Ruby started from.
export type ParsedInsert = { table: string; row: Record<string, unknown> };

const ESCAPES: Record<string, string> = { "0": "\0", n: "\n", r: "\r", Z: "\x1a" };

// A value list as MySQL quoting writes it: NULL, TRUE/FALSE, numbers, and strings with backslash escapes.
function parseValues(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "'") {
      let value = "";
      i++;
      while (text[i] !== "'") {
        if (text[i] === "\\") {
          i++;
          value += ESCAPES[text[i]!] ?? text[i]!;
        } else value += text[i]!;
        i++;
      }
      i++;
      values.push(value);
    } else if (/[\s,]/u.test(char)) {
      i++;
    } else {
      let end = i;
      while (end < text.length && text[end] !== ",") end++;
      const token = text.slice(i, end).trim();
      i = end;
      if (token === "NULL") values.push(null);
      else if (token === "TRUE") values.push(true);
      else if (token === "FALSE") values.push(false);
      else values.push(Number(token));
    }
  }
  return values;
}

export function parseInsert(sql: string): ParsedInsert {
  const match = /^INSERT INTO `([^`]+)` \((.*?)\) VALUES \((.*)\)$/su.exec(sql);
  if (!match) throw new Error(`not an INSERT: ${sql.slice(0, 80)}`);
  const columns = match[2]!.split(", ").map((c) => c.replaceAll("`", ""));
  const values = parseValues(match[3]!);
  if (columns.length !== values.length)
    throw new Error(`INSERT INTO ${match[1]!}: ${columns.length} columns, ${values.length} values`);
  return { table: match[1]!, row: Object.fromEntries(columns.map((c, i) => [c, values[i]])) };
}
