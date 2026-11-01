"use client";

import * as React from "react";

import { getScrollableParent, useInfiniteScroll } from "./infinite-scroll";
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

type InfiniteScrollSlotProps = {
  loading: boolean;
  fetch: () => void;
  autoMode: boolean;
  manualMode: boolean;
  hasMore: boolean;
  loadingPrevious: boolean;
  loadingNext: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
};
type Slot = React.ReactNode | ((props: InfiniteScrollSlotProps) => React.ReactNode);
type ElementRef = HTMLElement | React.RefObject<HTMLElement | null> | string | null | undefined;

export type InfiniteScrollProps = Omit<React.HTMLAttributes<HTMLElement>, "children"> & {
  data: string;
  buffer?: number;
  as?: string;
  manual?: boolean;
  manualAfter?: number;
  preserveUrl?: boolean;
  reverse?: boolean;
  autoScroll?: boolean;
  children?: React.ReactNode | ((props: { loading: boolean; loadingPrevious: boolean; loadingNext: boolean }) => React.ReactNode);
  startElement?: ElementRef;
  endElement?: ElementRef;
  itemsElement?: ElementRef;
  previous?: Slot;
  next?: Slot;
  loading?: Slot;
  onlyNext?: boolean;
  onlyPrevious?: boolean;
};

export type InfiniteScrollRef = { fetchNext: () => void; fetchPrevious: () => void; hasPrevious: () => boolean; hasNext: () => boolean };

const resolveHTMLElement = (value: ElementRef, fallback: HTMLElement | null): HTMLElement | null => {
  if (!value) return fallback;
  if (typeof value === "object" && "current" in value) return value.current;
  if (typeof value === "string") return document.querySelector<HTMLElement>(value);
  return value;
};
const renderSlot = (slot: Slot | undefined, slotProps: InfiniteScrollSlotProps, fallback: React.ReactNode = null) =>
  !slot ? fallback : typeof slot === "function" ? slot(slotProps) : slot;

// @inertiajs/react 2.3's <InfiniteScroll>, over the logic in infinite-scroll.ts.
export const InfiniteScroll = React.forwardRef<InfiniteScrollRef, InfiniteScrollProps>(function InfiniteScroll(
  { data, buffer = 0, as = "div", manual = false, manualAfter = 0, preserveUrl = false, reverse = false, autoScroll, children, startElement, endElement, itemsElement, previous, next, loading, onlyNext = false, onlyPrevious = false, ...props },
  ref,
) {
  const [startFromRef, setStartFromRef] = React.useState<HTMLElement | null>(null);
  const [endFromRef, setEndFromRef] = React.useState<HTMLElement | null>(null);
  const [itemsFromRef, setItemsFromRef] = React.useState<HTMLElement | null>(null);
  const [loadingPrevious, setLoadingPrevious] = React.useState(false);
  const [loadingNext, setLoadingNext] = React.useState(false);
  const [requestCount, setRequestCount] = React.useState(0);
  const [hasPreviousPage, setHasPreviousPage] = React.useState(false);
  const [hasNextPage, setHasNextPage] = React.useState(false);
  const [resolvedStart, setResolvedStart] = React.useState<HTMLElement | null>(null);
  const [resolvedEnd, setResolvedEnd] = React.useState<HTMLElement | null>(null);
  const [resolvedItems, setResolvedItems] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => setResolvedStart(startElement ? resolveHTMLElement(startElement, startFromRef) : startFromRef), [startElement, startFromRef]);
  React.useEffect(() => setResolvedEnd(endElement ? resolveHTMLElement(endElement, endFromRef) : endFromRef), [endElement, endFromRef]);
  React.useEffect(() => setResolvedItems(itemsElement ? resolveHTMLElement(itemsElement, itemsFromRef) : itemsFromRef), [itemsElement, itemsFromRef]);

  const scrollableParent = React.useMemo(() => getScrollableParent(resolvedItems), [resolvedItems]);
  const callbackProps = React.useRef({ buffer, onlyNext, onlyPrevious, reverse, preserveUrl });
  callbackProps.current = { buffer, onlyNext, onlyPrevious, reverse, preserveUrl };

  const [instance, setInstance] = React.useState<ReturnType<typeof useInfiniteScroll> | null>(null);
  const dataManager = instance?.dataManager;
  const elementManager = instance?.elementManager;

  const scrollToBottom = React.useCallback(() => {
    if (scrollableParent) scrollableParent.scrollTo({ top: scrollableParent.scrollHeight, behavior: "instant" });
    else window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
  }, [scrollableParent]);

  const manualMode = manual || (manualAfter > 0 && requestCount >= manualAfter);
  const autoLoad = !manualMode;
  const autoLoadRef = React.useRef(autoLoad);
  autoLoadRef.current = autoLoad;

  React.useEffect(() => {
    if (!resolvedItems) return;
    const sync = () => {
      setRequestCount(created.dataManager.getRequestCount());
      setHasPreviousPage(created.dataManager.hasPrevious());
      setHasNextPage(created.dataManager.hasNext());
    };
    const created: ReturnType<typeof useInfiniteScroll> = useInfiniteScroll({
      getPropName: () => data,
      inReverseMode: () => callbackProps.current.reverse,
      shouldFetchNext: () => !callbackProps.current.onlyPrevious,
      shouldFetchPrevious: () => !callbackProps.current.onlyNext,
      shouldPreserveUrl: () => callbackProps.current.preserveUrl,
      getTriggerMargin: () => callbackProps.current.buffer,
      getStartElement: () => resolvedStart,
      getEndElement: () => resolvedEnd,
      getItemsElement: () => resolvedItems,
      getScrollableParent: () => scrollableParent,
      onBeforePreviousRequest: () => setLoadingPrevious(true),
      onBeforeNextRequest: () => setLoadingNext(true),
      onCompletePreviousRequest: () => {
        setLoadingPrevious(false);
        sync();
      },
      onCompleteNextRequest: () => {
        setLoadingNext(false);
        sync();
      },
      onDataReset: sync,
    });
    setInstance(created);
    sync();
    created.elementManager.setupObservers();
    created.elementManager.processServerLoadedElements(created.dataManager.getLastLoadedPage());
    if (autoLoadRef.current) created.elementManager.enableTriggers();
    return () => {
      created.flush();
      setInstance(null);
    };
  }, [data, resolvedItems, resolvedStart, resolvedEnd, scrollableParent]);

  React.useEffect(() => {
    if (autoLoad) elementManager?.enableTriggers();
    else elementManager?.disableTriggers();
  }, [autoLoad, onlyNext, onlyPrevious, resolvedStart, resolvedEnd, elementManager]);

  React.useEffect(() => {
    if (autoScroll !== undefined ? autoScroll : reverse) scrollToBottom();
  }, [scrollableParent]);

  React.useImperativeHandle(
    ref,
    () => ({
      fetchNext: () => dataManager?.fetchNext(),
      fetchPrevious: () => dataManager?.fetchPrevious(),
      hasPrevious: dataManager?.hasPrevious ?? (() => false),
      hasNext: dataManager?.hasNext ?? (() => false),
    }),
    [dataManager],
  );

  const shared = { loadingPrevious, loadingNext, hasPrevious: hasPreviousPage, hasNext: hasNextPage };
  const headerAuto = autoLoad && !onlyNext;
  const footerAuto = autoLoad && !onlyPrevious;
  const exposedPrevious: InfiniteScrollSlotProps = { loading: loadingPrevious, fetch: () => dataManager?.fetchPrevious(), autoMode: headerAuto, manualMode: !headerAuto, hasMore: hasPreviousPage, ...shared };
  const exposedNext: InfiniteScrollSlotProps = { loading: loadingNext, fetch: () => dataManager?.fetchNext(), autoMode: footerAuto, manualMode: !footerAuto, hasMore: hasNextPage, ...shared };
  const exposedSlot = { loading: loadingPrevious || loadingNext, loadingPrevious, loadingNext };

  const elements: React.ReactNode[] = [];
  if (!startElement) {
    elements.push(React.createElement("div", { key: "start", ref: (node: HTMLDivElement | null) => setStartFromRef(node) }, renderSlot(previous, exposedPrevious, loadingPrevious ? renderSlot(loading, exposedPrevious) : null)));
  }
  elements.push(React.createElement(as, { ...props, key: "items", ref: (node: HTMLElement | null) => setItemsFromRef(node) }, typeof children === "function" ? children(exposedSlot) : children));
  if (!endElement) {
    elements.push(React.createElement("div", { key: "end", ref: (node: HTMLDivElement | null) => setEndFromRef(node) }, renderSlot(next, exposedNext, loadingNext ? renderSlot(loading, exposedNext) : null)));
  }
  return React.createElement(React.Fragment, {}, ...(reverse ? [...elements].reverse() : elements));
});

export function Form(_props: Record<string, unknown>): React.ReactNode {
  return unsupported("Form");
}
