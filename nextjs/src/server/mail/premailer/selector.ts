// Nokogiri 1.19's `doc.search(css)` over html.ts trees, for the selectors premailer inlines.
// Three outcomes, as in Ruby: matched elements; `skip` where Nokogiri raises (premailer rescues
// Nokogiri::SyntaxError and moves on: pseudo-elements, unknown pseudo-classes, namespaces);
// and UnsupportedSelectorError for selectors Nokogiri evaluates but this port does not.
import { allElements, type ElementNode, type ParentNode } from "./html.ts";

export class UnsupportedSelectorError extends Error {
  constructor(selector: string, reason: string) {
    super(`selector not ported (${reason}): ${selector}`);
    this.name = "UnsupportedSelectorError";
  }
}

class NokogiriSyntaxError extends Error {}

type AttributeTest = { name: string; op: string | null; value: string };
type Pseudo = { name: string; arg: string | null; not?: Compound };
type Compound = { tag: string | null; ids: string[]; classes: string[]; attributes: AttributeTest[]; pseudos: Pseudo[] };
type Step = { combinator: " " | ">" | "+" | "~"; compound: Compound };

// Pseudo-classes Nokogiri's XPathVisitor knows. The rest become undefined XPath functions and raise.
const PORTED_PSEUDOS = new Set([
  "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "empty", "root",
  "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "not",
]);
const NOKOGIRI_ONLY_PSEUDOS = new Set(["first", "last", "parent", "nth", "eq", "gt", "lt", "contains", "has", "self"]);

const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*/u;

function parseCompound(selector: string, input: { s: string; i: number }, inNot: boolean): Compound {
  const compound: Compound = { tag: null, ids: [], classes: [], attributes: [], pseudos: [] };
  const rest = () => input.s.slice(input.i);
  let any = false;
  if (rest().startsWith("*")) {
    if (rest().startsWith("*|")) throw new NokogiriSyntaxError();
    compound.tag = "*";
    input.i++;
    any = true;
  } else {
    const ident = /^[A-Za-z][A-Za-z0-9_-]*/u.exec(rest());
    if (ident) {
      if (input.s[input.i + ident[0].length] === "|") throw new NokogiriSyntaxError();
      compound.tag = ident[0];
      input.i += ident[0].length;
      any = true;
    }
  }
  for (;;) {
    const c = input.s[input.i];
    if (c === "#") {
      const ident = IDENT.exec(input.s.slice(input.i + 1));
      if (!ident) throw new UnsupportedSelectorError(selector, "id");
      compound.ids.push(ident[0]);
      input.i += 1 + ident[0].length;
    } else if (c === ".") {
      const ident = IDENT.exec(input.s.slice(input.i + 1));
      if (!ident) throw new UnsupportedSelectorError(selector, "class");
      compound.classes.push(ident[0]);
      input.i += 1 + ident[0].length;
    } else if (c === "[") {
      const m = /^\[\s*@?([A-Za-z_][A-Za-z0-9_:-]*)\s*(?:([~|^$*!]?=)\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*)?\]/u.exec(input.s.slice(input.i));
      if (!m) throw new UnsupportedSelectorError(selector, "attribute");
      compound.attributes.push({ name: m[1]!, op: m[2] ?? null, value: m[3] ?? m[4] ?? m[5] ?? "" });
      input.i += m[0].length;
    } else if (c === ":") {
      if (input.s[input.i + 1] === ":") throw new NokogiriSyntaxError();
      const m = /^:([A-Za-z-]+)/u.exec(input.s.slice(input.i));
      if (!m) throw new UnsupportedSelectorError(selector, "pseudo-class");
      const name = m[1]!;
      input.i += m[0].length;
      let arg: string | null = null;
      let not: Compound | undefined;
      if (input.s[input.i] === "(") {
        if (name === "not") {
          input.i++;
          while (input.s[input.i] === " ") input.i++;
          not = parseCompound(selector, input, true);
          while (input.s[input.i] === " ") input.i++;
          if (input.s[input.i] === ",") throw new NokogiriSyntaxError();
          if (input.s[input.i] !== ")") throw new NokogiriSyntaxError();
          input.i++;
        } else {
          const close = input.s.indexOf(")", input.i);
          if (close === -1) throw new NokogiriSyntaxError();
          arg = input.s.slice(input.i + 1, close);
          input.i = close + 1;
        }
      }
      if (NOKOGIRI_ONLY_PSEUDOS.has(name)) throw new UnsupportedSelectorError(selector, `:${name}`);
      if (!PORTED_PSEUDOS.has(name)) throw new NokogiriSyntaxError();
      if (name === "not" && !not) throw new NokogiriSyntaxError();
      compound.pseudos.push({ name, arg, ...(not ? { not } : {}) });
    } else {
      break;
    }
    any = true;
  }
  if (!any) {
    if (inNot) throw new NokogiriSyntaxError();
    throw new UnsupportedSelectorError(selector, `unexpected "${input.s[input.i] ?? "end"}"`);
  }
  return compound;
}

export function parseSelector(selector: string): Step[] | "skip" {
  try {
    if (selector.includes(",")) throw new UnsupportedSelectorError(selector, "selector list");
    if (selector.includes("\\")) throw new UnsupportedSelectorError(selector, "escape");
    const input = { s: selector.trim(), i: 0 };
    const steps: Step[] = [];
    let combinator: Step["combinator"] = " ";
    for (;;) {
      steps.push({ combinator, compound: parseCompound(selector, input, false) });
      const m = /^\s*([>+~])\s*|^\s+/u.exec(input.s.slice(input.i));
      if (!m) break;
      input.i += m[0].length;
      if (input.i >= input.s.length) throw new NokogiriSyntaxError();
      combinator = (m[1] as Step["combinator"] | undefined) ?? " ";
    }
    if (input.i !== input.s.length) throw new UnsupportedSelectorError(selector, `unexpected "${input.s[input.i]}"`);
    return steps;
  } catch (error) {
    if (error instanceof NokogiriSyntaxError) return "skip";
    throw error;
  }
}

const elementSiblings = (el: ElementNode) => (el.parent ? (el.parent.children.filter((c) => c.type === "element") as ElementNode[]) : [el]);

// XPath normalize-space on @class, then a space-padded contains().
function hasClass(el: ElementNode, name: string): boolean {
  const value = el.attributes.find((a) => a.name === "class")?.value;
  if (value == null) return false;
  return ` ${value.replace(/[ \t\r\n]+/gu, " ").trim()} `.includes(` ${name} `);
}

function attributeMatches(el: ElementNode, test: AttributeTest): boolean {
  const attr = el.attributes.find((a) => a.name === test.name);
  if (!attr) return false;
  const v = attr.value ?? "";
  switch (test.op) {
    case null:
      return true;
    case "=":
      return v === test.value;
    case "!=":
      return v !== test.value;
    case "~=":
      return ` ${v} `.includes(` ${test.value} `);
    case "|=":
      return v === test.value || v.startsWith(`${test.value}-`);
    case "^=":
      return v.startsWith(test.value);
    case "$=":
      return v.endsWith(test.value);
    case "*=":
      return v.includes(test.value);
    default:
      return false;
  }
}

function parseNth(selector: string, arg: string): (index: number) => boolean {
  const a = arg.replace(/\s+/gu, "");
  if (a === "odd") return (n) => n % 2 === 1;
  if (a === "even") return (n) => n % 2 === 0;
  const m = /^([+-]?\d*)n([+-]\d+)?$|^([+-]?\d+)$/u.exec(a);
  if (!m) throw new UnsupportedSelectorError(selector, `nth argument ${arg}`);
  if (m[3] !== undefined) {
    const b = Number(m[3]);
    return (n) => n === b;
  }
  const coef = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
  const b = m[2] ? Number(m[2]) : 0;
  return (n) => (coef === 0 ? n === b : (n - b) / coef >= 0 && (n - b) % coef === 0);
}

function pseudoMatches(selector: string, el: ElementNode, pseudo: Pseudo, tag: string | null): boolean {
  const siblings = elementSiblings(el);
  const index = siblings.indexOf(el);
  const ofType = () => {
    if (tag === null || tag === "*") throw new UnsupportedSelectorError(selector, `:${pseudo.name} without a type`);
    return siblings.filter((s) => s.name === el.name);
  };
  switch (pseudo.name) {
    case "first-child":
      return index === 0;
    case "last-child":
      return index === siblings.length - 1;
    case "only-child":
      return siblings.length === 1;
    case "root":
      return el.parent?.type === "document";
    case "empty":
      return el.children.length === 0;
    case "first-of-type":
      return ofType()[0] === el;
    case "last-of-type":
      return ofType().at(-1) === el;
    case "only-of-type":
      return ofType().length === 1;
    case "nth-child":
      return parseNth(selector, pseudo.arg ?? "")(index + 1);
    case "nth-last-child":
      return parseNth(selector, pseudo.arg ?? "")(siblings.length - index);
    case "nth-of-type": {
      const list = ofType();
      return parseNth(selector, pseudo.arg ?? "")(list.indexOf(el) + 1);
    }
    case "nth-last-of-type": {
      const list = ofType();
      return parseNth(selector, pseudo.arg ?? "")(list.length - list.indexOf(el));
    }
    case "not":
      return !compoundMatches(selector, el, pseudo.not!);
    default:
      throw new UnsupportedSelectorError(selector, `:${pseudo.name}`);
  }
}

function compoundMatches(selector: string, el: ElementNode, compound: Compound): boolean {
  if (compound.tag !== null && compound.tag !== "*" && compound.tag !== el.name) return false;
  if (!compound.ids.every((id) => el.attributes.some((a) => a.name === "id" && a.value === id))) return false;
  if (!compound.classes.every((name) => hasClass(el, name))) return false;
  if (!compound.attributes.every((test) => attributeMatches(el, test))) return false;
  return compound.pseudos.every((pseudo) => pseudoMatches(selector, el, pseudo, compound.tag));
}

function matchesFrom(selector: string, el: ElementNode, steps: Step[], index: number): boolean {
  const step = steps[index]!;
  if (!compoundMatches(selector, el, step.compound)) return false;
  if (index === 0) return true;
  const parentElement = (node: ElementNode) => (node.parent?.type === "element" ? node.parent : null);
  switch (step.combinator) {
    case ">": {
      const parent = parentElement(el);
      return parent !== null && matchesFrom(selector, parent, steps, index - 1);
    }
    case " ": {
      for (let p = parentElement(el); p; p = parentElement(p)) if (matchesFrom(selector, p, steps, index - 1)) return true;
      return false;
    }
    case "+": {
      const siblings = elementSiblings(el);
      const prev = siblings[siblings.indexOf(el) - 1];
      return prev !== undefined && matchesFrom(selector, prev, steps, index - 1);
    }
    case "~": {
      const siblings = elementSiblings(el);
      return siblings.slice(0, siblings.indexOf(el)).some((s) => matchesFrom(selector, s, steps, index - 1));
    }
  }
}

// Document#search(css): matching elements in document order, or "skip" where Nokogiri raises.
export function search(root: ParentNode, selector: string): ElementNode[] | "skip" {
  const steps = parseSelector(selector);
  if (steps === "skip") return "skip";
  return allElements(root).filter((el) => matchesFrom(selector, el, steps, steps.length - 1));
}
