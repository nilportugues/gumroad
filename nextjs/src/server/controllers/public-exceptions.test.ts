import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publicException } from "./application-controller.ts";
import { railsRequest } from "./rails-request.ts";

// Each case is what Rails answered to a 404 (nextjs/scripts/golden/public-exceptions.rb): `production` with
// ActionDispatch::PublicExceptions in charge, `test` with DebugExceptions' page, which the test environment
// serves for every Accept header.
type Case = {
  mode: "production" | "test";
  variant: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  accept: string | null;
  status: number;
  content_type: string;
  x_cascade: string | null;
  body: string;
};
const { cases } = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/public-exceptions.golden.json"), "utf8"),
) as {
  cases: Case[];
};
const PUBLIC_404 = readFileSync(path.join(process.cwd(), "..", "public", "404.html"), "utf8");
const RACK_HEADERS: Record<string, string> = {
  HTTP_X_REQUESTED_WITH: "x-requested-with",
  CONTENT_TYPE: "content-type",
};

const requestFor = (golden: Case) => {
  const headers = new Headers({ host: "app.test.gumroad.com" });
  if (golden.accept !== null) headers.set("accept", golden.accept);
  for (const [name, value] of Object.entries(golden.headers)) headers.set(RACK_HEADERS[name]!, value);
  return railsRequest(new Request(`http://app.test.gumroad.com${golden.path}`, { method: golden.method, headers }));
};

const label = (golden: Case) =>
  `${golden.variant}: ${golden.method} ${golden.path} accept=${JSON.stringify(golden.accept)}`;

// Rails answers an Accept header that is not a MIME type with an empty 406 on every route; the port does not model it
// (parity-debt.md, "404 content negotiation").
const modelled = cases.filter((golden) => golden.status === 404);

describe("publicException", () => {
  const saved = process.env.RAILS_ENV;
  afterEach(() => {
    process.env.RAILS_ENV = saved;
  });

  describe.each(["production", "test"] as const)("%s", (mode) => {
    beforeEach(() => {
      process.env.RAILS_ENV = mode;
    });

    it.each(modelled.filter((golden) => golden.mode === mode).map((golden) => [label(golden), golden] as const))(
      "%s",
      (_name, golden) => {
        const answer = publicException(requestFor(golden), 404);
        expect(answer.headers.get("content-type")).toBe(golden.content_type);
        const expected = golden.method === "HEAD" ? "" : golden.body === "<public/404.html>" ? PUBLIC_404 : golden.body;
        // The debug page is not recorded; the port answers the public page where Rails answers its own HTML.
        if (golden.body !== "<exception debug page>") expect(answer.body).toBe(expected);
        else
          expect(
            golden.method === "HEAD" || golden.content_type.startsWith("text/plain") || answer.body === PUBLIC_404,
          ).toBe(true);
      },
    );
  });

  describe("a 400, which has no public page", () => {
    const request = () =>
      railsRequest(
        new Request("http://app.test.gumroad.com/settings/team/invitations.json", {
          method: "POST",
          headers: { host: "app.test.gumroad.com", accept: "application/json" },
        }),
      );

    it("answers HTML in the test environment, where DebugExceptions renders its page", () => {
      process.env.RAILS_ENV = "test";
      expect(publicException(request(), 400).headers.get("content-type")).toBe("text/html; charset=utf-8");
    });

    it("answers JSON in production, where PublicExceptions renders the format asked for", () => {
      process.env.RAILS_ENV = "production";
      const answer = publicException(request(), 400);
      expect(answer.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(JSON.parse(answer.body)).toEqual({ status: 400, error: "Bad Request" });
    });
  });

  describe("an XHR in the test environment", () => {
    const xhr = (extra: Record<string, string>) =>
      railsRequest(
        new Request("http://app.test.gumroad.com/x", {
          headers: {
            host: "app.test.gumroad.com",
            accept: "application/json",
            "x-requested-with": "XMLHttpRequest",
            ...extra,
          },
        }),
      );

    beforeEach(() => {
      process.env.RAILS_ENV = "test";
    });

    it("answers a plain-text report", () => {
      expect(publicException(xhr({}), 404).headers.get("content-type")).toBe("text/plain; charset=utf-8");
    });

    it("answers the HTML page when the XHR is an Inertia visit", () => {
      expect(publicException(xhr({ "x-inertia": "true" }), 404).headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
    });
  });
});
