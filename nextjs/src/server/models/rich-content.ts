// Port of RichContent#has_editor_content? (app/models/rich_content.rb), with its private `node_has_content?` walk.
// Only the predicate is ported; the page rows are read where they are used.

// ActiveSupport `blank?` of a String: only Unicode whitespace.
const BLANK_STRING = /^[\p{Z}\t\n\v\f\r\u0085]*$/u;

// Ruby `present?` of a value read out of JSON.
function present(value: unknown): boolean {
  if (typeof value === "string") return !BLANK_STRING.test(value);
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false;
}

// RichContent#node_has_content? with no `excluding_node_types:`: text, or a container with a contentful child, or a
// leaf other than the editor's blank paragraph/heading placeholder.
function nodeHasContent(node: unknown): boolean {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const hash = node as Record<string, unknown>;
  if (present(hash.text)) return true;
  const children = hash.content;
  if (Array.isArray(children)) return children.some(nodeHasContent);
  return hash.type !== "paragraph" && hash.type !== "heading";
}

// RichContent#has_body_content?: `description.present? && description.any? { node_has_content? }`. `description` is the
// JSON column, which Prisma's raw reads may hand back as its text.
export function hasBodyContent(description: unknown): boolean {
  const nodes = typeof description === "string" ? (JSON.parse(description) as unknown) : description;
  return Array.isArray(nodes) && nodes.some(nodeHasContent);
}

// RichContent#has_editor_content?: a titled page counts even with an empty body.
export function hasEditorContent(page: { title: string | null; description: unknown }): boolean {
  return present(page.title) || hasBodyContent(page.description);
}
