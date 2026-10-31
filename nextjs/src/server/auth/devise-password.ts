// Devise::Encryptor plus User#valid_password?: bcrypt over "#{password}#{pepper}", where a hash
// that is not bcrypt (pre-Devise sha256 accounts) fails instead of raising.
import bcrypt from "bcryptjs";

import { getConfig } from "../infra/config";

// BCrypt::Password.valid_hash?
const BCRYPT_HASH = /^\$[0-9a-z]{2,}\$[0-9]{2,}\$[A-Za-z0-9./]{53,}$/;
// config/initializers/devise.rb: `Rails.env.test? ? 1 : 11`; bcrypt-ruby raises 1 to its minimum of 4.
const PRODUCTION_STRETCHES = 11;
const MIN_BCRYPT_COST = 4;

export type DeviseConfig = { pepper: string | null; stretches: number };

export function deviseConfig(): DeviseConfig {
  return {
    pepper: getConfig("DEVISE_PEPPER") || null,
    stretches: process.env.NODE_ENV === "test" ? MIN_BCRYPT_COST : PRODUCTION_STRETCHES,
  };
}

export async function validPassword(encryptedPassword: string | null | undefined, password: string | null | undefined, config = deviseConfig()): Promise<boolean> {
  if (!encryptedPassword || !BCRYPT_HASH.test(encryptedPassword)) return false;
  return bcrypt.compare(peppered(password, config), encryptedPassword);
}

// For WS-10's signup and password change; Rails stays the only writer until then.
export async function digestPassword(password: string, config = deviseConfig()): Promise<string> {
  return bcrypt.hash(peppered(password, config), Math.max(config.stretches, MIN_BCRYPT_COST));
}

// Devise's `authenticatable_salt`: the bcrypt version, cost and salt, which change with the password.
export function authenticatableSalt(encryptedPassword: string | null | undefined): string | null {
  return encryptedPassword == null ? null : encryptedPassword.slice(0, 29);
}

function peppered(password: string | null | undefined, { pepper }: DeviseConfig): string {
  return `${password ?? ""}${pepper ?? ""}`;
}
