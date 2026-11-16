// Port of the association reflections declared across app/models (reflect_on_association).
// Every association is listed, including the ones Prisma cannot model (polymorphic, through,
// has_and_belongs_to_many, Int keys pointing at BigInt ids); see prisma/relations/manifest.json.
import manifestJson from "../../../prisma/relations/manifest.json" with { type: "json" };
import type { Manifest, ManifestEntry } from "../../../scripts/relations.ts";

export type { ManifestEntry as Association };

const manifest = manifestJson as Manifest;

// `rubyClass` is the class name as written in Ruby, e.g. "User", "Marketing::Action", "Price".
// STI subclasses see their superclasses' associations, as in Rails.
export function reflectOnAssociation(rubyClass: string, name: string): ManifestEntry {
  for (let current: string | null = rubyClass; current; current = manifest[current]?.superclass ?? null) {
    const hit = manifest[current]?.associations.find((a) => a.name === name);
    if (hit) return hit;
  }
  throw new Error(`No association ${name} on ${rubyClass}`);
}

export function modelForRubyClass(rubyClass: string): string | null {
  return manifest[rubyClass]?.model ?? null;
}
