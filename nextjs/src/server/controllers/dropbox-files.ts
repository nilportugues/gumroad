// DropboxFilesController (app/controllers/dropbox_files_controller.rb): the Dropbox chooser of the product editor.
import { Prisma, type DropboxFile, type Link, type User } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import {
  createDropboxFile,
  dropboxFileJson,
  findDropboxFileForUser,
  listDropboxFiles,
  transitionDropboxFile,
} from "../models/dropbox-file.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { authorize } from "../policies/authorize.ts";
import { dropboxFilesPolicy } from "../policies/s3-utility.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { json, jsonAction, jsonSellerGuard } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

// `params.permit(:id, :bytes, :name, :link, :icon, :link_id)`: scalars only, the rest is dropped
function scalar(value: unknown): string | number | boolean | null | undefined {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? (value as string | number | boolean | null)
    : undefined;
}

// `fetch_product_and_enforce_ownership if permitted_params[:link_id]`: `Link.fetch(link_id, user: current_seller) || e404`
async function fetchProduct(seller: User, linkId: unknown): Promise<Link> {
  if (typeof linkId !== "string") throw new NotPortedError("Link.fetch", "a link_id that is not a string");
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${linkId} LIMIT 1`,
  );
  if (!row) throw new RoutingError("Not Found");
  return castRow<Link>("Link", row);
}

const wantsLink = (value: unknown) => value !== undefined && value !== null && value !== "" && value !== false;

async function serialize(record: DropboxFile, seller: User, link: Link | null) {
  return dropboxFileJson(record, {
    userExternalId: record.user_id === null ? null : (seller.external_id ?? null),
    linkExternalId: link === null ? (record.link_id === null ? null : encrypt(record.link_id)) : encrypt(link.id),
  });
}

export function dropboxIndexRoute(request: Request) {
  return jsonAction(request, {}, {}, async (input) => {
    const refused = await jsonSellerGuard(input, (context) => authorize(dropboxFilesPolicy.index, context));
    if (refused) return refused;
    const seller = input.context.currentSeller!;
    const linkId = scalar(input.params.link_id);
    const link = wantsLink(linkId) ? await fetchProduct(seller, linkId) : null;
    const files = await listDropboxFiles(seller.id, link === null ? null : link.id);
    return json({ dropbox_files: await Promise.all(files.map((file) => serialize(file, seller, null))) });
  });
}

registerMutations(
  {
    method: "POST",
    pattern: "/dropbox_files/create",
    formats: ["html", "json"],
    run: async (input: MutationInput): Promise<ActionResult> => {
      const refused = await jsonSellerGuard(input, (context) => authorize(dropboxFilesPolicy.create, context));
      if (refused) return refused;
      const seller = input.context.currentSeller!;
      const linkId = scalar(input.params.link_id);
      // create_with_file_info saves before the controller looks the product up, so Rails leaves a row behind when it is not
      // found: that request is Rails'.
      let link: Link | null = null;
      if (wantsLink(linkId)) {
        try {
          link = await fetchProduct(seller, linkId);
        } catch (error) {
          if (error instanceof RoutingError) throw new HandBackToRails("a product that is not the seller's");
          throw error;
        }
      }
      const record = await createDropboxFile(
        { name: scalar(input.params.name), bytes: scalar(input.params.bytes), link: scalar(input.params.link) },
        Number(seller.id),
        link === null ? null : Number(link.id),
      );
      return json({ dropbox_file: await serialize(record.attributes as DropboxFile, seller, link) });
    },
  },
  {
    method: "POST",
    pattern: "/dropbox_files/cancel_upload/:id",
    formats: ["html", "json"],
    run: async (input: MutationInput): Promise<ActionResult> => {
      const refused = await jsonSellerGuard(input, (context) => authorize(dropboxFilesPolicy.cancel_upload, context));
      if (refused) return refused;
      const seller = input.context.currentSeller!;
      const record = await findDropboxFileForUser(seller.id, input.routeParams.id!);
      if (!record) return json({ success: false });
      const state = record.get("state");
      // successfully_uploaded? → mark_deleted!, in_progress? → mark_cancelled!
      if (state === "successfully_uploaded") await transitionDropboxFile(record, "deleted");
      else if (state === "in_progress") await transitionDropboxFile(record, "cancelled");
      return json({ dropbox_file: await serialize(record.attributes as DropboxFile, seller, null), success: true });
    },
  },
);
