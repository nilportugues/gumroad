// Port of the css_parser gem 1.22.0 (Parser, RuleSet, CssParser.merge and the regexps), as premailer
// 1.29 drives it. Regexps are translated from Onigmo: Ruby's \s, ^, $ and \Z are spelled out (see
// ruby.ts), and the patterns that use \w carry no `u` flag so \w stays ASCII, as in Ruby.
// premailer.test.ts replays every rule of a real email stylesheet against the gem's output.
import { BOL, END_Z, EOL, scanCount, sliceBang, split, strip, WS } from "./ruby.ts";

const S = WS;

function possibleValues(...values: string[]): RegExp {
  // css_parser builds these from a double-quoted Ruby string, where "\s" is a literal space.
  return new RegExp(`([ ]*${BOL})?(${values.join("|")})([ ]*${EOL})?`, "i");
}

const NAMED_COLOURS = (
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
  "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
  "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
  "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
  "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
  "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
  "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
  "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
  "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
  "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
  "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple red " +
  "rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray " +
  "slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
  "yellowgreen transparent inherit currentColor"
).split(" ");

const NUM = `-?${S}*-?\\d+(\\.\\d+)?%?${S}*%?`;
const RE_COLOUR_NUMERIC = `\\b(hsl|rgb)${S}*\\(${NUM},${NUM},${NUM}\\)`;
const RE_COLOUR_NUMERIC_ALPHA = `\\b(hsla|rgba)${S}*\\(${NUM},${NUM},${NUM},${NUM}\\)`;
const RE_COLOUR_HEX = `${S}*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b`;
const RE_COLOUR_NAMED = `${S}*\\b(${NAMED_COLOURS.join("|")})\\b`;
export const RE_COLOUR = new RegExp(
  `(?:${RE_COLOUR_NUMERIC})|(?:${RE_COLOUR_NUMERIC_ALPHA})|(?:${RE_COLOUR_HEX})|(?:${RE_COLOUR_NAMED})`,
  "i",
);

const RE_INHERIT = possibleValues("inherit");
const URI_RX = `url\\(("([^"]*)"|'([^']*)'|([^)]*))\\)`;
const URI_RX_OR_NONE = new RegExp(`(?:${URI_RX})|(?:none)`, "i");
const RE_GRADIENT = `[-a-z]*gradient\\([-a-z0-9 .,#%()]*\\)`;
const RE_IMAGE = new RegExp(`(?:${URI_RX})|(?:${RE_GRADIENT})|(?:none)`, "i");
const IMPORTANT_IN_PROPERTY_RX = new RegExp(`${S}*!important\\b${S}*`, "i");
const RE_INSIDE_OUTSIDE = possibleValues("inside", "outside");
const RE_SCROLL_FIXED = possibleValues("scroll", "fixed");
const RE_REPEAT = possibleValues("repeat(\\-x|\\-y)*|no\\-repeat");
const RE_LIST_STYLE_TYPE = possibleValues(
  "disc",
  "circle",
  "square",
  "decimal-leading-zero",
  "decimal",
  "lower-roman",
  "upper-roman",
  "lower-greek",
  "lower-alpha",
  "lower-latin",
  "upper-alpha",
  "upper-latin",
  "hebrew",
  "armenian",
  "georgian",
  "cjk-ideographic",
  "hiragana",
  "hira-gana-iroha",
  "katakana-iroha",
  "katakana",
  "none",
);
const BOX_MODEL_UNITS_RX = `(auto|inherit|0|(-*([0-9]+|[0-9]*\\.[0-9]+)(rem|vw|vh|vm|vmin|vmax|e[mx]+|px|[cm]+m|p[tc+]|in|%)))(?:[ \\t\\n\\v\\f\\r;]|${END_Z})`;
const RE_BORDER_UNITS = new RegExp(`(?:${BOX_MODEL_UNITS_RX})|(?:(thin|medium|thick))`, "i");
const RE_BORDER_STYLE = new RegExp(
  `(${S}*${BOL})?(none|hidden|dotted|dashed|solid|double|dot-dash|dot-dot-dash|wave|groove|ridge|inset|outset)(${S}*${EOL})?`,
  "i",
);
const RE_LENGTH_OR_PERCENTAGE = `([\\-]*(([0-9]*\\.[0-9]+)|[0-9]+)(e[mx]+|px|[cm]+m|p[tc+]|in|\\%))`;
const SINGLE_POSITION = `(?:${RE_LENGTH_OR_PERCENTAGE}|left|center|right|top|bottom)`;
const SINGLE_SIZE = `(?:${RE_LENGTH_OR_PERCENTAGE}|auto|cover|contain|initial|inherit)`;
const RE_BACKGROUND_POSITION = new RegExp(`${SINGLE_POSITION}${S}+${SINGLE_POSITION}|${SINGLE_POSITION}`, "i");
const RE_BACKGROUND_SIZE = new RegExp(`${S}*/${S}*(${SINGLE_SIZE}${S}+${SINGLE_SIZE}|${SINGLE_SIZE})`, "i");
const FONT_UNITS_RX =
  /((x+-)*small|medium|larger*|auto|inherit|([0-9]+|[0-9]*\.[0-9]+)(e[mx]+|px|[cm]+m|p[tc+]|in|%)*)/iu;

const NON_ID_ATTRIBUTES_AND_PSEUDO_CLASSES_RX =
  /(?:\.\w+)|\[(?:\w+)|(?::(?:link|visited|active|hover|focus|lang|target|enabled|disabled|checked|indeterminate|root|nth-child|nth-last-child|nth-of-type|nth-last-of-type|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type|empty|contains))/giu;
const ELEMENTS_AND_PSEUDO_ELEMENTS_RX = new RegExp(
  `(?:(?:${BOL}|[ \\t\\n\\v\\f\\r+>~]+)\\w+|:{1,2}(?:after|before|first-letter|first-line|selection))`,
  "gi",
);

export class CssArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

// CssParser.calculate_specificity: the four counts are concatenated as digits, then read as an Integer.
export function calculateSpecificity(selector: string): number {
  const b = selector.split("#").length - 1;
  const c = scanCount(selector, NON_ID_ATTRIBUTES_AND_PSEUDO_CLASSES_RX);
  const d = scanCount(selector, ELEMENTS_AND_PSEUDO_ELEMENTS_RX);
  return Number.parseInt(`0${b}${c}${d}`, 10);
}

export function sanitizeMediaQuery(raw: string | null | undefined): string {
  const mq = strip(String(raw ?? "").replace(new RegExp(`${S}+`, "g"), " "));
  return mq === "" ? "all" : mq;
}

// ---------------------------------------------------------------------------------------------
// RuleSet::Declarations

export class DeclarationValue {
  value = "";
  important = false;

  constructor(value: string, important?: boolean) {
    this.setValue(value);
    if (important !== undefined) this.important = important;
  }

  // Value#value=
  setValue(raw: string): void {
    const holder = { value: String(raw).replace(new RegExp(`${S}*;${S}*${END_Z}`), "") };
    this.important = sliceBang(holder, IMPORTANT_IN_PROPERTY_RX) !== null;
    const value = strip(holder.value);
    if (value === "") throw new CssArgumentError("value is empty");
    this.value = value;
  }

  toString(): string {
    return this.important ? `${this.value} !important` : this.value;
  }
}

type DeclarationInput = string | DeclarationValue | null | undefined;

const normalizeProperty = (property: string) => strip(property.toLowerCase());

export class Declarations {
  map = new Map<string, DeclarationValue>();

  constructor(entries: [string, DeclarationInput][] = []) {
    for (const [property, value] of entries) this.set(property, value);
  }

  // Declarations#[]=
  set(property: string, value: DeclarationInput): void {
    const key = normalizeProperty(property);
    try {
      const currentlyImportant = this.map.get(key)?.important ?? false;
      if (value instanceof DeclarationValue && (!currentlyImportant || value.important)) {
        this.map.set(key, value);
      } else if (value == null || strip(String(value)) === "") {
        this.map.delete(key);
      } else if (!(value instanceof DeclarationValue)) {
        const parsed = new DeclarationValue(value);
        if (!currentlyImportant || parsed.important) this.map.set(key, parsed);
      }
    } catch (error) {
      if (error instanceof CssArgumentError) throw new CssArgumentError(`${key} ${error.message}`);
      throw error;
    }
  }

  get(property: string): DeclarationValue | undefined {
    return this.map.get(normalizeProperty(property));
  }

  has(property: string): boolean {
    return this.map.has(normalizeProperty(property));
  }

  get size(): number {
    return this.map.size;
  }

  delete(property: string): void {
    this.map.delete(normalizeProperty(property));
  }

  // Declarations#replace_declaration!
  replaceDeclaration(property: string, replacements: [string, DeclarationInput][], preserveImportance = false): void {
    const key = normalizeProperty(property);
    if (!this.has(key)) throw new CssArgumentError(`property ${key} does not exist`);
    const replacementDeclarations = new Declarations(replacements);
    if (preserveImportance) {
      const importance = this.get(key)!.important;
      for (const value of replacementDeclarations.map.values()) value.important = importance;
    }

    const keys = [...this.map.keys()];
    const values = [...this.map.values()];
    let propertyIndex = keys.indexOf(key);
    const result = new Map<string, DeclarationValue>();
    for (const [name, replacement] of replacementDeclarations.map) {
      const existing = this.map.get(name);
      if (!existing) {
        result.set(name, replacement);
        continue;
      }
      if (replacement.important && !existing.important) {
        result.set(name, replacement);
        const replacedIndex = keys.indexOf(name);
        keys.splice(replacedIndex, 1);
        values.splice(replacedIndex, 1);
        if (replacedIndex < propertyIndex) propertyIndex -= 1;
        continue;
      }
      if (!replacement.important && existing.important) continue;
      if (propertyIndex > keys.indexOf(name)) result.set(name, replacement);
    }
    if (result.size === 0) return;

    keys.splice(propertyIndex, 1, ...result.keys());
    values.splice(propertyIndex, 1, ...result.values());
    this.map = new Map();
    keys.forEach((name, index) => this.map.set(name, values[index]!));
  }

  // Declarations#to_s. Of the cleanup regexp's three alternatives the middle one always matches
  // (possibly empty), so the third never runs.
  toString(): string {
    let out = "";
    for (const [property, value] of this.map)
      out += `${property}: ${value.value}${value.important ? " !important" : ""}; `;
    out = out.replace(new RegExp(`${BOL}[ \\t\\n\\v\\f\\r^({)]+|[\\n\\r\\f\\t]*|${S}+${EOL}`, "g"), "");
    return strip(out);
  }
}

// ---------------------------------------------------------------------------------------------
// RuleSet

const BACKGROUND_PROPERTIES = [
  "background-color",
  "background-image",
  "background-repeat",
  "background-position",
  "background-size",
  "background-attachment",
];
const LIST_STYLE_PROPERTIES = ["list-style-type", "list-style-position", "list-style-image"];
const FONT_STYLE_PROPERTIES = ["font-style", "font-variant", "font-weight", "font-size", "line-height", "font-family"];
const FONT_WEIGHT_PROPERTIES = ["font-style", "font-weight", "font-variant"];
const BORDER_STYLE_PROPERTIES = ["border-width", "border-style", "border-color"];
const BORDER_PROPERTIES = ["border", "border-left", "border-right", "border-top", "border-bottom"];
const DIMENSIONS: [string, [string, string, string, string]][] = [
  ["margin", ["margin-top", "margin-right", "margin-bottom", "margin-left"]],
  ["padding", ["padding-top", "padding-right", "padding-bottom", "padding-left"]],
  ["border-color", ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"]],
  ["border-style", ["border-top-style", "border-right-style", "border-bottom-style", "border-left-style"]],
  ["border-width", ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]],
];
const WHITESPACE_REPLACEMENT = "___SPACE___";

// RE_FUNCTIONS, `name(...)` where every nested "(" is itself preceded by a name character. Onigmo
// recursion (\g<0>) has no JavaScript equivalent, so the match is done by hand.
const isFunctionNameChar = (c: string | undefined) => c !== undefined && /[a-z0-9-]/iu.test(c);

function matchFunctionParens(value: string, open: number): number | null {
  let j = open + 1;
  while (j < value.length) {
    const c = value[j];
    if (c === ")") return j + 1;
    if (c === "(") {
      if (j - 1 <= open || !isFunctionNameChar(value[j - 1])) return null;
      const end = matchFunctionParens(value, j);
      if (end === null) return null;
      j = end;
      continue;
    }
    j++;
  }
  return null;
}

function replaceFunctions(value: string, replace: (match: string) => string): string {
  let out = "";
  let p = 0;
  let copied = 0;
  while (p < value.length) {
    if (isFunctionNameChar(value[p])) {
      let q = p;
      while (isFunctionNameChar(value[q])) q++;
      if (value[q] === "(") {
        const end = matchFunctionParens(value, q);
        if (end !== null) {
          out += value.slice(copied, p) + replace(value.slice(p, end));
          p = end;
          copied = end;
          continue;
        }
      }
    }
    p++;
  }
  return out + value.slice(copied);
}

function splitValuePreservingFunctionWhitespace(value: string): string[] {
  const replaced = replaceFunctions(value, (c) => c.replace(new RegExp(`${S}+`, "g"), WHITESPACE_REPLACEMENT));
  return split(strip(replaced), new RegExp(`${S}+`)).map((c) => c.replaceAll(WHITESPACE_REPLACEMENT, " "));
}

function unmatchedOpenParenthesis(text: string): boolean {
  const open = text.indexOf("(");
  return open !== -1 && text.indexOf(")", open) === -1;
}

export class RuleSet {
  selectors: string[] = [];
  specificity: number | null;
  declarations = new Declarations();
  // Premailer::CachedRuleSet: expand_shorthand! runs once.
  private expandOnce: boolean;
  private expanded = false;

  constructor(
    options: { selectors?: string | null; block?: string | null; specificity?: number | null; cached?: boolean } = {},
  ) {
    this.specificity = options.specificity ?? null;
    this.expandOnce = options.cached ?? false;
    if (options.selectors) this.selectors = rubySplitComma(options.selectors);
    this.parseDeclarations(options.block ?? null);
  }

  set(property: string, value: DeclarationInput): void {
    this.declarations.set(property, value);
  }

  // RuleSet#get_value / #[]
  getValue(property: string): string {
    const value = this.declarations.get(property);
    return value ? `${value.toString()};` : "";
  }

  eachSelector(callback: (selector: string, declarations: string, specificity: number) => void): void {
    const decs = this.declarations.toString();
    for (const sel of this.selectors) callback(strip(sel), decs, this.specificity ?? calculateSpecificity(sel));
  }

  declarationsToString(): string {
    return this.declarations.toString();
  }

  expandShorthand(): void {
    if (this.expandOnce && this.expanded) return;
    try {
      this.expandBorderShorthand();
      this.expandDimensionsShorthand();
      this.expandFontShorthand();
      this.expandBackgroundShorthand();
      this.expandListStyleShorthand();
    } finally {
      this.expanded = true;
    }
  }

  private expandBackgroundShorthand(): void {
    const declaration = this.declarations.get("background");
    if (!declaration) return;
    const holder = { value: declaration.value };
    let replacement: [string, DeclarationInput][];
    if (RE_INHERIT.test(holder.value)) {
      replacement = BACKGROUND_PROPERTIES.map((key) => [key, "inherit"]);
    } else {
      const image = sliceBang(holder, RE_IMAGE);
      const attachment = sliceBang(holder, RE_SCROLL_FIXED);
      const repeat = sliceBang(holder, RE_REPEAT);
      const color = sliceBang(holder, RE_COLOUR);
      const sizeMatch = sliceBang(holder, RE_BACKGROUND_SIZE);
      const size = sizeMatch === null ? null : sizeMatch.replace(new RegExp(`${BOL}${S}*/${S}*`), "");
      const position = sliceBang(holder, RE_BACKGROUND_POSITION);
      replacement = [
        ["background-image", image],
        ["background-attachment", attachment],
        ["background-repeat", repeat],
        ["background-color", color],
        ["background-size", size],
        ["background-position", position],
      ];
    }
    this.declarations.replaceDeclaration("background", replacement, true);
  }

  private expandBorderShorthand(): void {
    for (const k of BORDER_PROPERTIES) {
      const declaration = this.declarations.get(k);
      if (!declaration) continue;
      const holder = { value: declaration.value };
      const width = sliceBang(holder, RE_BORDER_UNITS);
      const color = sliceBang(holder, RE_COLOUR);
      const style = sliceBang(holder, RE_BORDER_STYLE);
      this.declarations.replaceDeclaration(
        k,
        [
          [`${k}-width`, width],
          [`${k}-color`, color],
          [`${k}-style`, style],
        ],
        true,
      );
    }
  }

  private expandDimensionsShorthand(): void {
    for (const [property, [top, right, bottom, left]] of DIMENSIONS) {
      const declaration = this.declarations.get(property);
      if (!declaration) continue;
      const value = declaration.value.replace(new RegExp(RE_COLOUR.source, "gi"), (c) =>
        c.replace(new RegExp(`(${S}*,${S}*)`, "g"), ","),
      );
      const matches = splitValuePreservingFunctionWhitespace(value);
      let values: string[];
      switch (matches.length) {
        case 1:
          values = [matches[0]!, matches[0]!, matches[0]!, matches[0]!];
          break;
        case 2:
          values = [...matches, ...matches];
          break;
        case 3:
          values = [...matches, matches[1]!];
          break;
        case 4:
          values = matches;
          break;
        default:
          throw new CssArgumentError(`Cannot parse ${value}`);
      }
      const replacement: [string, DeclarationInput][] = [];
      const seen = new Map<string, string>();
      [top, right, bottom, left].forEach((side, index) => seen.set(side, values[index]!));
      for (const [side, v] of seen) replacement.push([side, v]);
      this.declarations.replaceDeclaration(property, replacement, true);
    }
  }

  private expandFontShorthand(): void {
    const declaration = this.declarations.get("font");
    if (!declaration) return;
    const fontProps = new Map<string, string>([
      ["font-style", "normal"],
      ["font-variant", "normal"],
      ["font-weight", "normal"],
      ["font-size", "normal"],
      ["line-height", "normal"],
    ]);
    const value = declaration.value.replace(new RegExp(`/${S}+`, "g"), "/");
    let inFonts = false;
    const scan = /"(?:[^\n]*[^"\n])"|'(?:[^\n]*[^'\n])'|(?:\w[^ ,]+)/gu;
    for (const match of value.matchAll(scan)) {
      const m = strip(match[0]).replace(new RegExp(`;${EOL}`, "g"), "");
      if (inFonts) {
        fontProps.set("font-family", fontProps.has("font-family") ? `${fontProps.get("font-family")}, ${m}` : m);
      } else if (/normal|inherit/iu.test(m)) {
        for (const prop of FONT_WEIGHT_PROPERTIES) if (!fontProps.get(prop)) fontProps.set(prop, m);
      } else if (/italic|oblique/iu.test(m)) {
        fontProps.set("font-style", m);
      } else if (/small-caps/iu.test(m)) {
        fontProps.set("font-variant", m);
      } else if (new RegExp(`[1-9]00${EOL}|bold|bolder|lighter`, "i").test(m)) {
        fontProps.set("font-weight", m);
      } else if (FONT_UNITS_RX.test(m)) {
        if (m.includes("/")) {
          const slash = m.indexOf("/");
          fontProps.set("font-size", m.slice(0, slash));
          fontProps.set("line-height", m.slice(slash + 1));
        } else {
          fontProps.set("font-size", m);
        }
        inFonts = true;
      }
    }
    this.declarations.replaceDeclaration("font", [...fontProps], true);
  }

  private expandListStyleShorthand(): void {
    const declaration = this.declarations.get("list-style");
    if (!declaration) return;
    const holder = { value: declaration.value };
    let replacement: [string, DeclarationInput][];
    if (RE_INHERIT.test(holder.value)) {
      replacement = LIST_STYLE_PROPERTIES.map((key) => [key, "inherit"]);
    } else {
      const type = sliceBang(holder, RE_LIST_STYLE_TYPE);
      const position = sliceBang(holder, RE_INSIDE_OUTSIDE);
      const image = sliceBang(holder, URI_RX_OR_NONE);
      replacement = [
        ["list-style-type", type],
        ["list-style-position", position],
        ["list-style-image", image],
      ];
    }
    this.declarations.replaceDeclaration("list-style", replacement, true);
  }

  createShorthand(): void {
    this.createBackgroundShorthand();
    this.createDimensionsShorthand();
    this.createBorderShorthand();
    this.createFontShorthand();
    this.createShorthandProperties(LIST_STYLE_PROPERTIES, "list-style");
  }

  private createShorthandProperties(properties: string[], shorthand: string): void {
    const values: string[] = [];
    const toDelete: string[] = [];
    for (const property of properties) {
      const declaration = this.declarations.get(property);
      if (!declaration || declaration.important) continue;
      values.push(declaration.value);
      toDelete.push(property);
    }
    if (values.length <= 1) return;
    for (const property of toDelete) this.declarations.delete(property);
    this.declarations.set(shorthand, values.join(" "));
  }

  private createBackgroundShorthand(): void {
    const declaration = this.declarations.get("background-size");
    if (declaration && !declaration.important) {
      if (!this.declarations.get("background-position")) this.declarations.set("background-position", "0% 0%");
      declaration.setValue(`/ ${declaration.value}`);
    }
    this.createShorthandProperties(BACKGROUND_PROPERTIES, "background");
  }

  private createBorderShorthand(): void {
    const values: string[] = [];
    for (const property of BORDER_STYLE_PROPERTIES) {
      const declaration = this.declarations.get(property);
      if (!declaration || declaration.important) continue;
      if (new RegExp(S).test(strip(declaration.value.replace(new RegExp(`,${S}`, "g"), ",")))) continue;
      values.push(declaration.value);
    }
    if (values.length !== BORDER_STYLE_PROPERTIES.length) return;
    for (const property of BORDER_STYLE_PROPERTIES) this.declarations.delete(property);
    this.declarations.set("border", values.join(" "));
  }

  private createDimensionsShorthand(): void {
    if (this.declarations.size < 4) return;
    for (const [property, dimensions] of DIMENSIONS) {
      const sides = new Map<"top" | "right" | "bottom" | "left", string>();
      (["top", "right", "bottom", "left"] as const).forEach((side, index) => {
        const declaration = this.declarations.get(dimensions[index]!);
        if (declaration) sides.set(side, declaration.value);
      });
      if (sides.size !== dimensions.length) continue;
      const newValue = strip(
        computeDimensionsShorthand(sides)
          .map((side) => sides.get(side))
          .join(" "),
      );
      if (newValue !== "") this.declarations.set(property, newValue);
      for (const d of dimensions) this.declarations.delete(d);
    }
  }

  private createFontShorthand(): void {
    if (!FONT_STYLE_PROPERTIES.every((prop) => this.declarations.has(prop))) return;
    let newValue = "";
    for (const property of ["font-style", "font-variant", "font-weight"]) {
      const value = this.declarations.get(property)!.value;
      if (value !== "normal") newValue += `${value} `;
    }
    newValue += this.declarations.get("font-size")!.value;
    const lineHeight = this.declarations.get("line-height")!.value;
    if (lineHeight !== "normal") newValue += `/${lineHeight}`;
    newValue += ` ${this.declarations.get("font-family")!.value}`;
    this.declarations.set("font", newValue.replace(new RegExp(`${S}+`, "g"), " "));
    for (const prop of FONT_STYLE_PROPERTIES) this.declarations.delete(prop);
  }

  private parseDeclarations(block: string | null): void {
    this.declarations = new Declarations();
    if (!block) return;
    let continuation: string | null = null;
    for (const segment of split(block, ";")) {
      const decs: string = continuation !== null ? `${continuation};${segment}` : segment;
      if (unmatchedOpenParenthesis(decs)) {
        continuation = decs;
        continue;
      }
      const colon = decs.indexOf(":");
      if (colon === -1) continue;
      const property = strip(decs.slice(0, colon));
      const value = strip(decs.slice(colon + 1));
      if (property === "" || value === "" || value.toLowerCase() === "!important") continue;
      this.declarations.set(property, value);
      continuation = null;
    }
  }
}

// RuleSet#parse_selectors!: selectors.split(',') with Ruby's trailing-empty-field rule.
function rubySplitComma(selectors: string): string[] {
  return split(selectors, ",").map((s) => strip(s.replace(new RegExp(`${S}+`, "g"), " ")));
}

function computeDimensionsShorthand(
  values: Map<"top" | "right" | "bottom" | "left", string>,
): ("top" | "right" | "bottom" | "left")[] {
  if (new Set(values.values()).size === 1) return ["top"];
  if (values.get("left") !== values.get("right")) return ["top", "right", "bottom", "left"];
  if (values.get("top") === values.get("bottom")) return ["top", "left"];
  return ["top", "left", "bottom"];
}

// CssParser.merge
export function mergeRuleSets(ruleSets: RuleSet[]): RuleSet {
  if (ruleSets.length === 1) return ruleSets[0]!;
  const properties = new Map<string, { value: string; specificity: number; important: boolean }>();
  for (const ruleSet of ruleSets) {
    ruleSet.expandShorthand();
    let specificity = ruleSet.specificity;
    if (specificity === null) {
      const values = ruleSet.selectors.map((s) => calculateSpecificity(s));
      specificity = values.length ? Math.max(...values) : 0;
    }
    for (const [property, value] of ruleSet.declarations.map) {
      const existing = properties.get(property);
      const entry = { value: value.value, specificity, important: value.important };
      if (!existing) properties.set(property, entry);
      else if (value.important) {
        if (!existing.important || existing.specificity <= specificity) properties.set(property, entry);
      } else if (existing.specificity <= specificity) {
        if (!existing.important) properties.set(property, entry);
      }
    }
  }
  const merged = new RuleSet();
  for (const [property, details] of properties) {
    const value = strip(details.value);
    merged.set(strip(property), details.important ? `${value.replace(new RegExp(`;${END_Z}`), "")}!important` : value);
  }
  merged.createShorthand();
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Parser

const RULESET_TOKENIZER_RX = /[ \t\n\v\f\r]+|\\{2,}|\\?[{}\t\n\v\f\r "]|[()]|[^\n][^ \t\n\v\f\r"{}()\\]*/uy;
const RE_AT_IMPORT_RULE = new RegExp(
  `@import${S}*(?:url${S}*)?(?:\\()?(?:${S}*)["']?([^'"\\t\\n\\v\\f\\r )]*)["']?\\)?([\\w\\t\\n\\v\\f\\r ,^\\]()]*)\\)?[;\\n]?`,
  "g",
);

export type CssRule = { mediaTypes: string[]; rules: RuleSet };

export class CssParser {
  rules: CssRule[] = [];

  // Parser#add_block! as premailer calls it: no base_uri or base_dir, so @import rules are only
  // stripped, never followed.
  addBlock(block: string): void {
    let css = block.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/<!--|-->/gu, "");
    css = css.replace(new RegExp(`${BOL}${S}+${EOL}`, "g"), "");
    css = css.replace(RE_AT_IMPORT_RULE, "");
    this.parseBlockIntoRuleSets(css, ["all"]);
  }

  addRuleSet(ruleSet: RuleSet, mediaTypes: string | string[] = "all"): void {
    const list = (Array.isArray(mediaTypes) ? mediaTypes : [mediaTypes]).map((mt) => sanitizeMediaQuery(mt));
    this.rules.push({ mediaTypes: list, rules: ruleSet });
  }

  eachSelector(
    callback: (selector: string, declarations: string, specificity: number, mediaTypes: string[]) => void,
  ): void {
    for (const { mediaTypes, rules } of this.rules) {
      rules.eachSelector((selector, declarations, specificity) =>
        callback(selector, declarations, specificity, mediaTypes),
      );
    }
  }

  toString(): string {
    const byMedia = new Map<string, [string, string][]>();
    this.eachSelector((selector, declarations, _specificity, mediaTypes) => {
      for (const mediaType of mediaTypes) {
        if (!byMedia.has(mediaType)) byMedia.set(mediaType, []);
        byMedia.get(mediaType)!.push([selector, declarations]);
      }
    });
    const out: string[] = [];
    for (const [mediaType, styles] of byMedia) {
      const mediaBlock = mediaType !== "all";
      if (mediaBlock) out.push(`@media ${mediaType} {`);
      for (const [selector, declarations] of styles) {
        out.push(mediaBlock ? `  ${selector} {\n    ${declarations}\n  }` : `${selector} {\n${declarations}\n}`);
      }
      if (mediaBlock) out.push("}");
    }
    out.push("");
    return out.join("\n");
  }

  private addRule(selectors: string, block: string, mediaTypes: string[]): void {
    this.addRuleSet(new RuleSet({ selectors, block }), mediaTypes);
  }

  private parseBlockIntoRuleSets(block: string, mediaTypes: string[]): void {
    let currentMediaQueries = mediaTypes.map((mt) => sanitizeMediaQuery(mt));
    let inDeclarations = 0;
    let inCharset = false;
    let inString = false;
    let inAtMediaRule = false;
    let inMediaBlock = false;
    let currentSelectors = "";
    let currentMediaQuery = "";
    let currentDeclarations = "";

    let pos = 0;
    while (pos < block.length) {
      RULESET_TOKENIZER_RX.lastIndex = pos;
      const match = RULESET_TOKENIZER_RX.exec(block);
      if (!match) throw new Error(`css tokenizer stuck at ${pos}`);
      let token = match[0];
      pos = RULESET_TOKENIZER_RX.lastIndex;

      if (token.startsWith('"')) inString = !inString;

      if (inDeclarations > 0) {
        if (inDeclarations > 1) {
          if (token.includes("}")) inDeclarations -= 1;
          continue;
        }
        if (!inString && token.includes("{")) {
          inDeclarations += 1;
          continue;
        }
        currentDeclarations += token;
        if (!inString && token.includes("}")) {
          currentDeclarations = strip(currentDeclarations.replace(new RegExp(`\\}${S}*${EOL}`, "g"), ""));
          inDeclarations -= 1;
          if (currentDeclarations !== "") this.addRule(currentSelectors, currentDeclarations, currentMediaQueries);
          currentSelectors = "";
          currentDeclarations = "";
        }
      } else if (/@media/iu.test(token)) {
        inAtMediaRule = true;
        currentMediaQueries = [];
      } else if (inAtMediaRule) {
        if (token.includes("{")) {
          inAtMediaRule = false;
          inMediaBlock = true;
          currentMediaQueries.push(sanitizeMediaQuery(currentMediaQuery));
          currentMediaQuery = "";
        } else if (token.includes(",")) {
          token = strip(token.replaceAll(",", " "));
          currentMediaQuery += `${token} `;
          currentMediaQueries.push(sanitizeMediaQuery(currentMediaQuery));
          currentMediaQuery = "";
        } else {
          token = strip(token);
          if (token === "(") currentMediaQuery += token;
          else if (token === ")") currentMediaQuery = currentMediaQuery.replace(new RegExp(` ?${EOL}`), token);
          else currentMediaQuery += `${token} `;
        }
      } else if (inCharset || /@charset/iu.test(token)) {
        inCharset = !token.includes(";");
      } else if (!inString && token.includes("}")) {
        if (inMediaBlock) {
          currentMediaQueries = ["all"];
          inMediaBlock = false;
        }
      } else if (!inString && token.includes("{")) {
        currentSelectors = strip(currentSelectors);
        inDeclarations += 1;
      } else {
        currentSelectors += token;
      }
    }

    if (inDeclarations > 0) this.addRule(currentSelectors, currentDeclarations, currentMediaQueries);
  }
}
