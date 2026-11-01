// The converted pages import shared components from app/javascript, whose bare imports would otherwise
// resolve from the Rails app's node_modules, which CI does not install for this app. Every package that
// graph reaches must be a dependency here and aliased in next.config.ts `sharedPackages`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const nextjsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.dirname(nextjsDir);
const appJavascript = path.join(repoRoot, "app/javascript");

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
// Next resolves these itself (its vendored React) or they are not imported at runtime.
const PROVIDED = new Set(["react", "react-dom", "tailwindcss", "@inertiajs/react", "@inertiajs/core"]);

function resolveLocal(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith("$app/")) base = path.join(appJavascript, specifier.slice(5));
  else if (specifier.startsWith("@/")) base = path.join(nextjsDir, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return "";
}

const packageName = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

function sharedPackagesReached(): Map<string, string> {
  const seen = new Set<string>();
  const packages = new Map<string, string>();
  const stack = sourceFiles(path.join(nextjsDir, "src"));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match.slice(1).find(Boolean)!;
      if (/^(\$assets\/|\$vendor\/|\$next-routes|node:)/.test(specifier)) continue;
      const local = resolveLocal(specifier, file);
      if (local === null) {
        if (file.startsWith(appJavascript)) packages.set(packageName(specifier), path.relative(repoRoot, file));
      } else if (local !== "") stack.push(local);
    }
  }
  return packages;
}

describe("packages the shared components import", () => {
  const reached = [...sharedPackagesReached()].filter(([name]) => !PROVIDED.has(name));
  const manifest = JSON.parse(readFileSync(path.join(nextjsDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
  const config = readFileSync(path.join(nextjsDir, "next.config.ts"), "utf8");
  const aliased = new Set([...(config.split("const sharedPackages = [")[1]?.split("];")[0] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!));

  it("are dependencies of the Next app", () => {
    expect(reached.filter(([name]) => !declared.has(name))).toEqual([]);
  });

  it("are aliased to the Next app's node_modules", () => {
    expect(reached.filter(([name]) => !aliased.has(name))).toEqual([]);
  });
});
