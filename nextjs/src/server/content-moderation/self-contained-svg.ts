// Port of `self_contained_svg?` in app/services/content_moderation/content_extractor.rb.
//
// Nokogiri::XML(source) is libxml2's XML parser in recovery mode; this uses parse5's HTML5
// algorithm, which parses `<svg>` as foreign content and, like the recovering XML parser, accepts
// malformed input. What differs, and why it stays on the safe side:
// - Names are matched by local name, lower-cased, so `foreignObject` and `feImage` case-adjustment
//   does not matter. `xlink:href` is the local name `href` in both parsers.
// - libxml2 stops at the first root element and drops "extra content"; this inspects every
//   top-level element, so trailing markup is checked instead of ignored. Stricter, never looser.
// - Entities: XML knows five predefined ones plus numeric references; HTML5 decodes a superset.
//   Numeric references (`&#100;ata:`) decode identically, which is what the vectors cover.
// - Text before the root element makes libxml2 fail to find a root; here it is ignored.
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import { cssReferencesAllLocal } from "./css-image-urls.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const FORBIDDEN_ELEMENTS = ["image", "feimage", "foreignobject", "script"];

const isElement = (node: Node): node is Element => "tagName" in node;

export function isSelfContainedSvg(source: string): boolean {
  const fragment = parseFragment(source, { scriptingEnabled: false });
  const root = fragment.childNodes.find(isElement);
  if (root === undefined || root.tagName.toLowerCase() !== "svg") return false;

  return fragment.childNodes.every((node) => nodeIsLocal(node, null));
}

function nodeIsLocal(node: Node, parent: Element | null): boolean {
  if (isElement(node)) {
    if (FORBIDDEN_ELEMENTS.includes(node.tagName.toLowerCase())) return false;

    for (const attribute of node.attrs) {
      const value = attribute.value;
      if (/data:/iu.test(value)) return false;

      switch (attribute.name.toLowerCase()) {
        case "href":
          if (!value.trim().startsWith("#")) return false;
          break;
        case "style":
          if (!cssReferencesAllLocal(value)) return false;
          break;
        default:
          // FuncIRI presentation attributes (fill, filter, mask, ...); attributes are already decoded.
          for (const match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gisu)) {
            if (!(match[2] ?? "").trim().startsWith("#")) return false;
          }
      }
    }

    return childrenOf(node).every((child) => nodeIsLocal(child, node));
  }

  if (node.nodeName === "#text") {
    const content = (node as DefaultTreeAdapterMap["textNode"]).value;
    if (/data:/iu.test(content)) return false;
    if (parent?.tagName.toLowerCase() === "style" && !cssReferencesAllLocal(content)) return false;
  }
  return true;
}

function childrenOf(element: Element): Node[] {
  return "content" in element && element.content
    ? (element.content as DefaultTreeAdapterMap["documentFragment"]).childNodes
    : element.childNodes;
}
