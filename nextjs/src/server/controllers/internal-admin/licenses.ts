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
    // An array is an IN list and a number compares as one in SQL; neither is the exact match below.
    if (typeof key !== "string") throw new NotPortedError("a license_key that is not text", SOURCE);
    const license = await db.license.findFirst({ where: { serial: key }, orderBy: { id: "asc" } });
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
