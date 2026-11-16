import { afterEach, describe, expect, it } from "vitest";

import { buildRequest, captureResponse, inertiaPage, interceptFetch, setCookies } from "../src/http";

const now = new Date("2026-10-31T12:00:00Z");

describe("buildRequest", () => {
  it("rebuilds the recorded request with its host, query, cookies and body", async () => {
    const request = buildRequest({
      source: "request",
      method: "POST",
      path: "/settings",
      query: "tab=profile",
      headers: { host: "app.test.gumroad.com:31337", "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      cookies: { _gumroad_session: "a b", locale: "en" },
      body: "user%5Bname%5D=Ann",
    });

    expect(request.url).toBe("http://app.test.gumroad.com:31337/settings?tab=profile");
    expect(request.headers.get("cookie")).toBe("_gumroad_session=a%20b; locale=en");
    expect(request.headers.get("accept")).toBe("text/html");
    expect(await request.text()).toBe("user%5Bname%5D=Ann");
  });

  it("sends no body for GET", () => {
    const request = buildRequest({ source: "controller", method: "GET", path: "/", headers: {}, body: "ignored" });
    expect(request.body).toBeNull();
  });
});

describe("captureResponse", () => {
  it("keeps contract headers, drops volatile ones and parses JSON bodies", async () => {
    const response = new Response('{"id": 9007199254740993, "at": "2026-10-31T12:00:00Z"}', {
      status: 201,
      headers: { "content-type": "application/json", "x-request-id": "abc", date: "Sat, 31 Oct 2026 12:00:00 GMT" },
    });

    expect(await captureResponse(response, now)).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      json: { id: { $big: "9007199254740993" }, at: "<now>" },
    });
  });

  it("extracts Inertia page props from HTML instead of comparing the layout", async () => {
    const page = { component: "Settings/Main", props: { name: "Ann & co" }, url: "/settings" };
    const escaped = JSON.stringify(page).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    const response = new Response(`<html><body><div id="app" data-page="${escaped}"></div></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    expect((await captureResponse(response, now)).inertia).toEqual(page);
  });

  it("records a redirect's location and cookies", async () => {
    const headers = new Headers({ location: "http://app.test/login" });
    headers.append("set-cookie", "flash=Signed+out; path=/; HttpOnly");
    const captured = await captureResponse(new Response(null, { status: 302, headers }), now);

    expect(captured).toEqual({
      status: 302,
      location: "http://app.test/login",
      headers: {},
      cookies: { flash: { value: "Signed out", path: "/", httponly: true } },
    });
  });
});

describe("setCookies", () => {
  it("turns expires into a token relative to now", () => {
    expect(setCookies(["remember=1; expires=Sun, 30 Nov 2026 12:00:00 GMT; SameSite=Lax"], now)).toEqual({
      remember: { value: "1", expires: "<now+720h>", samesite: "Lax" },
    });
  });
});

describe("inertiaPage", () => {
  it("reads the script-element form too", () => {
    expect(inertiaPage('<script data-page="app" type="application/json">{"component":"A"}</script>')).toEqual({ component: "A" });
  });

  it("returns undefined for plain HTML", () => {
    expect(inertiaPage("<p>hi</p>")).toBeUndefined();
  });
});

describe("interceptFetch", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("serves recorded responses and records what the port sent", async () => {
    const interceptor = interceptFetch(
      [{ method: "POST", url: "https://api.example.com/v1/charges", response: { status: 201, body: '{"id":"ch_1"}' } }],
      now,
    );
    restore = interceptor.restore;

    const response = await fetch("https://api.example.com/v1/charges", { method: "POST", body: "amount=100" });
    const unmatched = await fetch("https://api.example.com/v1/refunds");

    expect([response.status, await response.text()]).toEqual([201, '{"id":"ch_1"}']);
    expect(unmatched.status).toBe(599);
    expect(interceptor.calls()).toEqual([
      { method: "POST", url: "https://api.example.com/v1/charges", body: "amount=100", contentType: "text/plain;charset=UTF-8", response: {} },
      { method: "GET", url: "https://api.example.com/v1/refunds", response: {} },
    ]);
  });
});
