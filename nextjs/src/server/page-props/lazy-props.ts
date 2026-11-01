// inertia_rails' prop wrappers for the props a page builds from the database: a lambda is only
// called when the response includes it, `optional` props are only sent when a partial reload of the
// page asks for them, and `merge` props are listed in the page's `mergeProps` so the client appends
// them to what it already holds.
const KIND = Symbol("lazyProp");

type Kind = "lazy" | "optional" | "merge";
export type LazyProp = { [KIND]: Kind; resolve: () => unknown };

const wrap = (kind: Kind, resolve: () => unknown): LazyProp => ({ [KIND]: kind, resolve });

// `-> { ... }`
export const lazy = (resolve: () => unknown): LazyProp => wrap("lazy", resolve);
// `InertiaRails.optional { ... }`
export const optional = (resolve: () => unknown): LazyProp => wrap("optional", resolve);
// `InertiaRails.merge { ... }`
export const merge = (resolve: () => unknown): LazyProp => wrap("merge", resolve);

export const isLazyProp = (value: unknown): value is LazyProp => value !== null && typeof value === "object" && KIND in value;
export const lazyKind = (value: LazyProp): Kind => value[KIND];

// null: not a partial reload of this component, which sends every prop but the optional ones.
export type PartialRequest = { only: string[]; except: string[]; reset: string[] } | null;

// A top-level prop is sent unless `only` is given and omits it, or `except` names it.
const keep = (key: string, partial: NonNullable<PartialRequest>) =>
  !(partial.only.length > 0 && !partial.only.includes(key)) && !(partial.except.length > 0 && partial.except.includes(key));

// The props a response carries, with the wrappers resolved. A prop left out is never computed.
// `mergeProps` leaves out the props the client asked to reset (`X-Inertia-Reset`).
export async function resolveLazyProps(
  props: Record<string, unknown>,
  partial: PartialRequest,
): Promise<{ props: Record<string, unknown>; mergeProps: string[] }> {
  const resolved: Record<string, unknown> = {};
  const mergeProps: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (!isLazyProp(value)) {
      resolved[key] = value;
      continue;
    }
    const kind = lazyKind(value);
    if (kind === "optional" && !partial) continue;
    if (partial && !keep(key, partial)) continue;
    resolved[key] = await value.resolve();
    if (kind === "merge" && !(partial?.reset ?? []).includes(key)) mergeProps.push(key);
  }
  return { props: resolved, mergeProps };
}
