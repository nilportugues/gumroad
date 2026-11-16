// Api::Internal::Admin::LicensesController#lookup. The purchase is serialized as in PurchasesController, so one charged through Stripe
// hands back (Radar::ChargeRiskLevelService asks Stripe for its risk level).
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { selectRows } from "../../models/sql.ts";
import { NotPortedError } from "../../models/user.ts";

import { failure, isBlank, jsonRendered, timeJson } from "./base.ts";
import { type PurchaseRow, serializePurchases } from "./purchases.ts";
import { defineAdminRoute } from "./registry.ts";

const SOURCE = "app/controllers/api/internal/admin/licenses_controller.rb";

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/licenses/lookup",
  run: async (admin) => {
    const key = admin.params.license_key;
    if (isBlank(key)) return failure("license_key is required", 400);
    // A list of one key is an IN of one, the same match; a longer list has no recorded order for the row find_by takes, and a number
    // compares as one in SQL.
    const serial = Array.isArray(key) && key.length === 1 ? key[0] : key;
    if (typeof serial !== "string") throw new NotPortedError("a license_key that is not a single text", SOURCE);
    const license = await db.license.findFirst({ where: { serial }, orderBy: { id: "asc" } });
    if (license === null) return failure("License not found", 404);

    const [purchase] =
      license.purchase_id === null
        ? []
        : await selectRows<PurchaseRow>(Prisma.sql`SELECT * FROM purchases WHERE id = ${license.purchase_id} LIMIT 1`);
    const linkId = license.link_id ?? purchase?.link_id ?? null;
    const product =
      linkId === null
        ? null
        : await db.link.findUnique({ where: { id: BigInt(linkId) }, select: { id: true, name: true } });
    const [serialized] = purchase === undefined ? [null] : await serializePurchases([purchase]);

    return jsonRendered({
      success: true,
      license: {
        email: purchase?.email ?? null,
        product_id: product === null ? null : encryptNumeric(Number(product.id)).toString(),
        product_name: product?.name ?? null,
        purchase_id: purchase === undefined ? null : encryptNumeric(Number(purchase.id)).toString(),
        uses: license.uses,
        enabled: license.disabled_at === null,
        disabled: license.disabled_at !== null,
        created_at: timeJson(license.created_at),
      },
      purchase: serialized,
      uses: license.uses,
    });
  },
});
