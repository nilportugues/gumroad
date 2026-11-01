// Port of the flag_shih_tzu `has_flags` usage (flag_shih_tzu 0.3.23): every model stores its
// flags in an integer column, and flag N is bit 2^(N-1). Bit positions are persisted data —
// never renumber.
import { Prisma } from "@prisma/client";

type FlagMap = Record<number, string>;
type FlagName<M extends FlagMap> = M[keyof M] & string;

export type FlagOptions = {
  column?: string;
  // flag_shih_tzu defaults to :in_list; most models opt into :bit_operator.
  queryMode?: "bit_operator" | "in_list";
};

export function defineFlags<const M extends FlagMap>(table: string, mapping: M, options: FlagOptions = {}) {
  const column = options.column ?? "flags";
  const queryMode = options.queryMode ?? "in_list";
  const bits = new Map<string, bigint>();
  for (const [position, name] of Object.entries(mapping)) bits.set(name, 1n << BigInt(Number(position) - 1));
  const maxBit = [...bits.values()].reduce((a, b) => (b > a ? b : a), 0n);

  const bit = (name: FlagName<M>): bigint => {
    const value = bits.get(name);
    if (value === undefined) throw new Error(`Unknown flag ${name} on ${table}`);
    return value;
  };

  // MySQL quote_table_name: backticks per dot-separated part, doubling embedded backticks.
  const fullColumn = (tableName: string) =>
    [...tableName.split("."), column].map((part) => `\`${part.replaceAll("`", "``")}\``).join(".");

  // sql_in_for_flag: every value in 0..(2 * max_bit - 1) that has the flag's bit set.
  const inList = (value: bigint): string => {
    const values: string[] = [];
    for (let v = 0n; v < 2n * maxBit; v++) if ((v & value) === value) values.push(v.toString());
    return values.join(",");
  };

  return {
    column,
    bit,
    isSet(flags: bigint | number | null, name: FlagName<M>): boolean {
      return (BigInt(flags ?? 0) & bit(name)) !== 0n;
    },
    set(flags: bigint | number | null, name: FlagName<M>, enabled: boolean): bigint {
      const current = BigInt(flags ?? 0);
      return enabled ? current | bit(name) : current & ~bit(name);
    },
    // `Model.<flag>_condition(table_alias:)` / `Model.not_<flag>_condition`. Values are inlined
    // as literals, exactly as flag_shih_tzu writes them.
    condition(name: FlagName<M>, enabled = true, opts: { tableAlias?: string } = {}): Prisma.Sql {
      const value = bit(name);
      const lhs = fullColumn(opts.tableAlias ?? table);
      const sql =
        queryMode === "bit_operator"
          ? `(${lhs} & ${value} = ${enabled ? value : 0n})`
          : `(${lhs} ${enabled ? "" : "not "}in (${inList(value)}))`;
      return Prisma.raw(sql);
    },
    // `Model.set_flag_sql(:name, value)` for bulk update_all.
    setSql(name: FlagName<M>, enabled: boolean): Prisma.Sql {
      const col = fullColumn(table);
      return Prisma.raw(`${col} = ${col} ${enabled ? "| " : "& ~"}${bit(name)}`);
    },
    names: Object.values(mapping) as FlagName<M>[],
  };
}

export type Flags<M extends FlagMap> = ReturnType<typeof defineFlags<M>>;
