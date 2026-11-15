import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";

const { setPurchase, renderApplicationPage, requireHtml, railsLoggedInUser, domainConfig } = vi.hoisted(() => ({
  setPurchase: vi.fn(),
  renderApplicationPage: vi.fn(),
  requireHtml: vi.fn(),
  railsLoggedInUser: vi.fn(),
  domainConfig: vi.fn(),
}));

vi.mock("./purchase-access-writes.ts", () => ({ setPurchase }));
vi.mock("./erb-pages.ts", () => ({ renderApplicationPage }));
vi.mock("./users-controller.ts", () => ({ requireHtml }));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser }));
vi.mock("../page-props/domain.ts", () => ({ domainConfig }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ encrypt: (id: number) => `ext${id}` }));

const { confirmReceiptEmailPage, subscribePage } = await import("./purchases-pages.ts");

const input = { routeParams: { id: "ext5" }, request: {}, context: {} } as unknown as MutationInput;
const GIFT_RECEIVER = 32;

type Page = { view: (ctx: unknown, csrf: string) => string; options: Record<string, unknown> };
const rendered = (): Page => {
  const [, , , view, options] = renderApplicationPage.mock.calls[0]!;
  return { view, options };
};

beforeEach(() => {
  vi.resetAllMocks();
  setPurchase.mockResolvedValue({ id: 5, flags: 0 });
  renderApplicationPage.mockResolvedValue({ status: 200 });
  railsLoggedInUser.mockReturnValue(null);
  domainConfig.mockReturnValue({ railsEnv: "test" });
});

describe("confirmReceiptEmailPage", () => {
  it("renders the form with the buyer's prompt, the noindex header and the analytics Rails reports for a seller in test", async () => {
    await confirmReceiptEmailPage(input);

    const { view, options } = rendered();
    expect(view({}, "csrf")).toContain("used to purchase this product to view your receipt.");
    expect(view({}, "csrf")).toContain('action="/purchases/ext5/receipt"');
    expect(options).toMatchObject({
      title: "Confirm Email",
      analyticsEnabled: false,
      hideBase: true,
      bodyId: "app",
      headers: { "x-robots-tag": "noindex" },
    });
  });

  it("asks the giftee for the address the gift was sent to", async () => {
    setPurchase.mockResolvedValue({ id: 5, flags: GIFT_RECEIVER });

    await confirmReceiptEmailPage(input);

    expect(rendered().view({}, "csrf")).toContain("this gift was sent to");
  });

  it("hands a signed-in viewer back before it renders", async () => {
    railsLoggedInUser.mockReturnValue({ id: 1n });

    await expect(confirmReceiptEmailPage(input)).rejects.toThrow(HandBackToRails);
    expect(renderApplicationPage).not.toHaveBeenCalled();
  });

  it.each(["production", "staging"])("hands back in %s, where the seller's analytics setting decides", async (env) => {
    domainConfig.mockReturnValue({ railsEnv: env });

    await expect(confirmReceiptEmailPage(input)).rejects.toThrow(/analytics/u);
  });
});

describe("subscribePage", () => {
  it("renders the prompt with a form token bound to the subscribe path", async () => {
    await subscribePage(input);

    const { view, options } = rendered();
    const markup = view({}, "ZmFrZS1jc3JmLXRva2VuLWZvci10aGUtdGVzdC0zMg==");
    expect(markup).toContain("Resubscribe to this creator's emails?");
    expect(markup).toContain('action="/purchases/ext5/subscribe"');
    expect(markup).toMatch(/name="authenticity_token" value="[^"]+"/u);
    expect(options).toMatchObject({ hideBase: true, bodyId: "app", handBackFlash: true });
    expect(options).not.toHaveProperty("headers");
  });

  it("hands a signed-in viewer back and leaves a missing purchase to the 404", async () => {
    railsLoggedInUser.mockReturnValue({ id: 1n });
    await expect(subscribePage(input)).rejects.toThrow(HandBackToRails);

    setPurchase.mockRejectedValue(new Error("Not Found"));
    await expect(subscribePage(input)).rejects.toThrow("Not Found");
  });
});
