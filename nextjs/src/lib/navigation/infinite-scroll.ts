// The framework-agnostic half of Inertia 2's <InfiniteScroll> (@inertiajs/core 2.3 `useInfiniteScroll`:
// src/infiniteScroll/{data,elements,queryString,scrollPreservation}.ts), over this module's router and
// page instead of core's singletons. The request a fetch makes is the same one core makes (`only` the
// prop, the page parameter in `data`, `preserveUrl`, the merge intent header); `inertia-parity.test.ts`
// checks that against the real router.
import { currentPage, router } from "./router";
import type { Page, ReloadOptions, ScrollPropMetadata } from "./types";

const MERGE_INTENT_HEADER = "X-Inertia-Infinite-Scroll-Merge-Intent";
const INFINITE_SCROLL_PAGE_KEY = "infiniteScrollPage";
const INFINITE_SCROLL_IGNORE_KEY = "infiniteScrollIgnore";

type Side = "previous" | "next";

export type InfiniteScrollOptions = {
  getPropName: () => string;
  inReverseMode: () => boolean;
  shouldFetchNext: () => boolean;
  shouldFetchPrevious: () => boolean;
  shouldPreserveUrl: () => boolean;
  getTriggerMargin: () => number;
  getStartElement: () => HTMLElement | null;
  getEndElement: () => HTMLElement | null;
  getItemsElement: () => HTMLElement;
  getScrollableParent: () => HTMLElement | null;
  onBeforePreviousRequest: () => void;
  onBeforeNextRequest: () => void;
  onCompletePreviousRequest: () => void;
  onCompleteNextRequest: () => void;
  onDataReset: () => void;
};

export function debounce<Args extends unknown[]>(callback: (...args: Args) => void, delay: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

// Core's `requestAnimationFrame(cb, times)`.
function frames(callback: () => void, times = 1) {
  window.requestAnimationFrame(() => (times > 1 ? frames(callback, times - 1) : callback()));
}

export function getScrollableParent(element: HTMLElement | null): HTMLElement | null {
  const hasDimensionConstraint = (maxDimension: string, inlineDimension: string) =>
    (!!maxDimension && maxDimension !== "none" && maxDimension !== "0px") || (!!inlineDimension && inlineDimension !== "auto" && inlineDimension !== "0");
  const allowsVerticalScroll = (el: HTMLElement) => {
    const style = window.getComputedStyle(el);
    if (["scroll", "overlay"].includes(style.overflowY)) return true;
    if (style.overflowY !== "auto") return false;
    if (["visible", "clip"].includes(style.overflowX)) return true;
    return hasDimensionConstraint(style.maxHeight, el.style.height);
  };
  const allowsHorizontalScroll = (el: HTMLElement) => {
    const style = window.getComputedStyle(el);
    if (["scroll", "overlay"].includes(style.overflowX)) return true;
    if (style.overflowX !== "auto") return false;
    if (["visible", "clip"].includes(style.overflowY)) return true;
    return hasDimensionConstraint(style.maxWidth, el.style.width);
  };
  let parent = element?.parentElement ?? null;
  while (parent) {
    const allowsScroll = allowsVerticalScroll(parent) || allowsHorizontalScroll(parent);
    if (window.getComputedStyle(parent).display !== "contents" && allowsScroll) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function elementInViewport(el: HTMLElement): boolean {
  if (el.offsetParent === null) return false;
  const rect = el.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom >= 0 && rect.left < window.innerWidth && rect.right >= 0;
}

function elementsInViewport(elements: HTMLElement[], reference?: HTMLElement): HTMLElement[] {
  if (!reference) return elements.filter(elementInViewport);
  const referenceIndex = elements.indexOf(reference);
  const upward: HTMLElement[] = [];
  const downward: HTMLElement[] = [];
  for (let i = referenceIndex; i >= 0; i--) {
    if (!elementInViewport(elements[i]!)) break;
    upward.push(elements[i]!);
  }
  for (let i = referenceIndex + 1; i < elements.length; i++) {
    if (!elementInViewport(elements[i]!)) break;
    downward.push(elements[i]!);
  }
  return [...upward.reverse(), ...downward];
}

class Queue {
  private items: (() => Promise<void>)[] = [];
  private processing: Promise<void> | null = null;
  add(item: () => Promise<void>) {
    this.items.push(item);
    this.processing ??= this.next().finally(() => {
      this.processing = null;
    });
    return this.processing;
  }
  private next(): Promise<void> {
    const item = this.items.shift();
    return item ? Promise.resolve(item()).then(() => this.next()) : Promise.resolve();
  }
}

type Remembered = { previousPage: unknown; nextPage: unknown; lastLoadedPage: unknown; requestCount: number };

function createDataManager(options: Omit<InfiniteScrollOptions, "onCompletePreviousRequest" | "onCompleteNextRequest"> & { onBeforeUpdate: () => void; onCompletePreviousRequest: (loaded: unknown) => void; onCompleteNextRequest: (loaded: unknown) => void }) {
  const scrollPropOfCurrentPage = (): ScrollPropMetadata => {
    const scrollProp = currentPage().scrollProps?.[options.getPropName()];
    if (scrollProp) return scrollProp;
    throw new Error(`The page object does not contain a scroll prop named "${options.getPropName()}".`);
  };
  const state = { component: null as string | null, loading: false, previousPage: null as unknown, nextPage: null as unknown, lastLoadedPage: null as unknown, requestCount: 0 };
  const resetState = () => {
    const scrollProp = scrollPropOfCurrentPage();
    state.component = currentPage().component;
    state.loading = false;
    state.previousPage = scrollProp.previousPage;
    state.nextPage = scrollProp.nextPage;
    state.lastLoadedPage = scrollProp.currentPage;
    state.requestCount = 0;
  };
  const rememberKey = () => `inertia:infinite-scroll-data:${options.getPropName()}`;
  resetState();
  const remembered = router.restore(rememberKey()) as Remembered | undefined;
  if (remembered && typeof remembered === "object" && remembered.lastLoadedPage === scrollPropOfCurrentPage().currentPage) {
    state.previousPage = remembered.previousPage;
    state.nextPage = remembered.nextPage;
    state.lastLoadedPage = remembered.lastLoadedPage;
    state.requestCount = remembered.requestCount || 0;
  }

  const removeEventListener = router.on("success", (event) => {
    if (state.component === event.detail.page?.component && scrollPropOfCurrentPage().reset) {
      resetState();
      options.onDataReset();
    }
  });

  const keyForSide = (side: Side) => (side === "next" ? "nextPage" : "previousPage");
  const syncStateOnSuccess = (side: Side) => {
    const scrollProp = scrollPropOfCurrentPage();
    const key = keyForSide(side);
    state.lastLoadedPage = scrollProp.currentPage;
    state[key] = scrollProp[key];
    state.requestCount += 1;
    router.remember({ previousPage: state.previousPage, nextPage: state.nextPage, lastLoadedPage: state.lastLoadedPage, requestCount: state.requestCount }, rememberKey());
  };
  const getPageName = () => scrollPropOfCurrentPage().pageName;

  const fetchPage = (side: Side, reloadOptions: ReloadOptions = {}) => {
    const pageToLoad = state[keyForSide(side)];
    if (state.loading || pageToLoad === null || pageToLoad === undefined) return;
    state.loading = true;
    router.reload({
      ...reloadOptions,
      data: { [getPageName()]: pageToLoad as string },
      only: [options.getPropName()],
      preserveUrl: true,
      headers: { [MERGE_INTENT_HEADER]: side === "previous" ? "prepend" : "append", ...reloadOptions.headers },
      onBefore: (visit) => {
        if (side === "next") options.onBeforeNextRequest();
        else options.onBeforePreviousRequest();
        return reloadOptions.onBefore?.(visit);
      },
      onBeforeUpdate: (loaded: Page) => {
        options.onBeforeUpdate();
        reloadOptions.onBeforeUpdate?.(loaded);
      },
      onSuccess: (loaded) => {
        syncStateOnSuccess(side);
        return reloadOptions.onSuccess?.(loaded);
      },
      onFinish: (visit) => {
        state.loading = false;
        if (side === "next") options.onCompleteNextRequest(state.lastLoadedPage);
        else options.onCompletePreviousRequest(state.lastLoadedPage);
        reloadOptions.onFinish?.(visit);
      },
    });
  };

  return {
    getLastLoadedPage: () => state.lastLoadedPage,
    getPageName,
    getRequestCount: () => state.requestCount,
    hasPrevious: () => !!state.previousPage,
    hasNext: () => !!state.nextPage,
    fetchNext: (reloadOptions?: ReloadOptions) => fetchPage("next", reloadOptions),
    fetchPrevious: (reloadOptions?: ReloadOptions) => fetchPage("previous", reloadOptions),
    removeEventListener,
  };
}

type PageRange = Record<string, { from: number; to: number }>;

function createElementManager(options: InfiniteScrollOptions & { onItemIntersected: (element: Element) => void; onPreviousTriggered: () => void; onNextTriggered: () => void }) {
  const observers: IntersectionObserver[] = [];
  const newObserver = (callback: (entry: IntersectionObserverEntry) => void, observerOptions: IntersectionObserverInit = {}) => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) callback(entry);
    }, observerOptions);
    observers.push(observer);
    return observer;
  };

  let itemsObserver: IntersectionObserver;
  let startObserver: IntersectionObserver;
  let endObserver: IntersectionObserver;
  let itemsMutationObserver: MutationObserver | undefined;
  let triggersEnabled = false;
  const addedElements = new Set<Element>();

  const pageOf = (element: HTMLElement) => element.dataset[INFINITE_SCROLL_PAGE_KEY];
  const untagged = (element: HTMLElement) => !(INFINITE_SCROLL_PAGE_KEY in element.dataset) && !(INFINITE_SCROLL_IGNORE_KEY in element.dataset);
  const rememberKey = () => `inertia:infinite-scroll-elements:${options.getPropName()}`;

  const rememberElements = () => {
    const ranges: PageRange = {};
    const childNodes = options.getItemsElement().childNodes;
    for (let index = 0; index < childNodes.length; index++) {
      const node = childNodes[index]!;
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const page = pageOf(node as HTMLElement);
      if (typeof page === "undefined") continue;
      if (!(page in ranges)) ranges[page] = { from: index, to: index };
      else ranges[page]!.to = index;
    }
    router.remember(ranges, rememberKey());
  };
  const rememberElementsDebounced = debounce(rememberElements, 250);

  const restoreElements = () => {
    const ranges = router.restore(rememberKey()) as PageRange | undefined;
    if (!ranges || typeof ranges !== "object") return false;
    const childNodes = options.getItemsElement().childNodes;
    for (let index = 0; index < childNodes.length; index++) {
      const node = childNodes[index]!;
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as HTMLElement;
      let elementPage: string | undefined;
      for (const [page, range] of Object.entries(ranges)) {
        if (index >= range.from && index <= range.to) {
          elementPage = page;
          break;
        }
      }
      if (elementPage) element.dataset[INFINITE_SCROLL_PAGE_KEY] = elementPage;
      else if (!untagged(element)) continue;
      else element.dataset[INFINITE_SCROLL_IGNORE_KEY] = "true";
      itemsObserver.observe(element);
    }
    return true;
  };

  const disableTriggers = () => {
    if (!triggersEnabled) return;
    startObserver.disconnect();
    endObserver.disconnect();
    triggersEnabled = false;
  };
  const enableTriggers = () => {
    if (triggersEnabled) disableTriggers();
    const start = options.getStartElement();
    const end = options.getEndElement();
    if (start && options.shouldFetchPrevious()) startObserver.observe(start);
    if (end && options.shouldFetchNext()) endObserver.observe(end);
    triggersEnabled = true;
  };

  let hasRestoredElements = false;
  return {
    setupObservers() {
      itemsMutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) =>
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) addedElements.add(node as Element);
          }),
        );
        rememberElementsDebounced();
      });
      itemsMutationObserver.observe(options.getItemsElement(), { childList: true });
      itemsObserver = newObserver((entry) => options.onItemIntersected(entry.target));
      const observerOptions = { root: options.getScrollableParent(), rootMargin: `${Math.max(1, options.getTriggerMargin())}px` };
      startObserver = newObserver(options.onPreviousTriggered, observerOptions);
      endObserver = newObserver(options.onNextTriggered, observerOptions);
    },
    enableTriggers,
    disableTriggers,
    refreshTriggers() {
      if (triggersEnabled) enableTriggers();
    },
    flushAll() {
      disableTriggers();
      observers.forEach((observer) => observer.disconnect());
      observers.length = 0;
      itemsMutationObserver?.disconnect();
    },
    processManuallyAddedElements() {
      Array.from(addedElements).forEach((element) => {
        const el = element as HTMLElement;
        if (untagged(el)) el.dataset[INFINITE_SCROLL_IGNORE_KEY] = "true";
        itemsObserver.observe(element);
      });
      addedElements.clear();
    },
    processServerLoadedElements(loadedPage: unknown) {
      if (!hasRestoredElements) {
        hasRestoredElements = true;
        if (restoreElements()) return;
      }
      const untaggedElements = Array.from(options.getItemsElement().querySelectorAll<HTMLElement>(":scope > *:not([data-infinite-scroll-page]):not([data-infinite-scroll-ignore])"));
      untaggedElements.forEach((element) => {
        if (untagged(element)) element.dataset[INFINITE_SCROLL_PAGE_KEY] = String(loadedPage ?? "") || "1";
        itemsObserver.observe(element);
      });
      rememberElements();
    },
  };
}

// The URL follows the most visible page unless preserveUrl is set (`useInfiniteScrollQueryString`).
const urlQueue = new Queue();
let initialUrl: URL | null = null;
let payloadUrl: URL | null = null;
let initialUrlWasAbsolute: boolean | null = null;

function createQueryStringManager(options: InfiniteScrollOptions & { getPageName: () => string }) {
  let enabled = true;
  const queuePageUpdate = (page: string) => {
    void urlQueue
      .add(
        () =>
          new Promise<void>((resolve) => {
            if (!enabled) {
              initialUrl = payloadUrl = null;
              resolve();
              return;
            }
            if (!initialUrl || !payloadUrl) {
              const href = currentPage().url;
              initialUrl = new URL(href, window.location.href);
              payloadUrl = new URL(href, window.location.href);
              initialUrlWasAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(href);
            }
            const pageName = options.getPageName();
            if (page === "1") payloadUrl.searchParams.delete(pageName);
            else payloadUrl.searchParams.set(pageName, page);
            setTimeout(() => resolve());
          }),
      )
      .finally(() => {
        if (enabled && initialUrl && payloadUrl && initialUrl.href !== payloadUrl.href && initialUrlWasAbsolute !== null) {
          router.replace({ url: initialUrlWasAbsolute ? payloadUrl.href : `${payloadUrl.pathname}${payloadUrl.search}${payloadUrl.hash}`, preserveScroll: true, preserveState: true });
        }
        initialUrl = payloadUrl = initialUrlWasAbsolute = null;
      });
  };

  const onItemIntersected = debounce((itemElement: Element) => {
    const itemsElement = options.getItemsElement();
    if (!enabled || options.shouldPreserveUrl() || !itemElement || !itemsElement) return;
    const pageMap = new Map<string, number>();
    const elements = [...itemsElement.children] as HTMLElement[];
    elementsInViewport(elements, itemElement as HTMLElement).forEach((element) => {
      const page = element.dataset[INFINITE_SCROLL_PAGE_KEY] ?? "1";
      pageMap.set(page, (pageMap.get(page) ?? 0) + 1);
    });
    const mostVisible = Array.from(pageMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (mostVisible !== undefined) queuePageUpdate(mostVisible);
  }, 250);

  return { onItemIntersected, cancel: () => (enabled = false) };
}

function createScrollPreservation(options: InfiniteScrollOptions) {
  return () => {
    let currentScrollTop: number | undefined;
    let referenceElement: HTMLElement | null = null;
    let referenceElementTop = 0;
    return {
      captureScrollPosition() {
        const container = options.getScrollableParent();
        currentScrollTop = container?.scrollTop || window.scrollY;
        const visible = elementsInViewport([...options.getItemsElement().children] as HTMLElement[]);
        if (visible.length > 0) {
          referenceElement = visible[0]!;
          const containerTop = container ? container.getBoundingClientRect().top : 0;
          referenceElementTop = referenceElement.getBoundingClientRect().top - containerTop;
        }
      },
      restoreScrollPosition() {
        if (!referenceElement) return;
        let attempts = 0;
        let restored = false;
        const restore = () => {
          attempts++;
          if (restored || attempts > 10) return;
          const container = options.getScrollableParent();
          const containerTop = container ? container.getBoundingClientRect().top : 0;
          const adjustment = referenceElement!.getBoundingClientRect().top - containerTop - referenceElementTop;
          if (adjustment === 0) {
            window.requestAnimationFrame(restore);
            return;
          }
          if (container) container.scrollTo({ top: (currentScrollTop ?? 0) + adjustment });
          else window.scrollTo(0, window.scrollY + adjustment);
          restored = true;
        };
        window.requestAnimationFrame(restore);
      },
    };
  };
}

export function useInfiniteScroll(options: InfiniteScrollOptions) {
  const createCallbacks = createScrollPreservation(options);
  let dataManager: ReturnType<typeof createDataManager>;
  // The triggers go through the scroll-preserving wrappers, as core mutates fetchNext/fetchPrevious in place.
  let manager: ReturnType<typeof createDataManager>;
  const queryStringManager = createQueryStringManager({ ...options, getPageName: () => dataManager.getPageName() });
  const elementManager = createElementManager({
    ...options,
    onItemIntersected: queryStringManager.onItemIntersected,
    onPreviousTriggered: () => manager.fetchPrevious(),
    onNextTriggered: () => manager.fetchNext(),
  });
  dataManager = createDataManager({
    ...options,
    onBeforeUpdate: elementManager.processManuallyAddedElements,
    onCompletePreviousRequest: (loaded) => {
      options.onCompletePreviousRequest();
      frames(() => elementManager.processServerLoadedElements(loaded), 2);
    },
    onCompleteNextRequest: (loaded) => {
      options.onCompleteNextRequest();
      frames(() => elementManager.processServerLoadedElements(loaded), 2);
    },
  });

  const withScrollPreservation = (reloadOptions: ReloadOptions): ReloadOptions => {
    const { captureScrollPosition, restoreScrollPosition } = createCallbacks();
    const { onBeforeUpdate, onSuccess } = reloadOptions;
    return {
      ...reloadOptions,
      onBeforeUpdate: (loaded) => {
        onBeforeUpdate?.(loaded);
        captureScrollPosition();
      },
      onSuccess: (loaded) => {
        const result = onSuccess?.(loaded);
        restoreScrollPosition();
        return result;
      },
    };
  };
  manager = {
    ...dataManager,
    fetchNext: (reloadOptions: ReloadOptions = {}) => dataManager.fetchNext(options.inReverseMode() ? withScrollPreservation(reloadOptions) : reloadOptions),
    fetchPrevious: (reloadOptions: ReloadOptions = {}) => dataManager.fetchPrevious(!options.inReverseMode() ? withScrollPreservation(reloadOptions) : reloadOptions),
  };

  const removeEventListener = router.on("success", () => frames(elementManager.refreshTriggers, 2));
  return {
    dataManager: manager,
    elementManager,
    flush: () => {
      removeEventListener();
      dataManager.removeEventListener();
      elementManager.flushAll();
      queryStringManager.cancel();
    },
  };
}
