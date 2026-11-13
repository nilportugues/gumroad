import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  guardRedirect: vi.fn<() => unknown>(),
  policy: vi.fn<() => boolean>(),
  selectRows: vi.fn(),
  execute: vi.fn(),
  touch: vi.fn(),
  slice: vi.fn(),
  findSellerProfile: vi.fn(),
  saveProfile: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("./custom-html-products-slice.ts", () => ({ customHtmlProductsSlice: mocks.slice }));
vi.mock("./users-controller.ts", () => ({ requireHtml: () => undefined }));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../page-props/audience/seller-guard.ts", () => ({
  sellerGuard: async (_input: unknown, authorization: (context: unknown) => Promise<void>) => {
    const denied = mocks.guardRedirect();
    if (denied) return denied;
    await authorization({ seller: { id: 3n } });
    return null;
  },
}));
vi.mock("../policies/authorize.ts", () => ({
  authorize: (query: () => boolean) => {
    if (!query()) throw new Error("not authorized");
  },
}));
vi.mock("../policies/page.ts", () => {
  const policy = () => mocks.policy();
  return { pagePolicy: { create: policy, update: policy, destroy: policy, preview: policy, products: policy } };
});
vi.mock("../models/sql.ts", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    column: (tableName: string, name: string) => Prisma.raw(`${tableName}.${name}`),
    table: (name: string) => Prisma.raw(name),
    selectRows: mocks.selectRows,
    execute: mocks.execute,
  };
});
vi.mock("../models/runtime/transaction.ts", () => ({ transaction: (run: () => unknown) => run() }));
vi.mock("../models/seller-profile.ts", () => ({
  findSellerProfile: mocks.findSellerProfile,
  SellerProfiles: { save: mocks.saveProfile },
}));
vi.mock("../models/user.ts", () => ({
  Users: { load: (row: unknown) => row, touch: mocks.touch, withLock: (_record: unknown, run: () => unknown) => run() },
  findUserBang: async (id: unknown) => ({ id }),
  setSellerProfileTarget: () => undefined,
  rubyStrip: (value: string) => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, ""),
}));

await import("./pages-controller.ts");

const find = (method: string, pattern: string) => {
  const spec = mocks.specs.find((candidate) => candidate.method === method && candidate.pattern === pattern)!;
  return (input: MutationInput) => spec.run(input);
};
const input = (params: Record<string, unknown> = {}, slug?: string) =>
  ({
    params,
    routeParams: slug === undefined ? {} : { slug },
    context: { currentSeller: { id: 3n } },
  }) as unknown as MutationInput;
const withErrors = (location: string, inertiaErrors: Record<string, string>) => ({
  status: 302,
  location,
  inertiaErrors,
});
const BLANK = { title: "", content: "" };

type Row = { custom_html: string | null } | null;

// Answers the lookups by what they ask for: the root page when the SQL names `slug IS NULL`.
function database({ page = null, root = null }: { page?: Row; root?: Row } = {}) {
  mocks.selectRows.mockImplementation((query: { sql: string }) => {
    if (query.sql.includes("IS NULL")) return root === null ? [] : [root];
    return page === null ? [] : [page];
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guardRedirect.mockReturnValue(null);
  mocks.policy.mockReturnValue(true);
  database({ page: { custom_html: null } });
});

describe("POST /pages", () => {
  const run = find("POST", "/pages");

  it("returns the redirect of the guard", async () => {
    mocks.guardRedirect.mockReturnValue({ status: 302, location: "/dashboard" });
    expect(await run(input(BLANK))).toEqual({ status: 302, location: "/dashboard" });
  });

  it("refuses a blank title and content", async () => {
    expect(await run(input({ title: "  ", content: "　" }))).toEqual(
      withErrors("/pages/new", { title: "can't be blank" }),
    );
  });

  it("refuses a request with neither title nor content", async () => {
    expect(await run(input())).toEqual(withErrors("/pages/new", { title: "can't be blank" }));
  });

  it("lists the search field errors before the title error, as the validations run", async () => {
    const result = await run(input({ ...BLANK, seo_title: "t".repeat(71), seo_description: "d".repeat(321) }));
    expect(Object.keys((result as { inertiaErrors: object }).inertiaErrors)).toEqual([
      "seo_title",
      "seo_description",
      "title",
    ]);
  });

  it("counts a search field after it is squished", async () => {
    const result = await run(input({ ...BLANK, seo_title: `${"t ".repeat(35)}   `, seo_description: "   " }));
    expect(result).toEqual(withErrors("/pages/new", { title: "can't be blank" }));
  });

  it("counts the characters of a search field, not its bytes", async () => {
    const result = await run(input({ ...BLANK, seo_title: "é".repeat(70) }));
    expect(result).toEqual(withErrors("/pages/new", { title: "can't be blank" }));
  });

  it("hands a page with a title to Rails", async () => {
    await expect(run(input({ title: "About me", content: "" }))).rejects.toThrow(/moderated/u);
  });

  it("hands a page with content and no title to Rails", async () => {
    await expect(run(input({ title: "", content: "<p>Hello</p>" }))).rejects.toThrow(/moderated/u);
  });

  it("hands a title that is not text to Rails", async () => {
    await expect(run(input({ title: ["About me"], content: "" }))).rejects.toThrow(/not text/u);
  });

  it("hands a search field that is not text to Rails", async () => {
    await expect(run(input({ ...BLANK, seo_title: 5 }))).rejects.toThrow(/not text/u);
  });
});

describe("PATCH /pages/:slug", () => {
  const run = find("PATCH", "/pages/:slug");

  it("is registered for PUT too", () => {
    expect(mocks.specs.some((spec) => spec.method === "PUT" && spec.pattern === "/pages/:slug")).toBe(true);
  });

  it("sends an unknown slug back to the list before the policy is asked", async () => {
    database();
    expect(await run(input(BLANK, "nothing"))).toEqual({ status: 302, location: "/pages", rescued: true });
    expect(mocks.policy).not.toHaveBeenCalled();
  });

  it("refuses a blank title and content, back to the edit page", async () => {
    expect(await run(input(BLANK, "about-me"))).toEqual(
      withErrors("/pages/about-me/edit", { title: "can't be blank" }),
    );
  });

  it("hands a valid edit to Rails", async () => {
    await expect(run(input({ title: "About us", content: "x" }, "about-me"))).rejects.toThrow(/moderated/u);
  });

  it("hands a custom HTML page to Rails", async () => {
    database({ page: { custom_html: "<main></main>" } });
    await expect(run(input({ seo_title: "x" }, "landing"))).rejects.toThrow(/custom HTML page/u);
  });

  it("sends the profile entry with nothing to write to the list", async () => {
    expect(await run(input({}, "profile"))).toEqual({ status: 302, location: "/pages" });
  });

  describe("search fields of the profile", () => {
    const profile = (errors: { attribute: string; message: string }[] = []) => ({
      set: vi.fn(),
      errors: { details: errors },
    });

    it("hands a seller with no profile row to Rails", async () => {
      mocks.findSellerProfile.mockResolvedValue(null);
      await expect(run(input({ seo_title: "Home" }, "profile"))).rejects.toThrow(/no profile row/u);
    });

    it("saves the squished fields on the locked row", async () => {
      const row = profile();
      mocks.findSellerProfile.mockResolvedValue(row);
      mocks.saveProfile.mockResolvedValue(true);
      expect(await run(input({ seo_title: "  Home  page ", seo_description: " " }, "profile"))).toEqual({
        status: 303,
        location: "/pages/profile/edit",
        flash: { notice: "Changes saved!" },
      });
      expect(row.set).toHaveBeenCalledWith("seo_title", "Home page");
      expect(row.set).toHaveBeenCalledWith("seo_description", null);
    });

    it("sends the first error of each field back to the editor", async () => {
      mocks.findSellerProfile.mockResolvedValue(
        profile([
          { attribute: "seo_title", message: "is too long (maximum is 70 characters)" },
          { attribute: "seo_title", message: "second" },
        ]),
      );
      mocks.saveProfile.mockResolvedValue(false);
      expect(await run(input({ seo_title: "t".repeat(71) }, "profile"))).toEqual(
        withErrors("/pages/profile/edit", { seo_title: "is too long (maximum is 70 characters)" }),
      );
    });
  });

  describe("removal of the custom HTML of the profile", () => {
    const removal = input({ remove_custom_html: "1" }, "profile");

    it("clears the HTML and touches the seller", async () => {
      database({ root: { id: 5n, custom_html: "<main></main>", title: null, content: null } as never });
      expect(await run(removal)).toEqual({
        status: 303,
        location: "/pages/profile/edit",
        flash: { notice: "Custom page removed — your profile is back on the default template." },
      });
      expect(mocks.execute).toHaveBeenCalledTimes(1);
      expect(mocks.touch).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when there is no HTML to clear", async () => {
      database({ root: { id: 5n, custom_html: null, title: null, content: null } as never });
      expect(await run(removal)).toMatchObject({ status: 303 });
      database();
      expect(await run(removal)).toMatchObject({ status: 303 });
      expect(mocks.execute).not.toHaveBeenCalled();
    });

    it("hands a page with a title or content of its own to Rails", async () => {
      database({ root: { id: 5n, custom_html: "<main></main>", title: "Home", content: null } as never });
      await expect(run(removal)).rejects.toThrow(/title or content/u);
      database({ root: { id: 5n, custom_html: "<main></main>", title: null, content: "<p></p>" } as never });
      await expect(run(removal)).rejects.toThrow(/title or content/u);
      expect(mocks.execute).not.toHaveBeenCalled();
    });
  });

  it("treats a false removal flag as absent", async () => {
    expect(await run(input({ remove_custom_html: false }, "profile"))).toEqual({ status: 302, location: "/pages" });
  });
});

describe("DELETE /pages/:slug", () => {
  const run = find("DELETE", "/pages/:slug");

  it("sends an unknown slug back to the list", async () => {
    database();
    expect(await run(input({}, "nothing"))).toEqual({ status: 302, location: "/pages", rescued: true });
  });

  it("leaves the profile entry alone", async () => {
    expect(await run(input({}, "profile"))).toEqual({ status: 302, location: "/pages" });
  });

  it("deletes the page and touches the seller", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 8n, custom_html: null }]);
    expect(await run(input({}, "about-me"))).toEqual({
      status: 303,
      location: "/pages",
      flash: { notice: "Page deleted!" },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.touch).toHaveBeenCalledWith({ id: 3n }, { deferred: true });
  });
});

describe("GET /pages/:slug/preview", () => {
  const run = find("GET", "/pages/:slug/preview");

  it("answers 404 to a profile with no custom HTML", async () => {
    database();
    expect(await run(input({}, "profile"))).toMatchObject({ status: 404, body: "" });
  });

  it("answers 404 to a profile whose custom HTML is blank", async () => {
    database({ root: { custom_html: "  " } });
    expect(await run(input({}, "profile"))).toMatchObject({ status: 404 });
  });

  it("hands the profile takeover to Rails", async () => {
    database({ root: { custom_html: "<main></main>" } });
    await expect(run(input({}, "profile"))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a rich text page to Rails", async () => {
    await expect(run(input({}, "about-me"))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("GET /pages/:slug/products", () => {
  const run = find("GET", "/pages/:slug/products");

  it("answers 404 to a page that is not the profile", async () => {
    expect(await run(input({}, "about-me"))).toMatchObject({ status: 404, body: "" });
  });

  // The slice itself is replayed against Rails in pages_controller_guards_parity_spec.
  it("answers the catalogue slice of the profile's custom HTML", async () => {
    database({ root: { custom_html: "<main></main>" } });
    const answer = { status: 200, body: "{}" };
    mocks.slice.mockResolvedValue(answer);
    const now = new Date(0);
    const params = { offset: "0", limit: "3" };
    const request = { ...input(params, "profile"), chain: { now } } as unknown as MutationInput;
    expect(await run(request)).toBe(answer);
    expect(mocks.slice).toHaveBeenCalledWith(expect.objectContaining({ id: 3n }), "<main></main>", params, now);
  });
});
