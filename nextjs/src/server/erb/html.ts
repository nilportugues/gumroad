// ActionView's tag helpers for the ERB layout pages: what `link_to`, `image_tag`, `content_tag` and
// `tag.meta` write, and the escaping every `<%= %>` applies.

// A string the helper that built it already escaped (ActiveSupport::SafeBuffer).
export class SafeString {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Html = string | SafeString;

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// ERB::Util.html_escape
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char]!);

export const html = (value: Html): string => (value instanceof SafeString ? value.value : escapeHtml(value));

// ActionView::Helpers::TagHelper::BOOLEAN_ATTRIBUTES
const BOOLEAN_ATTRIBUTES = new Set(
  `allowfullscreen allowpaymentrequest async autofocus autoplay checked compact controls declare default defaultchecked defaultmuted
  defaultselected defer disabled enabled formnovalidate hidden indeterminate inert ismap itemscope loop multiple muted nohref nomodule
  noresize noshade novalidate nowrap open pauseonexit playsinline readonly required reversed scoped seamless selected sortable
  truespeed typemustmatch visible`.split(/\s+/u),
);

export type AttributeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, string | number | boolean | null | undefined>;
export type Attributes = Record<string, AttributeValue>;

// ActionView::Helpers::TagHelper::TagBuilder#tag_options: keys keep their order, nil and false values are dropped, `data` and
// `aria` hashes expand to `data-*` / `aria-*` in place, and underscores in a symbol key stay (callers pass the hyphenated name).
export function tagOptions(attributes: Attributes): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if ((key === "data" || key === "aria") && value !== null && typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue === null || innerValue === undefined || innerValue === false) continue;
        parts.push(`${key}-${inner.replaceAll("_", "-")}="${escapeHtml(String(innerValue))}"`);
      }
    } else if (value === null || value === undefined || value === false) continue;
    else if (BOOLEAN_ATTRIBUTES.has(key)) parts.push(`${key}="${key}"`);
    else parts.push(`${key}="${escapeHtml(String(value))}"`);
  }
  return parts.join(" ");
}

const open = (name: string, attributes: Attributes) => {
  const options = tagOptions(attributes);
  return options === "" ? `<${name}` : `<${name} ${options}`;
};

// content_tag / tag.div: the content is escaped unless it is already safe.
export function contentTag(name: string, content: Html, attributes: Attributes = {}): SafeString {
  return new SafeString(`${open(name, attributes)}>${html(content)}</${name}>`);
}

// link_to name, url, html_options: the options come first and `href` last.
export function linkTo(content: Html, url: string, attributes: Attributes = {}): SafeString {
  return new SafeString(`${open("a", { ...attributes, href: url })}>${html(content)}</a>`);
}

// image_tag: `src` comes last, and the tag is self-closed.
export function imageTag(src: string, attributes: Attributes = {}): SafeString {
  return new SafeString(`${open("img", { ...attributes, src })} />`);
}

// `button_tag type: "submit"` defaults to name="button".
export function buttonTag(content: Html, attributes: Attributes = {}): SafeString {
  return new SafeString(`${open("button", { name: "button", ...attributes })}>${html(content)}</button>`);
}
