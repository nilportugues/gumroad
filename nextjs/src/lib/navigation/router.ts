// The Inertia `router` singleton, re-implemented over the Next.js App Router.
//
// GET visits become Next navigations (the server component reloads the props). Other methods are
// sent with fetch to whichever app owns the endpoint; while Rails still owns it, the request speaks
// the Inertia protocol (X-Inertia) and the proxy always sends such requests to Rails.
import type {
  ActiveVisit,
  Errors,
  GlobalEvent,
  GlobalEventNames,
  Method,
  Page,
  PageProps,
  PendingVisit,
  ReloadOptions,
  RequestPayload,
  VisitOptions,
} from "./types";
import { hasFiles, mergeDataIntoQueryString, objectToFormData } from "./form-data";

// What the page-props provider hands the router once it mounts.
export type Navigator = {
  push: (href: string, options: { scroll: boolean }) => void;
  replace: (href: string, options: { scroll: boolean }) => void;
  refresh: () => void;
  prefetch: (href: string) => void;
  getPage: () => Page;
  // Props that replace the server-rendered ones until the next navigation (Inertia's in-place page swap).
  setPageProps: (update: (props: PageProps) => PageProps) => void;
  remount: () => void;
};

type PendingNavigation = { visit: ActiveVisit; options: VisitOptions };

let navigator: Navigator | null = null;
let pendingNavigations: PendingNavigation[] = [];
// Flash and errors from a Rails response whose page Next will render after navigating.
let carryOverProps: PageProps | null = null;

export function registerNavigator(next: Navigator | null) {
  navigator = next;
}

export function takeCarryOverProps(): PageProps | null {
  const props = carryOverProps;
  carryOverProps = null;
  return props;
}

function requireNavigator(): Navigator {
  if (!navigator) throw new Error("@/lib/navigation router used outside <PagePropsProvider>");
  return navigator;
}

function fire(name: GlobalEventNames, detail: GlobalEvent["detail"], cancelable = false): boolean {
  if (typeof document === "undefined") return true;
  return document.dispatchEvent(new CustomEvent(`inertia:${name}`, { detail, cancelable }));
}

function csrfToken(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? null;
}

function currentHref(): string {
  return typeof window === "undefined" ? requireNavigator().getPage().url : window.location.href;
}

function relativeHref(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

function buildVisit(href: string | URL, options: VisitOptions): ActiveVisit {
  const method = (options.method ?? "get").toLowerCase() as Method;
  const data = (options.data ?? {}) as RequestPayload;
  const [url, body] = mergeDataIntoQueryString(method, new URL(href.toString(), currentHref()), data);
  return {
    url,
    method,
    data: body,
    replace: options.replace ?? false,
    preserveScroll: options.preserveScroll ?? false,
    preserveState: options.preserveState ?? false,
    only: options.only ?? [],
    except: options.except ?? [],
    headers: options.headers ?? {},
    errorBag: options.errorBag ?? null,
    forceFormData: options.forceFormData ?? false,
    async: options.async ?? false,
    showProgress: options.showProgress ?? !options.async,
    prefetch: options.prefetch ?? false,
    reset: options.reset ?? [],
    preserveUrl: options.preserveUrl ?? false,
    completed: false,
    cancelled: false,
    interrupted: false,
  };
}

function resolveOption(option: VisitOptions["preserveScroll"], page: Page): boolean {
  return typeof option === "function" ? option(page) : option === true;
}

async function finishWithPage(visit: ActiveVisit, options: VisitOptions, page: Page) {
  const errors: Errors = page.props.errors ?? {};
  visit.completed = true;
  if (Object.keys(errors).length > 0) {
    const scoped = visit.errorBag ? ((errors as Record<string, unknown>)[visit.errorBag] as Errors | undefined) ?? {} : errors;
    options.onError?.(scoped);
    fire("error", { visit, errors: scoped });
  } else {
    await options.onSuccess?.(page);
    fire("success", { visit, page });
  }
  fire("navigate", { visit, page });
}

function finish(visit: ActiveVisit, options: VisitOptions) {
  options.onFinish?.(visit);
  fire("finish", { visit });
}

// Called by the provider after a navigation or refresh has rendered new server props.
export function settleNavigations(page: Page) {
  const settled = pendingNavigations;
  pendingNavigations = [];
  if (settled.some(({ visit }) => !resolveOption(visit.preserveState, page))) requireNavigator().remount();
  for (const { visit, options } of settled) {
    void finishWithPage(visit, options, page).finally(() => finish(visit, options));
  }
}

function navigate(visit: ActiveVisit, options: VisitOptions, refreshOnly: boolean) {
  const nav = requireNavigator();
  pendingNavigations.push({ visit, options });
  const scroll = !resolveOption(visit.preserveScroll, nav.getPage());
  if (refreshOnly) nav.refresh();
  else if (visit.replace) nav.replace(relativeHref(visit.url), { scroll });
  else nav.push(relativeHref(visit.url), { scroll });
}

async function send(visit: ActiveVisit, options: VisitOptions) {
  const nav = requireNavigator();
  const isMultipart = visit.forceFormData || hasFiles(visit.data);
  const headers: Record<string, string> = {
    Accept: "text/html, application/xhtml+xml",
    "X-Requested-With": "XMLHttpRequest",
    "X-Inertia": "true",
    ...visit.headers,
  };
  const token = csrfToken();
  if (token) headers["X-CSRF-Token"] = token;
  if (!isMultipart) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  options.onCancelToken?.({ cancel: () => controller.abort() });

  let response: Response;
  try {
    response = await fetch(visit.url, {
      method: visit.method.toUpperCase(),
      headers,
      credentials: "same-origin",
      body: isMultipart ? objectToFormData(visit.data) : JSON.stringify(visit.data),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      visit.cancelled = true;
      options.onCancel?.();
      fire("cancel", { visit });
    } else if (fire("exception", { visit }, true)) {
      throw error;
    }
    finish(visit, options);
    return;
  }

  const location = response.headers.get("X-Inertia-Location");
  if (response.status === 409 && location) {
    window.location.href = location;
    return;
  }

  if (response.headers.get("X-Inertia") === "true") {
    const page = (await response.json()) as Page;
    const target = new URL(page.url, window.location.href);
    const here = new URL(window.location.href);
    if (target.pathname === here.pathname && page.component === nav.getPage().component) {
      nav.setPageProps(() => page.props);
      if (!visit.preserveUrl && target.search !== here.search) window.history.replaceState(window.history.state, "", relativeHref(target));
      if (!resolveOption(visit.preserveState, page)) nav.remount();
      await finishWithPage(visit, options, page);
      finish(visit, options);
    } else {
      // Rails sent another page. Next renders it (or hands off to Rails); only the one-shot props
      // Rails already consumed from the session have to travel with the navigation.
      carryOverProps = { flash: page.props.flash, errors: page.props.errors };
      visit.url = target;
      navigate(visit, options, false);
    }
    return;
  }

  if (response.redirected) {
    // A Next.js route handler answered with a redirect to a Next page.
    visit.url = new URL(response.url);
    navigate(visit, options, false);
    return;
  }

  if (fire("invalid", { visit, response }, true)) {
    window.location.href = response.url || visit.url.href;
  }
  finish(visit, options);
}

function visit(href: string | URL, options: VisitOptions = {}) {
  const active = buildVisit(href, options);
  if (options.onBefore?.(active) === false || !fire("before", { visit: active }, true)) return;
  options.onStart?.(active);
  fire("start", { visit: active });
  if (active.method === "get") navigate(active, options, false);
  else void send(active, options);
}

type DataVisitOptions = Omit<VisitOptions, "method" | "data">;

export const router = {
  visit,
  get: (url: string | URL, data: RequestPayload = {}, options: DataVisitOptions = {}) => visit(url, { ...options, method: "get", data }),
  post: (url: string | URL, data: RequestPayload = {}, options: DataVisitOptions = {}) => visit(url, { preserveState: true, ...options, method: "post", data }),
  put: (url: string | URL, data: RequestPayload = {}, options: DataVisitOptions = {}) => visit(url, { preserveState: true, ...options, method: "put", data }),
  patch: (url: string | URL, data: RequestPayload = {}, options: DataVisitOptions = {}) => visit(url, { preserveState: true, ...options, method: "patch", data }),
  delete: (url: string | URL, options: Omit<VisitOptions, "method"> = {}) => visit(url, { preserveState: true, ...options, method: "delete" }),

  // `only`/`except` cannot narrow a server component render, so a reload always refreshes every prop.
  reload(options: ReloadOptions = {}) {
    const active = buildVisit(currentHref(), { ...options, preserveScroll: true, preserveState: true, async: true, method: "get" });
    if (options.onBefore?.(active) === false || !fire("before", { visit: active }, true)) return;
    options.onStart?.(active);
    fire("start", { visit: active });
    navigate(active, options, true);
  },

  // Client-side only visits (no request), as in Inertia 2.1+.
  replace(params: { url?: string; props?: PageProps | ((props: PageProps) => PageProps); preserveScroll?: boolean; preserveState?: boolean }) {
    applyClientVisit(params, "replace");
  },
  push(params: { url?: string; props?: PageProps | ((props: PageProps) => PageProps); preserveScroll?: boolean; preserveState?: boolean }) {
    applyClientVisit(params, "push");
  },
  replaceProp(name: string, value: unknown | ((previous: unknown, props: PageProps) => unknown)) {
    requireNavigator().setPageProps((props) => ({
      ...props,
      [name]: typeof value === "function" ? (value as (previous: unknown, props: PageProps) => unknown)(props[name], props) : value,
    }));
  },

  prefetch(href: string | URL, options: { method?: Method } = {}) {
    if ((options.method ?? "get") === "get") requireNavigator().prefetch(href.toString());
  },

  on(name: GlobalEventNames, callback: (event: GlobalEvent) => boolean | void): () => void {
    if (typeof document === "undefined") return () => undefined;
    const listener = (event: Event) => {
      const result = callback(event as GlobalEvent);
      if (event.cancelable && !event.defaultPrevented && result === false) event.preventDefault();
    };
    document.addEventListener(`inertia:${name}`, listener);
    return () => document.removeEventListener(`inertia:${name}`, listener);
  },

  // Inertia boots itself with this; Next.js boots the page, so there is nothing to do.
  init() {},
};

function applyClientVisit(
  params: { url?: string; props?: PageProps | ((props: PageProps) => PageProps) },
  mode: "push" | "replace",
) {
  const nav = requireNavigator();
  const { props } = params;
  if (props !== undefined) nav.setPageProps((current) => (typeof props === "function" ? props(current) : { ...current, ...props }));
  if (params.url !== undefined) {
    // Next.js syncs usePathname/useSearchParams with native history calls.
    if (mode === "push") window.history.pushState(window.history.state, "", params.url);
    else window.history.replaceState(window.history.state, "", params.url);
  }
}

export type Router = typeof router;
