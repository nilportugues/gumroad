// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Navigator, registerNavigator, router, settleNavigations, takeCarryOverProps } from "./router";
import type { Page, PageProps } from "./types";

let props: PageProps;
const navigator = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  remount: vi.fn(),
  getPage: (): Page => ({ component: "Settings/Password/Show", url: "/settings/password", version: null, props: { errors: {}, ...props } }),
  setPageProps: (update: (current: PageProps) => PageProps) => {
    props = update(props);
  },
  setScrollProps: vi.fn(),
} satisfies Navigator;

const inertiaResponse = (page: Partial<Page> & { props: PageProps }) =>
  new Response(JSON.stringify({ component: "Settings/Password/Show", url: "/settings/password", version: null, ...page }), {
    headers: { "X-Inertia": "true", "Content-Type": "application/json" },
  });

beforeEach(() => {
  props = { title: "Before" };
  window.history.replaceState(null, "", "/settings/password");
  document.head.innerHTML = '<meta name="csrf-token" content="token-123">';
  registerNavigator(navigator);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  registerNavigator(null);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("router GET visits", () => {
  it("navigates with the Next router and runs callbacks once the new props render", () => {
    const onSuccess = vi.fn();
    const onFinish = vi.fn();

    router.get("/settings", { tab: "profile", ids: [1, 2] }, { onSuccess, onFinish });

    expect(navigator.push).toHaveBeenCalledWith("/settings?tab=profile&ids[]=1&ids[]=2", { scroll: true });
    expect(onSuccess).not.toHaveBeenCalled();

    settleNavigations(navigator.getPage());
    return flush().then(() => {
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onFinish).toHaveBeenCalledOnce();
      // preserveState defaults to false for GET, which remounts the page like Inertia's new page key.
      expect(navigator.remount).toHaveBeenCalled();
    });
  });

  it("replaces history and keeps scroll when asked", () => {
    router.visit("/products?page=2", { replace: true, preserveScroll: true });
    expect(navigator.replace).toHaveBeenCalledWith("/products?page=2", { scroll: false });
    settleNavigations(navigator.getPage());
  });

  it("reloads by refreshing the server component, keeping state", () => {
    router.reload();
    expect(navigator.refresh).toHaveBeenCalledOnce();
    settleNavigations(navigator.getPage());
    expect(navigator.remount).not.toHaveBeenCalled();
  });

  it("reloads onto the new URL when data changes the query string", () => {
    router.reload({ data: { page: 2 } });
    expect(navigator.refresh).not.toHaveBeenCalled();
    expect(navigator.push).toHaveBeenCalledWith("/settings/password?page=2", { scroll: false });
    settleNavigations(navigator.getPage());
  });

  it("lets a `before` listener cancel the visit", () => {
    const off = router.on("before", (event) => {
      event.preventDefault();
    });
    router.visit("/dashboard");
    off();

    expect(navigator.push).not.toHaveBeenCalled();
  });
});

describe("router non-GET visits", () => {
  it("sends JSON with the Inertia and CSRF headers", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(inertiaResponse({ props: { errors: {} } }));

    router.put("/settings/password", { user: { password: "x" } });
    await flush();

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:3000/settings/password");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(JSON.stringify({ user: { password: "x" } }));
    expect(init?.headers).toMatchObject({ "X-Inertia": "true", "X-CSRF-Token": "token-123", "Content-Type": "application/json" });
  });

  it("sends multipart form data when a file is present", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(inertiaResponse({ props: { errors: {} } }));

    router.post("/upload", { file: new Blob(["x"]), meta: { public: true } });
    await flush();

    const body = fetch.mock.calls[0]![1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("meta[public]")).toBe("1");
    expect(fetch.mock.calls[0]![1]?.headers).not.toHaveProperty("Content-Type");
  });

  it("swaps in the returned props for the same page and calls onSuccess", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(inertiaResponse({ props: { errors: {}, title: "After", flash: { message: "Saved", status: "success" } } }));
    const onSuccess = vi.fn();

    router.put("/settings/password", {}, { onSuccess });
    await flush();
    await flush();

    expect(props).toMatchObject({ title: "After", flash: { message: "Saved" } });
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ title: "After" }) }));
    expect(navigator.push).not.toHaveBeenCalled();
  });

  it("reports validation errors through onError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(inertiaResponse({ props: { errors: { "user.password": "is wrong" } } }));
    const onError = vi.fn();
    const onSuccess = vi.fn();

    router.put("/settings/password", {}, { onError, onSuccess });
    await flush();
    await flush();

    expect(onError).toHaveBeenCalledWith({ "user.password": "is wrong" });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("navigates to another page Rails redirected to, carrying its flash", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      inertiaResponse({ component: "Dashboard/Index", url: "/dashboard", props: { errors: {}, flash: { message: "Done", status: "success" } } }),
    );

    router.delete("/settings/password");
    await flush();
    await flush();

    expect(navigator.push).toHaveBeenCalledWith("/dashboard", { scroll: true });
    expect(takeCarryOverProps()).toEqual({ flash: { message: "Done", status: "success" }, errors: {} });
  });

  it("does a full page load on 409 with X-Inertia-Location", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 409, headers: { "X-Inertia-Location": "http://localhost:3000/login" } }));
    const assign = vi.fn();
    const current = window.location.href;
    vi.spyOn(window, "location", "get").mockReturnValue({
      get href() {
        return current;
      },
      set href(value: string) {
        assign(value);
      },
    } as Location);

    router.post("/settings/password");
    await flush();

    expect(assign).toHaveBeenCalledWith("http://localhost:3000/login");
  });
});

describe("router client-side visits", () => {
  it("replaceProp updates one prop in place", () => {
    router.replaceProp("flash", null);
    expect(props).toEqual({ title: "Before", flash: null });
  });

  it("replace updates the URL without a request", () => {
    router.replace({ url: "/settings/password?tab=2", preserveState: true });
    expect(window.location.search).toBe("?tab=2");
    expect(navigator.push).not.toHaveBeenCalled();
  });
});
