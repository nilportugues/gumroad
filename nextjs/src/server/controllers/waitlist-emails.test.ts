import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, selectRows, eligibleToSendEmails, isSuspended, createInstallment, subdomain } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  createInstallment: vi.fn(),
  subdomain: vi.fn(),
  selectRows: vi.fn(),
  eligibleToSendEmails: vi.fn(),
  isSuspended: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./json-seller.ts", () => ({
  sellerJsonAction: (_input: unknown, _policy: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../models/runtime/transaction.ts", () => ({ transaction: (run: () => unknown) => run() }));
vi.mock("../models/installment-writes.ts", () => ({ Installments: { create: createInstallment } }));
vi.mock("../presenters/product.ts", () => ({
  longUrl: () => "https://seller.example.com/l/launch",
  subdomainWithProtocol: subdomain,
}));
vi.mock("../models/user-email-eligibility.ts", () => ({
  MINIMUM_SALES_CENTS_VALUE: 100_00,
  eligibleToSendEmails,
}));
vi.mock("../models/user.ts", () => ({ isSuspended, Users: { load: (user: unknown) => user } }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ encrypt: (id: bigint) => `enc${id}` }));

await import("./waitlist-emails.ts");
const { HandBackToRails, RoutingError } = await import("./application-controller.ts");

const run = (routeParams: Record<string, string> = { product_id: "launch" }) =>
  specs[0]!.run({ routeParams, context: { currentSeller: { id: 7n } } } as unknown as MutationInput);
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as Record<string, unknown>;
const marker = (id: number | string) => JSON.stringify({ waitlist_launch_product_id: id });

// selectRows answers, in order: the product, the seller's installments carrying the marker.
const answers = (...rows: unknown[][]) => {
  selectRows.mockReset();
  for (const result of rows) selectRows.mockResolvedValueOnce(result);
};

beforeEach(() => {
  eligibleToSendEmails.mockReset().mockResolvedValue(true);
  isSuspended.mockReset().mockReturnValue(false);
  createInstallment.mockReset();
  subdomain.mockReset();
  answers([{ id: 3n }], [{ id: 11n, json_data: marker(3) }]);
});

describe("Products::WaitlistEmailsController#create", () => {
  it("registers POST /products/:product_id/waitlist_email.json as a JSON action", () => {
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      method: "POST",
      pattern: "/products/:product_id/waitlist_email.json",
      json: true,
    });
  });

  it("answers the edit url of the existing launch email", async () => {
    const result = await run();

    expect(result).toMatchObject({ status: 200 });
    expect(body(result)).toEqual({ success: true, edit_url: "/emails/enc11/edit" });
  });

  it("picks the newest email when several carry the marker", async () => {
    answers(
      [{ id: 3n }],
      [
        { id: 20n, json_data: marker(3) },
        { id: 25n, json_data: marker(4) },
        { id: 12n, json_data: marker(3) },
      ],
    );

    const result = await run();

    expect(body(result).edit_url).toBe("/emails/enc20/edit");
  });

  it("raises a routing error for a product the seller does not have", async () => {
    answers([]);

    await expect(run()).rejects.toBeInstanceOf(RoutingError);
  });

  it("refuses a suspended seller", async () => {
    eligibleToSendEmails.mockResolvedValue(false);
    isSuspended.mockReturnValue(true);

    const result = await run();

    expect(result).toMatchObject({ status: 422 });
    expect(body(result)).toEqual({
      success: false,
      error: "Your account can't send emails while it's suspended.",
    });
  });

  it("refuses a seller below the sales threshold", async () => {
    eligibleToSendEmails.mockResolvedValue(false);

    const result = await run();

    expect(result).toMatchObject({ status: 422 });
    expect(body(result).error).toBe(
      "You can email your waitlist once you've made at least $100 in sales and received a payout.",
    );
  });

  // The first press is replayed against Rails in waitlist_emails_signed_in_spec.
  describe("on the first press", () => {
    const firstPress = () =>
      answers(
        [{ id: 3n }],
        [{ id: 11n, json_data: marker(4) }],
        [{ id: 3n, name: "Launch <1>", unique_permalink: "launch" }],
        [{ id: 11n, json_data: marker(4) }],
      );

    it("builds the launch email and answers its edit url", async () => {
      firstPress();
      subdomain.mockReturnValue("https://seller.example.com");
      createInstallment.mockResolvedValue({ persisted: true, get: () => 99n });

      expect(body(await run())).toEqual({ success: true, edit_url: "/emails/enc99/edit" });
      expect(createInstallment).toHaveBeenCalledWith(
        expect.objectContaining({
          seller_id: 7,
          name: "Launch <1> is out now",
          installment_type: "follower",
          json_data: expect.stringContaining('"waitlist_launch_product_id":3') as string,
        }),
      );
    });

    it("hands a seller without a subdomain to Rails", async () => {
      firstPress();
      subdomain.mockReturnValue(null);

      await expect(run()).rejects.toBeInstanceOf(HandBackToRails);
    });

    it("hands a launch email that fails validation to Rails", async () => {
      firstPress();
      subdomain.mockReturnValue("https://seller.example.com");
      createInstallment.mockResolvedValue({ persisted: false, get: () => null });

      await expect(run()).rejects.toBeInstanceOf(HandBackToRails);
    });
  });

  it("hands a marker that is not a number to Rails", async () => {
    answers([{ id: 3n }], [{ id: 11n, json_data: marker("3") }]);

    await expect(run()).rejects.toBeInstanceOf(HandBackToRails);
  });
});
