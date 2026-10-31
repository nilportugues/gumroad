"use client";

import * as React from "react";

import { usePage } from "./page-context";
import { router } from "./router";
import type { ReloadOptions } from "./types";

// React 19 hoists <title>, <meta> and <link> into the document head wherever they render, during SSR
// too, so Inertia's portal is unnecessary. `head-key` dedupe is not reproduced: every tag comes from
// one place (MetaTags or the page), as in the Rails layout.
export function Head({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <>
      {title !== undefined ? <title>{title}</title> : null}
      {children}
    </>
  );
}

type Renderable = React.ReactNode | (() => React.ReactNode);
const render = (node: Renderable) => (typeof node === "function" ? node() : node);

// Deferred props arrive as promises from the server component; usePage() reports them undefined
// until they resolve, exactly like an Inertia deferred prop before its follow-up request lands.
export function Deferred({ data, fallback, children }: { data: string | string[]; fallback: Renderable; children: Renderable }) {
  const { props } = usePage();
  const keys = Array.isArray(data) ? data : [data];
  return <>{keys.every((key) => props[key] !== undefined) ? render(children) : render(fallback)}</>;
}

export function usePoll(
  interval: number,
  requestOptions: ReloadOptions = {},
  { keepAlive = false, autoStart = true }: { keepAlive?: boolean; autoStart?: boolean } = {},
) {
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const options = React.useRef(requestOptions);
  options.current = requestOptions;

  const stop = React.useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  const start = React.useCallback(() => {
    stop();
    timer.current = setInterval(() => {
      // Inertia throttles polling in background tabs unless keepAlive is set.
      if (!keepAlive && document.hidden) return;
      router.reload(options.current);
    }, interval);
  }, [interval, keepAlive, stop]);

  React.useEffect(() => {
    if (autoStart) start();
    return stop;
  }, [autoStart, start, stop]);

  return { start, stop };
}

function unsupported(name: string): never {
  throw new Error(`${name} from @inertiajs/react has no @/lib/navigation equivalent yet; convert this page by hand.`);
}

// Used by one page each (Communities, and none for Form today); see CONVERTING.md.
export function InfiniteScroll(_props: Record<string, unknown>): React.ReactNode {
  return unsupported("InfiniteScroll");
}

export function Form(_props: Record<string, unknown>): React.ReactNode {
  return unsupported("Form");
}
