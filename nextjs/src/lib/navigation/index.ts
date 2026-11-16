// Drop-in replacement for the parts of @inertiajs/react and @inertiajs/core the pages use. next.config.ts
// aliases both packages here, so shared components under app/javascript run unchanged; converted pages
// import from "@/lib/navigation" directly. Client-only: import it from "use client" modules.
import { useRemember as useRememberState } from "./use-remember";

export { PagePropsProvider, usePage } from "./page-context";
export { router } from "./router";
export { useForm, type InertiaForm, type InertiaFormProps } from "./use-form";
export { Link, shouldIntercept } from "./link";
export { Deferred, Form, Head, InfiniteScroll, usePoll } from "./components";
export type * from "./types";

export function useRemember<State>(initialState: State, key = "default") {
  return useRememberState(initialState, key);
}

export function createInertiaApp(): never {
  throw new Error("Next.js renders the pages; createInertiaApp has no meaning here.");
}
