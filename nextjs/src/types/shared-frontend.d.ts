// Ambient types app/javascript compiles against (app/javascript/types/index.d.ts and the Vite
// auto-import of `Routes`), minus its `process.env` override, which conflicts with @types/node.
// A global script file: an `import` would turn it into a module and stop its declarations being ambient.
/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="../../../app/javascript/types/assets.d.ts" />
/// <reference path="../../../app/javascript/types/css.d.ts" />
/// <reference path="../../../app/javascript/types/analytics.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */

type Tuple<T, N extends number> = N extends N ? (number extends N ? T[] : $TupleOf<T, N, []>) : never;
type $TupleOf<T, N extends number, R extends unknown[]> = R["length"] extends N ? R : $TupleOf<T, N, [T, ...R]>;

// app/javascript narrows Object.keys to the keys of its argument for every type. Here only for
// plain object types (a Record<CurrencyCode, ...> table), so class instances like FormData keep
// the standard string[].
interface ObjectConstructor {
  keys<T extends Record<string, unknown>>(o: T): string extends keyof T ? string[] : (keyof T & string)[];
  entries<T extends Record<string, unknown>>(
    o: T,
  ): string extends keyof T ? [string, T[keyof T]][] : [keyof T & string, T[keyof T]][];
  fromEntries<T, K extends PropertyKey>(entries: Iterable<readonly [K, T]>): { [k in K]: T };
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

// Vite hands images imported through `$assets` over as URL strings, as app/javascript/types/assets.d.ts
// declares; next/image-types/global declares `*.png` first, as StaticImageData, so the more specific
// pattern keeps the shared components type-checking against what they receive at runtime.
declare module "$assets/*.png" {
  const value: string;
  export default value;
}

// react-select 5.8 and other libraries still read the global JSX namespace that @types/react 19 dropped;
// without it their prop types collapse to `any` and every callback passed to them loses contextual typing.
declare namespace JSX {
  type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
}

declare module "*?inline" {
  const content: string;
  export default content;
}

declare module "*?url" {
  const url: string;
  export default url;
}
