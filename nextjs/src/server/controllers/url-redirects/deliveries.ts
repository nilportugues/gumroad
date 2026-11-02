// UrlRedirectsController's file deliveries: #show (/r/:id), #download_product_files, #download_archive (/zip/:id) and #media_urls.
// Dispatched from public-handlers.ts (`url_redirects`); each runs the controller's before_actions, the action and its after_actions.
import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { HandBackToRails, RoutingError, type ActionContext, type ActionResult, type Rendered } from "../application-controller.ts";
import { json } from "../json-actions.ts";
import { parseQuery } from "../rails-query.ts";
import { queryParam, isPresent } from "../rails-request.ts";
import { requestFormat } from "../rails-params.ts";
import { appDomainUrl, checkPermissions, createConsumptionEvent, loadRedirect, registerDownload, requireSellerForTestPurchase, type Loaded } from "./access.ts";
import { aliveProductFiles, displayFilename, hlsPlaylistOrSmilPath, isFileDownloadable, signedLocationForFile, signedUrl, StorageObjectMissing, triggerFilesLifecycleEvents, type DeliveryFile } from "./files.ts";
import { isListenable, isStreamable, mustBePdfStamped, s3Fields } from "../../models/product-file.ts";

const FOUND = 302;
const NOT_FOUND = 404;
const NO_LONGER_AVAILABLE_WARNING = "The file is no longer available. Please contact the seller.";

const found = (location: string, extra: { cookies?: string[]; flash?: Record<string, string> } = {}): ActionResult => ({ status: FOUND, location, ...extra });
const downloadPageUrl = (token: string) => appDomainUrl(`/d/${token}`);
const jsonFormat = (action: ActionContext, path: string) => path.endsWith(".json") || requestFormat(action.request) === "json";
// e404_json
const notFoundJson = (): Rendered => json({ success: false, error: "Not found" }, NOT_FOUND);

const asList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []);

// ProductFile.by_external_ids: ids that do not decrypt match nothing.
const byExternalIds = (files: DeliveryFile[], externalIds: string[]) => {
  const ids = new Set(externalIds.map((id) => decrypt(id)).filter((id): id is number => id !== null).map(BigInt));
  return files.filter(({ file }) => ids.has(file.id));
};

type Context = { loaded: Loaded; action: ActionContext; token: string; now: Date };

async function viaPermissions(token: string, action: ActionContext, actionName: string): Promise<{ context: Context } | { halted: ActionResult }> {
  const loaded = await loadRedirect(token);
  const halted = await checkPermissions({ loaded, action, actionName });
  return halted ? { halted } : { context: { loaded, action, token, now: new Date() } };
}

// #show
async function show(token: string, action: ActionContext): Promise<ActionResult> {
  const gate = await viaPermissions(token, action, "show");
  if ("halted" in gate) return gate.halted;
  const { loaded, now } = gate.context;
  const files = await aliveProductFiles(loaded);

  let location: string;
  try {
    // UrlRedirect#redirect_or_s3_location
    const [only] = files;
    location = files.length === 1 && only ? ((await signedLocationForFile(only)) ?? downloadPageUrl(token)) : downloadPageUrl(token);
  } catch (error) {
    if (!(error instanceof StorageObjectMissing)) throw error;
    return found(downloadPageUrl(token), { flash: { warning: NO_LONGER_AVAILABLE_WARNING } });
  }
  await triggerFilesLifecycleEvents(files, now);
  // after_actions run last-declared first: the consumption event, then the use counter and the cookie.
  await createConsumptionEvent(loaded, action.request, "download", null, now);
  const cookie = await registerDownload(loaded.redirect, now);
  return found(location, { cookies: [cookie] });
}

// #download_product_files
async function downloadProductFiles(token: string, action: ActionContext): Promise<ActionResult> {
  const gate = await viaPermissions(token, action, "download_product_files");
  if ("halted" in gate) return gate.halted;
  const { loaded, now } = gate.context;
  const asJson = jsonFormat(action, action.request.path);
  const files = byExternalIds(await aliveProductFiles(loaded), asList(parseQuery(action.request.queryString).product_file_ids));
  if (files.length === 0 || !(await Promise.all(files.map((delivery) => isFileDownloadable(loaded, delivery)))).every(Boolean)) throw new RoutingError("Not Found");

  try {
    if (asJson) {
      const listed = [];
      for (const delivery of files) listed.push({ url: await signedLocationForFile(delivery), filename: displayFilename(delivery) });
      return json({ files: listed });
    }
    const [first] = files;
    const location = (await signedLocationForFile(first!))!;
    // Non-JSON requests pass a single product file: the consumption event follows the redirect.
    await createConsumptionEvent(loaded, action.request, "download", first!.file.id, now);
    return found(location);
  } catch (error) {
    if (!(error instanceof StorageObjectMissing)) throw error;
    if (asJson) return json({ error: "The file is no longer available." }, NOT_FOUND);
    return found(downloadPageUrl(token), { flash: { warning: NO_LONGER_AVAILABLE_WARNING } });
  }
}

// #download_archive: the product's ready ZIP. Folder archives rebuild through a job and bundle archives lock rows: both stay with Rails.
async function downloadArchive(token: string, action: ActionContext): Promise<ActionResult> {
  const gate = await viaPermissions(token, action, "download_archive");
  if ("halted" in gate) return gate.halted;
  const { loaded, now } = gate.context;
  const folderId = queryParam(action.request, "folder_id");
  if (isPresent(folderId)) throw new HandBackToRails("a folder archive");
  const { purchase, product, redirect } = loaded;
  if (purchase && PurchaseFlags.isSet(purchase.flags, "is_bundle_purchase")) throw new HandBackToRails("a bundle archive");
  if (redirect.preorder_id !== null) throw new HandBackToRails("a url redirect of a preorder");

  const files = await aliveProductFiles(loaded);
  // UrlRedirect#entity_archive: the product's latest ready archive, none when it holds stampable PDFs.
  const archive = product === null || files.some(({ file }) => mustBePdfStamped(file)) ? null : await db.productFilesArchive.findFirst({ where: { link_id: product.id, folder_id: null, deleted_at: null, product_files_archive_state: "ready" }, orderBy: { id: "desc" } });
  if (jsonFormat(action, action.request.path)) {
    const url = archive ? `${action.request.protocol}${action.request.hostWithPort}/zip/${token}` : null;
    return json({ url });
  }
  if (archive === null) throw new RoutingError("Not Found");
  const fields = s3Fields(archive.url, product?.user_id == null ? null : encrypt(product.user_id));
  if (fields === null) throw new HandBackToRails("an archive that is not in S3");
  try {
    const location = await signedUrl(fields);
    await createConsumptionEvent(loaded, action.request, "download_all", null, now);
    return found(location);
  } catch (error) {
    if (!(error instanceof StorageObjectMissing)) throw error;
    throw new HandBackToRails("an archive missing from storage");
  }
}

// #media_urls
async function mediaUrls(token: string, action: ActionContext): Promise<ActionResult> {
  const loaded = await loadRedirect(token);
  if (requireSellerForTestPurchase(loaded, action) === "forbidden") return jsonFormat(action, action.request.path) ? notFoundJson() : (() => { throw new RoutingError("Not Found"); })();
  const requested = asList(parseQuery(action.request.queryString).file_ids);
  if (requested.length === 0) return json({});
  const result: Record<string, string[]> = {};
  try {
    for (const delivery of byExternalIds(await aliveProductFiles(loaded), requested)) {
      const urls: string[] = [];
      if (isStreamable(delivery.file)) urls.push(await hlsPlaylistOrSmilPath(token, delivery));
      if (isListenable(delivery.file) || isStreamable(delivery.file)) urls.push((await signedLocationForFile(delivery))!);
      result[encryptId(delivery)] = urls;
    }
  } catch (error) {
    if (error instanceof StorageObjectMissing) throw new Error("Aws::S3::Errors::NotFound");
    throw error;
  }
  return json(result);
}

const encryptId = ({ file }: DeliveryFile) => encrypt(file.id);

const ROUTES: { pattern: RegExp; run: (token: string, action: ActionContext) => Promise<ActionResult> }[] = [
  { pattern: /^\/r\/([^/.]+)\/product_files(?:\.json)?$/u, run: downloadProductFiles },
  { pattern: /^\/r\/([^/.]+)$/u, run: show },
  { pattern: /^\/zip\/([^/.]+)(?:\.json)?$/u, run: downloadArchive },
  { pattern: /^\/media_urls\/([^/.]+)(?:\.json)?$/u, run: mediaUrls },
];

export async function urlRedirectsAction(action: ActionContext): Promise<ActionResult> {
  const { path } = action.request;
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (match) return route.run(decodeURIComponent(match[1]!), action);
  }
  throw new RoutingError("Not Found");
}
