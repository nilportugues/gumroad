import * as React from "react";

// Inertia keeps remembered state in history.state, which Next.js owns. sessionStorage keyed by the
// URL gives the same "restored on back/forward and reload" behaviour without touching it.
function storageKey(key: string) {
  return `inertia-remember:${window.location.pathname}${window.location.search}:${key}`;
}

export function readRemembered(key: string): unknown {
  if (typeof window === "undefined") return undefined;
  return read<unknown>(key);
}

export function writeRemembered(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Best effort, as in Inertia.
  }
}

function read<T>(key: string): T | undefined {
  try {
    const stored = window.sessionStorage.getItem(storageKey(key));
    return stored === null ? undefined : (JSON.parse(stored) as T);
  } catch {
    return undefined;
  }
}

// A null key makes this plain useState, so callers can keep hook order stable.
export function useRemember<State>(initialState: State, key: string | null): [State, React.Dispatch<React.SetStateAction<State>>] {
  const [state, setState] = React.useState<State>(initialState);

  // Restored after hydration: the server cannot see sessionStorage, and the first client render must match it.
  const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;
  useIsomorphicLayoutEffect(() => {
    if (key === null) return;
    const stored = read<State>(key);
    if (stored !== undefined) setState(stored);
  }, [key]);

  React.useEffect(() => {
    if (key === null) return;
    try {
      window.sessionStorage.setItem(storageKey(key), JSON.stringify(state));
    } catch {
      // Storage full or blocked: remembering is best-effort, as in Inertia.
    }
  }, [key, state]);

  return [state, setState];
}
