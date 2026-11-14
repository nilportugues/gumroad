// GeoIp.lookup (lib/utilities/geo_ip.rb) over the MaxMind reader of config/initializers/geoip.rb.
import { Reader, type CityResponse } from "mmdb-lib";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { railsRoot } from "./rails-env.ts";

export const GEOIP_DATABASE = "lib/GeoIP2-City.mmdb";
const CITY_DATABASE_TYPE = "City";

export type GeoIpResult = {
  countryName: string | null;
  countryCode: string | null;
  regionName: string | null;
  cityName: string | null;
  postalCode: string | null;
  // GeoIp.santitize_string calls `try(:encode)`, which is nil for a Float: Rails always returns nil.
  latitude: null;
  longitude: null;
};

type Loaded = { path: string; reader: Reader<CityResponse> | null };
let loaded: Loaded | null = null;

// GEOIP is nil when the file is missing, so every lookup is nil. The initializer reads it once at boot;
// the reader is cached per path here. GEOIP_DATABASE_PATH points tests at another file.
function cityReader(): Reader<CityResponse> | null {
  const databasePath = process.env.GEOIP_DATABASE_PATH?.trim() || path.join(railsRoot(), GEOIP_DATABASE);
  if (loaded?.path === databasePath) return loaded.reader;
  const reader = existsSync(databasePath) ? new Reader<CityResponse>(readFileSync(databasePath)) : null;
  loaded = { path: databasePath, reader };
  return reader;
}

// IPAddr.new takes "1.2.3.4/24" (the network address) and a bracketed "[::1]"; it rejects the rest.
function ipAddress(ip: string): string | null {
  const [rawAddress, prefix, ...rest] = ip.split("/");
  if (rawAddress === undefined || rest.length > 0) return null;
  const address = /^\[(.*)\]$/u.exec(rawAddress)?.[1] ?? rawAddress;
  const version = isIP(address);
  if (version === 0) return null;
  if (prefix === undefined) return address;
  if (!/^\d+$/u.test(prefix)) return null;
  const length = Number(prefix);
  if (length > (version === 4 ? 32 : 128)) return null;
  return maskAddress(address, version as 4 | 6, length);
}

function maskAddress(address: string, version: 4 | 6, length: number): string | null {
  const bytes = version === 4 ? address.split(".").map(Number) : expandIpv6(address);
  if (bytes === null) return null;
  const masked = bytes.map((byte, index) => {
    const bits = Math.max(0, Math.min(8, length - index * 8));
    return byte & ((0xff << (8 - bits)) & 0xff);
  });
  if (version === 4) return masked.join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((masked[i] ?? 0) << 8) | (masked[i + 1] ?? 0)).toString(16));
  return groups.join(":");
}

function expandIpv6(address: string): number[] | null {
  let text = address.split("%")[0] ?? "";
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (v4) text = text.replace(v4[0], `${((Number(v4[1]) << 8) | Number(v4[2])).toString(16)}:${((Number(v4[3]) << 8) | Number(v4[4])).toString(16)}`);
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(fill, 0)).fill("0"), ...right].map((group) => parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

// Place#name: the first of the locales (["en"]) the names hash has.
function placeName(names: { en?: string } | undefined): string | null {
  if (names === undefined || !Object.hasOwn(names, "en")) return null;
  return names.en ?? null;
}

// `GEOIP.city(ip) rescue nil`: a bad address, one the database lacks, or a non-City database is nil.
export function geoIpLookup(ip: string | null | undefined): GeoIpResult | null {
  const reader = cityReader();
  if (reader === null || typeof ip !== "string") return null;
  if (!reader.metadata.databaseType.includes(CITY_DATABASE_TYPE)) return null;
  const address = ipAddress(ip);
  if (address === null) return null;
  if (isIP(address) === 6 && reader.metadata.ipVersion === 4) return null;
  let record: CityResponse | null;
  try {
    record = reader.get(address);
  } catch {
    return null;
  }
  if (record === null) return null;
  const subdivisions = record.subdivisions ?? [];
  return {
    countryName: placeName(record.country?.names),
    countryCode: record.country?.iso_code ?? null,
    regionName: subdivisions.at(-1)?.iso_code ?? null,
    cityName: placeName(record.city?.names),
    postalCode: record.postal?.code ?? null,
    latitude: null,
    longitude: null,
  };
}
