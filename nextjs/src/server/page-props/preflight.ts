// What a page's `redirect` hook (pages.ts) may answer before the page renders.
import type { Redirected } from "../controllers/application-controller.ts";

// `e404`
export const NOT_FOUND = { notFound: true } as const;
export type PreflightOutcome = Redirected | typeof NOT_FOUND;
// The visitor's URL, host included.
export type PreflightRequest = { url: URL; headers: Headers };
