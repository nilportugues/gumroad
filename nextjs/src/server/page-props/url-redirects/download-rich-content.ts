// UrlRedirect#rich_content_json for a redirect whose rich content provider is the product or the one version bought (no
// commission), and the node walks the download page reads from those pages.
import type { RichContent } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { jsonTime } from "../../presenters/mobile-serializers.ts";

type Node = { type?: unknown; attrs?: { id?: unknown }; content?: unknown };

const FILE_EMBED = "fileEmbed";
const POSTS = "posts";
// RichContent::COMMON_CONTAINER_NODE_TYPES and FILE_EMBED_CONTAINER_NODE_TYPES
const COMMON_CONTAINERS = ["orderedList", "bulletList", "listItem", "blockquote"];
const FILE_EMBED_CONTAINERS = ["fileEmbedGroup", ...COMMON_CONTAINERS];

const nodesOf = (description: unknown): Node[] => (Array.isArray(description) ? (description as Node[]) : []);

// `alive_rich_contents.sort_by(&:position)`: Array#sort_by is not stable, so equal positions are Rails'.
async function alivePages(entityType: string, entityId: bigint): Promise<RichContent[]> {
  const pages = await db.richContent.findMany({
    where: { entity_type: entityType, entity_id: entityId, deleted_at: null },
    orderBy: { id: "asc" },
  });
  const positions = pages.map((page) => page.position);
  if (new Set(positions).size !== positions.length) throw new HandBackToRails("pages that share a position");
  return [...pages].sort((a, b) => a.position - b.position);
}

export const productRichPages = (productId: bigint) => alivePages("Link", productId);

// A polymorphic entity stores its base class, so a version's pages are BaseVariant's.
export const variantRichPages = (variantId: number) => alivePages("BaseVariant", BigInt(variantId));

// RichContent#select_file_embed_ids, over the nodes of every page. `alive_rich_contents` has no ORDER BY, so the pages are
// walked as stored (by id), not by position.
export function embeddedFileIds(pages: RichContent[]): bigint[] {
  const ids: bigint[] = [];
  const walk = (node: Node) => {
    if (node.type === FILE_EMBED) {
      const raw = node.attrs?.id;
      if (typeof raw !== "string" || raw === "") return;
      const id = decrypt(raw);
      if (id === null) throw new HandBackToRails("a file embed whose id does not decode");
      ids.push(BigInt(id));
    } else if (typeof node.type === "string" && FILE_EMBED_CONTAINERS.includes(node.type)) {
      for (const child of nodesOf(node.content)) walk(child);
    }
  };
  for (const page of [...pages].sort((a, b) => (a.id < b.id ? -1 : 1)))
    for (const node of nodesOf(page.description)) walk(node);
  return [...new Set(ids)];
}

// RichContent#has_posts?
export function hasPostsNode(pages: RichContent[]): boolean {
  const contains = (node: Node): boolean =>
    node.type === POSTS ||
    (typeof node.type === "string" && COMMON_CONTAINERS.includes(node.type) && nodesOf(node.content).some(contains));
  return pages.some((page) => nodesOf(page.description).some(contains));
}

// RichContents#rich_content_json for the provider's pages, which the page props keep as-is. A version's pages carry its id.
export function richContentPagesJson(pages: RichContent[], variantId: string | null = null) {
  return pages.map((page) => ({
    id: encrypt(page.id),
    page_id: encrypt(page.id),
    title: page.title,
    variant_id: variantId,
    description: { type: "doc", content: page.description },
    updated_at: jsonTime(page.updated_at),
  }));
}
