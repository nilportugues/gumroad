// premailer-rails 1.12 (Premailer::Rails::Hook + CustomizedPremailer) over premailer 1.29's
// Nokogiri adapter, with the options config/initializers/premailer_rails.rb sets
// (remove_ids: false, preserve_style_attribute: true) and premailer's defaults for the rest.
import { calculateSpecificity, CssArgumentError, CssParser, mergeRuleSets, RuleSet } from "./css-parser.ts";
import {
  allElements,
  appendChild,
  createElement,
  type DocumentNode,
  type ElementNode,
  findElement,
  getAttribute,
  parseHtml,
  removeAttribute,
  removeNode,
  serializeChildren,
  serializeDocument,
  setAttribute,
} from "./html.ts";
import { convertToText } from "./html-to-text.ts";
import { strip } from "./ruby.ts";
import { search } from "./selector.ts";

export type StylesheetLoader = (href: string) => string;

const RE_UNMERGABLE_SELECTORS = /(:(visited|active|hover|focus|after|before|selection|target|first-(line|letter))|^@)/im;
const RE_RESET_SELECTORS = /^(:#outlook|body[^\n]*|\.ReadMsgBody|\.ExternalClass|img|#backgroundTable)$/m;

const RELATED_ATTRIBUTES: Record<string, [string, string][]> = {
  h1: [["text-align", "align"]],
  h2: [["text-align", "align"]],
  h3: [["text-align", "align"]],
  h4: [["text-align", "align"]],
  h5: [["text-align", "align"]],
  h6: [["text-align", "align"]],
  p: [["text-align", "align"]],
  div: [["text-align", "align"]],
  blockquote: [["text-align", "align"]],
  body: [["background-color", "bgcolor"]],
  table: [
    ["-premailer-align", "align"],
    ["background-color", "bgcolor"],
    ["background-image", "background"],
    ["-premailer-width", "width"],
    ["-premailer-height", "height"],
    ["-premailer-cellpadding", "cellpadding"],
    ["-premailer-cellspacing", "cellspacing"],
  ],
  tr: [
    ["text-align", "align"],
    ["background-color", "bgcolor"],
    ["-premailer-height", "height"],
  ],
  th: [
    ["text-align", "align"],
    ["background-color", "bgcolor"],
    ["vertical-align", "valign"],
    ["-premailer-width", "width"],
    ["-premailer-height", "height"],
  ],
  td: [
    ["text-align", "align"],
    ["background-color", "bgcolor"],
    ["vertical-align", "valign"],
    ["-premailer-width", "width"],
    ["-premailer-height", "height"],
  ],
  img: [
    ["float", "align"],
    ["-premailer-width", "width"],
    ["-premailer-height", "height"],
  ],
};

// AdapterHelper::RgbToHex#ensure_hex
function ensureHex(color: string): string {
  const m = /rgb\s*\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})\s*(?:\/\s*\d*\.?\d*%?)?\s*\)/u.exec(color);
  if (!m) return color;
  return [m[1], m[2], m[3]].map((n) => Number.parseInt(n!, 10).toString(16).padStart(2, "0").toUpperCase()).join("");
}

// Premailer#media_type_ok?
function mediaTypeOk(media: string | null | undefined): boolean {
  const value = media ?? "";
  if (value === "") return true;
  return value.split(/[\s]+|,/u).some((t) => /screen|handheld|all/iu.test(t.trim()));
}

const isStylesheetLink = (el: ElementNode) =>
  el.name === "link" && getAttribute(el, "rel") === "stylesheet" && getAttribute(el, "data-premailer") !== "ignore";

class Premailer {
  private readonly doc: DocumentNode;
  private readonly cssParser = new CssParser();

  constructor(html: string, cssString: string) {
    this.doc = parseHtml(html);
    this.cssParser.addBlock(cssString);
    // load_css_from_html!: <link> tags are gone already (CSSHelper took them); <style> tags remain.
    const tags = allElements(this.doc).filter((el) => isStylesheetLink(el) || (el.name === "style" && getAttribute(el, "data-premailer") !== "ignore"));
    for (const tag of tags) {
      if (tag.name === "link") {
        if (getAttribute(tag, "href") && mediaTypeOk(getAttribute(tag, "media"))) throw new Error("premailer: a <link> stylesheet survived CSSHelper");
      } else {
        this.cssParser.addBlock(serializeChildren(tag));
      }
    }
    for (const tag of tags) removeNode(tag);
  }

  // Premailer::Adapter::Nokogiri#to_plain_text
  toPlainText(): string {
    const body = findElement(this.doc, "body");
    let source = body ? serializeChildren(body) : "";
    if (source === "") source = serializeDocument(this.doc);
    return convertToText(source, 65);
  }

  // Premailer::Adapter::Nokogiri#to_inline_css
  toInlineCss(): string {
    const doc = this.doc;
    const unmergable = new CssParser();

    for (const el of allElements(doc)) {
      const style = getAttribute(el, "style");
      if (style !== undefined) setAttribute(el, "style", `[SPEC=1000[${style ?? ""}]]`);
    }

    this.cssParser.eachSelector((rawSelector, declaration, specificity, mediaTypes) => {
      let selector = rawSelector.replace(/:link([ \t\n\v\f\r]*)+/giu, (_m, ws: string | undefined) => ws ?? "");
      selector = selector.replace(/([ \t\n\v\f\r]|^)([\w]+)/gmu, (_m, pre: string, word: string) => pre + word.toLowerCase());

      const mediaQuery = mediaTypes.some((mt) => (mt.match(/[()]/gu)?.length ?? 0) >= 2);
      if (mediaQuery || RE_UNMERGABLE_SELECTORS.test(selector)) {
        unmergable.addRuleSet(new RuleSet({ selectors: selector, block: declaration }), mediaTypes);
        return;
      }
      if (RE_RESET_SELECTORS.test(selector)) unmergable.addRuleSet(new RuleSet({ selectors: selector, block: declaration }));
      selector = selector.replace(/^#([\w_-]+)$/u, "*[@id=$1]");

      const matches = search(doc, selector);
      if (matches === "skip") return;
      for (const el of matches) {
        const parentName = el.parent?.type === "element" ? el.parent.name : "document";
        if (el.name === "head" || parentName === "head") continue;
        setAttribute(el, "style", `${getAttribute(el, "style") ?? ""} [SPEC=${specificity}[${declaration}]]`);
      }
    });

    for (const el of allElements(doc)) {
      const style = getAttribute(el, "style");
      if (style === undefined) continue;
      const declarations = [...(style ?? "").matchAll(/\[SPEC=([\d]+)\[([\s\S][^\]]*)\]\]/gu)].map((m) => {
        const rs = new RuleSet({ block: m[2]!, specificity: Number.parseInt(m[1]!, 10), cached: true });
        rs.expandShorthand();
        return rs;
      });
      const merged = mergeRuleSets(declarations);
      merged.expandShorthand();

      for (const [cssAttr, htmlAttr] of RELATED_ATTRIBUTES[el.name] ?? []) {
        const current = merged.getValue(cssAttr);
        if (getAttribute(el, htmlAttr) === undefined && current !== "") {
          let value = current.replace(/url\((['"])([^\n]*?)\1\)/gu, "$2");
          value = strip(value.replace(/;$|[ \t\n\v\f\r]*!important/gmu, ""));
          if (htmlAttr === "width" || htmlAttr === "height") value = value.replace(/(\d+)px/gu, "$1");
          if (cssAttr.endsWith("color")) value = ensureHex(value);
          setAttribute(el, htmlAttr, value);
        }
      }

      merged.createShorthand();
      setAttribute(el, "style", merged.declarationsToString());
    }

    const styles = unmergable.toString();
    if (styles !== "") {
      const head = findElement(doc, "head");
      if (!head) throw new Error("premailer: unmergeable rules need a <head>");
      const tag = createElement("style");
      appendChild(tag, { type: "text", content: styles, parent: null });
      appendChild(head, tag);
    }

    for (const el of allElements(doc)) {
      if (el.name === "script") removeNode(el);
    }
    for (const el of allElements(doc)) {
      if (getAttribute(el, "contenteditable") !== undefined) removeAttribute(el, "contenteditable");
    }
    return serializeDocument(doc);
  }
}

export type PremailerResult = { html: string; text: string };

// Premailer::Rails::Hook for a message whose only part is text/html: CustomizedPremailer pulls the
// <link> stylesheets out (EmailStylesheetLoader), the remaining document is reparsed, and the text
// part is generated before the CSS is inlined.
export function premailerRails(html: string, loadStylesheet: StylesheetLoader): PremailerResult {
  const first = parseHtml(html);
  const links = allElements(first).filter(isStylesheetLink);
  const css = links
    .map((link) => {
      removeNode(link);
      return loadStylesheet(getAttribute(link, "href") ?? "");
    })
    .join("\n");
  const premailer = new Premailer(serializeDocument(first), css);
  const text = premailer.toPlainText();
  return { text, html: premailer.toInlineCss() };
}

export { calculateSpecificity, CssArgumentError };
