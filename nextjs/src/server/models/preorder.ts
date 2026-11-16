// The slice of app/models/preorder.rb that moving a guest purchase to a new account runs: `preorder.purchaser = user; preorder.save!`. The
// state machine and the charge paths are not ported; the validations are `validates :preorder_link, presence: true` and
// `validates :seller, presence: true`, which load the rows the two foreign keys name.
import { Prisma, type Preorder } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import { column, selectRows, table } from "./sql.ts";

async function exists(tableName: string, id: unknown): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS present FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1`,
  );
  return rows.length > 0;
}

export const Preorders = defineModel<Preorder>({
  rubyClass: "Preorder",
  prismaModel: "Preorder",
  delegate: (tx) => tx.preorder as never,
  validations: [
    {
      name: "preorder_link presence",
      async run(record) {
        if (!(await exists("preorder_links", record.get("preorder_link_id"))))
          record.errors.add("preorder_link", "blank");
      },
    },
    {
      name: "seller presence",
      async run(record) {
        if (!(await exists("users", record.get("seller_id")))) record.errors.add("seller", "blank");
      },
    },
  ],
});
