import { describe, expect, it } from "vitest";

import { filterPartialProps } from "./load-page.ts";
import { always, defer, lazy, merge, optional, resolveLazyProps } from "./lazy-props.ts";

const partial = (only: string[] = [], except: string[] = []) => ({ only, except, reset: [] });

describe("resolveLazyProps", () => {
  const props = () => ({
    plain: 1,
    count: always(() => 2),
    chart: defer(() => ({ points: [1, 2] })),
    slow: defer(() => "slow", "data"),
    extra: optional(() => "extra"),
    rows: merge(() => [1]),
    now: lazy(() => "now"),
  });

  it("leaves deferred props out of a first load and lists them by group, without calling them", async () => {
    let called = false;
    const resolved = await resolveLazyProps({ ...props(), spy: defer(() => (called = true)) }, null);
    expect(resolved.props).toEqual({ plain: 1, count: 2, rows: [1], now: "now" });
    expect(resolved.deferredProps).toEqual({ default: ["chart", "spy"], data: ["slow"] });
    expect(resolved.mergeProps).toEqual(["rows"]);
    expect(called).toBe(false);
    expect(await resolved.deferredLoaders.chart!()).toEqual({ points: [1, 2] });
  });

  it("answers a partial reload of the component with the props it asks for and lists no deferred props", async () => {
    const resolved = await resolveLazyProps(props(), partial(["chart"]));
    expect(resolved.props).toEqual({ plain: 1, count: 2, chart: { points: [1, 2] } });
    expect(resolved.alwaysKeys).toEqual(["count"]);
    expect(resolved.deferredProps).toEqual({});
  });

  it("includes every deferred prop in a partial reload that names none", async () => {
    const resolved = await resolveLazyProps(props(), partial([], ["rows"]));
    expect(Object.keys(resolved.props)).toEqual(["plain", "count", "chart", "slow", "extra", "now"]);
  });
});

describe("filterPartialProps with always props", () => {
  const headers = new Headers({ "x-inertia-partial-component": "C", "x-inertia-partial-data": "chart" });

  it("keeps an always prop that the partial reload did not ask for", () => {
    const props = { errors: {}, count: { a: 1 }, other: 2, chart: [1] };
    expect(filterPartialProps(props, "C", headers, ["count"])).toEqual({ errors: {}, count: { a: 1 }, chart: [1] });
    expect(filterPartialProps(props, "C", headers)).toEqual({ errors: {}, chart: [1] });
  });
});
