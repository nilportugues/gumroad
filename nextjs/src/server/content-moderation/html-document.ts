// Stands in for the `Nokogiri::HTML(...)` documents content_extractor.rb builds: a parsed tree with
// element removal, selector-free lookups and `Node#text`.
//
// Nokogiri parses with libxml2's HTML4 parser, parse5 with the HTML5 algorithm. What differs:
// - Character references: parse5 never sees an `&` (it is swapped for a sentinel, as in
//   search/plaintext.ts) and text and attribute values are decoded here the way libxml2 does.
// - Tree construction for misnested markup (implied `tbody`, foster parenting, `<p>` closing rules,
//   nesting limits) follows HTML5, so such pages can order or group text differently. The extracted
//   set of text, links and image URLs is unaffected for well-formed markup.
// - `<template>` content sits in a separate fragment in parse5; it is walked as a child here.
// - `<noscript>` is parsed as raw text (scripting enabled). With scripting disabled, HTML5 moves a
//   head-level noscript's text into <body>, so removing the element would leave its text behind.
import { parse, type DefaultTreeAdapterMap } from "parse5";

import { AMP, ESCAPED_SENTINEL, restoreSentinels } from "../search/plaintext.ts";

export type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlNode = DefaultTreeAdapterMap["node"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

// libxml2 parses only these as raw text, so a literal `&` stays.
const RAW_TEXT = new Set(["script", "style"]);

const isElement = (node: HtmlNode): node is HtmlElement => "tagName" in node;
const isText = (node: HtmlNode): node is DefaultTreeAdapterMap["textNode"] => node.nodeName === "#text";

function childrenOf(node: ParentNode | HtmlNode): HtmlNode[] {
  if ("content" in node && node.content) return node.content.childNodes;
  return "childNodes" in node ? node.childNodes : [];
}

function decodeReferences(node: HtmlNode, raw: boolean): void {
  if (isText(node)) {
    node.value = restoreSentinels(node.value, !raw);
    return;
  }
  if (isElement(node)) {
    for (const attr of node.attrs) attr.value = restoreSentinels(attr.value, true);
  }
  const rawChildren = isElement(node) && RAW_TEXT.has(node.tagName);
  for (const child of childrenOf(node)) decodeReferences(child, rawChildren);
}

export class HtmlDocument {
  private constructor(private readonly root: ParentNode) {}

  static parse(html: string): HtmlDocument {
    const guarded = html.replaceAll(AMP, `${AMP}${ESCAPED_SENTINEL}`).replaceAll("&", AMP);
    const root = parse(guarded, { scriptingEnabled: true });
    for (const child of childrenOf(root)) decodeReferences(child, false);
    return new HtmlDocument(root);
  }

  // Every element, in document order.
  elements(): HtmlElement[] {
    const out: HtmlElement[] = [];
    const visit = (node: HtmlNode | ParentNode) => {
      for (const child of childrenOf(node)) {
        if (isElement(child)) out.push(child);
        visit(child);
      }
    };
    visit(this.root);
    return out;
  }

  // document.css("script, style"): elements by tag name, in document order.
  byTag(...names: string[]): HtmlElement[] {
    return this.elements().filter((element) => names.includes(element.tagName));
  }

  remove(...names: string[]): void {
    for (const element of this.byTag(...names)) {
      const parent = element.parentNode;
      if (parent) parent.childNodes = parent.childNodes.filter((child) => child !== element);
    }
  }

  // Node#text for the whole document: text nodes only, so comments are left out.
  get text(): string {
    return textOf(this.root);
  }
}

export function textOf(node: HtmlNode | ParentNode): string {
  if (isText(node)) return node.value;
  return childrenOf(node).map(textOf).join("");
}

// node["name"]: the attribute's value, or null when absent.
export function attribute(element: HtmlElement, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name)?.value ?? null;
}
