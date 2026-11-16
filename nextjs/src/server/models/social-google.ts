// User.find_or_create_for_google_oauth2 and User#google_picture_url (app/models/concerns/user/social_google.rb). Unlike Apple's, every case here
// runs after Google's code was exchanged (the auth hash comes from the userinfo answer), so nothing is handed back: a shape this port does not
// reproduce is an error for the caller to turn into the failure action.
import { db } from "../../lib/db.ts";
import { isBlank } from "../html/text-helper.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { rubyUriParse, rubyUriToString } from "../infra/ruby-uri.ts";

import { assignAvatar, basename, MAXIMUM_AVATAR_FILE_SIZE } from "./active-storage-attach.ts";
import { attachGuestPurchases } from "./guest-purchase-attach.ts";
import { downloadPicture, escapeUri } from "./profile-picture.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { confirmUser, isBlockedSignup } from "./social-apple.ts";
import {
  type GoogleAuthData,
  isDeletedPlaceholderEmail,
  reportedGoogleEmail,
  verifiedGoogleEmail,
} from "./social-google-auth.ts";
import { avatarAttached, friendlyToken } from "./social-twitter.ts";
import { isDeadlocked, isLockWaitTimeout } from "./sql.ts";
import { revokeUnprovenAccess } from "./user-adoption.ts";
import { invalidateActiveSessions } from "./user-risk.ts";
import {
  findUser,
  INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX,
  isConfirmed,
  isDeleted,
  isValidEmailFormat,
  setPassword,
  type UserRecord,
  Users,
} from "./user.ts";

const PROVIDER = "google_oauth2";
const LOCK_RETRIES = 2;
const PICTURE_TIMEOUT_MS = 5000;
const AVATAR_TYPES = ["png", "jpg", "jpeg"];

const users = {
  alive: (where: { google_uid?: string; email?: string }) =>
    db.user.findFirst({ where: { ...where, deleted_at: null }, orderBy: { id: "asc" } }),
  any: (where: { google_uid?: string; email?: string }) => db.user.findFirst({ where, orderBy: { id: "asc" } }),
};

async function load(row: { id: bigint } | null): Promise<UserRecord | null> {
  return row === null ? null : findUser(row.id);
}

// User#google_picture_url: the picture at its larger size is downloaded and assigned as the avatar. Every failure along the way (an address
// that does not parse, a refused download, a type that is no PNG or JPEG, the attach itself) leaves the user without one.
async function googlePictureUrl(user: UserRecord, data: GoogleAuthData, now: () => Date): Promise<void> {
  try {
    const image = data.info.image;
    if (image === undefined || image === "") return;
    const url = rubyUriToString(rubyUriParse(escapeUri(image.replaceAll("s96-c", "s400-c"))));
    const download = await downloadPicture(url, PICTURE_TIMEOUT_MS);
    if (download === null || isBlank(download.contentType)) return;
    if (!AVATAR_TYPES.some((type) => download.contentType.includes(type))) return;
    if (download.bytes.length > MAXIMUM_AVATAR_FILE_SIZE) return;
    await assignAvatar(
      user,
      { bytes: download.bytes, filename: basename(url), declaredType: download.contentType },
      { now },
    );
  } catch {
    // rescue StandardError
  }
}

// User.query_google. A RecordInvalid from the save is the caller's nil user.
async function queryGoogle(
  user: UserRecord,
  data: GoogleAuthData,
  now: () => Date,
  newUser: boolean,
): Promise<UserRecord> {
  const email = verifiedGoogleEmail(data);

  // A sign-in that brings the first Google identity for a row with no provider is adopting it, so the password and the sessions the signup
  // left behind go with it.
  if (isBlank(user.get("provider")) && isBlank(user.get("google_uid"))) {
    await setPassword(user, friendlyToken());
    await invalidateActiveSessions(user, now);
    if (!isConfirmed(user)) await revokeUnprovenAccess(user, now);
  }

  if (user.get("google_uid") === null || user.get("google_uid") === undefined) user.set("google_uid", data.uid);

  const name = data.info.name;
  if (isBlank(user.get("name")) && name !== undefined && !isBlank(name)) {
    if (typeof name !== "string") throw new TypeError("undefined method 'gsub' for the name Google reported");
    user.set("name", name.replace(new RegExp(INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX.source, "gu"), ""));
  }

  if (newUser && isValidEmailFormat(email)) user.set("email", email);

  if (!user.persisted || !(await avatarAttached(BigInt(String(user.get("id"))))))
    await googlePictureUrl(user, data, now);

  user.ivars.skip_confirmation_notification = true;
  await Users.saveBang(user, { now });
  // Google proves only the current address, so a pending change waits for its emailed link.
  if (!isConfirmed(user) && isBlank(user.get("unconfirmed_email"))) await confirmUser(user, now);
  return user;
}

async function liveUserForEmail(data: GoogleAuthData): Promise<UserRecord | null> {
  const email = verifiedGoogleEmail(data);
  return isValidEmailFormat(email) ? load(await users.alive({ email: email! })) : null;
}

async function findOrCreate(data: GoogleAuthData, now: () => Date): Promise<UserRecord | null> {
  if (data.uid === null || isBlank(data.uid)) {
    notifyError("Google OAuth2 data is missing a uid");
    return null;
  }

  // The redirect below copies a deleted row's uid onto the live account without clearing it on the deleted row, so a live match must win.
  let user = await load((await users.alive({ google_uid: data.uid })) ?? (await users.any({ google_uid: data.uid })));

  // A closed account keeps its google_uid after support frees its email to a placeholder: prefer the live account holding the Google address.
  if (user !== null && isDeleted(user) && isDeletedPlaceholderEmail(user.get("email"))) {
    const live = await liveUserForEmail(data);
    if (live !== null) user = live;
  }

  if (user !== null && isDeleted(user) && isDeletedPlaceholderEmail(user.get("email"))) {
    return (await liveUserForEmail(data)) ?? user;
  }

  if (user !== null) return queryGoogle(user, data, now, false);

  const email = verifiedGoogleEmail(data);
  // An address Google has not verified must not create an account that would then hold the identity.
  if (email === null && !isBlank(reportedGoogleEmail(data))) return null;

  if (isValidEmailFormat(email)) user = await load(await users.any({ email: email! }));
  if (user !== null) return queryGoogle(user, data, now, false);

  user = Users.build({});
  user.set("provider", PROVIDER);
  await setPassword(user, friendlyToken());
  const created = await queryGoogle(user, data, now, true);
  const address = created.get("email");
  if (typeof address === "string" && !isBlank(address))
    await attachGuestPurchases(address, BigInt(String(created.get("id"))), now);
  return created;
}

// `rescue ActiveRecord::Deadlocked, ActiveRecord::LockWaitTimeout` with `retry if retries <= 2`: the attempt is made again twice, then the
// last error is handed to `giveUp` and the answer is nil.
export async function retryOnLock<T>(attempt: () => Promise<T>, giveUp: (error: unknown) => void): Promise<T | null> {
  for (let retries = 0; ; retries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isDeadlocked(error) && !isLockWaitTimeout(error)) throw error;
      if (retries >= LOCK_RETRIES) {
        giveUp(error);
        return null;
      }
    }
  }
}

// find_or_create_for_google_oauth2: a RecordInvalid is nil, reported unless a signup gate refused it.
export async function findOrCreateForGoogleOauth2(data: GoogleAuthData, now: () => Date): Promise<UserRecord | null> {
  try {
    return await retryOnLock(() => findOrCreate(data, now), notifyError);
  } catch (error) {
    if (!(error instanceof RecordInvalid)) throw error;
    if (!isBlockedSignup(error)) notifyError(error);
    return null;
  }
}
