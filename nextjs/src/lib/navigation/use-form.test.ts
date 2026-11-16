// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Page, VisitOptions } from "./types";
import { useForm } from "./use-form";

const visits: { method: string; url: string; data: unknown; options: VisitOptions }[] = [];

vi.mock("./router", () => {
  const record = (method: string) => (url: string, data: unknown, options: VisitOptions) => visits.push({ method, url, data, options });
  return {
    router: {
      get: record("get"),
      post: record("post"),
      put: record("put"),
      patch: record("patch"),
      delete: (url: string, options: VisitOptions) => visits.push({ method: "delete", url, data: options.data, options }),
    },
  };
});

const page = (props: Record<string, unknown> = {}): Page => ({ component: "Test", url: "/test", version: null, props: { errors: {}, ...props } });

beforeEach(() => {
  visits.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("useForm", () => {
  const initial = { user: { email: "seller@example.com", name: "" }, tags: ["a"] };

  it("starts with the initial data, no errors and not processing", () => {
    const { result } = renderHook(() => useForm(initial));

    expect(result.current.data).toEqual(initial);
    expect(result.current.errors).toEqual({});
    expect(result.current.hasErrors).toBe(false);
    expect(result.current.processing).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });

  it("sets data by dotted key, by object and by updater, without mutating the defaults", () => {
    const { result } = renderHook(() => useForm(initial));

    act(() => result.current.setData("user.name", "Gum"));
    expect(result.current.data.user).toEqual({ email: "seller@example.com", name: "Gum" });
    expect(result.current.isDirty).toBe(true);
    expect(initial.user.name).toBe("");

    act(() => result.current.setData({ ...result.current.data, tags: ["b"] }));
    expect(result.current.data.tags).toEqual(["b"]);

    act(() => result.current.setData((previous) => ({ ...previous, tags: [...previous.tags, "c"] })));
    expect(result.current.data.tags).toEqual(["b", "c"]);
  });

  it("resets all fields or only the given ones to the defaults", () => {
    const { result } = renderHook(() => useForm(initial));

    act(() => {
      result.current.setData("user.name", "Gum");
      result.current.setData("tags", ["z"]);
    });
    act(() => result.current.reset("tags"));
    expect(result.current.data).toEqual({ user: { email: "seller@example.com", name: "Gum" }, tags: ["a"] });

    act(() => result.current.reset());
    expect(result.current.data).toEqual(initial);
    expect(result.current.isDirty).toBe(false);
  });

  it("sets and clears errors, keeping hasErrors in sync", () => {
    const { result } = renderHook(() => useForm(initial));

    act(() => result.current.setError("user.email", "is invalid"));
    act(() => result.current.setError({ "user.name": "can't be blank" }));
    expect(result.current.errors).toEqual({ "user.email": "is invalid", "user.name": "can't be blank" });
    expect(result.current.hasErrors).toBe(true);

    act(() => result.current.clearErrors("user.email"));
    expect(result.current.errors).toEqual({ "user.name": "can't be blank" });

    act(() => result.current.clearErrors());
    expect(result.current.errors).toEqual({});
    expect(result.current.hasErrors).toBe(false);
  });

  it.each(["post", "put", "patch"] as const)("submits the transformed data with %s", (method) => {
    const { result } = renderHook(() => useForm(initial));

    act(() => result.current.transform((data) => ({ user: { ...data.user, email: data.user.email.toUpperCase() } })));
    act(() => result.current[method]("/settings", { preserveScroll: true }));

    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ method, url: "/settings", data: { user: { email: "SELLER@EXAMPLE.COM", name: "" } } });
    expect(visits[0]?.options.preserveScroll).toBe(true);
  });

  it("sends delete data inside the options, like Inertia", () => {
    const { result } = renderHook(() => useForm({ id: "1" }));

    act(() => result.current.delete("/followers/1"));

    expect(visits[0]).toMatchObject({ method: "delete", url: "/followers/1", data: { id: "1" } });
  });

  it("accepts submit(method, url) and submit({ url, method })", () => {
    const { result } = renderHook(() => useForm({ q: "" }));

    act(() => result.current.submit("get", "/search"));
    act(() => result.current.submit({ url: "/search", method: "post" }));

    expect(visits.map(({ method, url }) => [method, url])).toEqual([
      ["get", "/search"],
      ["post", "/search"],
    ]);
  });

  it("tracks processing from start to finish and records success", async () => {
    vi.useFakeTimers();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useForm(initial));

    act(() => result.current.setData("user.name", "Gum"));
    act(() => result.current.post("/settings", { onSuccess }));
    const { options } = visits[0]!;

    act(() => {
      options.onBefore?.({} as never);
      options.onStart?.({} as never);
    });
    expect(result.current.processing).toBe(true);

    await act(async () => {
      await options.onSuccess?.(page());
      options.onFinish?.({} as never);
    });
    expect(result.current.processing).toBe(false);
    expect(result.current.wasSuccessful).toBe(true);
    expect(result.current.recentlySuccessful).toBe(true);
    expect(onSuccess).toHaveBeenCalledWith(page());
    // The submitted data becomes the new defaults.
    expect(result.current.isDirty).toBe(false);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.recentlySuccessful).toBe(false);
  });

  it("keeps the old defaults when onSuccess resets the form", async () => {
    const { result } = renderHook(() => useForm(initial));

    act(() => result.current.setData("user.name", "Gum"));
    act(() => result.current.put("/settings", { onSuccess: () => result.current.reset() }));

    await act(async () => {
      await visits[0]!.options.onSuccess?.(page());
    });
    expect(result.current.data).toEqual(initial);
    expect(result.current.isDirty).toBe(false);
  });

  it("stores server errors and stops processing on error", () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useForm(initial));

    act(() => result.current.post("/settings", { onError }));
    const { options } = visits[0]!;
    act(() => options.onStart?.({} as never));
    act(() => options.onError?.({ "user.email": "is taken" }));

    expect(result.current.processing).toBe(false);
    expect(result.current.errors).toEqual({ "user.email": "is taken" });
    expect(result.current.hasErrors).toBe(true);
    expect(onError).toHaveBeenCalledWith({ "user.email": "is taken" });
  });

  it("clears previous errors on success", async () => {
    const { result } = renderHook(() => useForm(initial));

    act(() => result.current.setError("user.email", "is taken"));
    act(() => result.current.post("/settings"));
    await act(async () => {
      await visits[0]!.options.onSuccess?.(page());
    });

    expect(result.current.errors).toEqual({});
    expect(result.current.hasErrors).toBe(false);
  });

  it("restores remembered data for a remember key", () => {
    const first = renderHook(() => useForm("SettingsForm", { name: "" }));
    act(() => first.result.current.setData("name", "Remembered"));
    first.unmount();

    const second = renderHook(() => useForm("SettingsForm", { name: "" }));
    expect(second.result.current.data).toEqual({ name: "Remembered" });
  });
});
