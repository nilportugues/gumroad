import { describe, expect, it } from "vitest";

import golden from "../controllers/__fixtures__/custom-html-document.golden.json" with { type: "json" };

import { documentTitleFor, richTextDocument } from "./pages-documents.ts";

type Arguments = {
  title: string | null;
  seo_title: string | null;
  content: string | null;
  seller_name: string | null;
  profile_href: string;
  head_extra: string;
};

describe("Pages::DocumentTitle and Pages::RichTextDocument against Ruby (nextjs/scripts/golden/custom-html-document.rb)", () => {
  for (const c of golden.rich_text_documents) {
    const args = c.arguments as Arguments;
    it(`titles ${JSON.stringify(args.title)} for ${JSON.stringify(args.seller_name)}`, () => {
      expect(documentTitleFor({ pageTitle: args.title, sellerName: args.seller_name, seoTitle: args.seo_title })).toBe(
        c.document_title,
      );
    });

    it(`renders ${JSON.stringify(args.title)} by ${JSON.stringify(args.seller_name)}`, () => {
      expect(
        richTextDocument({
          page: { title: args.title, seo_title: args.seo_title, content: args.content },
          sellerName: args.seller_name,
          profileHref: args.profile_href,
          headExtra: args.head_extra,
        }),
      ).toBe(c.document);
    });
  }
});
