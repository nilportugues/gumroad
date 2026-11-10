// ProductVariantDeletionAudit and AuditCorrelationId, for the one writer Node has: DELETE /v2/products/:link_id/variant_categories/:id.
import { createHmac, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { getConfig } from "../infra/config.ts";

export const API_V2_VARIANT_CATEGORY_DESTROY = "api_v2_variant_category_destroy";
export const API_EXPLICIT_DESTROY = "api_explicit_destroy";
const CORRELATION_ID_LENGTH = 64;
const REQUEST_ID_LENGTH = 255;

// ActionDispatch::RequestId: the client's X-Request-Id stripped to `[\w\-@]` and cut to 255, else a fresh UUID.
export function requestIdOf(header: string | null): string {
  const sanitized = (header ?? "").replace(/[^A-Za-z0-9_\-@]/gu, "").slice(0, REQUEST_ID_LENGTH);
  return sanitized === "" ? randomUUID() : sanitized;
}

// AuditCorrelationId.for: a keyed digest, so a client-chosen request id never reaches the table.
export function auditCorrelationId(requestId: string): string {
  const secretKeyBase = getConfig("SECRET_KEY_BASE");
  if (!secretKeyBase) throw new Error("Missing config SECRET_KEY_BASE (must match the Rails app)");
  return createHmac("sha256", secretKeyBase).update(requestId, "utf8").digest("hex").slice(0, CORRELATION_ID_LENGTH);
}

export type VariantCategoryDeletionAudit = {
  actorUserId: bigint;
  productId: bigint;
  deletedCategoryExternalId: string;
  aliveChildVariantCount: number;
  requestId: string;
};

// `record_deletion` for a category destroyed through the API. Call it after the deleting transaction commits: it fails open, since a lost
// audit row must not undo the deletion.
export async function recordVariantCategoryDeletion(
  client: Pick<PrismaClient, "productVariantDeletionAudit">,
  audit: VariantCategoryDeletionAudit,
): Promise<void> {
  try {
    const correlationId = auditCorrelationId(audit.requestId);
    await client.productVariantDeletionAudit.create({
      data: {
        actor_user_id: audit.actorUserId,
        product_id: audit.productId,
        route: API_V2_VARIANT_CATEGORY_DESTROY,
        intent_source: API_EXPLICIT_DESTROY,
        // The grouping goes without soft-deleting its versions (no `dependent:` on the association), so the deleted and affected sets are empty.
        deleted_variant_external_ids: [],
        deleted_variant_category_external_ids: [audit.deletedCategoryExternalId],
        affected_variant_external_ids: [],
        confirmed_affected_variant_external_ids: [],
        alive_child_variant_count: audit.aliveChildVariantCount,
        correlation_id: correlationId,
        created_at: new Date(),
      },
    });
    console.warn(`[audit_correlation] request_id=${audit.requestId} correlation_id=${correlationId}`);
  } catch (error) {
    console.error("Failed to record a product variant deletion audit", error);
  }
}
