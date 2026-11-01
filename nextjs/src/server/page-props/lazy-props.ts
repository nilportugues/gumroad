// inertia_rails' prop wrappers for the props a page builds from the database: a lambda is only
// called when the response includes it, `optional` props are only sent when a partial reload of the
// page asks for them, and `merge` props are listed in the page's `mergeProps` so the client appends
// them to what it already holds.
const KIND = Symbol("lazyProp");

type Kind = "lazy" | "optional" | "merge" | "always" | "defer" | "scroll";
// ScrollMetadata::Props#as_json
export type ScrollMetadata = { pageName: string; previousPage: unknown; nextPage: unknown; currentPage: unknown };
export type LazyProp = { [KIND]: Kind; resolve: () => unknown; group?: string; metadata?: () => ScrollMetadata | Promise<ScrollMetadata> };

const wrap = (kind: Kind, resolve: () => unknown, group?: string): LazyProp => ({ [KIND]: kind, resolve, ...(group === undefined ? {} : { group }) });

// `-> { ... }`
export const lazy = (resolve: () => unknown): LazyProp => wrap("lazy", resolve);
// `InertiaRails.optional { ... }`
export const optional = (resolve: () => unknown): LazyProp => wrap("optional", resolve);
// `InertiaRails.merge { ... }`
export const merge = (resolve: () => unknown): LazyProp => wrap("merge", resolve);

// `InertiaRails.always { ... }`: kept by every partial reload.
export const always = (resolve: () => unknown): LazyProp => wrap("always", resolve);
// `InertiaRails.defer(group:) { ... }`: left out of the first load and listed in `deferredProps`; a partial
// reload of the page that asks for it gets it.
export const defer = (resolve: () => unknown, group = DEFAULT_DEFER_GROUP): LazyProp => wrap("defer", resolve, group);
export const DEFAULT_DEFER_GROUP = "default";

// `InertiaRails.scroll(metadata) { ... }` with the HashAdapter: a merge prop that appends, or prepends for
// the `X-Inertia-Infinite-Scroll-Merge-Intent: prepend` request, and is listed in `scrollProps`. Rails builds
// `metadata` in the action, so it is evaluated whenever the props are resolved, even if a partial reload
// leaves the prop out.
export const scroll = (metadata: () => ScrollMetadata | Promise<ScrollMetadata>, resolve: () => unknown): LazyProp => ({ ...wrap("scroll", resolve), metadata });

export const isLazyProp = (value: unknown): value is LazyProp => value !== null && typeof value === "object" && KIND in value;
export const lazyKind = (value: LazyProp): Kind => value[KIND];

// null: not a partial reload of this component, which sends every prop but the optional ones.
export type PartialRequest = { only: string[]; except: string[]; reset: string[] } | null;

// The `X-Inertia-Infinite-Scroll-Merge-Intent` request header.
export type ScrollIntent = string | null;

// A top-level prop is sent unless `only` is given and omits it, or `except` names it.
const keep = (key: string, partial: NonNullable<PartialRequest>) =>
  !(partial.only.length > 0 && !partial.only.includes(key)) && !(partial.except.length > 0 && partial.except.includes(key));

export type ResolvedProps = {
  props: Record<string, unknown>;
  mergeProps: string[];
  // Merge props that prepend (a scroll prop answering a "prepend" intent).
  prependProps: string[];
  // `scrollProps` of the page: the metadata of each scroll prop sent, with `reset` for the ones the client resets.
  scrollProps: Record<string, ScrollMetadata & { reset: boolean }>;
  // The top-level props `always` marks: the partial-reload filter must not drop them.
  alwaysKeys: string[];
  // `deferredProps` of the page (group -> prop names), empty for a partial reload of this component.
  deferredProps: Record<string, string[]>;
  // What a server render starts for the deferred props, so their data streams in after the shell.
  deferredLoaders: Record<string, () => Promise<unknown>>;
};

// The props a response carries, with the wrappers resolved. A prop left out is never computed.
// `mergeProps` leaves out the props the client asked to reset (`X-Inertia-Reset`).
export async function resolveLazyProps(props: Record<string, unknown>, partial: PartialRequest, scrollIntent: ScrollIntent = null): Promise<ResolvedProps> {
  const resolved: Record<string, unknown> = {};
  const mergeProps: string[] = [];
  const prependProps: string[] = [];
  const scrollProps: Record<string, ScrollMetadata & { reset: boolean }> = {};
  const alwaysKeys: string[] = [];
  const deferredProps: Record<string, string[]> = {};
  const deferredLoaders: Record<string, () => Promise<unknown>> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!isLazyProp(value)) {
      resolved[key] = value;
      continue;
    }
    const kind = lazyKind(value);
    const metadata = kind === "scroll" ? await value.metadata!() : null;
    if (kind === "always") {
      resolved[key] = await value.resolve();
      alwaysKeys.push(key);
      continue;
    }
    if (kind === "defer" && !partial) {
      (deferredProps[value.group!] ??= []).push(key);
      deferredLoaders[key] = async () => value.resolve();
      continue;
    }
    if (kind === "optional" && !partial) continue;
    if (partial && !keep(key, partial)) continue;
    resolved[key] = await value.resolve();
    const reset = (partial?.reset ?? []).includes(key);
    if (kind === "merge" && !reset) mergeProps.push(key);
    if (kind === "scroll") {
      scrollProps[key] = { ...metadata!, reset };
      if (!reset) (scrollIntent === "prepend" ? prependProps : mergeProps).push(key);
    }
  }
  return { props: resolved, mergeProps, prependProps, scrollProps, alwaysKeys, deferredProps, deferredLoaders };
}
