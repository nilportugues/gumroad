// Port of the flag_shih_tzu `has_flags` usage: every model stores its flags in a `flags`
// column, and flag N is bit 2^(N-1). Bit positions are persisted data — never renumber.
import { Prisma } from "@prisma/client";

type FlagMap = Record<number, string>;
type FlagName<M extends FlagMap> = M[keyof M] & string;

export function defineFlags<const M extends FlagMap>(table: string, mapping: M) {
  const bits = new Map<string, bigint>();
  for (const [position, name] of Object.entries(mapping)) bits.set(name, 1n << BigInt(Number(position) - 1));

  const bit = (name: FlagName<M>): bigint => {
    const value = bits.get(name);
    if (value === undefined) throw new Error(`Unknown flag ${name} on ${table}`);
    return value;
  };

  return {
    isSet(flags: bigint | number | null, name: FlagName<M>): boolean {
      return (BigInt(flags ?? 0) & bit(name)) !== 0n;
    },
    set(flags: bigint | number | null, name: FlagName<M>, enabled: boolean): bigint {
      const current = BigInt(flags ?? 0);
      return enabled ? current | bit(name) : current & ~bit(name);
    },
    // Same SQL as flag_shih_tzu's :bit_operator query mode, so query plans stay unchanged.
    condition(name: FlagName<M>, enabled = true): Prisma.Sql {
      const value = bit(name);
      return Prisma.sql`(${Prisma.raw(`\`${table}\`.\`flags\``)} & ${value} = ${enabled ? value : 0n})`;
    },
    // Mirrors `Model.set_flag_sql(:name, value)` for bulk update_all.
    setSql(name: FlagName<M>, enabled: boolean): Prisma.Sql {
      const value = bit(name);
      const column = Prisma.raw(`\`${table}\`.\`flags\``);
      return enabled ? Prisma.sql`${column} = ${column} | ${value}` : Prisma.sql`${column} = ${column} & ~${value}`;
    },
    names: Object.values(mapping) as FlagName<M>[],
  };
}
