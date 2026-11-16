// Shapes of html.golden.json (generate-html-golden.rb) and the tree dump it compares.
import type { DocumentNode, HtmlNode } from "../libxml2-tree.ts";

export type Outcome = { ok: string } | { error: string };

export type HtmlCase = {
  document: string;
  parse: DumpedDocument;
  fragment: string;
  fragment_html: string;
  strip_tags: string;
  sanitize: string;
  sanitize_recap: string;
  uri: string;
  allowed_uri: Outcome;
  href_fragment: string;
  href: Outcome;
  simple_format_input: string;
  simple_format: string;
  links: string;
  auto_link: Outcome;
  comment_body: Outcome;
  recap_summary: Outcome;
};

export type HtmlGolden = { seed: number; count: number; cases: HtmlCase[] };

type Dumped = ["e", string, [string, string | null][], Dumped[]] | ["t" | "c" | "!", string] | ["?", string, string];
export type DumpedDocument = { dtd: [string | null, string | null, string | null] | null; children: Dumped[] };

function dump(node: HtmlNode): Dumped {
  switch (node.type) {
    case "element":
      return ["e", node.name, node.attributes.map((a) => [a.name, a.value]), node.children.map(dump)];
    case "text":
      return ["t", node.content];
    case "cdata":
      return ["c", node.content];
    case "comment":
      return ["!", node.content];
    case "pi":
      return ["?", node.name, node.content ?? ""];
  }
}

export function dumpDocument(doc: DocumentNode): DumpedDocument {
  return { dtd: doc.dtd && [doc.dtd.name, doc.dtd.externalId, doc.dtd.systemId], children: doc.children.map(dump) };
}
