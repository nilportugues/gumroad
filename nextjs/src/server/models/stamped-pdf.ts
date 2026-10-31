// Port of app/models/stamped_pdf.rb. Not ported: S3Retrievable (has_s3_fields :url),
// CdnDeletable#mark_deleted_from_cdn, and #user (needs ProductFile#link).
import { Prisma, type StampedPdf } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { setAssociation, validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, columnIn, selectRows, table } from "./sql.ts";

export const STAMPED_PDFS = "stamped_pdfs";

const urlRedirect: BelongsTo = { name: "url_redirect", foreignKey: "url_redirect_id", targetTable: "url_redirects", targetModel: "UrlRedirect" };
const productFile: BelongsTo = { name: "product_file", foreignKey: "product_file_id", targetTable: "product_files", targetModel: "ProductFile" };

export const StampedPdfs = defineModel<StampedPdf>({
  rubyClass: "StampedPdf",
  prismaModel: "StampedPdf",
  delegate: (tx) => tx.stampedPdf as never,
  // validates_presence_of :url_redirect, :product_file, :url
  validations: [
    validatesAssociationPresence<StampedPdf>(urlRedirect),
    validatesAssociationPresence<StampedPdf>(productFile),
    validatesPresenceOf<StampedPdf>(["url"]),
  ],
});

export const StampedPdfDeletable = deletable(StampedPdfs);

export const aliveScope = () => Prisma.sql`${column(STAMPED_PDFS, "deleted_at")} IS NULL`;

// `includes(:url_redirect, :product_file)`: one query per association over the distinct non-nil
// foreign keys, caching nil where the target is gone.
export async function preloadAssociations(records: ModelRecord<StampedPdf>[]): Promise<void> {
  for (const association of [urlRedirect, productFile]) {
    const key = association.foreignKey as keyof StampedPdf & string;
    const ids = [...new Map(records.map((r) => r.get(key)).filter((id) => id != null).map((id) => [String(id), id])).values()];
    const byId = new Map<string, Record<string, unknown>>();
    if (ids.length > 0) {
      const T = association.targetTable;
      const rows = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT ${Prisma.raw(`\`${T}\`.*`)} FROM ${table(T)} WHERE ${columnIn(T, "id", ids)}`);
      for (const row of rows) byId.set(String(row.id), castRow(association.targetModel, row));
    }
    for (const record of records) {
      const id = record.get(key);
      setAssociation(record, association.name, id, id == null ? null : (byId.get(String(id)) ?? null));
    }
  }
}
