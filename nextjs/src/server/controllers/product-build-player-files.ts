// ProductBuildPlayerFilesController#show (app/controllers/product_build_player_files_controller.rb): the files of a web build, under the
// grant UrlRedirectsController#play issued. The frame is an opaque origin, so the request carries no cookies and the grant is the only
// credential.
//
// Handed to Rails: a page of the build (html, htm), which gets the buyer's save and the save shim put in front of its scripts and
// whose serving checks the kill switch, and the save endpoint, which applies a batch under the save limits. So is a build served
// from a storage that is not MinIO (the signed link is a Cloudflare URL).
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

import { PLAYER_GRANT_PURPOSE, verifiedPlayerGrant } from "../auth/player-grant.ts";
import { getS3Client, presignS3GetUrl, SIGNED_S3_URL_VALID_FOR_MINIMUM } from "../infra/signed-urls.ts";
import { storageConfig } from "../infra/storage.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const PAGE_EXTENSIONS = ["html", "htm"];
const DOCUMENT_EXTENSIONS = [...PAGE_EXTENSIONS, "svg", "xml"];
const SERVED_EXTENSIONS = [...DOCUMENT_EXTENSIONS, "js", "mjs", "cjs", "css"];
const CACHE_CONTROL = "max-age=300, private";
const INDEX = "index.html";
// ProductBuilds::PlayerDocument::SANDBOX
const SANDBOX = "allow-scripts allow-pointer-lock";

// ProductBuilds::PlayerDocument.content_security_policy
function contentSecurityPolicy(requestOrigin: string, cdnOrigin: string): string {
  const hosts = `${requestOrigin} ${cdnOrigin}`;
  return [
    `sandbox ${SANDBOX}`,
    "default-src 'none'",
    `script-src ${hosts} 'unsafe-inline' 'wasm-unsafe-eval' blob:`,
    `style-src ${hosts} 'unsafe-inline' blob: data:`,
    `img-src ${hosts} blob: data:`,
    `media-src ${hosts} blob: data:`,
    `font-src ${hosts} blob: data:`,
    `connect-src ${hosts} blob: data:`,
    "worker-src blob:",
    `frame-ancestors ${requestOrigin}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// File.extname(path).delete_prefix(".").downcase
function extensionOf(path: string): string {
  const base = path.split("/").at(-1)!;
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? "" : base.slice(dot + 1).toLowerCase();
}

// The scheme, host and port of a url, as the CSP names the CDN.
function originOf(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

const isMissing = (error: unknown) =>
  ["NotFound", "NoSuchKey"].includes((error as { name?: string }).name ?? "") ||
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

// GET /d/:id/play/:grant(/*path)
async function show(input: MutationInput): Promise<ActionResult> {
  const grant = verifiedPlayerGrant(input.routeParams.grant!, input.routeParams.id!, PLAYER_GRANT_PURPOSE);
  if (grant === null) throw new RoutingError("Not Found");

  // `new URL` has already resolved `a/../b`, which Rails' router would hand to the controller untouched.
  const target = input.rawTarget?.split("?")[0] ?? "";
  const rawPath = /^\/d\/[^/]+\/play\/[^/]+\/(.*)$/u.exec(target)?.[1];
  const given = rawPath === undefined ? input.routeParams.path : decodeURIComponent(rawPath);
  const path = given === undefined || given === "" ? INDEX : given;
  const segments = path.split("/");
  // eslint-disable-next-line no-control-regex -- \p{Cc} spelled out: the controller rejects control characters in a path
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || /[\p{Cc}\\]/u.test(path))
    throw new RoutingError("Not Found");

  const extension = extensionOf(path);
  const config = storageConfig();
  if (!config.usingMinio)
    throw new HandBackToRails("a build served from a storage whose signed link is a Cloudflare URL");
  if (PAGE_EXTENSIONS.includes(extension)) throw new HandBackToRails("a page of the build, which gets the save shim");
  if (typeof grant.site_prefix !== "string") throw new HandBackToRails("a grant without a site prefix");
  const key = `${grant.site_prefix}/${path}`;
  const cors = { "Access-Control-Allow-Origin": "*" };

  if (!SERVED_EXTENSIONS.includes(extension)) {
    // Not served from here: every other file (wasm, images, audio, data) goes to a signed link.
    const location = presignS3GetUrl(config.s3Bucket, key, { expiresIn: SIGNED_S3_URL_VALID_FOR_MINIMUM });
    return { status: 302, location, headers: { ...cors, "Cache-Control": CACHE_CONTROL } };
  }

  const s3 = getS3Client();
  let contentType: string | undefined;
  let body: Uint8Array;
  try {
    contentType = (await s3.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }))).ContentType;
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    body = await object.Body!.transformToByteArray();
  } catch (error) {
    if (isMissing(error)) throw new RoutingError("Not Found");
    throw error;
  }
  const headers: Record<string, string> = { ...cors, "Referrer-Policy": "no-referrer", "Cache-Control": CACHE_CONTROL };
  if (DOCUMENT_EXTENSIONS.includes(extension)) {
    // SecureHeaders' own CSP is opted out of for these.
    headers["Content-Security-Policy"] = contentSecurityPolicy(
      `${input.urlOptions.protocol}://${input.urlOptions.host}`,
      originOf(config.s3Endpoint),
    );
  }
  return { status: 200, body, contentType: contentType ?? "", headers, paramsRead: true };
}

registerMutations(
  { method: "GET", pattern: "/d/:id/play/:grant", skipForgeryProtection: true, run: show },
  { method: "GET", pattern: "/d/:id/play/:grant/*path", skipForgeryProtection: true, run: show },
);
