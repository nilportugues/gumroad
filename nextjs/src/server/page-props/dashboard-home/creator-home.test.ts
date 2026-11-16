import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { NotPortedError } from "../not-ported.ts";

const thumbnailUrl = vi.hoisted(() => vi.fn());
vi.mock("../buyer/products.ts", () => ({ thumbnailUrl }));

import { cardThumbnail } from "./creator-home.ts";

describe("cardThumbnail", () => {
  beforeEach(() => {
    thumbnailUrl.mockReset();
  });

  it("answers an Unsplash thumbnail's address", async () => {
    thumbnailUrl.mockResolvedValue("https://images.unsplash.com/photo-1");
    await expect(cardThumbnail(7n)).resolves.toBe("https://images.unsplash.com/photo-1");
    expect(thumbnailUrl).toHaveBeenCalledWith(7n);
  });

  it("answers null for a product without a live thumbnail", async () => {
    thumbnailUrl.mockResolvedValue(null);
    await expect(cardThumbnail(7n)).resolves.toBeNull();
  });

  it("hands an uploaded thumbnail back to Rails", async () => {
    thumbnailUrl.mockImplementation(() => Promise.reject(new NotPortedError("Thumbnail#url for an uploaded file")));
    await expect(cardThumbnail(7n)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("lets a database failure through", async () => {
    thumbnailUrl.mockImplementation(() => Promise.reject(new Error("connection lost")));
    await expect(cardThumbnail(7n)).rejects.toThrow("connection lost");
  });
});
