// The libxml2 tree premailer works on: Nokogiri::HTML(html, nil, "UTF-8", &:recover), then
// Premailer::Adapter::Nokogiri#load_html's swap of <style>/<script> CDATA for text nodes.
import { parseHtmlDocument } from "../../html/libxml2-parser.ts";
import { allElements, type DocumentNode, UnsupportedHtmlError } from "../../html/libxml2-tree.ts";

export * from "../../html/libxml2-tree.ts";

export function parseHtml(html: string): DocumentNode {
  const doc = parseHtmlDocument(html);
  for (const element of allElements(doc)) {
    if (element.name !== "style" && element.name !== "script") continue;
    for (const [i, child] of element.children.entries()) {
      if (child.type !== "cdata") continue;
      // `child.swap(child.text)` parses the text as markup in the element's context.
      if (/[<&]/u.test(child.content)) throw new UnsupportedHtmlError(`markup in <${element.name}> content`);
      element.children[i] = { type: "text", content: child.content, parent: element };
    }
  }
  return doc;
}
