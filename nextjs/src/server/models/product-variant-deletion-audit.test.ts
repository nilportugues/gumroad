import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auditCorrelationId, recordVariantCategoryDeletion, requestIdOf } from "./product-variant-deletion-audit.ts";

const SECRET_KEY_BASE = "parity-replay-secret-key-base";
// AuditCorrelationId.for("parity-variant-category-destroy") under that secret, as Rails recorded it in the parity fixture.
const RAILS_CORRELATION_ID = "e3844342cb21aaf61ff14568008325b3c574acc7e5553d903f3d40b94524fabe";

describe("auditCorrelationId", () => {
  const saved = process.env.SECRET_KEY_BASE;
  beforeEach(() => {
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SECRET_KEY_BASE;
    else process.env.SECRET_KEY_BASE = saved;
  });

  it("matches the digest Rails stores for the same request id", () => {
    expect(auditCorrelationId("parity-variant-category-destroy")).toBe(RAILS_CORRELATION_ID);
  });

  it("is 64 hex characters whatever the request id", () => {
    expect(auditCorrelationId("x".repeat(255))).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("requestIdOf", () => {
  it("strips what ActionDispatch::RequestId strips", () => {
    expect(requestIdOf("req id/1;<b>@x_y-z")).toBe("reqid1b@x_y-z");
  });

  it("cuts a long header to 255 characters", () => {
    expect(requestIdOf("a".repeat(300))).toHaveLength(255);
  });

  it("generates an id when the header is missing or strips to nothing", () => {
    expect(requestIdOf(null)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requestIdOf("!!!")).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe("recordVariantCategoryDeletion", () => {
  const audit = {
    actorUserId: 7n,
    productId: 9n,
    deletedCategoryExternalId: "ext-1",
    aliveChildVariantCount: 2,
    requestId: "parity-variant-category-destroy",
  };
  beforeEach(() => {
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the row Rails writes for an explicit category destroy", async () => {
    const create = vi.fn().mockResolvedValue({});
    await recordVariantCategoryDeletion({ productVariantDeletionAudit: { create } } as never, audit);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor_user_id: 7n,
        product_id: 9n,
        route: "api_v2_variant_category_destroy",
        intent_source: "api_explicit_destroy",
        deleted_variant_external_ids: [],
        deleted_variant_category_external_ids: ["ext-1"],
        affected_variant_external_ids: [],
        confirmed_affected_variant_external_ids: [],
        alive_child_variant_count: 2,
        correlation_id: RAILS_CORRELATION_ID,
      }),
    });
  });

  it("fails open when the insert raises", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      recordVariantCategoryDeletion({ productVariantDeletionAudit: { create } } as never, audit),
    ).resolves.toBeUndefined();
  });
});
