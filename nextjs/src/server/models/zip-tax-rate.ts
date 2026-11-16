// Port of app/models/zip_tax_rate.rb: flags, Deletable and validations. Not ported: the
// json_data accessors invoice_sales_tax_id and applicable_years (attr_json_data_accessor is not
// in the runtime yet); see models/README.md.
import type { ZipTaxRate } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { deletable } from "./concerns/deletable.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesLengthOf, validatesPresenceOf } from "./runtime/validators.ts";

export const ZIP_TAX_RATES = "zip_tax_rates";

// Bit positions are persisted data: never renumber. `opt_out_eligible` is is_seller_responsible.
export const ZipTaxRateFlags = defineFlags(ZIP_TAX_RATES, { 1: "is_seller_responsible", 2: "is_epublication_rate" }, { queryMode: "bit_operator" });

export const ZipTaxRates = defineModel<ZipTaxRate>({
  rubyClass: "ZipTaxRate",
  prismaModel: "ZipTaxRate",
  delegate: (tx) => tx.zipTaxRate as never,
  validations: [validatesPresenceOf<ZipTaxRate>(["combined_rate"]), validatesLengthOf<ZipTaxRate>(["country"], { is: 2 })],
});

export const ZipTaxRateDeletable = deletable(ZipTaxRates);
