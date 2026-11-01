"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { registerNavigator, router, settleNavigations, takeCarryOverProps } from "./router";
import type { Page, PageProps } from "./types";

const PageContext = React.createContext<Page | null>(null);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function";

type Overrides = { base: PageProps; props: PageProps };

// Server components render this with the props Rails would have sent. Props passed as promises are
// Inertia's deferred props: undefined until they stream in, which is what <Deferred> waits for.
export function PagePropsProvider({
  component,
  props,
  deferredProps,
  scrollProps,
  children,
}: {
  component: string;
  props: PageProps;
  deferredProps?: Record<string, string[]>;
  scrollProps?: Page["scrollProps"];
  children: React.ReactNode;
}) {
  const nextRouter = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const url = `${pathname}${search ? `?${search}` : ""}`;

  const [overrides, setOverrides] = React.useState<Overrides>({ base: props, props });
  const [resolved, setResolved] = React.useState(() => new Map<PromiseLike<unknown>, unknown>());
  const [mountKey, setMountKey] = React.useState(0);

  // Overrides belong to the server props they were made against; new server props drop them.
  const current = overrides.base === props ? overrides.props : props;
  const effectiveProps = React.useMemo(() => {
    const result: PageProps = { errors: {} };
    for (const [key, value] of Object.entries(current)) {
      result[key] = isThenable(value) ? (resolved.has(value) ? resolved.get(value) : undefined) : value;
    }
    return result;
  }, [current, resolved]);

  // Like the props, the scroll metadata of a response belongs to the server render it was made against.
  const [scrollOverrides, setScrollOverrides] = React.useState<{ base: Page["scrollProps"]; value: Page["scrollProps"] }>({ base: scrollProps, value: scrollProps });
  const currentScrollProps = scrollOverrides.base === scrollProps ? scrollOverrides.value : scrollProps;

  const page = React.useMemo<Page>(
    () => ({ component, url, version: null, props: effectiveProps as Page["props"], ...(currentScrollProps ? { scrollProps: currentScrollProps } : {}) }),
    [component, url, effectiveProps, currentScrollProps],
  );
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const propsRef = React.useRef(props);
  propsRef.current = props;
  const scrollPropsRef = React.useRef(scrollProps);
  scrollPropsRef.current = scrollProps;

  React.useEffect(() => {
    let cancelled = false;
    for (const value of Object.values(props)) {
      if (!isThenable(value)) continue;
      value.then((data) => {
        if (!cancelled) setResolved((previous) => new Map(previous).set(value, data));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [props]);

  // Inertia 2 asks for each deferred group as soon as the page it came with is set.
  React.useEffect(() => {
    if (!deferredProps) return;
    for (const keys of Object.values(deferredProps)) router.reload({ only: keys });
  }, [props, deferredProps]);

  React.useEffect(() => {
    registerNavigator({
      push: (href, { scroll }) => nextRouter.push(href, { scroll }),
      replace: (href, { scroll }) => nextRouter.replace(href, { scroll }),
      refresh: () => nextRouter.refresh(),
      prefetch: (href) => nextRouter.prefetch(href),
      getPage: () => pageRef.current,
      setPageProps: (update) =>
        setOverrides((previous) => {
          const base = previous.base === propsRef.current ? previous.props : propsRef.current;
          return { base: propsRef.current, props: update(base) };
        }),
      setScrollProps: (update) =>
        setScrollOverrides((previous) => {
          const held = previous.base === scrollPropsRef.current ? previous.value : scrollPropsRef.current;
          return { base: scrollPropsRef.current, value: update(held ?? {}) };
        }),
      remount: () => setMountKey((key) => key + 1),
    });
    return () => registerNavigator(null);
  }, [nextRouter]);

  // A navigation or refresh has rendered: apply what a Rails response carried over, then let the
  // visits that were waiting for it run their callbacks.
  const settledFor = React.useRef<{ props: PageProps; url: string }>({ props, url });
  React.useEffect(() => {
    if (settledFor.current.props === props && settledFor.current.url === url) return;
    settledFor.current = { props, url };
    const carried = takeCarryOverProps();
    if (carried) setOverrides({ base: props, props: { ...props, ...carried } });
    settleNavigations(carried ? { ...pageRef.current, props: { ...pageRef.current.props, ...carried } as Page["props"] } : pageRef.current);
  }, [props, url]);

  return (
    <PageContext.Provider value={page}>
      <React.Fragment key={mountKey}>{children}</React.Fragment>
    </PageContext.Provider>
  );
}

export function usePage<TPageProps extends PageProps = PageProps>(): Page<TPageProps> {
  const page = React.useContext(PageContext);
  if (!page) throw new Error("usePage() must be used inside <PagePropsProvider>");
  return page as Page<TPageProps>;
}
