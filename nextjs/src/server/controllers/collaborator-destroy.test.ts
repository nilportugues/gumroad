import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError } from "./application-controller.ts";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  blocker: vi.fn(),
  markDeleted: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock("../models/collaborator-end.ts", () => ({
  ENDED_BY_SELLER_MAIL: "collaboration_ended_by_seller",
  ENDED_BY_AFFILIATE_USER_MAIL: "collaboration_ended_by_affiliate_user",
  loadAliveCollaborator: mocks.load,
  endBlocker: mocks.blocker,
  markCollaboratorDeletedBang: mocks.markDeleted,
  deliverCollaboratorMail: mocks.deliver,
}));

const { destroyCollaboration, endCollaboration } = await import("./collaborator-destroy.ts");

const row = { id: 7, seller_id: 9, affiliate_user_id: 3 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue(row);
  mocks.blocker.mockResolvedValue(null);
});

describe("endCollaboration", () => {
  it("answers not found for a collaboration that is gone", async () => {
    mocks.load.mockResolvedValue(undefined);
    await expect(endCollaboration(7)).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands back before the write when a row would fail validation", async () => {
    mocks.blocker.mockResolvedValue("a product that would fail its own validation");
    await expect(endCollaboration(7)).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.markDeleted).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});

describe("destroyCollaboration", () => {
  it("mails the collaborator when the seller ends it", async () => {
    await destroyCollaboration(9n, 7);
    expect(mocks.markDeleted).toHaveBeenCalledWith(row);
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith("collaboration_ended_by_seller", 7);
  });

  it("mails the seller when the collaborator ends it", async () => {
    await destroyCollaboration(3n, 7);
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith("collaboration_ended_by_affiliate_user", 7);
  });

  it("mails nobody when neither side ended it", async () => {
    await destroyCollaboration(5n, 7);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
