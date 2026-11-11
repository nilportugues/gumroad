// Request encoding identical to @inertiajs/core 2.3.13, so Rails parses the same params either way.
import type { FormDataConvertible, Method, RequestPayload } from "./types";

export function hasFiles(data: unknown): boolean {
  if (typeof Blob !== "undefined" && data instanceof Blob) return true;
  if (typeof FileList !== "undefined" && data instanceof FileList) return data.length > 0;
  if (typeof FormData !== "undefined" && data instanceof FormData) return true;
  if (Array.isArray(data)) return data.some(hasFiles);
  if (data && typeof data === "object") return Object.values(data).some(hasFiles);
  return false;
}

const composeKey = (parent: string | null, key: string) => (parent ? `${parent}[${key}]` : key);

function append(form: FormData, key: string, value: FormDataConvertible): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => append(form, composeKey(key, index.toString()), item));
  } else if (value instanceof Date) {
    form.append(key, value.toISOString());
  } else if (typeof Blob !== "undefined" && value instanceof Blob) {
    form.append(key, value);
  } else if (typeof value === "boolean") {
    form.append(key, value ? "1" : "0");
  } else if (typeof value === "string") {
    form.append(key, value);
  } else if (typeof value === "number") {
    form.append(key, `${value}`);
  } else if (value === null || value === undefined) {
    form.append(key, "");
  } else {
    objectToFormData(value as Record<string, FormDataConvertible>, form, key);
  }
}

export function objectToFormData(source: RequestPayload, form = new FormData(), parentKey: string | null = null): FormData {
  if (typeof FormData !== "undefined" && source instanceof FormData) return source;
  for (const key of Object.keys(source)) append(form, composeKey(parentKey, key), (source as Record<string, FormDataConvertible>)[key]);
  return form;
}

// qs.stringify(..., { encodeValuesOnly: true, arrayFormat: "brackets" }): nulls become `key=`, undefined is skipped.
function flatten(value: unknown, key: string, out: [string, string][]): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item) => flatten(item, `${key}[]`, out));
  } else if (value instanceof Date) {
    out.push([key, value.toISOString()]);
  } else if (value !== null && typeof value === "object") {
    for (const [child, childValue] of Object.entries(value)) flatten(childValue, `${key}[${child}]`, out);
  } else {
    out.push([key, value === null ? "" : String(value)]);
  }
}

export function toQueryString(data: Record<string, unknown>): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(data)) flatten(value, key, pairs);
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

const topLevelKey = (param: string) => param.split("[", 1)[0];

// GET data moves into the query string, replacing existing parameters with the same top-level name.
export function mergeDataIntoQueryString(method: Method, url: URL, data: RequestPayload): [URL, RequestPayload] {
  const isFormData = typeof FormData !== "undefined" && data instanceof FormData;
  if (method !== "get" || isFormData || Object.keys(data).length === 0) return [url, data];

  const replaced = new Set(Object.keys(data));
  const kept = url.search
    .replace(/^\?/u, "")
    .split("&")
    .filter((pair) => pair !== "" && !replaced.has(topLevelKey(decodeURIComponent(pair.split("=", 1)[0] ?? "")) ?? ""));
  const added = toQueryString(data as Record<string, unknown>);
  const search = [...kept, ...(added ? [added] : [])].join("&");
  const merged = new URL(url.href);
  merged.search = search ? `?${search}` : "";
  return [merged, {}];
}
