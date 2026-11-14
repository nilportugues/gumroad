// UrlRedirectsController#read (GET /read/:id and /read/:id/:product_file_id): the access gate, the lookup of the book, the props
// UrlRedirectPresenter#read_page_props builds for UrlRedirects/Read, the files lifecycle writes, and the after_actions (the read
// event, then the use count). A PDF that must be stamped and an EPUB (whose reader loosens the content security policy) go to Rails.
import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { createConsumptionEvent } from "../../controllers/url-redirects/access.ts";
import {
  aliveProductFiles,
  fieldsOf,
  signedUrl,
  StorageObjectMissing,
  triggerFilesLifecycleEvents,
  type DeliveryFile,
} from "../../controllers/url-redirects/files.ts";
import { findFile } from "../../controllers/url-redirects/streaming.ts";
import { browserReadable, isEpub, mustBePdfStamped } from "../../models/product-file.ts";
import { jsonTime } from "../../presenters/mobile-serializers.ts";

import { decideAccess } from "./download-gate.ts";
import { buildGateInput, registerDownload } from "./download-page.ts";
import { load, present, type Loaded } from "./unavailable.ts";

const READ_PATH = /^\/read\/([^/.]+)(?:\/([^/.]+))?$/u;
// MediaLocation::Unit::PAGE_NUMBER
const PAGE_NUMBER_UNIT = "page_number";
export const READ_STATE_KEY = "readPageProps";

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// ProductFile#latest_media_location_for(purchase), for a PDF: the most recently consumed location when its unit fits the file.
// Two rows sharing that time come back in no defined order, so that case is Rails'.
async function latestReadingLocation(loaded: Loaded, { file }: DeliveryFile) {
  if (file.link_id === null || file.installment_id !== null || loaded.purchase === null) return null;
  const [latest, runnerUp] = await db.mediaLocation.findMany({
    where: { purchase_id: loaded.purchase.id, product_file_id: file.id },
    orderBy: { consumed_at: "desc" },
    take: 2,
  });
  if (latest === undefined) return null;
  if (runnerUp !== undefined && runnerUp.consumed_at?.getTime() === latest.consumed_at?.getTime())
    throw new HandBackToRails("media locations that share the latest consumed_at");
  if (latest.unit !== PAGE_NUMBER_UNIT) return null;
  return {
    location: latest.location,
    unit: latest.unit,
    timestamp: jsonTime(latest.consumed_at),
    ...(present(latest.epub_cfi) ? { cfi: latest.epub_cfi } : {}),
  };
}

// The file #read opens: the requested one among the redirect's files, else the product's first readable one. Anything else is a
// 404, which #read rescues into a redirect.
async function readFile(loaded: Loaded, files: DeliveryFile[], requested: string | undefined): Promise<DeliveryFile> {
  let found = requested !== undefined && present(requested) ? findFile(files, requested) : undefined;
  if (!found && loaded.product) {
    const rows = await db.productFile.findMany({
      where: { link_id: loaded.product.id, deleted_at: null },
      orderBy: { id: "asc" },
    });
    const row = rows.find(browserReadable);
    if (row) found = { file: row, s3: fieldsOf(row, loaded) };
  }
  if (!found || !browserReadable(found.file)) throw new RoutingError("Not Found");
  return found;
}

export async function readPage(token: string, productFileId: string | undefined) {
  const loaded = await load(token);
  const files = await aliveProductFiles(loaded);
  const delivery = await readFile(loaded, files, productFileId);
  const { file } = delivery;
  if (mustBePdfStamped(file)) throw new HandBackToRails("a PDF that must be stamped");
  if (isEpub(file)) throw new HandBackToRails("an EPUB");
  const fields = delivery.s3 ?? fieldsOf(file, loaded);
  if (fields === null) throw new HandBackToRails("a file that is not in S3");
  const owner = file.link_id === null ? null : await db.link.findUnique({ where: { id: file.link_id } });
  if (owner === null) throw new HandBackToRails("a file without a product");
  let readUrl: string;
  try {
    readUrl = await signedUrl(fields, { cacheGroup: "read" });
  } catch (error) {
    if (error instanceof StorageObjectMissing) throw new HandBackToRails("a file missing from storage");
    throw error;
  }
  const props = {
    read_id: encrypt(file.id),
    url: readUrl,
    url_redirect_id: encrypt(loaded.redirect.id),
    purchase_id: loaded.purchase ? encrypt(loaded.purchase.id) : null,
    product_file_id: encrypt(file.id),
    latest_media_location: await latestReadingLocation(loaded, delivery),
    title: owner.name,
    file_type: "pdf",
  };
  return { loaded, files, delivery, props };
}

async function readGate(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const match = READ_PATH.exec(chain.request.path);
  if (match === null) throw new RoutingError("Not Found");
  const token = safeDecode(match[1]!);
  const productFileId = match[2] === undefined ? undefined : safeDecode(match[2]);
  const loaded = await load(token);
  // sign_in_mobile_app_viewer needs doorkeeper.
  if (present(queryParam(chain.request, "access_token"))) throw new HandBackToRails("a mobile app token");

  const { gate } = await buildGateInput(chain, loaded, { destination: "read", isPoll: false });
  const decision = decideAccess(gate);
  if (decision.kind === "notFound") throw new RoutingError("Not Found");
  if (decision.kind === "redirect") return { halt: { status: 302, location: decision.location, rescued: true } };

  // Built before the writes, so a hand-back never follows a lifecycle write or a counted read.
  const page = await readPage(loaded.redirect.token ?? token, productFileId);
  await triggerFilesLifecycleEvents(page.files, chain.now);
  await createConsumptionEvent(page.loaded, chain.request, "read", page.delivery.file.id, chain.now);
  await registerDownload(loaded.redirect, chain);
  return { state: { [READ_STATE_KEY]: page.props } };
}

// rescue_from ActionController::RoutingError: a `read` that cannot be shown goes to the library, or the home page when signed out.
export async function readFilters(chain: Chain): Promise<FilterOutcome> {
  try {
    return await readGate(chain);
  } catch (error) {
    if (!(error instanceof RoutingError)) throw error;
    const signedIn = railsLoggedInUser(chain.auth.context) !== null;
    return { halt: { status: 302, location: signedIn ? "/library" : "/", rescued: true } };
  }
}
