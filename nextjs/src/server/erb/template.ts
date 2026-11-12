// Renders an ERB template from the .erb file Rails renders, so the markup cannot drift. The Ruby in its tags is not interpreted: every
// `<%= %>` expression, `if`/`unless` condition, `each` loop and assignment must be listed in a table of ported closures, matched on
// the exact source text, and anything unlisted throws NotPortedError, which hands the request back to Rails instead of rendering a
// guess. A tag that is not in the table cannot be wrong; one that is, is pinned by a recorded example.
//
// Whitespace is Erubi's with Rails' `trim: true`: a `<% %>` tag alone on its line is removed with its indentation and newline, while
// a `<%= %>` tag keeps the text around it.
import { readFileSync } from "node:fs";
import path from "node:path";

import { railsRoot } from "../infra/rails-env.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { type Html, html, SafeString } from "./html.ts";

type Scalar = string | number | boolean | null;
// A literal hash (`locals: { name: "x" }`, `data: { parallax: true }`) holds literals and the output of helper calls.
export type Value = Scalar | SafeString | { [key: string]: Value };
export type Keywords = Record<string, Value>;
// `block`: the captured body of `<%= helper ... do %> ... <% end %>`, which the helper's `yield` prints.
export type Call = { positional: Value[]; keywords: Keywords; block?: SafeString };
export type Helpers = Record<string, (call: Call) => Html | number>;

export type Scope = Record<string, unknown>;
export type ErbTable = {
  // `<%= source %>`
  values?: Record<string, (scope: Scope) => Html | number>;
  // `if source` / `unless source` (the condition after the keyword)
  conditions?: Record<string, (scope: Scope) => boolean>;
  // `source` of `<% source do |a, b| %>`: the scope of each iteration, layered over the enclosing one
  loops?: Record<string, (scope: Scope) => Scope[]>;
  // `<% source %>`, an assignment to the scope
  statements?: Record<string, (scope: Scope) => void>;
  // `<%= helper arg, key: value %>` calls with literal arguments
  helpers?: Helpers;
};

type Node =
  | { type: "text"; text: string }
  | { type: "value"; source: string }
  | { type: "statement"; source: string }
  | { type: "if"; negate: boolean; condition: string; then: Node[]; otherwise: Node[] }
  | { type: "each"; source: string; body: Node[] }
  | { type: "capture"; source: string; body: Node[] };

const TAG = /<%(=?)([\s\S]*?)%>/gu;

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: { nodes: Node[]; node?: Node & { type: "if" | "each" | "capture" } }[] = [{ nodes: root }];
  const current = () => stack.at(-1)!;
  let position = 0;
  let text = "";
  // Erubi trims a code tag only when the line holds nothing else: start of the template or a line start before it, a newline behind.
  let atLineStart = true;
  const flush = () => {
    if (text !== "") current().nodes.push({ type: "text", text });
    text = "";
  };
  for (let match = TAG.exec(source); match !== null; match = TAG.exec(source)) {
    let before = source.slice(position, match.index);
    position = TAG.lastIndex;
    const code = match[2]!.trim();
    if (match[1] === "") {
      const lineStart = before.lastIndexOf("\n") + 1;
      const indentOnly = /^[ \t]*$/u.test(before.slice(lineStart));
      const behind = /^[ \t]*\r?\n/u.exec(source.slice(position));
      if (indentOnly && (lineStart > 0 || atLineStart) && behind) {
        before = before.slice(0, lineStart);
        position += behind[0].length;
        TAG.lastIndex = position;
        atLineStart = true;
      } else atLineStart = false;
    }
    text += before;
    if (match[1] === "=") {
      atLineStart = false;
      flush();
      // `<%= helper args do %>`: the block's output is captured and handed to the helper.
      const block = /^([\s\S]*?)\s+do$/u.exec(code);
      if (block) {
        const node: Node & { type: "capture" } = { type: "capture", source: block[1]!, body: [] };
        current().nodes.push(node);
        stack.push({ nodes: node.body, node });
      } else current().nodes.push({ type: "value", source: code });
      continue;
    }
    flush();
    // `<%# comment %>` is trimmed like any code tag and prints nothing.
    if (code.startsWith("#")) continue;
    const conditional = /^(if|unless)\s+([\s\S]+)$/u.exec(code);
    if (conditional) {
      const node: Node & { type: "if" } = {
        type: "if",
        negate: conditional[1] === "unless",
        condition: conditional[2]!,
        then: [],
        otherwise: [],
      };
      current().nodes.push(node);
      stack.push({ nodes: node.then, node });
    } else if (code === "else") {
      const frame = current();
      if (frame.node?.type !== "if") throw new NotPortedError("an ERB else outside an if");
      frame.nodes = frame.node.otherwise;
    } else if (code === "end") {
      if (stack.length === 1) throw new NotPortedError("an unbalanced ERB end");
      stack.pop();
    } else if (/\sdo(?:\s*\|[^|]*\|)?$/u.test(code)) {
      const node: Node & { type: "each" } = { type: "each", source: code, body: [] };
      current().nodes.push(node);
      stack.push({ nodes: node.body, node });
    } else current().nodes.push({ type: "statement", source: code });
  }
  text += source.slice(position);
  flush();
  if (stack.length !== 1) throw new NotPortedError("an unbalanced ERB block");
  return root;
}

// A double-quoted string may interpolate `#{...}`, whose body holds no `}` of its own.
const TOKEN =
  /\s*(?:"((?:[^"\\#]|\\.|#(?!\{)|#\{[^}]*\})*)"|'((?:[^'\\]|\\.)*)'|(\d+)|([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*[?!]?)(:)?|([(),{}]))/uy;
const STRING_ESCAPES: Record<string, string> = { n: "\n", t: "\t" };
type Token = { type: "string" | "number" | "ident" | "label" | "punct"; value: string };

// The escapes of a double-quoted Ruby string: `\n` and `\t`, anything else stands for itself.
const unescape = (raw: string) => raw.replace(/\\(.)/gu, (_, char: string) => STRING_ESCAPES[char] ?? char);

// "text #{expression} text": an interpolated SafeString contributes its bytes unescaped, as String#to_s does.
function interpolate(raw: string, helpers: Helpers): string {
  let output = "";
  let position = 0;
  for (const match of raw.matchAll(/#\{([^}]*)\}/gu)) {
    output += unescape(raw.slice(position, match.index));
    const result = evaluateCall(match[1]!, helpers);
    output += typeof result === "number" ? String(result) : result.toString();
    position = match.index + match[0].length;
  }
  return output + unescape(raw.slice(position));
}

function tokenize(source: string, helpers: Helpers): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length && !/^\s*$/u.test(source.slice(position))) {
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(source);
    if (!match) throw new NotPortedError(`the ERB expression ${source}`);
    // The interpolation tokenizes with the same sticky regex, so the end of this token is read first.
    position = TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: "string", value: interpolate(match[1], helpers) });
    else if (match[2] !== undefined) tokens.push({ type: "string", value: match[2].replace(/\\([\\'])/gu, "$1") });
    else if (match[3] !== undefined) tokens.push({ type: "number", value: match[3] });
    else if (match[4] !== undefined) tokens.push({ type: match[5] ? "label" : "ident", value: match[4] });
    else tokens.push({ type: "punct", value: match[6]! });
  }
  return tokens;
}

// `helper "literal", key: "literal", hash: { key: helper }` with the helpers of the table. `block` is what `yield` prints.
function evaluateCall(source: string, helpers: Helpers, block?: SafeString): Html | number {
  const tokens = tokenize(source, helpers);
  let position = 0;
  const fail = (): never => {
    throw new NotPortedError(`the ERB expression ${source}`);
  };
  const isPunct = (value: string) => tokens[position]?.type === "punct" && tokens[position]?.value === value;
  const endsArguments = () => position >= tokens.length || isPunct(")") || isPunct(",") || isPunct("}");

  function value(): Value {
    if (isPunct("{")) return hash();
    const token = tokens[position++];
    if (!token) return fail();
    if (token.type === "string") return token.value;
    if (token.type === "number") return Number(token.value);
    if (token.type !== "ident") return fail();
    if (token.value === "true" || token.value === "false") return token.value === "true";
    if (token.value === "nil") return null;
    return call(token.value, undefined);
  }

  function hash(): Value {
    position++;
    const result: Record<string, Value> = {};
    while (!isPunct("}")) {
      const token = tokens[position++];
      if (token?.type !== "label") return fail();
      result[token.value] = value();
      if (isPunct(",")) position++;
      else if (!isPunct("}")) return fail();
    }
    position++;
    return result;
  }

  function call(name: string, captured: SafeString | undefined): Html | number {
    const helper = helpers[name];
    if (!helper) return fail();
    const positional: Call["positional"] = [];
    const keywords: Keywords = {};
    const parenthesised = isPunct("(");
    if (parenthesised) position++;
    if (!endsArguments()) {
      for (;;) {
        const token = tokens[position];
        if (token?.type === "label") {
          position++;
          keywords[token.value] = value();
        } else positional.push(value());
        if (isPunct(",")) position++;
        else break;
      }
    }
    if (parenthesised) {
      if (!isPunct(")")) fail();
      position++;
    }
    return helper({ positional, keywords, ...(captured ? { block: captured } : {}) });
  }

  const first = tokens[0];
  if (first?.type === "ident" && !["true", "false", "nil"].includes(first.value)) {
    position = 1;
    const result = call(first.value, block);
    if (position !== tokens.length) fail();
    return result;
  }
  // A literal alone is a string or a number.
  const literal = value();
  if (position !== tokens.length || (typeof literal === "object" && literal !== null && !(literal instanceof SafeString)))
    return fail();
  return literal instanceof SafeString ? literal : String(literal);
}

const sources = new Map<string, string>();
const parsed = new Map<string, Node[]>();

export function readView(relativePath: string): string {
  let source = sources.get(relativePath);
  if (source === undefined) {
    source = readFileSync(path.join(railsRoot(), "app", "views", relativePath), "utf8");
    sources.set(relativePath, source);
  }
  return source;
}

function run(nodes: Node[], scope: Scope, table: ErbTable): string {
  let output = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        output += node.text;
        break;
      case "value": {
        const closure = table.values?.[node.source];
        const result = closure ? closure(scope) : evaluateCall(node.source, table.helpers ?? {});
        output += typeof result === "number" ? String(result) : html(result);
        break;
      }
      case "statement": {
        const closure = table.statements?.[node.source];
        if (!closure) throw new NotPortedError(`the ERB statement ${node.source}`);
        closure(scope);
        break;
      }
      case "if": {
        const closure = table.conditions?.[node.condition];
        if (!closure) throw new NotPortedError(`the ERB condition ${node.condition}`);
        output += run(closure(scope) !== node.negate ? node.then : node.otherwise, scope, table);
        break;
      }
      case "capture": {
        const body = new SafeString(run(node.body, scope, table));
        output += html(evaluateCall(node.source, table.helpers ?? {}, body));
        break;
      }
      case "each": {
        const closure = table.loops?.[node.source];
        if (!closure) throw new NotPortedError(`the ERB loop ${node.source}`);
        for (const iteration of closure(scope)) output += run(node.body, { ...scope, ...iteration }, table);
        break;
      }
    }
  }
  return output;
}

export function renderErb(relativePath: string, table: ErbTable, scope: Scope = {}): string {
  let nodes = parsed.get(relativePath);
  if (nodes === undefined) {
    nodes = parse(readView(relativePath));
    parsed.set(relativePath, nodes);
  }
  return run(nodes, { ...scope }, table);
}
