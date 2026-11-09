// Port of `css_image_urls` and its helpers, and of `css_references_all_local?`, in
// app/services/content_moderation/content_extractor.rb.
import {
  parseProperties,
  parseRules,
  parseStylesheet,
  tokenize,
  type CssError,
  type CssFunction,
  type CssNode,
  type CssProperty,
  type CssRule,
  type CssToken,
} from "./css-syntax.ts";
import { attribute, textOf, type HtmlDocument } from "./html-document.ts";

// CSS properties that paint an image the visitor sees. url() also appears in fonts and SVG filter
// references, which the image moderation endpoint rejects.
export const IMAGE_CSS_PROPERTIES: readonly string[] = [
  "background",
  "background-image",
  "border-image",
  "border-image-source",
  "content",
  "cursor",
  "list-style",
  "list-style-image",
  "mask",
  "mask-border",
  "mask-border-source",
  "mask-image",
];

// CssToken.node is a plain string, so `node === "function"` does not narrow the union.
const isFunction = (node: CssNode): node is CssFunction => node.node === "function";

const isProperty = (node: unknown): node is CssProperty => (node as CssNode | undefined)?.node === "property";

// Whether every reference this CSS can load points inside the document. Token level, so escapes
// read as a browser reads them; strings count as references. Fails closed.
export function cssReferencesAllLocal(css: string): boolean {
  let depth = 0;
  for (const token of tokenize(css)) {
    const value = (token.value ?? "").trim();
    switch (token.node) {
      case "function":
      case "(":
        depth += 1;
        break;
      case ")":
        depth -= 1;
        break;
      case "url":
      case "bad_url":
        if (!value.startsWith("#")) return false;
        break;
      case "string":
      case "bad_string":
        if (depth > 0 && !value.startsWith("#")) return false;
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
        break;
      case "at_keyword":
        if ((token.value ?? "").toLowerCase() === "import") return false;
        break;
    }
  }
  return true;
}

// Images painted by CSS in inline `style` attributes and <style> blocks. A custom property's url()
// counts only when an image-painting declaration reads it through var(), possibly via other custom
// properties; definitions and references match across the whole document.
export function cssImageUrls(document: HtmlDocument): string[] {
  const properties: CssProperty[] = [];
  for (const element of document.elements()) {
    const style = attribute(element, "style");
    if (style !== null) properties.push(...parseProperties(style).filter(isProperty));
  }
  for (const element of document.byTag("style")) properties.push(...styleSheetProperties(textOf(element)));

  // Custom property names are case-sensitive, unlike standard properties.
  const customValues = new Map<string, CssNode[][]>();
  const urls: string[] = [];
  const referenced: string[] = [];

  for (const property of properties) {
    if (property.name.startsWith("--")) {
      customValues.set(property.name, [...(customValues.get(property.name) ?? []), property.children]);
    } else if (IMAGE_CSS_PROPERTIES.includes(property.name.toLowerCase().replace(/^-[a-z]+-/, ""))) {
      urls.push(...cssUrlValues(property.children));
      referenced.push(...cssVarReferences(property.children));
    }
  }

  const resolved = new Set<string>();
  while (referenced.length > 0) {
    const name = referenced.shift()!;
    if (resolved.has(name)) continue;
    resolved.add(name);

    // Every definition, not one winner: which applies depends on the cascade per element.
    for (const value of customValues.get(name) ?? []) {
      urls.push(...cssUrlValues(value));
      referenced.push(...cssVarReferences(value));
    }
  }

  return urls;
}

// One <style> sheet's declarations. The structured parse drops a rule nested in another (CSS
// nesting) as a bare error, while nesting-capable browsers render it. When it dropped something,
// the sheet is re-read with every block brace turned into a semicolon so declarations at any depth
// parse flat. That can collect a declaration a browser would not apply, which only errs toward
// reviewing an image.
function styleSheetProperties(css: string): CssProperty[] {
  const nodes = ruleProperties(parseStylesheet(css));
  const properties = nodes.filter(isProperty);
  if (nodes.some((node) => !isProperty(node))) {
    properties.push(...parseProperties(flattenBlocks(css)).filter(isProperty));
  }
  return properties;
}

function flattenBlocks(css: string): string {
  return tokenize(css)
    .map((token) => (token.node === "{" || token.node === "}" ? ";" : token.raw))
    .join("");
}

// Property nodes plus the :error nodes marking content the parse dropped.
function ruleProperties(rules: CssRule[]): (CssProperty | CssError)[] {
  return rules.flatMap((rule): (CssProperty | CssError)[] => {
    switch (rule.node) {
      case "style_rule":
        return rule.children;
      case "at_rule":
        // @font-face is skipped whole: its src URLs are fonts, and its declarations would surface
        // as errors that must not trigger the flattened re-read.
        if (rule.name.toLowerCase() === "font-face" || rule.block === null) return [];
        return ruleProperties(parseRules(rule.block as CssToken[]));
      case "error":
        return [rule];
    }
  });
}

// Custom property names read through var() anywhere in a value, fallbacks included.
function cssVarReferences(nodes: CssNode[]): string[] {
  return nodes.flatMap((node) => {
    if (!isFunction(node)) return [];
    const names = cssVarReferences(node.value);
    if (node.name.toLowerCase() === "var") {
      for (const token of node.value) {
        if (token.node === "ident" && (token as CssToken).value?.startsWith("--"))
          names.push((token as CssToken).value!);
      }
    }
    return names;
  });
}

// url() tokens anywhere in the value, including inside image-set() and cross-fade(). Parenthesised
// and bracketed groups are not entered, as in the Ruby.
function cssUrlValues(nodes: CssNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.node === "url") return [(node as CssToken).value ?? ""];
    if (!isFunction(node)) return [];
    if (node.name.toLowerCase() === "url") {
      return node.value.filter((token) => token.node === "string").map((token) => (token as CssToken).value ?? "");
    }
    return cssUrlValues(node.value);
  });
}
