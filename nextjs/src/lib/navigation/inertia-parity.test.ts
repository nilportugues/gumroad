// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://localhost:47391/"}
// Drives the real @inertiajs/core router and the compat router through the same reloads against one
// HTTP server, and expects the same request headers, resulting props and URL. Skipped when the Rails
// app's node_modules (where @inertiajs/core lives) is not installed.
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type Navigator, registerNavigator, router as compat } from "./router";
import type { Page, PageProps, ReloadOptions } from "./types";

const PORT = 47391;
let corePath: string | null = null;
try {
  corePath = createRequire(import.meta.url)
    .resolve("@inertiajs/core")
    .replace(/index\.js$/u, "index.esm.js");
} catch {
  corePath = null;
}

type Request = { path: string; headers: Record<string, string> };
let requests: Request[] = [];
let server: http.Server;

const ITEMS = [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `item ${id}` }));
const PAGE_SIZE = 2;
let stamp = 0;

// A stand-in for inertia_rails: partial filtering, `mergeProps` minus the reset props, and the extra
// merge strategies of Inertia 2 on /deep.
function inertiaPage(url: URL, headers: http.IncomingHttpHeaders) {
  const partialComponent = headers["x-inertia-partial-component"];
  const only = String(headers["x-inertia-partial-data"] ?? "")
    .split(",")
    .filter(Boolean);
  const except = String(headers["x-inertia-partial-except"] ?? "")
    .split(",")
    .filter(Boolean);
  const reset = String(headers["x-inertia-reset"] ?? "")
    .split(",")
    .filter(Boolean);
  const component =
    url.pathname === "/deep" ? "Deep/Index" : url.pathname === "/scroll" ? "Scroll/Index" : "Items/Index";
  const page = Number(url.searchParams.get("page") ?? 1);
  stamp += 1;
  if (component === "Scroll/Index") return scrollPage(url, headers, partialComponent === component, only, reset);

  const all: Record<string, unknown> =
    component === "Deep/Index"
      ? {
          feed: {
            data: [
              { id: page, v: stamp },
              { id: 100, v: stamp },
            ],
            meta: { page, seen: [page] },
          },
          tags: [`t${page}`],
          stamp,
        }
      : { items: ITEMS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, stamp, total: ITEMS.length };
  const props: Record<string, unknown> = { errors: {} };
  const partial = partialComponent === component;
  for (const [key, value] of Object.entries(all)) {
    if (partial && only.length > 0 && !only.includes(key)) continue;
    if (partial && except.includes(key)) continue;
    props[key] = value;
  }
  const page_: Record<string, unknown> = { component, props, url: url.pathname + url.search, version: null };
  if (component === "Items/Index") page_.mergeProps = reset.includes("items") || !("items" in props) ? [] : ["items"];
  else {
    page_.deepMergeProps = ["feed"];
    page_.prependProps = ["tags"];
    page_.matchPropsOn = ["feed.data.id"];
  }
  return page_;
}

// inertia_rails' InertiaRails.scroll over a list read by cursor: the merge intent header decides between
// appending and prepending, and `scrollProps` carries the metadata (with `reset` for a reset prop).
const MESSAGES = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, text: `message ${id}` }));
function scrollPage(url: URL, headers: http.IncomingHttpHeaders, partial: boolean, only: string[], reset: string[]) {
  const cursor = Number(url.searchParams.get("cursor") ?? 4);
  const intent = headers["x-inertia-infinite-scroll-merge-intent"];
  const from = intent === "prepend" ? Math.max(0, cursor - 3) : intent === "append" ? cursor : Math.max(0, cursor - 2);
  const to =
    intent === "prepend"
      ? cursor
      : intent === "append"
        ? Math.min(MESSAGES.length, cursor + 2)
        : Math.min(MESSAGES.length, cursor + 2);
  const slice = MESSAGES.slice(from, to);
  const props: Record<string, unknown> = { errors: {} };
  if (!partial || only.length === 0 || only.includes("messages")) props.messages = slice;
  if (!partial || only.length === 0 || only.includes("stamp")) props.stamp = stamp;
  const out: Record<string, unknown> = {
    component: "Scroll/Index",
    props,
    url: url.pathname + url.search,
    version: null,
  };
  if ("messages" in props) {
    out.scrollProps = {
      messages: {
        pageName: "cursor",
        previousPage: from > 0 ? from : null,
        nextPage: to < MESSAGES.length ? to : null,
        currentPage: cursor,
        reset: reset.includes("messages"),
      },
    };
    if (!reset.includes("messages")) out[intent === "prepend" ? "prependProps" : "mergeProps"] = ["messages"];
  }
  return out;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const headers: Record<string, string> = {};
    for (const name of [
      "x-inertia",
      "x-inertia-partial-component",
      "x-inertia-partial-data",
      "x-inertia-partial-except",
      "x-inertia-reset",
      "x-inertia-error-bag",
      "x-requested-with",
      "x-inertia-infinite-scroll-merge-intent",
    ]) {
      if (req.headers[name]) headers[name] = String(req.headers[name]);
    }
    requests.push({ path: url.pathname + url.search, headers });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Inertia", "true");
    res.setHeader("Vary", "X-Inertia");
    res.end(JSON.stringify(inertiaPage(url, req.headers)));
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  expect((server.address() as AddressInfo).port).toBe(PORT);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Step = { name: string; options: ReloadOptions & { data?: Record<string, unknown> } };
type Snapshot = { name: string; request: Request | undefined; props: unknown; scrollProps?: unknown; search: string };

const sequences: Record<
  string,
  { path: string; initial: PageProps; initialScroll?: Page["scrollProps"]; steps: Step[] }
> = {
  "scroll props with merge intents": {
    path: "/scroll",
    initial: { messages: MESSAGES.slice(2, 6), stamp: 0 },
    initialScroll: { messages: { pageName: "cursor", previousPage: 2, nextPage: 6, currentPage: 4, reset: false } },
    steps: [
      {
        name: "next",
        options: {
          data: { cursor: 6 },
          only: ["messages"],
          preserveUrl: true,
          headers: { "X-Inertia-Infinite-Scroll-Merge-Intent": "append" },
        },
      },
      {
        name: "previous",
        options: {
          data: { cursor: 2 },
          only: ["messages"],
          preserveUrl: true,
          headers: { "X-Inertia-Infinite-Scroll-Merge-Intent": "prepend" },
        },
      },
      {
        name: "reset",
        options: {
          data: { cursor: 4 },
          only: ["messages"],
          reset: ["messages"],
          preserveUrl: true,
          headers: { "X-Inertia-Infinite-Scroll-Merge-Intent": "append" },
        },
      },
    ],
  },
  "appending a merge prop": {
    path: "/items",
    initial: { items: ITEMS.slice(0, 2), page: 1, stamp: 0, total: 6 },
    steps: [
      { name: "load more", options: { data: { page: 2 }, only: ["items", "page"], preserveUrl: true } },
      { name: "load more again", options: { data: { page: 3 }, only: ["items", "page"], preserveUrl: true } },
      {
        name: "reset the list",
        options: { data: { page: 1 }, only: ["items", "page"], reset: ["items"], preserveUrl: true },
      },
      { name: "single prop", options: { only: ["stamp"] } },
      { name: "except", options: { except: ["stamp"], data: { page: 2 } } },
    ],
  },
  "prepend, deep merge and matchPropsOn": {
    path: "/deep",
    initial: { feed: { data: [{ id: 1, v: 0 }], meta: { page: 1, seen: [1] } }, tags: ["t1"], stamp: 0 },
    steps: [
      { name: "page 2", options: { data: { page: 2 }, only: ["feed", "tags"], preserveUrl: true } },
      {
        name: "same page again (matched ids replace)",
        options: { data: { page: 2 }, only: ["feed", "tags"], preserveUrl: true },
      },
      { name: "reset", options: { data: { page: 5 }, only: ["feed"], reset: ["feed"], preserveUrl: true } },
    ],
  },
};

const componentOf = (path: string) =>
  path === "/deep" ? "Deep/Index" : path === "/scroll" ? "Scroll/Index" : "Items/Index";

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function runReal(
  core: typeof import("@inertiajs/core"),
  sequence: (typeof sequences)[string],
): Promise<Snapshot[]> {
  const initialPage = {
    component: componentOf(sequence.path),
    props: { errors: {}, ...sequence.initial },
    url: sequence.path,
    version: null,
    ...(sequence.initialScroll ? { scrollProps: sequence.initialScroll } : {}),
  };
  window.history.replaceState(null, "", sequence.path);
  let current: Page = initialPage as Page;
  await (core.router as unknown as { init: (options: unknown) => Promise<void> }).init({
    initialPage: initialPage as never,
    resolveComponent: async () => ({}),
    swapComponent: async ({ page }: { page: unknown }) => {
      current = page as Page;
    },
  });
  const out: Snapshot[] = [];
  stamp = 0;
  for (const step of sequence.steps) {
    requests = [];
    await new Promise<void>((resolve) => core.router.reload({ ...step.options, onFinish: () => resolve() } as never));
    await settle();
    out.push({
      name: step.name,
      request: requests[0],
      props: current.props,
      scrollProps: current.scrollProps,
      search: window.location.search,
    });
  }
  return out;
}

async function runCompat(sequence: (typeof sequences)[string]): Promise<Snapshot[]> {
  window.history.replaceState(null, "", sequence.path);
  const component = componentOf(sequence.path);
  let props: PageProps = { errors: {}, ...sequence.initial };
  let scrollProps = sequence.initialScroll;
  const navigator: Navigator = {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    remount: vi.fn(),
    getPage: () => ({
      component,
      url: window.location.pathname + window.location.search,
      version: null,
      props: props as Page["props"],
      ...(scrollProps ? { scrollProps } : {}),
    }),
    setPageProps: (update) => {
      props = update(props);
    },
    setScrollProps: (update) => {
      scrollProps = update(scrollProps ?? {});
    },
  };
  registerNavigator(navigator);
  const out: Snapshot[] = [];
  stamp = 0;
  for (const step of sequence.steps) {
    requests = [];
    await new Promise<void>((resolve) => compat.reload({ ...step.options, onFinish: () => resolve() } as never));
    await settle();
    out.push({ name: step.name, request: requests[0], props, scrollProps, search: window.location.search });
  }
  registerNavigator(null);
  return out;
}

describe.skipIf(!corePath)("partial reloads against the real @inertiajs/core router", () => {
  for (const [name, sequence] of Object.entries(sequences)) {
    it(`sends the same requests and ends with the same props: ${name}`, async () => {
      // jsdom's AbortSignal is not undici's; the signal is only for cancellation.
      const nodeFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
        nodeFetch(input, { ...init, signal: undefined }),
      );
      const core = (await import(/* @vite-ignore */ corePath!)) as typeof import("@inertiajs/core");
      const real = await runReal(core, sequence);
      const mine = await runCompat(sequence);
      expect(mine).toEqual(real);
      // Guards against both clients silently doing nothing.
      expect(real.every((snapshot) => snapshot.request?.headers["x-inertia"] === "true")).toBe(true);
      if (sequence.path === "/items") expect((real[1]!.props as { items: unknown[] }).items).toHaveLength(6);
      if (sequence.path === "/scroll")
        expect((real[1]!.props as { messages: unknown[] }).messages.length).toBeGreaterThan(4);
      vi.unstubAllGlobals();
    });
  }
});
