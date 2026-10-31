"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { registerNavigator, settleNavigations, takeCarryOverProps } from "./router";
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
  children,
}: {
  component: string;
  props: PageProps;
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

  const page = React.useMemo<Page>(
    () => ({ component, url, version: null, props: effectiveProps as Page["props"] }),
    [component, url, effectiveProps],
  );
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const propsRef = React.useRef(props);
  propsRef.current = props;

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
