// Port of app/models/taxonomy_stat.rb for UpdateTaxonomyStatsJob: the required taxonomy.
import type { TaxonomyStat } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";

export const TAXONOMY: BelongsTo = {
  name: "taxonomy",
  foreignKey: "taxonomy_id",
  targetTable: "taxonomies",
  targetModel: "Taxonomy",
};

export const TaxonomyStats = defineModel<TaxonomyStat>({
  rubyClass: "TaxonomyStat",
  prismaModel: "TaxonomyStat",
  delegate: (tx) => tx.taxonomyStat as never,
  validations: [belongsToRequired<TaxonomyStat>(TAXONOMY)],
});
