import path from "node:path";

export type RailsEnv = "development" | "test" | "staging" | "production";

// Rails.env: RAILS_ENV, then RACK_ENV, then "development" (blank values are skipped).
export function railsEnv(): RailsEnv {
  const value = process.env.RAILS_ENV?.trim() || process.env.RACK_ENV?.trim() || "development";
  return value as RailsEnv;
}

// The Next.js app runs from nextjs/, one level below the Rails root. RAILS_ROOT overrides it for
// processes started elsewhere (tests, scripts).
export function railsRoot(): string {
  return process.env.RAILS_ROOT?.trim() || path.resolve(process.cwd(), "..");
}
