import { afterEach, describe, expect, it, vi } from "vitest";

import { authorizationHeader, oauthEscape, parseTokenAnswer, signedRequest } from "./oauth1.ts";

// Twitter's "Creating a signature" example (developer.twitter.com/en/docs/authentication/oauth-1-0a/creating-a-signature).
const TWITTER_EXAMPLE = {
  method: "POST",
  url: new URL("https://api.twitter.com/1.1/statuses/update.json?include_entities=true"),
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: { token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", secret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
  formParams: [["status", "Hello Ladies + Gentlemen, a signed OAuth request!"]] as [string, string][],
  now: new Date(1_318_622_958_000),
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("oauth1", () => {
  it("escapes everything but the unreserved characters, byte by byte", () => {
    expect(oauthEscape("Ladies + Gentlemen ~é*")).toBe("Ladies%20%2B%20Gentlemen%20~%C3%A9%2A");
  });

  it("reproduces the signature of Twitter's documented example", () => {
    vi.stubEnv("RAILS_ENV", "test");
    vi.stubEnv("OAUTH1_PARITY_NONCE", "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg");

    const header = authorizationHeader(TWITTER_EXAMPLE);

    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
        'oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", ' +
        'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });

  it("signs a token request with a callback and no token", () => {
    vi.stubEnv("RAILS_ENV", "test");
    vi.stubEnv("OAUTH1_PARITY_NONCE", "n");
    vi.stubEnv("OAUTH1_PARITY_TIMESTAMP", "1");

    const header = authorizationHeader({
      method: "POST",
      url: new URL("https://api.twitter.com/oauth/request_token"),
      consumerKey: "key",
      consumerSecret: "secret",
      callback: "https://example.com/cb?state=a b",
      now: new Date(0),
    });

    expect(header).toMatch(/^OAuth oauth_callback="https%3A%2F%2Fexample\.com%2Fcb%3Fstate%3Da%20b", oauth_consumer_key="key", oauth_nonce="n", oauth_signature="/u);
    expect(header).not.toContain("oauth_token");
  });

  it("ignores the fixed nonce outside the test environment", () => {
    vi.stubEnv("RAILS_ENV", "production");
    vi.stubEnv("OAUTH1_PARITY_NONCE", "fixed");

    expect(authorizationHeader({ ...TWITTER_EXAMPLE, formParams: [] })).not.toContain("fixed");
  });

  it("parses a token answer by its first values", () => {
    expect(parseTokenAnswer("oauth_token=a%20b&oauth_token_secret=c&oauth_token=d")).toEqual({ oauth_token: "a b", oauth_token_secret: "c" });
  });

  it("sends the header, the user agent and the form of a request token call", async () => {
    vi.stubEnv("RAILS_ENV", "production");
    const fetchMock = vi.fn(() => Promise.resolve(new Response("oauth_token=t", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    const answer = await signedRequest({ ...TWITTER_EXAMPLE, formParams: undefined, form: [["x_auth_access_type", "read"]] });

    expect(answer).toMatchObject({ status: 200, text: "oauth_token=t" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe("x_auth_access_type=read");
    expect(init.headers).toMatchObject({ "User-Agent": "OAuth gem v1.1.0", "Content-Type": "application/x-www-form-urlencoded" });
  });
});
