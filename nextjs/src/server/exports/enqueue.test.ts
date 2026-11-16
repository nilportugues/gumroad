import { beforeEach, describe, expect, it, vi } from "vitest";

import { enqueue } from "../jobs/enqueue.ts";
import { enqueueAudienceExport, enqueueSalesExportChunks, exportAffiliatesOrEnqueue } from "./enqueue.ts";

vi.mock("../jobs/enqueue.ts", () => ({ enqueue: vi.fn(async () => "jid") }));

const enqueueMock = vi.mocked(enqueue);

describe("export enqueue calls", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
  });

  it("enqueues the audience export with the seller, recipient and selected audience types", async () => {
    await enqueueAudienceExport(1n, 2n, { followers: true, customers: false });
    expect(enqueueMock).toHaveBeenCalledWith("Exports::AudienceExportWorker", [1n, 2n, { followers: true, customers: false }]);
  });

  it("builds the affiliate export inline at or below the threshold", async () => {
    const result = await exportAffiliatesOrEnqueue({ sellerId: 1n, recipientId: 2n, liveAffiliateCount: 500 });
    expect(result).toEqual({ synchronous: true });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("enqueues the affiliate export above the threshold", async () => {
    const result = await exportAffiliatesOrEnqueue({ sellerId: 1n, recipientId: 2n, liveAffiliateCount: 501 });
    expect(result).toEqual({ synchronous: false });
    expect(enqueueMock).toHaveBeenCalledWith("Exports::AffiliateExportWorker", [1n, 2n]);
  });

  it("enqueues the chunking job for a sales export", async () => {
    await enqueueSalesExportChunks(9n);
    expect(enqueueMock).toHaveBeenCalledWith("Exports::Sales::CreateAndEnqueueChunksWorker", [9n]);
  });
});
