import { existsSync, readFileSync } from "node:fs";

export type QuarantineEntry = { file: string; reason: string; since: string };

/** Reads e2e/quarantine.json. A missing file means nothing is quarantined; a malformed entry throws so it cannot silently widen the skip list. */
export const loadQuarantine = (file: string): QuarantineEntry[] => {
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a JSON array`);
  return parsed.map((entry: unknown, index) => {
    const fields: Record<string, unknown> = typeof entry === "object" && entry !== null ? { ...entry } : {};
    const { file: spec, reason, since } = fields;
    if (typeof spec !== "string" || !/^e2e\/specs\/[\w.-]+\.spec\.ts$/u.test(spec))
      throw new Error(`${file}[${index}].file must be a path like e2e/specs/name.spec.ts`);
    if (typeof reason !== "string" || !reason.trim() || typeof since !== "string" || !since.trim())
      throw new Error(`${file}[${index}] needs a non-empty reason and since`);
    return { file: spec, reason, since };
  });
};

/** Anchored regexes for Playwright's testIgnore / testMatch. */
export const quarantinePatterns = (entries: QuarantineEntry[]) =>
  entries.map(({ file }) => new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
