// Port of Pages::DefaultProfileDocument.render (app/services/pages/default_profile_document.rb) for a seller whose storefront lists
// nothing: no product, no published post (Pages::ProfileData would list them) and no uploaded avatar (User#avatar_url would ask Active
// Storage for a variant). The caller proves those three and hands the seller back otherwise, so the product and post sections, which are
// empty strings here, are not ported.
import { rubyBlank } from "../ai/page-sanitizer.ts";
import { accessibleAccent } from "../models/contrast-color.ts";

export type DefaultProfileDocumentInput = {
  // User#name_or_username
  nameOrUsername: string | null;
  bio: string | null;
  // User#avatar_url of a seller with no uploaded avatar
  avatarUrl: string;
  // SellerProfile columns, null when the seller has no profile row
  profile: { background_color: string | null; highlight_color: string | null } | null;
};

const DEFAULT_BACKGROUND = "#ffffff";
const DEFAULT_HIGHLIGHT = "#ff90e8";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// ERB::Util.h
const h = (text: string): string => text.replace(/[&<>"']/gu, (c) => HTML_ESCAPES[c]!);

// Pages::DefaultProfileDocument.css_hex_color: \A and \z, not ^ and $, so a trailing newline falls back.
const cssHexColor = (value: string | null | undefined, fallback: string): string =>
  value != null && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;

export function defaultProfileDocument(input: DefaultProfileDocumentInput): string {
  const background = cssHexColor(input.profile?.background_color, DEFAULT_BACKGROUND);
  const highlight = cssHexColor(input.profile?.highlight_color, DEFAULT_HIGHLIGHT);
  const accentWithText = accessibleAccent(highlight);
  const name = h(input.nameOrUsername ?? "");
  const bio = h(input.bio ?? "");
  const avatar = h(input.avatarUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${name}</title>
    <style>
      :root { --background: ${background}; --accent: ${highlight}; --accent-with-text: ${accentWithText.accent}; --accent-text: ${accentWithText.text}; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--background); color: #000; line-height: 1.5; }
      main { max-width: 64rem; margin: 0 auto; padding: 3rem 1.5rem; }
      header.creator { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
      header.creator img { width: 4rem; height: 4rem; border-radius: 50%; border: 1px solid #000; }
      header.creator h1 { margin: 0; font-size: 2rem; line-height: 1.2; }
      p.bio { margin: 0 0 2rem; max-width: 42rem; }
      section h2 { font-size: 1.25rem; margin: 2.5rem 0 1rem; }
      .products { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 1rem; padding: 0; margin: 0; list-style: none; }
      .products a { display: block; height: 100%; color: inherit; text-decoration: none; border: 1px solid #000; border-radius: 8px; overflow: hidden; background: #fff; }
      .products a:hover { box-shadow: 4px 4px 0 var(--accent); }
      .products img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-bottom: 1px solid #000; }
      .products .details { padding: 0.75rem 1rem; }
      .products h3 { margin: 0 0 0.5rem; font-size: 1rem; }
      .products .price { display: inline-block; padding: 0.125rem 0.5rem; border: 1px solid #000; border-radius: 4px; background: var(--accent-with-text); color: var(--accent-text); font-size: 0.875rem; }
      .posts { padding: 0; margin: 0; list-style: none; }
      .posts li { border-top: 1px solid rgba(0, 0, 0, 0.2); }
      .posts a { display: block; padding: 0.75rem 0; color: inherit; }
    </style>
  </head>
  <body>
    <main>
      <header class="creator">
        ${rubyBlank(avatar) ? "" : `<img src="${avatar}" alt="${name}">`}
        <h1>${name}</h1>
      </header>
      ${rubyBlank(bio) ? "" : `<p class="bio">${bio}</p>`}
      
      
    </main>
  </body>
</html>
`;
}
