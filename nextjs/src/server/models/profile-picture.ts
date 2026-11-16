// The profile picture a login or link brings: User#twitter_picture_url (app/modules/user/social_twitter.rb) and the download half of
// User#google_picture_url (app/models/concerns/user/social_google.rb). Both rescue StandardError and answer nil, so a picture that cannot be
// fetched leaves the user without one; a picture that can is handed to `attachAvatar`.
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";

import { type AvatarPicture, attachAvatar, basename } from "./active-storage-attach.ts";
import type { UserRecord } from "./user.ts";

const TWITTER = "https://api.twitter.com";
const TWITTER_USER_AGENT = "TwitterRubyGem/8.2.0";
const HTTP_SUCCESS_MINIMUM = 200;
const HTTP_SUCCESS_LIMIT = 300;
// Twitter::Error::ERRORS (400..504) raise; the other statuses return a body the lookups below find nothing in.
const OPEN_URI_DEFAULT_TYPE = "application/octet-stream";

// URI::DEFAULT_PARSER.escape: everything outside RFC 2396's unreserved and reserved set (so `%` and `#` too) is percent-encoded.
const SAFE = /[-_.!~*'()a-zA-Z\d;/?:@&=+$,[\]]/u;
export function escapeUri(value: string): string {
  return Array.from(value, (char) =>
    SAFE.test(char)
      ? char
      : Array.from(Buffer.from(char, "utf8"), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(
          "",
        ),
  ).join("");
}

export type Download = { bytes: Buffer; contentType: string };

// `URI.open(url)`: http and https only (anything else is a file path Ruby cannot open), redirects followed, a non-2xx answer an error.
// OpenURI's content_type is the media type of the header without its parameters, lower-cased.
export async function downloadPicture(url: string, timeoutMs?: number): Promise<Download | null> {
  if (!/^https?:\/\//iu.test(url)) return null;
  try {
    const response = await outboundFetch(
      url,
      timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (response.status < HTTP_SUCCESS_MINIMUM || response.status >= HTTP_SUCCESS_LIMIT) return null;
    const header = response.headers.get("content-type");
    const type = header?.split(";")[0]?.trim().toLowerCase();
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: type && /^[^/\s]+\/[^/\s]+$/u.test(type) ? type : OPEN_URI_DEFAULT_TYPE,
    };
  } catch {
    return null;
  }
}

export const pictureFile = (url: string, download: Download): AvatarPicture => ({
  bytes: download.bytes,
  filename: basename(url),
});

// `$twitter.user(id)` on a client with consumer credentials only: a bearer token (client credentials grant), then users/show. The gem keeps
// the token for the life of the process; this asks for a new one each time, which only costs a call.
async function twitterProfileImage(twitterUserId: string): Promise<string | null> {
  try {
    const key = getConfig("TWITTER_APP_ID");
    const secret = getConfig("TWITTER_APP_SECRET");
    const tokenAnswer = await outboundFetch(`${TWITTER}/oauth2/token`, {
      method: "POST",
      headers: {
        "user-agent": TWITTER_USER_AGENT,
        accept: "*/*",
        authorization: `Basic ${Buffer.from(`${key ?? ""}:${secret ?? ""}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenAnswer.ok) return null;
    const token = ((await tokenAnswer.json()) as { access_token?: unknown }).access_token;
    const profile = await outboundFetch(
      `${TWITTER}/1.1/users/show.json?user_id=${encodeURIComponent(String(Number.parseInt(twitterUserId, 10) || 0))}`,
      { headers: { "user-agent": TWITTER_USER_AGENT, authorization: `Bearer ${String(token)}` } },
    );
    if (!profile.ok) return null;
    const url = ((await profile.json()) as { profile_image_url_https?: unknown }).profile_image_url_https;
    // Twitter::Profile#profile_image_url: the https address with its scheme made insecure.
    return typeof url === "string" ? url.replace(/^https/iu, "http") : null;
  } catch {
    return null;
  }
}

// User#twitter_picture_url
export async function twitterPictureUrl(user: UserRecord, now: () => Date): Promise<void> {
  const twitterUserId = user.get("twitter_user_id");
  const image = await twitterProfileImage(typeof twitterUserId === "string" ? twitterUserId : "");
  if (image === null) return;
  const url = escapeUri(image.replaceAll("_normal.", "_400x400."));
  const download = await downloadPicture(url);
  if (download === null) return;
  await attachAvatar(user, pictureFile(url, download), { now });
}
