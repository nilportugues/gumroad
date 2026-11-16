// Turns prisma/relations/associations.json (the ActiveRecord reflection dump written by
// extract-associations.rb) into Prisma relation fields plus a manifest of every association.
//
// Prisma models only plain foreign-key relations whose key types match exactly. Everything else
// (polymorphic, `as:`, `through:`, has_and_belongs_to_many, Int keys pointing at BigInt ids, ...)
// stays in the manifest with a reason, and model services load it by hand.

export type RubyAssociation = {
  macro: "belongs_to" | "has_many" | "has_one" | "has_and_belongs_to_many";
  name: string;
  owner: string;
  via: string | null;
  options: Record<string, unknown>;
  scope: string | null;
  extension: boolean;
  defined_at: string;
  polymorphic: boolean;
  through: string | null;
  class_name: string | null;
  klass: string | null;
  foreign_key: string | null;
  foreign_type: string | null;
  primary_key: string;
  association_foreign_key?: string;
  join_table?: string | null;
};

export type RubyModel = {
  name: string;
  external: boolean;
  files: string[];
  superclass: string | null;
  abstract: boolean;
  base_class: string | null;
  table_name: string | null;
  includes: string[];
  associations: RubyAssociation[];
};

export type TableInfo = {
  name: string;
  model: string;
  ignored: boolean;
  columns: Map<string, { type: string; optional: boolean }>;
  uniqueColumns: Set<string>;
};

export type ManifestEntry = {
  macro: RubyAssociation["macro"];
  name: string;
  defined_at: string;
  scope: string | null;
  // The Prisma field that loads this association's rows. It never applies `scope`, and for
  // "alias" it is a differently named field over the same key (e.g. `alive_products` → `links`).
  prisma: { field: string } | null;
  status: "modeled" | "alias" | "polymorphic" | "polymorphic_inverse" | "through" | "habtm" | "unsupported";
  reason?: string;
  target_model: string | null;
  target_table: string | null;
  foreign_key: string | null;
  foreign_type: string | null;
  primary_key: string;
  through?: string | null;
  source?: string | null;
  source_type?: string | null;
  join_table?: string | null;
  association_foreign_key?: string;
  dependent?: string | null;
};

export type Manifest = Record<string, { table: string | null; model: string | null; superclass: string | null; base_class: string | null; associations: ManifestEntry[] }>;

type Relation = {
  ownerTable: string; // holds the foreign key
  fk: string;
  targetTable: string;
  pk: string;
  belongsTo: { field: string; synthesized: boolean };
  inverse: { field: string; kind: "list" | "optional"; synthesized: boolean; hasOneAsList: boolean };
};

export function rubyClassToModelName(rubyClass: string): string {
  return rubyClass.replaceAll("::", "");
}

export function buildRelations(tables: Map<string, TableInfo>, models: RubyModel[]) {
  const byClass = new Map(models.map((m) => [m.name, m]));
  const tableOf = (klass: string | null) => (klass ? (byClass.get(klass)?.table_name ?? null) : null);
  const fieldNames = new Map<string, Set<string>>();
  for (const t of tables.values()) fieldNames.set(t.name, new Set([...t.columns.keys(), "id"]));
  const claim = (table: string, field: string) => {
    const names = fieldNames.get(table)!;
    if (names.has(field)) return false;
    names.add(field);
    return true;
  };

  const relations: Relation[] = [];
  const manifest: Manifest = {};
  const entryFor = new Map<RubyAssociation, ManifestEntry>();

  for (const m of models) {
    manifest[m.name] = {
      table: m.table_name,
      model: m.table_name ? (tables.get(m.table_name)?.model ?? null) : null,
      superclass: m.superclass,
      base_class: m.base_class,
      associations: m.associations.map((a) => {
        const entry: ManifestEntry = {
          macro: a.macro,
          name: a.name,
          defined_at: a.defined_at,
          scope: a.scope,
          prisma: null,
          status: "unsupported",
          target_model: a.klass,
          target_table: tableOf(a.klass),
          foreign_key: a.foreign_key,
          foreign_type: a.foreign_type,
          primary_key: a.primary_key,
          dependent: (a.options.dependent as string | undefined) ?? null,
        };
        if (a.through) Object.assign(entry, { through: a.through, source: a.options.source ?? null, source_type: a.options.source_type ?? null });
        if (a.macro === "has_and_belongs_to_many") Object.assign(entry, { join_table: a.join_table, association_foreign_key: a.association_foreign_key });
        entryFor.set(a, entry);
        return entry;
      }),
    };
  }

  // Returns why Prisma cannot model owner.fk -> target.pk, or null when it can.
  const blocker = (ownerTable: string | null, fk: string | null, targetTable: string | null, pk: string): string | null => {
    if (!ownerTable || !targetTable) return "no table for one side";
    const owner = tables.get(ownerTable);
    const target = tables.get(targetTable);
    if (!owner || !target) return "table missing from db/schema.rb";
    if (owner.ignored || target.ignored) return "model is @@ignore'd (no primary key)";
    const fkCol = fk ? owner.columns.get(fk) : undefined;
    if (!fk || !fkCol) return `no column ${ownerTable}.${fk}`;
    const pkCol = target.columns.get(pk);
    if (!pkCol) return `no column ${targetTable}.${pk}`;
    if (!target.uniqueColumns.has(pk)) return `${targetTable}.${pk} is not unique`;
    if (fkCol.type !== pkCol.type) return `type mismatch: ${ownerTable}.${fk} is ${fkCol.type}, ${targetTable}.${pk} is ${pkCol.type}`;
    return null;
  };

  const key = (ownerTable: string, fk: string, targetTable: string, pk: string) => `${ownerTable}.${fk}->${targetTable}.${pk}`;
  const byKey = new Map<string, Relation>();
  const assocs = models.filter((m) => m.table_name).flatMap((m) => m.associations.map((a) => ({ m, a, table: m.table_name! })));

  // belongs_to first: the side with the foreign key decides whether a relation exists.
  for (const { a, table } of assocs) {
    const entry = entryFor.get(a)!;
    if (a.macro !== "belongs_to") continue;
    if (a.polymorphic) {
      entry.status = "polymorphic";
      continue;
    }
    const target = tableOf(a.klass);
    const why = blocker(table, a.foreign_key, target, a.primary_key);
    if (why) {
      entry.reason = why;
      continue;
    }
    const k = key(table, a.foreign_key!, target!, a.primary_key);
    const existing = byKey.get(k);
    if (existing) {
      entry.prisma = { field: existing.belongsTo.field };
      entry.status = existing.belongsTo.field === a.name ? "modeled" : "alias";
      continue;
    }
    if (!claim(table, a.name)) {
      entry.reason = `field name ${a.name} already used on ${table}`;
      continue;
    }
    const relation: Relation = {
      ownerTable: table,
      fk: a.foreign_key!,
      targetTable: target!,
      pk: a.primary_key,
      belongsTo: { field: a.name, synthesized: false },
      inverse: { field: "", kind: "list", synthesized: true, hasOneAsList: false },
    };
    byKey.set(k, relation);
    relations.push(relation);
    entry.prisma = { field: a.name };
    entry.status = "modeled";
  }

  // has_many / has_one become the inverse side, or synthesize a belongs_to when Rails declares none.
  for (const { a, table } of assocs) {
    const entry = entryFor.get(a)!;
    if (a.macro === "belongs_to") continue;
    if (a.macro === "has_and_belongs_to_many") {
      entry.status = "habtm";
      continue;
    }
    if (a.through) {
      entry.status = "through";
      continue;
    }
    if (a.options.as) {
      entry.status = "polymorphic_inverse";
      continue;
    }
    const target = tableOf(a.klass);
    const why = blocker(target, a.foreign_key, table, a.primary_key);
    if (why) {
      entry.reason = why;
      continue;
    }
    const k = key(target!, a.foreign_key!, table, a.primary_key);
    let relation = byKey.get(k);
    if (!relation) {
      const synthesized = `${singular(table)}_via_${a.foreign_key}`;
      if (!claim(target!, synthesized)) {
        entry.reason = `field name ${synthesized} already used on ${target}`;
        continue;
      }
      relation = {
        ownerTable: target!,
        fk: a.foreign_key!,
        targetTable: table,
        pk: a.primary_key,
        belongsTo: { field: synthesized, synthesized: true },
        inverse: { field: "", kind: "list", synthesized: true, hasOneAsList: false },
      };
      byKey.set(k, relation);
      relations.push(relation);
    }
    if (relation.inverse.field && !relation.inverse.synthesized) {
      entry.prisma = { field: relation.inverse.field };
      entry.status = "alias";
      continue;
    }
    if (!claim(table, a.name)) {
      entry.reason = `field name ${a.name} already used on ${table}`;
      continue;
    }
    const unique = tables.get(relation.ownerTable)!.uniqueColumns.has(relation.fk);
    relation.inverse = {
      field: a.name,
      kind: unique ? "optional" : "list",
      synthesized: false,
      hasOneAsList: a.macro === "has_one" && !unique,
    };
    entry.prisma = { field: a.name };
    entry.status = "modeled";
  }

  // Prisma needs both sides; name the missing inverse after the owner table and key.
  for (const r of relations) {
    if (r.inverse.field) continue;
    const base = `${r.ownerTable}_via_${r.fk}`;
    let field = base;
    for (let n = 2; !claim(r.targetTable, field); n++) field = `${base}_${n}`;
    const unique = tables.get(r.ownerTable)!.uniqueColumns.has(r.fk);
    r.inverse = { field, kind: unique ? "optional" : "list", synthesized: true, hasOneAsList: false };
  }

  const fields = new Map<string, string[]>();
  const push = (table: string, line: string) => {
    if (!fields.has(table)) fields.set(table, []);
    fields.get(table)!.push(line);
  };
  for (const r of relations) {
    const owner = tables.get(r.ownerTable)!;
    const target = tables.get(r.targetTable)!;
    const name = `${owner.model}_${r.belongsTo.field}`;
    const optional = owner.columns.get(r.fk)!.optional ? "?" : "";
    if (r.belongsTo.synthesized) push(r.ownerTable, `  /// No belongs_to in Rails; inverse of ${target.model}.${r.inverse.field}`);
    push(r.ownerTable, `  ${r.belongsTo.field} ${target.model}${optional} @relation("${name}", fields: [${r.fk}], references: [${r.pk}])`);
    if (r.inverse.synthesized) push(r.targetTable, `  /// No has_many/has_one in Rails; inverse of ${owner.model}.${r.belongsTo.field}`);
    if (r.inverse.hasOneAsList) push(r.targetTable, `  /// has_one in Rails, but ${r.ownerTable}.${r.fk} is not unique: take the first row the way Rails does`);
    push(r.targetTable, `  ${r.inverse.field} ${owner.model}${r.inverse.kind === "list" ? "[]" : "?"} @relation("${name}")`);
  }
  return { fields, manifest };
}

function singular(table: string): string {
  return table.replace(/ies$/u, "y").replace(/s$/u, "");
}
