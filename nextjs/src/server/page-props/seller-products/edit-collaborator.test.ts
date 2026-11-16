import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ collaborator: null as unknown, bylined: [] as unknown[] }));

vi.mock("../../presenters/product-props.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../presenters/product-props.ts")>()),
  collaboratorForDisplay: async () => mocks.collaborator,
}));
vi.mock("../../presenters/product.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../presenters/product.ts")>()),
  authorBylineProps: async (user: { username: string | null }) => {
    mocks.bylined.push(user);
    return user.username ? { id: "abc", name: user.username } : null;
  },
}));

import { collaboratingUserProps } from "./edit.ts";

const product = { id: 7n } as never;

// ProductPresenter#edit_props / BundlePresenter#shared_props `collaborating_user`
describe("collaboratingUserProps", () => {
  beforeEach(() => {
    mocks.collaborator = null;
    mocks.bylined = [];
  });

  it("is null without a credited collaborator", async () => {
    expect(await collaboratingUserProps(product)).toBeNull();
    expect(mocks.bylined).toEqual([]);
  });

  it("is the collaborator's author byline", async () => {
    mocks.collaborator = { username: "partner" };

    expect(await collaboratingUserProps(product)).toEqual({ id: "abc", name: "partner" });
  });

  it("is null for a collaborator without a username, as author_byline_props is", async () => {
    mocks.collaborator = { username: null };

    expect(await collaboratingUserProps(product)).toBeNull();
  });
});
