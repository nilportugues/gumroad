// lib/utilities/email_custom_property_resolver.rb (EmailCustomPropertyResolver) and the
// EmailCustomPropertyInlining prepend of config/initializers/premailer_rails.rb: premailer inlines
// var() as written, so the inlined document is reparsed and every var() resolved against the
// element's own inline custom properties, seeded by the stylesheet's :root.
import { parseHtmlDocument } from "../../html/libxml2-parser.ts";
import {
  type DocumentNode,
  type ElementNode,
  getAttribute,
  removeAttribute,
  serializeDocument,
  setAttribute,
} from "../../html/libxml2-tree.ts";

import { strip } from "./ruby.ts";

const MAX_DEPTH = 8;
// Ruby's \s is ASCII only; [^()] and \w match what Ruby's do.
const VAR_PATTERN = /var\([ \t\n\v\f\r]*(--[\w-]+)[ \t\n\v\f\r]*(?:,((?:[^()]|\([^()]*\))*))?\)/gu;
const MODERN_RGB =
  /\brgba?\([ \t\n\v\f\r]*(\d+(?:\.\d+)?)[ \t\n\v\f\r,]+(\d+(?:\.\d+)?)[ \t\n\v\f\r,]+(\d+(?:\.\d+)?)[ \t\n\v\f\r]*(?:[/,][ \t\n\v\f\r]*(\d*\.?\d+%?))?[ \t\n\v\f\r]*\)/gu;

export type CustomProperties = Map<string, string>;

export function rootProperties(css: string | null | undefined): CustomProperties {
  const vars: CustomProperties = new Map();
  for (const match of (css ?? "").matchAll(/:root[ \t\n\v\f\r]*\{([^{}]*)\}/gu)) {
    for (const [name, value] of declarations(match[1]!)) {
      if (name.startsWith("--")) vars.set(name, value);
    }
  }
  return vars;
}

export function resolveCustomProperties(html: string, rootVars: CustomProperties): string {
  if (!html.includes("var(--")) return html;

  const doc: DocumentNode = parseHtmlDocument(html);
  const root = doc.children.find((child): child is ElementNode => child.type === "element");
  if (root) resolveNode(root, rootVars);
  return serializeDocument(doc);
}

// ActiveSupport's present?: not blank (whitespace only counts as blank).
const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && /[^ \t\n\v\f\r]/u.test(value);

function resolveNode(node: ElementNode, inherited: CustomProperties): void {
  let vars = inherited;
  const style = getAttribute(node, "style");
  if (present(style)) {
    const pairs = declarations(style);
    const own: CustomProperties = new Map(pairs.filter(([name]) => name.startsWith("--")));
    const scope = new Map([...inherited, ...own]);
    vars = new Map([
      ...inherited,
      ...[...own].map(([name, value]): [string, string] => [name, substitute(value, scope)]),
    ]);
    const resolved = pairs
      .filter(([name]) => !name.startsWith("--"))
      .map(([name, value]) => `${name}: ${modernize(substitute(value, vars))}`)
      .join("; ");
    setAttribute(node, "style", resolved);
    if (resolved === "") removeAttribute(node, "style");
  }
  for (const child of node.children) {
    if (child.type === "element") resolveNode(child, vars);
  }
}

function substitute(value: string, vars: CustomProperties, depth = 0): string {
  if (depth > MAX_DEPTH || !value.includes("var(")) return value;

  const resolved = value.replace(VAR_PATTERN, (whole: string, name: string, fallback: string | undefined) => {
    // An empty value or fallback is truthy in Ruby, so only a missing one falls through.
    const found = vars.get(name);
    if (found !== undefined) return found;
    return fallback !== undefined ? strip(fallback) : whole;
  });
  return resolved === value ? value : substitute(resolved, vars, depth + 1);
}

function modernize(value: string): string {
  return value.replace(MODERN_RGB, (_whole: string, r: string, g: string, b: string, a: string | undefined) =>
    a !== undefined ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`,
  );
}

// Splits on ";" outside quotes and parentheses, then on the first ":" of each part.
function declarations(block: string): [string, string][] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const char of block) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === ";" && depth <= 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const result: [string, string][] = [];
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const name = strip(part.slice(0, colon));
    if (name === "") continue;
    result.push([name, strip(part.slice(colon + 1))]);
  }
  return result;
}
