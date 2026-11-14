// The client half of Inertia 2's partial reloads (@inertiajs/core 2.3 `RequestParams.headers` and
// `Response.mergeProps`): the request headers a visit with `only`/`except`/`reset` sends, and how the
// response's props combine with the ones the page already holds.
import type { Page, PageProps } from "./types";

type PartialVisit = { only: string[]; except: string[]; reset: string[] };

export const isPartialVisit = (visit: PartialVisit) => visit.only.length > 0 || visit.except.length > 0 || visit.reset.length > 0;

export function partialHeaders(visit: PartialVisit, component: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isPartialVisit(visit)) headers["X-Inertia-Partial-Component"] = component;
  // A prop to reset must be requested, or the server would omit it and the client would keep the old list.
  const only = visit.only.concat(visit.reset);
  if (only.length > 0) headers["X-Inertia-Partial-Data"] = only.join(",");
  if (visit.except.length > 0) headers["X-Inertia-Partial-Except"] = visit.except.join(",");
  if (visit.reset.length > 0) headers["X-Inertia-Reset"] = visit.reset.join(",");
  return headers;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// lodash-style paths, as @inertiajs/core's `get`/`set` helpers: "a.b.c" and "a.0".
function getPath(target: unknown, path: string): unknown {
  let value: unknown = target;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let node: Record<string, unknown> = target;
  segments.slice(0, -1).forEach((segment, index) => {
    if (node[segment] === null || typeof node[segment] !== "object") node[segment] = /^\d+$/u.test(segments[index + 1] ?? "") ? [] : {};
    node = node[segment] as Record<string, unknown>;
  });
  node[segments[segments.length - 1]!] = value;
}

const hasUnique = (item: unknown, property: string): item is Record<string, unknown> =>
  !!item && typeof item === "object" && property in (item as object);

function mergeOrMatchItems(existing: unknown, incoming: unknown[], matchProp: string, matchPropsOn: string[], append = true): unknown[] {
  const items = Array.isArray(existing) ? existing : [];
  const matchingKey = matchPropsOn.find((key) => key.split(".").slice(0, -1).join(".") === matchProp);
  if (!matchingKey) return append ? [...items, ...incoming] : [...incoming, ...items];

  const unique = matchingKey.split(".").pop() ?? "";
  const incomingByKey = new Map<unknown, unknown>();
  for (const item of incoming) if (hasUnique(item, unique)) incomingByKey.set(item[unique], item);

  if (!append) {
    const untouched = items.filter((item) => !(hasUnique(item, unique) && incomingByKey.has(item[unique])));
    return [...incoming, ...untouched];
  }
  const updated = items.map((item) => (hasUnique(item, unique) && incomingByKey.has(item[unique]) ? incomingByKey.get(item[unique]) : item));
  const added = incoming.filter((item) => !hasUnique(item, unique) || !items.some((held) => hasUnique(held, unique) && held[unique] === item[unique]));
  return [...updated, ...added];
}

function deepMerge(target: unknown, source: unknown, matchProp: string, matchPropsOn: string[]): unknown {
  if (Array.isArray(source)) return mergeOrMatchItems(target, source, matchProp, matchPropsOn);
  if (isObject(source)) {
    const base = isObject(target) ? target : {};
    return Object.keys(source).reduce<Record<string, unknown>>(
      (acc, key) => {
        acc[key] = deepMerge(base[key], source[key], `${matchProp}.${key}`, matchPropsOn);
        return acc;
      },
      { ...base },
    );
  }
  return source;
}

// The props a response sets, merged against `current` for a partial reload. Everything the response
// carries replaces the page's value, except the props it lists in mergeProps/prependProps/deepMergeProps.
export function mergeResponseProps(current: PageProps, response: Page, partial: boolean): PageProps {
  const incoming: PageProps = structuredClone(response.props);
  if (!partial) return incoming;
  const matchPropsOn = response.matchPropsOn ?? [];

  const mergeProp = (prop: string, append: boolean) => {
    const held = getPath(current, prop);
    const next = getPath(incoming, prop);
    if (Array.isArray(next)) setPath(incoming, prop, mergeOrMatchItems(held ?? [], next, prop, matchPropsOn, append));
    else if (isObject(next)) setPath(incoming, prop, { ...(isObject(held) ? held : {}), ...next });
  };
  (response.mergeProps ?? []).forEach((prop) => mergeProp(prop, true));
  (response.prependProps ?? []).forEach((prop) => mergeProp(prop, false));
  (response.deepMergeProps ?? []).forEach((prop) => {
    incoming[prop] = deepMerge(current[prop], incoming[prop], prop, matchPropsOn);
  });
  return incoming;
}
