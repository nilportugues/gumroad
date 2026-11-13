import type { Installment, Link, Purchase, User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";

const mocks = vi.hoisted(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "download-posts-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";
  return {
    db: {
      purchase: { findMany: vi.fn() },
      customDomain: { findMany: vi.fn() },
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
  domains = [] as unknown[],
} = {}) {
  mocks.db.purchase.findMany.mockResolvedValueOnce(sales).mockResolvedValueOnce(sales);
  mocks.db.customDomain.findMany.mockResolvedValue(domains);
  mocks.db.emailInfo.findMany.mockImplementation(
    ({ where }: { where: { installment_id?: { in: bigint[] }; purchase_id: bigint | { in: bigint[] } } }) =>
      Promise.resolve(
        infos
          .filter((row) => where.installment_id === undefined || where.installment_id.in.includes(row.installment_id))
          .filter((row) =>
            typeof where.purchase_id === "bigint"
              ? row.purchase_id === where.purchase_id
              : where.purchase_id.in.includes(row.purchase_id),
          ),
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
    ["a membership purchase", () => downloadPosts(purchase({ subscription_id: 9n }), product(), seller)],
    ["a product that shows every past post", () => downloadPosts(purchase(), product({ flags: 1n << 19n }), seller)],
    ["a purchase without an email", () => downloadPosts(purchase({ email: null }), product(), seller)],
  ])("hands back %s before querying posts", async (_, run) => {
    await expect(run()).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.db.installment.findMany).not.toHaveBeenCalled();
  });

  it("links a seller without a username by the external id of the seller", async () => {
    arrange({ infos: [info(1n, at(10))], posts: [post(1n)] });

    const [entry] = (await downloadPosts(purchase(), product(), {
      ...seller,
      username: null,
      external_id: "ext123",
    } as User)) as Record<string, unknown>[];

    expect(String(entry!.view_url)).toMatch(/^https?:\/\/ext123\.[^/]+\/p\/post-1\?.*&username=ext123$/u);
  });

  it("lists the posts emailed to either purchase of an address that bought twice, linked to the earlier purchase", async () => {
    const earlier = purchase({ id: 4n });
    arrange({
      sales: [purchase(), earlier],
      infos: [info(1n, at(10), { purchase_id: 4n }), info(2n, at(20)), info(2n, at(15), { id: 99n, purchase_id: 4n })],
      posts: [post(1n), post(2n)],
    });

    const result = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(result.map((entry) => entry.name)).toEqual(["Post 2", "Post 2", "Post 1"]);
    // The last email info of the post across both purchases is the one with the highest id.
    expect(result.map((entry) => entry.action_at)).toEqual([
      "2026-01-15T12:00:00Z",
      "2026-01-15T12:00:00Z",
      "2026-01-10T12:00:00Z",
    ]);
    expect(mocks.db.emailInfo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { purchase_id: { in: [5n, 4n] } } }),
    );
    for (const entry of result)
      expect(String(entry.view_url)).toContain(`purchase_id=${encodeURIComponent(encrypt(4n))}`);
  });

  it("keeps a post when any purchase of the address passes its filters", async () => {
    arrange({
      sales: [purchase(), purchase({ id: 6n })],
      infos: [info(4n, at(10), { purchase_id: 6n })],
      sellerPosts: [post(4n, { installment_type: "seller", link_id: null })],
    });
    mocks.passes.mockImplementation((_, record: { row: Purchase }) => Promise.resolve(record.row.id === 6n));

    const [entry] = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(entry).toMatchObject({ name: "Post 4" });
    expect(String(entry!.view_url)).toContain(`purchase_id=${encodeURIComponent(encrypt(5n))}`);
  });

  it("hands back an address with a displayed membership purchase of the product", async () => {
    arrange({ sales: [purchase(), purchase({ id: 6n, subscription_id: 9n })] });

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("lists the posts of an address whose other membership purchase is refunded", async () => {
    arrange({
      sales: [purchase(), purchase({ id: 6n, subscription_id: 9n, stripe_refunded: true })],
      infos: [info(1n, at(10))],
      posts: [post(1n)],
    });

    await expect(downloadPosts(purchase(), product(), seller)).resolves.toHaveLength(1);
  });

  it("hands back when the viewed purchase is not displayed but another purchase of the address is", async () => {
    arrange({ sales: [purchase({ stripe_refunded: true }), purchase({ id: 6n })] });

    await expect(downloadPosts(purchase({ stripe_refunded: true }), product(), seller)).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });

  it("links to the custom domain of the seller while it is verified with a current certificate", async () => {
    arrange({
      infos: [info(1n, at(10))],
      posts: [post(1n)],
      domains: [{ domain: "shop.example.com", state: "verified", ssl_certificate_issued_at: new Date() }],
    });

    const [entry] = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(String(entry!.view_url)).toMatch(
      /^https?:\/\/shop\.example\.com\/p\/post-1\?purchase_id=.*&username=someseller$/u,
    );
  });

  it.each([
    ["unverified", { state: "unverified", ssl_certificate_issued_at: new Date() }],
    ["without a certificate", { state: "verified", ssl_certificate_issued_at: null }],
    [
      "with an expired certificate",
      { state: "verified", ssl_certificate_issued_at: new Date(Date.now() - 91 * 864e5) },
    ],
  ])("keeps the subdomain link while the custom domain is %s", async (_, domain) => {
    arrange({ infos: [info(1n, at(10))], posts: [post(1n)], domains: [{ domain: "shop.example.com", ...domain }] });

    const [entry] = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(String(entry!.view_url)).toMatch(/^https?:\/\/someseller\./u);
  });

  it("looks only at custom domains that were not deleted", async () => {
    arrange({ infos: [info(1n, at(10))], posts: [post(1n)] });

    await downloadPosts(purchase(), product(), seller);

    expect(mocks.db.customDomain.findMany).toHaveBeenCalledWith({ where: { user_id: 2, deleted_at: null } });
  });

  it("hands back a seller with several custom domains", async () => {
    arrange({ domains: [{ domain: "a.example.com" }, { domain: "b.example.com" }] });

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("lists the posts of two scopes that share a sort time in the reverse of the order Rails builds them", async () => {
    arrange({
      infos: [info(1n, at(10))],
      posts: [post(1n)],
      profile: [post(2n, { flags: SHOWN_ON_PROFILE, published_at: at(10) })],
    });

    const result = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(result.map((entry) => entry.name)).toEqual(["Post 2", "Post 1"]);
  });

  it("hands back two posts of one scope that share a sort time, whose order is the scope's SQL", async () => {
    arrange({ infos: [info(1n, at(10)), info(2n, at(10))], posts: [post(1n), post(2n)] });

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a tie among more than two posts, since Ruby's sort_by is unstable", async () => {
    arrange({
      infos: [info(1n, at(10))],
      posts: [post(1n)],
      profile: [post(2n, { flags: SHOWN_ON_PROFILE, published_at: at(10) })],
      sellerProfile: [post(4n, { installment_type: "seller", flags: SHOWN_ON_PROFILE, published_at: at(20) })],
    });

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("lists a post once for each of its email infos", async () => {
    arrange({
      infos: [info(1n, at(10)), info(1n, at(20), { id: 99n }), info(2n, at(15))],
      posts: [post(1n), post(2n)],
    });

    const result = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

    expect(result.map((entry) => entry.name)).toEqual(["Post 1", "Post 2", "Post 1"]);
  });

  it("sorts an email info without a time before every other post and stamps the post with the current time", async () => {
    vi.useFakeTimers({ now: at(25) });
    try {
      arrange({ infos: [info(1n, null), info(2n, at(10))], posts: [post(1n), post(2n)] });

      const result = (await downloadPosts(purchase(), product(), seller)) as Record<string, unknown>[];

      expect(result.map((entry) => [entry.name, entry.action_at])).toEqual([
        ["Post 2", "2026-01-10T12:00:00Z"],
        ["Post 1", "2026-01-25T12:00:00Z"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back a seller post with several email infos", async () => {
    arrange({
      infos: [info(4n, at(10)), info(4n, at(11), { id: 99n })],
      sellerPosts: [post(4n, { installment_type: "seller", link_id: null })],
    });

    await expect(downloadPosts(purchase(), product(), seller)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
