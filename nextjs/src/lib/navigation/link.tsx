"use client";

// Port of @inertiajs/react 2.3.13 <Link>: same props, element choice and click handling; visits go
// through the compat router. A plain GET anchor renders next/link with Next's prefetching off, since
// prefetch is only on request (Inertia's `prefetch` prop) and the proxy answers it cheaply for Rails pages.
import NextLink from "next/link";
import * as React from "react";

import { mergeDataIntoQueryString } from "./form-data";
import { router } from "./router";
import type { CacheForOption, LinkPrefetchOption, Method, RequestPayload, VisitCallbacks, VisitOptions } from "./types";

const PREFETCH_HOVER_DELAY_MS = 75;

type InterceptableEvent = Pick<MouseEvent, "altKey" | "ctrlKey" | "defaultPrevented" | "metaKey" | "shiftKey"> & {
  button?: number;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
};

// Inertia's rule for when a click is a navigation the app should handle itself.
export function shouldIntercept(event: InterceptableEvent): boolean {
  const isLink = (event.currentTarget as HTMLElement | null)?.tagName.toLowerCase() === "a";
  return !(
    (event.target && (event.target as HTMLElement).isContentEditable) ||
    event.defaultPrevented ||
    (isLink && event.altKey) ||
    (isLink && event.ctrlKey) ||
    (isLink && event.metaKey) ||
    (isLink && event.shiftKey) ||
    (isLink && "button" in event && event.button !== 0)
  );
}

type BaseLinkProps = Partial<
  Pick<VisitOptions, "replace" | "preserveScroll" | "preserveState" | "preserveUrl" | "only" | "except" | "headers" | "async">
> &
  VisitCallbacks & {
    as?: React.ElementType;
    data?: RequestPayload;
    href?: string | { url: string; method: Method };
    method?: Method | Uppercase<Method>;
    prefetch?: boolean | LinkPrefetchOption | LinkPrefetchOption[];
    cacheFor?: CacheForOption | CacheForOption[];
    onClick?: (event: React.MouseEvent) => void;
  };

export type InertiaLinkProps = BaseLinkProps &
  Omit<React.HTMLAttributes<HTMLElement>, keyof BaseLinkProps> &
  Omit<React.AllHTMLAttributes<HTMLElement>, keyof BaseLinkProps>;

export const Link = React.forwardRef<unknown, InertiaLinkProps>(function Link(
  {
    children,
    as = "a",
    data = {},
    href = "",
    method = "get",
    preserveScroll = false,
    preserveState,
    preserveUrl = false,
    replace = false,
    only = [],
    except = [],
    headers = {},
    async = false,
    prefetch = false,
    cacheFor: _cacheFor,
    onClick,
    onCancelToken,
    onBefore,
    onStart,
    onProgress,
    onFinish,
    onCancel,
    onSuccess,
    onError,
    ...props
  },
  ref,
) {
  const [inFlightCount, setInFlightCount] = React.useState(0);
  const hoverTimeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const resolvedMethod = (typeof href === "object" ? href.method : method.toLowerCase()) as Method;
  const element = typeof as !== "string" || as.toLowerCase() !== "a" ? as : resolvedMethod !== "get" ? "button" : "a";
  const base = typeof window === "undefined" ? "http://localhost" : window.location.href;
  const rawUrl = typeof href === "object" ? href.url : href;
  const [mergedUrl, mergedData] = mergeDataIntoQueryString(resolvedMethod, new URL(rawUrl, base), data);
  // Keep the href as written when nothing was merged, so server and client render the same markup.
  const url = mergedUrl.search === new URL(rawUrl, base).search ? rawUrl : `${mergedUrl.pathname}${mergedUrl.search}${mergedUrl.hash}`;

  const visitOptions: VisitOptions = {
    data: mergedData,
    method: resolvedMethod,
    preserveScroll,
    preserveState: preserveState ?? resolvedMethod !== "get",
    preserveUrl,
    replace,
    only,
    except,
    headers,
    async,
    onCancelToken,
    onBefore,
    onStart(visit) {
      setInFlightCount((count) => count + 1);
      onStart?.(visit);
    },
    onProgress,
    onFinish(visit) {
      setInFlightCount((count) => count - 1);
      onFinish?.(visit);
    },
    onCancel,
    onSuccess,
    onError,
  };

  const prefetchModes: LinkPrefetchOption[] = prefetch === true ? ["hover"] : prefetch === false ? [] : Array.isArray(prefetch) ? prefetch : [prefetch];
  const doPrefetch = () => {
    if (resolvedMethod === "get") router.prefetch(url);
  };

  React.useEffect(() => {
    if (prefetchModes.includes("mount")) setTimeout(doPrefetch);
    return () => clearTimeout(hoverTimeout.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors Inertia, which only re-runs on mode changes
  }, prefetchModes);

  const handleClick = (event: React.MouseEvent) => {
    onClick?.(event);
    if (shouldIntercept(event)) {
      event.preventDefault();
      router.visit(url, visitOptions);
    }
  };
  const events = prefetchModes.includes("hover")
    ? {
        onMouseEnter: () => {
          hoverTimeout.current = setTimeout(doPrefetch, PREFETCH_HOVER_DELAY_MS);
        },
        onMouseLeave: () => clearTimeout(hoverTimeout.current),
        onClick: handleClick,
      }
    : { onClick: handleClick };

  const elementProps = { ...props, ref, ...events, "data-loading": inFlightCount > 0 ? "" : undefined };
  if (element === "a") {
    return (
      <NextLink {...(elementProps as Omit<React.ComponentProps<typeof NextLink>, "href">)} href={url} prefetch={false}>
        {children}
      </NextLink>
    );
  }
  if (element === "button") return React.createElement(element, { ...elementProps, type: "button" }, children);
  return React.createElement(element, typeof element === "string" ? elementProps : { ...elementProps, href: url }, children);
});
