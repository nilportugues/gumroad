// Generates prisma/schema.prisma from the Rails db/schema.rb so the two never drift.
// Run: node scripts/schema-rb-to-prisma.ts [../db/schema.rb] [prisma/schema.prisma]
//
// Rails stays the owner of migrations while both apps share the database; this file is
// regenerated, never hand-edited. Relations live in prisma/relations/*.prisma fragments
// (WS-02) because schema.rb carries no foreign keys to derive them from.
import { readFileSync, writeFileSync } from "node:fs";

type Column = { name: string; type: string; opts: Record<string, string> };
type Index = { columns: string[]; opts: Record<string, string>; lengths: Record<string, number> };
type Table = { name: string; idType: "bigint" | "integer" | "none"; charset: string; columns: Column[]; indexes: Index[] };

const [schemaRbPath = "../db/schema.rb", outPath = "prisma/schema.prisma"] = process.argv.slice(2);
const source = readFileSync(schemaRbPath, "utf8");

// Splits `a: 1, b: "x, y", c: { d: 2 }` at top-level commas only.
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseOpts(parts: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const part of parts) {
    const m = /^(\w+):\s*([\s\S]+)$/u.exec(part);
    if (m) opts[m[1]!] = m[2]!;
  }
  return opts;
}

function parseTables(rb: string): Table[] {
  const tables: Table[] = [];
  let table: Table | null = null;
  for (const line of rb.split("\n")) {
    const create = /^\s*create_table "([^"]+)"(.*) do \|t\|/u.exec(line);
    if (create) {
      const opts = parseOpts(splitTopLevel(create[2]!.replace(/^,/u, "")));
      table = {
        name: create[1]!,
        idType: opts.id === "false" ? "none" : opts.id === ":integer" ? "integer" : "bigint",
        charset: opts.charset?.replaceAll('"', "") ?? "utf8mb4",
        columns: [],
        indexes: [],
      };
      continue;
    }
    if (!table) continue;
    if (/^\s*end\s*$/u.test(line)) {
      tables.push(table);
      table = null;
      continue;
    }
    const index = /^\s*t\.index \[([^\]]*)\](.*)$/u.exec(line);
    if (index) {
      const opts = parseOpts(splitTopLevel(index[2]!.replace(/^,/u, "")));
      const columns = [...index[1]!.matchAll(/"([^"]+)"/gu)].map((m) => m[1]!);
      const lengths: Record<string, number> = {};
      if (opts.length?.startsWith("{")) {
        for (const m of opts.length.matchAll(/(\w+):\s*(\d+)/gu)) lengths[m[1]!] = Number(m[2]);
      } else if (opts.length) {
        for (const c of columns) lengths[c] = Number(opts.length);
      }
      table.indexes.push({ columns, opts, lengths });
      continue;
    }
    const expressionIndex = /^\s*t\.index "(.*)", (name: .*)$/u.exec(line);
    if (expressionIndex) {
      // Prisma has no syntax for functional indexes; MySQL still enforces it, so code must
      // reproduce its constraint (e.g. taxonomies' unique IFNULL(parent_id, 0), slug).
      table.indexes.push({ columns: [], opts: { ...parseOpts(splitTopLevel(expressionIndex[2]!)), expression: expressionIndex[1]! }, lengths: {} });
      continue;
    }
    const column = /^\s*t\.(\w+) "([^"]+)"(.*)$/u.exec(line);
    if (column) {
      table.columns.push({ type: column[1]!, name: column[2]!, opts: parseOpts(splitTopLevel(column[3]!.replace(/^,/u, ""))) });
    }
  }
  return tables;
}

const IRREGULAR: Record<string, string> = { people: "person", data: "data", media: "media", statuses: "status", taxes: "tax", indices: "index" };

function singularize(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/ies$/u.test(word)) return word.replace(/ies$/u, "y");
  if (/(ss|us|is)$/u.test(word)) return word;
  if (/(s|x|z|ch|sh)es$/u.test(word)) return word.replace(/es$/u, "");
  if (/s$/u.test(word)) return word.replace(/s$/u, "");
  return word;
}

function modelName(table: string): string {
  const words = table.split("_");
  words[words.length - 1] = singularize(words[words.length - 1]!);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function prismaType(col: Column, tableName: string): { type: string; attrs: string[] } {
  const { opts } = col;
  const limit = opts.limit ? Number(opts.limit) : undefined;
  switch (col.type) {
    case "integer":
      if (limit === 8) return { type: "BigInt", attrs: [] };
      if (limit === 1) return { type: "Int", attrs: ["@db.TinyInt"] };
      if (limit === 2) return { type: "Int", attrs: ["@db.SmallInt"] };
      if (limit === 3) return { type: "Int", attrs: ["@db.MediumInt"] };
      return { type: "Int", attrs: [] };
    case "bigint":
      return { type: "BigInt", attrs: [] };
    case "string":
      return { type: "String", attrs: [`@db.VarChar(${limit ?? 255})`] };
    case "text": {
      const size = opts.size?.replace(":", "");
      if (size === "medium") return { type: "String", attrs: ["@db.MediumText"] };
      if (size === "long") return { type: "String", attrs: ["@db.LongText"] };
      return { type: "String", attrs: ["@db.Text"] };
    }
    case "binary": {
      const size = opts.size?.replace(":", "");
      if (size === "medium") return { type: "Bytes", attrs: ["@db.MediumBlob"] };
      if (size === "long") return { type: "Bytes", attrs: ["@db.LongBlob"] };
      return { type: "Bytes", attrs: ["@db.Blob"] };
    }
    case "boolean":
      return { type: "Boolean", attrs: [] };
    case "datetime":
      // Rails 7 writes `precision: nil` for legacy DATETIME(0) columns; omitted precision means DATETIME(6).
      return { type: "DateTime", attrs: [opts.precision === "nil" ? "@db.DateTime(0)" : `@db.DateTime(${opts.precision ?? 6})`] };
    case "date":
      return { type: "DateTime", attrs: ["@db.Date"] };
    case "decimal":
      return { type: "Decimal", attrs: [`@db.Decimal(${opts.precision ?? 10}, ${opts.scale ?? 0})`] };
    case "float":
      return { type: "Float", attrs: ["@db.Float"] };
    case "json":
      return { type: "Json", attrs: [] };
    default:
      throw new Error(`Unhandled column type t.${col.type} on ${tableName}.${col.name}`);
  }
}

function prismaDefault(col: Column, type: string): string | null {
  const raw = col.opts.default;
  if (raw === undefined || raw === "nil") return null;
  if (/CURRENT_TIMESTAMP/u.test(raw)) return "@default(now())";
  if (raw.startsWith("->")) return `@default(dbgenerated(${JSON.stringify(raw.replace(/^->\s*\{\s*"|"\s*\}$/gu, ""))}))`;
  if (type === "Boolean") return `@default(${raw})`;
  if (type === "Int" || type === "BigInt" || type === "Float" || type === "Decimal") return `@default(${raw.replaceAll('"', "")})`;
  if (type === "Json") return `@default(${JSON.stringify(raw.replace(/^"|"$/gu, ""))})`;
  if (raw.startsWith('"')) return `@default(${raw})`;
  return `@default(dbgenerated(${JSON.stringify(raw)}))`;
}

function indexFields(idx: Index): string {
  return idx.columns.map((c) => (idx.lengths[c] ? `${c}(length: ${idx.lengths[c]})` : c)).join(", ");
}

function renderTable(table: Table): string {
  const lines: string[] = [];
  const pk = table.idType === "integer" ? "Int" : "BigInt";
  if (table.idType !== "none") lines.push(`  id ${pk} @id @default(autoincrement())`);
  for (const col of table.columns) {
    if (col.type === "virtual") {
      // Prisma cannot model generated columns; the field is read-only and Rails/MySQL owns its value.
      const stored = col.opts.type?.replace(":", "") ?? "string";
      const { type, attrs } = prismaType({ ...col, type: stored }, table.name);
      lines.push(`  /// GENERATED: ${col.opts.as ?? ""} — never write this column`);
      lines.push(`  ${col.name} ${type}? ${attrs.join(" ")}`.trimEnd());
      continue;
    }
    const { type, attrs } = prismaType(col, table.name);
    const optional = col.opts.null === "false" ? "" : "?";
    const def = prismaDefault(col, type);
    lines.push(`  ${col.name} ${type}${optional} ${[def, ...attrs].filter(Boolean).join(" ")}`.trimEnd());
  }
  let ignore = false;
  if (table.idType === "none") {
    const unique = table.indexes.find((i) => i.opts.unique === "true");
    if (unique) lines.push(`\n  @@id([${unique.columns.join(", ")}])`);
    else ignore = true;
  }
  if (lines.at(-1)?.startsWith("\n") !== true) lines.push("");
  for (const idx of table.indexes) {
    const name = idx.opts.name?.replaceAll('"', "");
    if (idx.opts.expression) {
      lines.push(`  // EXPRESSION INDEX ${name}${idx.opts.unique === "true" ? " (unique)" : ""}: ${idx.opts.expression}`);
      continue;
    }
    const kind = idx.opts.unique === "true" ? "@@unique" : idx.opts.type === ":fulltext" ? "@@fulltext" : "@@index";
    lines.push(`  ${kind}([${indexFields(idx)}]${name ? `, map: "${name}"` : ""})`);
  }
  lines.push(`  @@map("${table.name}")`);
  if (ignore) lines.push("  @@ignore");
  const header = table.charset === "utf8mb4" ? "" : `/// charset: ${table.charset}\n`;
  return `${header}model ${modelName(table.name)} {\n${lines.join("\n")}\n}\n`;
}

const tables = parseTables(source);
const names = new Map<string, string>();
for (const t of tables) {
  const name = modelName(t.name);
  const clash = names.get(name);
  if (clash) throw new Error(`Model name clash: ${clash} and ${t.name} both map to ${name}`);
  names.set(name, t.name);
}

const version = /define\(version: ([\d_]+)\)/u.exec(source)?.[1] ?? "unknown";
const out = `// GENERATED from db/schema.rb (version ${version}) by scripts/schema-rb-to-prisma.ts. Do not edit.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider     = "mysql"
  url          = env("DATABASE_URL")
  // The database has no foreign keys by policy; relations are enforced in application code.
  relationMode = "prisma"
}

${tables.map(renderTable).join("\n")}`;

writeFileSync(outPath, out);
console.log(`Wrote ${tables.length} models to ${outPath}`);
