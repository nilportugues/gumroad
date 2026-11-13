import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "../../lib/obfuscate-ids.ts";

import { HandBackToRails, RoutingError } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, count, findMany, findFirst, update, remove } = vi.hoisted(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "passkeys-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "12345";
  return {
    specs: [] as MutationSpec[],
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
});

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./json-seller.ts", async (original) => ({
  ...(await original<typeof import("./json-seller.ts")>()),
  sellerJsonAction: (_input: unknown, _policy: unknown, run: (context: unknown) => unknown): unknown => run({}),
}));
vi.mock("../../lib/db.ts", () => ({
  db: { webauthnCredential: { count, findMany, findFirst, update, delete: remove } },
}));

await import("./settings-passkeys-mutations.ts");

const find = (method: string, pattern: string) =>
  specs.find((spec) => spec.method === method && spec.pattern.startsWith(pattern))!;
const externalId = encrypt(5n);
const inputWith = (params: Record<string, unknown> = {}) =>
  ({
    context: { currentSeller: { id: 7n, email: "seller@example.com", external_id: "ext", username: null, name: null } },
    chain: { session: { data: {} }, now: new Date() },
    routeParams: { id: externalId },
    params,
  }) as unknown as MutationInput;
const answer = async (spec: MutationSpec, input: MutationInput): Promise<unknown[]> => {
  const rendered = (await spec.run(input)) as unknown as { status: number; body: string };
  return [rendered.status, JSON.parse(rendered.body) as unknown];
};

const CREATED_AT = new Date("2025-02-01T00:00:00Z");
const CREDENTIAL = { id: 5n, nickname: "MacBook Pro", created_at: CREATED_AT, last_used_at: null };

beforeEach(() => {
  for (const mock of [count, findFirst, update, remove]) mock.mockReset();
  findFirst.mockResolvedValue(CREDENTIAL);
});

describe("POST /settings/passkeys/registration_options", () => {
  const options = find("POST", "/settings/passkeys/registration_options");

  it("answers 422 once the seller has ten passkeys", async () => {
    findMany.mockResolvedValue(Array.from({ length: 10 }, () => ({ webauthn_id: "id" })));

    expect(await answer(options, inputWith())).toEqual([
      422,
      { success: false, error_message: "You can add up to 10 passkeys." },
    ]);
  });

  it("answers the options of a seller with room, which carry a random challenge and exclude the existing passkeys", async () => {
    findMany.mockResolvedValue(Array.from({ length: 9 }, () => ({ webauthn_id: "id" })));

    const input = inputWith();
    const [status, body] = await answer(options, input);

    expect(status).toBe(200);
    const { success, options: creation } = body as {
      success: boolean;
      options: { challenge: string; excludeCredentials: unknown[] };
    };
    expect(success).toBe(true);
    expect(creation.challenge).toMatch(/^[\w-]+$/u);
    expect(creation.excludeCredentials).toHaveLength(9);
    expect(Object.values(input.chain.session.data)).toEqual([creation.challenge]);
  });
});

describe("POST /settings/passkeys", () => {
  it("answers 422 when no registration challenge is in the session", async () => {
    expect(
      await answer(specs.find((spec) => spec.method === "POST" && spec.pattern === "/settings/passkeys")!, inputWith()),
    ).toEqual([422, { success: false, error_message: expect.any(String) as string }]);
  });
});

describe("PUT /settings/passkeys/:id", () => {
  const rename = find("PUT", "/settings/passkeys/:id");

  it("renames the passkey and answers its props", async () => {
    expect(await answer(rename, inputWith({ nickname: "Work laptop" }))).toEqual([
      200,
      {
        success: true,
        passkey: { id: externalId, nickname: "Work laptop", created_at: "2025-02-01T00:00:00Z", last_used_at: null },
      },
    ]);
    expect(update).toHaveBeenCalledWith({
      where: { id: 5n },
      data: { nickname: "Work laptop", updated_at: expect.any(Date) as Date },
    });
  });

  it("strips the name as Ruby does, nulls included", async () => {
    await answer(rename, inputWith({ nickname: "\0 \tWork laptop\n " }));

    expect(update).toHaveBeenCalledWith({
      where: { id: 5n },
      data: { nickname: "Work laptop", updated_at: expect.any(Date) as Date },
    });
  });

  it("writes nothing when the stripped name is the current one", async () => {
    expect(await answer(rename, inputWith({ nickname: " MacBook Pro " }))).toEqual([
      200,
      expect.objectContaining({ success: true }),
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank name", { nickname: "  " }],
    ["no name", {}],
    ["a null name", { nickname: null }],
    ["a name of 101 characters", { nickname: "a".repeat(101) }],
  ])("answers 422 for %s", async (_label, params) => {
    expect(await answer(rename, inputWith(params))).toEqual([
      422,
      { success: false, error_message: "Could not update this passkey." },
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("counts characters, not UTF-16 units, against the limit", async () => {
    await answer(rename, inputWith({ nickname: "😀".repeat(100) }));

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("hands back a name that is not text", async () => {
    await expect(rename.run(inputWith({ nickname: 42 }))).rejects.toBeInstanceOf(HandBackToRails);
    expect(update).not.toHaveBeenCalled();
  });

  it("raises the 404 for a passkey the seller does not own", async () => {
    findFirst.mockResolvedValue(null);

    await expect(rename.run(inputWith({ nickname: "x" }))).rejects.toBeInstanceOf(RoutingError);
  });

  it("raises the 404 for an id that does not decrypt", async () => {
    const input = { ...inputWith({ nickname: "x" }), routeParams: { id: "not-an-id" } } as MutationInput;

    await expect(rename.run(input)).rejects.toBeInstanceOf(RoutingError);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("DELETE /settings/passkeys/:id", () => {
  const destroy = find("DELETE", "/settings/passkeys/:id");

  it("deletes the passkey", async () => {
    expect(await answer(destroy, inputWith())).toEqual([200, { success: true }]);
    expect(remove).toHaveBeenCalledWith({ where: { id: 5n } });
  });

  it("raises the 404 and deletes nothing for a passkey the seller does not own", async () => {
    findFirst.mockResolvedValue(null);

    await expect(destroy.run(inputWith())).rejects.toBeInstanceOf(RoutingError);
    expect(remove).not.toHaveBeenCalled();
  });
});
