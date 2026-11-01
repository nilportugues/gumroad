// Ambient types app/javascript compiles against (app/javascript/types/index.d.ts and the Vite
// auto-import of `Routes`), minus its `process.env` override, which conflicts with @types/node.
/// <reference path="../../../app/javascript/types/assets.d.ts" />
/// <reference path="../../../app/javascript/types/css.d.ts" />
/// <reference path="../../../app/javascript/types/analytics.d.ts" />

type Tuple<T, N extends number> = N extends N ? (number extends N ? T[] : $TupleOf<T, N, []>) : never;
type $TupleOf<T, N extends number, R extends unknown[]> = R["length"] extends N ? R : $TupleOf<T, N, [T, ...R]>;

// app/javascript narrows Object.keys to the keys of its argument for every type. Here only for
// plain object types (a Record<CurrencyCode, ...> table), so class instances like FormData keep
// the standard string[].
interface ObjectConstructor {
  keys<T extends Record<string, unknown>>(o: T): string extends keyof T ? string[] : (keyof T & string)[];
}

// @inertiajs/core declares these on DocumentEventMap; the compat module dispatches them itself.
interface DocumentEventMap {
  "inertia:start": CustomEvent;
  "inertia:success": CustomEvent;
  "inertia:error": CustomEvent;
  "inertia:progress": CustomEvent;
  "inertia:finish": CustomEvent;
}

declare namespace React {
  interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    inert?: boolean | undefined;
    "scroll-region"?: string | undefined;
  }
  interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
    fetchpriority?: HTMLImageElement["fetchPriority"];
  }
}

declare const SSR: boolean;
declare const Routes: typeof import("../lib/navigation/routes");
