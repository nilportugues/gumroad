// Contract owned by WS-06. Port of lib/utilities/global_config.rb: ENV first, then Rails
// credentials (`FOO__BAR` reads credentials.foo.bar), with Ruby's `presence` semantics.
import { type Credentials, loadCredentials } from "./credentials.ts";

let credentialsCache: Credentials | undefined;

function credentials(): Credentials {
  credentialsCache ??= loadCredentials();
  return credentialsCache;
}

// Tests swap in fixed credentials; `undefined` reloads from disk on next read.
export function setCredentialsForTesting(value: Credentials | undefined): void {
  credentialsCache = value;
}

const NO_DEFAULT: unique symbol = Symbol("no default");

// Rails.application.credentials.dig(*keys): a nil link ends the walk, a non-Hash link raises
// TypeError just as Hash#dig does on a String or Integer.
function fetchFromCredentials(name: string): unknown {
  let current: unknown = credentials();
  for (const key of name.toLowerCase().split("__")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object" || Array.isArray(current)) {
      throw new TypeError(`${typeof current} does not have #dig method`);
    }
    current = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current ?? undefined;
}

// ActiveSupport's Object#blank?
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "string") return /^\s*$/u.test(value);
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function isRubyTruthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * GlobalConfig.get with the raw value: credentials can hold integers, booleans and hashes.
 * Without a default, blank values (including "" from ENV) become undefined; with one, ENV wins
 * even when empty, then a truthy credential, then the default.
 */
export function getConfigValue(name: string, defaultValue: unknown = NO_DEFAULT): unknown {
  const fromCredentials = fetchFromCredentials(name);
  const fromEnv = process.env[name];
  if (defaultValue === NO_DEFAULT) {
    const value = fromEnv !== undefined ? fromEnv : fromCredentials;
    return isBlank(value) ? undefined : value;
  }
  if (fromEnv !== undefined) return fromEnv;
  return isRubyTruthy(fromCredentials) ? fromCredentials : defaultValue;
}

function toConfigString(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new TypeError(`Config ${name} is a ${Array.isArray(value) ? "list" : "hash"}; read it with getConfigValue`);
}

export function getConfig(name: string): string | undefined;
export function getConfig(name: string, defaultValue: string): string;
export function getConfig(name: string, defaultValue: string | undefined): string | undefined;
export function getConfig(name: string, ...rest: [] | [string | undefined]): string | undefined {
  const value = rest.length === 0 ? getConfigValue(name) : getConfigValue(name, rest[0]);
  return toConfigString(name, value);
}

export function getRequiredConfig(name: string): string {
  const value = getConfig(name);
  if (value === undefined || value === "") throw new Error(`Missing config ${name}`);
  return value;
}

// GlobalConfig.dig("stripe", "api_key") reads STRIPE__API_KEY.
export function digConfigName(...parts: string[]): string {
  return parts.map((part) => part.toUpperCase()).join("__");
}

export function digConfig(parts: string[], defaultValue: unknown = NO_DEFAULT): unknown {
  return getConfigValue(digConfigName(...parts), defaultValue);
}
