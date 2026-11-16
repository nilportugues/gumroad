import type { Follower } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineModel } from "../runtime/define-model.ts";
import { ModelRecord, type Row } from "../runtime/record.ts";
import { fakeDatabase } from "../runtime/testing.ts";
import golden from "./__fixtures__/paper-trail.golden.json" with { type: "json" };
import { activeSupportJsonEncode, buildVersion, hasPaperTrail, setPaperTrailEnabled, withPaperTrailRequest, type ColumnType, type Resolved } from "./paper-trail.ts";
import { hashFrom, type YamlValue } from "./psych.ts";
import { RubyFloat } from "./ruby-values.ts";
import { yamlColumn } from "./serialized-columns.ts";

// Vectors come from paper_trail 17 itself (scripts/golden/paper-trail.rb).
type Tagged =
  | null
  | boolean
  | string
  | Tagged[]
  | { $int: string }
  | { $float: string }
  | { $decimal: string }
  | { $time: string }
  | { $date: string }
  | { $hash: [string, Tagged][] };

function untag(t: Tagged): unknown {
  if (t === null || typeof t === "boolean" || typeof t === "string") return t;
  if (Array.isArray(t)) return t.map(untag);
  if ("$int" in t) return Number(t.$int);
  if ("$float" in t) {
    const f = Number(t.$float);
    return Number.isInteger(f) ? new RubyFloat(f) : f;
  }
  if ("$decimal" in t) return new Prisma.Decimal(t.$decimal);
  if ("$time" in t) return new Date(t.$time);
  if ("$date" in t) return new Date(`${t.$date}T00:00:00Z`);
  return hashFrom(t.$hash.map(([k, v]) => [k, untag(v) as YamlValue]));
}

const settings = yamlColumn("settings", "Hash");

// The TypeScript record keeps serialized text columns as their database text.
function row(tagged: Record<string, Tagged> | null): Row | null {
  if (!tagged) return null;
  const values = Object.fromEntries(Object.entries(tagged).map(([k, v]) => [k, untag(v)]));
  values.settings = settings.dump(values.settings as YamlValue);
  return values;
}

const columnTypes = Object.fromEntries(golden.columns.map((c) => [c.name, c.type])) as Record<string, ColumnType>;
const config: Resolved = { itemType: "Widget", only: [], skip: golden.options.skip, ignore: golden.options.ignore, columnTypes };
const defaults: Row = Object.fromEntries(golden.columns.map((c) => [c.name, c.name === "flags" ? 0 : c.name === "active" ? false : null]));
const controllerInfo = { remote_ip: "203.0.113.7", request_path: "/widgets/1", request_uuid: "req-uuid-1" };

function recordFor(step: (typeof golden.steps)[number]): { event: "create" | "update" | "destroy"; record: ModelRecord } {
  const before = row(step.before as Record<string, Tagged> | null);
  const after = row(step.after as Record<string, Tagged> | null);
  if (!after) return { event: "destroy", record: new ModelRecord(before!, { newRecord: false }) };
  const record = new ModelRecord(after, { newRecord: false, inDatabase: before ?? defaults });
  record.changesApplied();
  return { event: before ? "update" : "create", record };
}

describe("PaperTrail versions match paper_trail 17", () => {
  it.each(golden.steps.map((s) => [s.name, s] as const))("%s", (_, step) => {
    const { event, record } = recordFor(step);
    const version = withPaperTrailRequest({ whodunnit: 42, controllerInfo }, () => buildVersion(event, record, config, new Date(step.now)));
    const expected = step.versions.map((v) => ({ ...v, created_at: new Date(v.created_at) }));
    expect(version ? [version] : []).toEqual(expected);
  });
});

describe("activeSupportJsonEncode", () => {
  it("escapes HTML entities and JS line separators but not slashes", () => {
    expect(activeSupportJsonEncode({ s: "</a>&\u2028\u2029\u0001" })).toBe('{"s":"\\u003c/a\\u003e\\u0026\\u2028\\u2029\\u0001"}');
  });

  it("keeps HTML and separators unescaped for JSON columns, as Type::Json#serialize does", () => {
    expect(activeSupportJsonEncode({ a: "<&> \u0001/", f: NaN, d: new Prisma.Decimal("5") }, { escape: false })).toBe('{"a":"<&> \\u0001/","f":null,"d":"5.0"}');
  });

  it("encodes non-finite floats as null and decimals with a fraction", () => {
    expect(activeSupportJsonEncode([NaN, new RubyFloat(1), new Prisma.Decimal("5"), new Prisma.Decimal("1e-7")])).toBe('[null,1.0,"5.0","0.0000001"]');
  });
});

describe("hasPaperTrail on a model service", () => {
  let db: ReturnType<typeof fakeDatabase>;

  beforeEach(() => {
    db = fakeDatabase();
  });

  afterEach(() => setPaperTrailEnabled(true));

  const paperTrail = hasPaperTrail<Follower>("Follower", { itemType: "Follower" });
  const Followers = defineModel<Follower>({
    rubyClass: "Follower",
    prismaModel: "Follower",
    delegate: (tx) => tx.follower as never,
    ...paperTrail,
  });

  it("writes create, update and destroy versions inside the record's transaction", async () => {
    const now = () => new Date("2024-01-01T00:00:00.123Z");
    const record = await withPaperTrailRequest({ whodunnit: "7" }, () => Followers.createBang({ email: "a@example.com", followed_id: 1 }, { now }));
    await Followers.updateBang(record, { email: "b@example.com" }, { now });
    await Followers.save(record, { now });
    await Followers.destroyBang(record);

    const versions = db.committed.filter((w) => w.model === "version").map((w) => w.data!);
    expect(versions.map((v) => v.event)).toEqual(["create", "update", "destroy"]);
    expect(versions[0]).toMatchObject({ item_type: "Follower", item_id: 1, whodunnit: "7", object: null, created_at: new Date("2024-01-01T00:00:00Z") });
    expect(JSON.parse(versions[1]!.object_changes as string)).toEqual({ email: ["a@example.com", "b@example.com"] });
    expect(versions[1]!.whodunnit).toBeNull();
  });

  it("records nothing while PaperTrail is disabled", async () => {
    setPaperTrailEnabled(false);
    await Followers.createBang({ email: "a@example.com", followed_id: 1 });
    expect(db.committed.filter((w) => w.model === "version")).toHaveLength(0);
  });
});
