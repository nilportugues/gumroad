import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetRailsCacheForTesting } from "../cache/rails-cache.ts";
import { railsRoot } from "../infra/rails-env.ts";
import { register } from "../services/staging-apple-pay-domain-registration.ts";
import { parseRedirectConfig, setSubdomainRedirectorDepsForTesting, subdomainRedirects } from "../services/subdomain-redirector.ts";
import { StripeClient, setStripeClientForTesting, type TransportRequest } from "../stripe/client.ts";
import { STRIPE_API_VERSION } from "../stripe/config.ts";
import { InvalidRequestError } from "../stripe/errors.ts";
import { processAction, redirectLocation } from "./application-controller.ts";
import { healthcheckRoute, setHealthcheckDepsForTesting } from "./healthcheck.ts";
import { railsRequest } from "./rails-request.ts";

const APP = "http://app.test.gumroad.com:31337";
const saved = { ...process.env };

beforeAll(() => {
  process.env.RAILS_ENV = "test";
  process.env.SECRET_KEY_BASE = "healthcheck-test";
});

afterEach(() => {
  setHealthcheckDepsForTesting(null);
  setSubdomainRedirectorDepsForTesting(null);
  setStripeClientForTesting(undefined);
  resetRailsCacheForTesting();
  vi.unstubAllGlobals();
});

afterAll(() => {
  process.env = saved;
});

describe("GET /healthcheck/apple_pay_domain outside a staging branch deployment", () => {
  const { GET, HEAD } = healthcheckRoute("apple_pay_domain");

  it("answers Rails' public 404 page, with no controller headers or cookies", async () => {
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
    const response = await GET(new Request(`${APP}/healthcheck/apple_pay_domain`));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-gr")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(await response.text()).toBe(fs.readFileSync(path.join(railsRoot(), "public/404.html"), "utf8"));
  });

  it("renders the error as JSON for an Accept header asking for it", async () => {
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
    const response = await GET(new Request(`${APP}/healthcheck/apple_pay_domain`, { headers: { accept: "application/json" } }));

    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe('{"status":404,"error":"Not Found"}');
  });

  it("sends no body for HEAD", async () => {
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
    const response = await HEAD(new Request(`${APP}/healthcheck/apple_pay_domain`, { method: "HEAD" }));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

describe("StagingApplePayDomainRegistration.register", () => {
  function stripe(responses: [number, unknown][]) {
    const requests: TransportRequest[] = [];
    const client = new StripeClient({
      config: {
        apiKey: "sk_test_1",
        apiVersion: STRIPE_API_VERSION,
        apiBase: "https://api.stripe.com",
        maxNetworkRetries: 0,
        initialNetworkRetryDelay: 0.5,
        maxNetworkRetryDelay: 2,
        openTimeout: 30,
        readTimeout: 80,
        writeTimeout: 30,
        enableTelemetry: false,
      },
      transport: async (request) => {
        requests.push(request);
        const [status, body] = responses.shift()!;
        return { status, headers: { "request-id": "req_1" }, body: JSON.stringify(body) };
      },
    });
    setStripeClientForTesting(client);
    return requests;
  }

  it("creates the payment method domain, validates it and reports Apple Pay's status", async () => {
    process.env.CUSTOM_DOMAIN = "my-branch.apps.staging.gumroad.org";
    const requests = stripe([
      [200, { id: "pmd_1", object: "payment_method_domain" }],
      [200, { id: "pmd_1", apple_pay: { status: "inactive", status_details: { error_message: "Domain verification failed" } } }],
    ]);

    expect(await register()).toEqual({ active: false, message: "Apple Pay on my-branch.apps.staging.gumroad.org: inactive — Domain verification failed" });
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ["POST", "https://api.stripe.com/v1/payment_method_domains", "domain_name=my-branch.apps.staging.gumroad.org"],
      ["POST", "https://api.stripe.com/v1/payment_method_domains/pmd_1/validate", ""],
    ]);
  });

  it("leaves the error out once Apple Pay is active", async () => {
    process.env.CUSTOM_DOMAIN = "my-branch.apps.staging.gumroad.org";
    stripe([
      [200, { id: "pmd_1" }],
      [200, { id: "pmd_1", apple_pay: { status: "active", status_details: { error_message: "stale" } } }],
    ]);

    expect(await register()).toEqual({ active: true, message: "Apple Pay on my-branch.apps.staging.gumroad.org: active" });
  });

  it("reports a Stripe error by its bare message, as `e.message` reads in Ruby", async () => {
    process.env.CUSTOM_DOMAIN = "my-branch.apps.staging.gumroad.org";
    stripe([[400, { error: { type: "invalid_request_error", message: "Domain is not valid" } }]]);
    setHealthcheckDepsForTesting({ applePayApplicable: () => true });
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });

    const response = await healthcheckRoute("apple_pay_domain").GET(new Request(`${APP}/healthcheck/apple_pay_domain`));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Apple Pay domain registration failed: Domain is not valid");
  });
});

describe("the filter chain around an action", () => {
  it("answers 500 with Rails' public page when an action raises", async () => {
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
    setHealthcheckDepsForTesting({ applePayApplicable: () => true, registerApplePayDomain: async () => Promise.reject(new TypeError("boom")) });

    const response = await healthcheckRoute("apple_pay_domain").GET(new Request(`${APP}/healthcheck/apple_pay_domain`));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe(fs.readFileSync(path.join(railsRoot(), "public/500.html"), "utf8"));
  });

  it("treats a Stripe error from the stub as Rails' rescue does", async () => {
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
    setHealthcheckDepsForTesting({
      applePayApplicable: () => true,
      registerApplePayDomain: async () => Promise.reject(new InvalidRequestError("verification failed", null, { httpStatus: 400 })),
    });

    const response = await healthcheckRoute("apple_pay_domain").GET(new Request(`${APP}/healthcheck/apple_pay_domain`));

    expect(await response.text()).toBe("Apple Pay domain registration failed: verification failed");
  });

  it("raises on a path-relative redirect target, as load_defaults 8.1 does", () => {
    const request = railsRequest(new Request(`${APP}/healthcheck/payouts`));
    expect(() => redirectLocation(request, "elsewhere.example.com/x")).toThrow(/Path relative URL redirect/u);
    expect(redirectLocation(request, "/x")).toBe("http://app.test.gumroad.com:31337/x");
    expect(redirectLocation(request, "//cdn.example.com/x\r\n")).toBe("//cdn.example.com/x");
  });

  it("drops bare Gumroad hosts from the redirect table but, like Rails, not host-and-path entries", () => {
    const config = " App.Example.com = https://a.example.com \napp.test.gumroad.com=https://b.example.com\napp.test.gumroad.com/x=https://c.example.com\nno-location=\n";
    expect([...parseRedirectConfig(config, ["app.test.gumroad.com"])]).toEqual([
      ["app.example.com", "https://a.example.com"],
      ["app.test.gumroad.com/x", "https://c.example.com"],
    ]);
  });

  it("caches the redirect table and answers no redirects when Redis fails", async () => {
    let reads = 0;
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => (reads++, "a.example.com=https://b.example.com") });
    expect([...(await subdomainRedirects())]).toEqual([["a.example.com", "https://b.example.com"]]);
    expect([...(await subdomainRedirects())]).toEqual([["a.example.com", "https://b.example.com"]]);
    expect(reads).toBe(1);

    resetRailsCacheForTesting();
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => Promise.reject(new Error("ECONNREFUSED")) });
    expect([...(await subdomainRedirects())]).toEqual([]);
  });

  it("hands requests UTM tracking could record on a seller host to Rails", async () => {
    process.env.RAILS_ORIGIN = "http://rails.internal:3000";
    const fetch = vi.fn(async () => new Response("from rails", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const response = await processAction(
      new Request("http://seller.test.gumroad.com:31337/healthcheck?utm_source=a&utm_medium=b&utm_campaign=c"),
      {},
      async () => ({ status: 200, body: "node", contentType: "text/plain" }),
    );

    expect(await response.text()).toBe("from rails");
    const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.toString()).toBe("http://rails.internal:3000/healthcheck?utm_source=a&utm_medium=b&utm_campaign=c");
    expect(new Headers(init.headers).get("x-forwarded-host")).toBe("seller.test.gumroad.com:31337");
  });

  it("serves UTM-tagged requests on Gumroad's own hosts itself", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });

    const response = await healthcheckRoute("index").GET(new Request(`${APP}/healthcheck?utm_source=a&utm_medium=b&utm_campaign=c`));

    expect(await response.text()).toBe("healthcheck");
    expect(fetch).not.toHaveBeenCalled();
  });
});
