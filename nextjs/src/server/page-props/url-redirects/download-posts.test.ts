import type { Installment, Link, Purchase, User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";

const mocks = vi.hoisted(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "download-posts-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";
  return {
    db: {
      purchase: { findMany: vi.fn() },
      customDomain: { count: vi.fn() },
      emailInfo: { findMany: vi.fn() },
      installment: { findMany: vi.fn() },
    },
    passes: vi.fn(),
  };
});

vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("../../models/with-filtering.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  purchasePassesFilters: mocks.passes,
}));

const { downloadPosts } = await import("./download-posts.ts");
const { encrypt } = await import("../../../lib/obfuscate-ids.ts");

const SEND_EMAILS = 1 << 8;
const SHOWN_ON_PROFILE = 1 << 7;
const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 0, day, hour));

const purchase = (overrides: Partial<Purchase> = {}) =>
  ({
    id: 5n,
    link_id: 3n,
    seller_id: 2,
    email: "buyer@example.com",
    purchase_state: "successful",
    stripe_refunded: null,
    chargeback_date: null,
    subscription_id: null,
    flags: 0n,
    ...overrides,
  }) as Purchase;
const product = (overrides: Partial<Link> = {}) => ({ id: 3n, user_id: 2, flags: 0n, ...overrides }) as Link;
const seller = { id: 2, username: "someseller", flags: 0n, json_data: null } as unknown as User;
const post = (id: bigint, overrides: Partial<Installment> = {}) =>
  ({
    id,
    name: `Post ${id}`,
    message: "<p>Body</p>",
    slug: `post-${id}`,
    link_id: 3,
    seller_id: 2,
    base_variant_id: null,
    installment_type: "product",
    flags: SEND_EMAILS,
    deleted_at: null,
    published_at: at(1),
    ...overrides,
  }) as unknown as Installment;
const info = (installmentId: bigint, sentAt: Date | null, extra: Record<string, unknown> = {}) => ({
  id: installmentId * 10n,
  installment_id: installmentId,
  purchase_id: 5n,
  type: "CreatorContactingCustomersEmailInfo",
  sent_at: sentAt,
  delivered_at: null,
  opened_at: null,
  ...extra,
});

// The queries downloadPosts runs, in order: the product's sales with this email, the seller's, the infos of the purchase,
// the posts of those infos, the profile-only product posts, the infos for seller posts, the seller posts they name, the
// seller's profile posts, and the infos behind each action_at.
function arrange({
  sales = [purchase()],
  infos = [] as ReturnType<typeof info>[],
  posts = [] as Installment[],
  profile = [] as Installment[],
  sellerPosts = [] as Installment[],
  sellerProfile = [] as Installment[],
} = {}) {
  mocks.db.purchase.findMany.mockResolvedValueOnce(sales).mockResolvedValueOnce(sales);
  mocks.db.customDomain.count.mockResolvedValue(0);
  mocks.db.emailInfo.findMany.mockImplementation(({ where }: { where: { installment_id?: unknown } }) =>
    Promise.resolve(
      where.installment_id === undefined
        ? infos
        : infos.filter((row) => (where.installment_id as { in: bigint[] }).in.includes(row.installment_id)),
    ),
  );
  mocks.db.installment.findMany
    .mockResolvedValueOnce(posts)
    .mockResolvedValueOnce(profile)
    .mockResolvedValueOnce(sellerPosts)
    .mockResolvedValueOnce(sellerProfile);
  mocks.passes.mockResolvedValue(true);
}

beforeEach(() => vi.resetAllMocks());

describe("downloadPosts", () => {
  it("lists nothing for a redirect without a purchase", async () => {
    await expect(downloadPosts(null, product(), seller)).resolves.toEqual([]);
  });

  it("lists the emailed product posts newest first, with the view link of the purchase", async () => {
    arrange({
      infos: [info(1n, at(10)), info(2n, at(20))],
      posts: [post(1n), post(2n)],
    });

    const result = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(result.map((entry) => entry.name)).toEqual(["Post 2", "Post 1"]);
    expect(result[0]).toMatchObject({
      id: encrypt(2n),
      action_at: "2026-01-20T12:00:00Z",
    });
    expect(String(result[0]!.view_url)).toMatch(
      new RegExp(
        `/p/post-2\\?purchase_id=${encodeURIComponent(encrypt(5n)).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}&username=someseller$`,
        "u",
      ),
    );
  });

  it("lists a profile-only product post by its publish time, with no email info behind it", async () => {
    arrange({ profile: [post(3n, { flags: SHOWN_ON_PROFILE, published_at: at(7) })] });

    const [entry] = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(entry).toMatchObject({ name: "Post 3", action_at: "2026-01-07T12:00:00Z" });
  });

  it("drops unpublished and deleted posts, and seller posts the buyer filters exclude", async () => {
    arrange({
      infos: [info(1n, at(10)), info(2n, at(11)), info(4n, at(12))],
      posts: [post(1n, { published_at: null }), post(2n, { deleted_at: at(2) })],
      sellerPosts: [post(4n, { installment_type: "seller", link_id: null })],
    });
    mocks.passes.mockResolvedValue(false);

    await expect(downloadPosts(purchase(), product(), seller)).resolves.toEqual([]);
  });

  it("lists nothing when the purchase does not display installments, such as a refunded one", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([purchase({ stripe_refunded: true })]);

    await expect(downloadPosts(purchase({ stripe_refunded: true }), product(), seller)).resolves.toEqual([]);
  });

  it.each([
    ["a product that shows every past post", () => downloadPosts(purchase(), product({ flags: 1n << 19n }), seller)],
    ["a purchase without an email", () => downloadPosts(purchase({ email: null }), product(), seller)],
    ["a membership purchase", () => downloadPosts(purchase({ subscription_id: 9n }), product(), seller)],
  ])("hands back %s before querying posts", async (_, run) => {
    await expect(run()).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.db.installment.findMany).not.toHaveBeenCalled();
  });

  it("hands back a seller without a username, who has no subdomain to link to", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([purchase()]);

    await expect(downloadPosts(purchase(), product(), { ...seller, username: null } as User)).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    expect(mocks.db.installment.findMany).not.toHaveBeenCalled();
  });

  it("hands back an address that bought the product twice", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([purchase(), purchase({ id: 6n })]);

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a seller with a custom domain", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([purchase()]);
    mocks.db.customDomain.count.mockResolvedValue(1);

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back posts that share a sort time, since Ruby's sort_by is unstable", async () => {
    arrange({ infos: [info(1n, at(10)), info(2n, at(10))], posts: [post(1n), post(2n)] });

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a post with several email infos and an email info without a time", async () => {
    arrange({ infos: [info(1n, at(10)), info(1n, at(11), { id: 99n })], posts: [post(1n)] });
    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);

    vi.resetAllMocks();
    arrange({ infos: [info(1n, null)], posts: [post(1n)] });
    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
