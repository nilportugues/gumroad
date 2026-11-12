// Port of app/models/custom_domain.rb for soft-deleting a stored domain (Deletable#mark_deleted!) and for saving the domain a seller
// sets on the advanced settings page. A change to anything else refuses with NotPortedError before SQL, and the DNS check that would
// mark a domain verified is not ported (the controller hands that case back before its first write). Golden: the suspension cases of
// __fixtures__/user-writes.golden.json.
import { Prisma, type CustomDomain } from "@prisma/client";

import { railsEnv } from "../infra/rails-env.ts";
import { domainConfig } from "../page-props/domain.ts";

import { deletable } from "./concerns/deletable.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { isValidDomain, parseDomain } from "./concerns/public-suffix.ts";
import { loadBelongsTo, setAssociation, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord, Row } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError, strippedField } from "./user.ts";

export type CustomDomainRecord = ModelRecord<CustomDomain>;

const WWW_PREFIX = "www";
const SSL_CERTIFICATE_DELAY_SECONDS = 2;
// INTERNAL_GUMROAD_DOMAIN (config/domain.rb), which page-props/domain.ts does not carry.
const INTERNAL_GUMROAD_DOMAINS = {
  production: "gumroad.net",
  staging: "gumroad.net",
  test: "test.gumroad.net",
  development: "internal.localhost",
} as const;

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const PRODUCT: BelongsTo = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" };

// DOMAIN, ROOT_DOMAIN, SHORT_DOMAIN, DISCOVER_DOMAIN, API_DOMAIN, INTERNAL_GUMROAD_DOMAIN
function forbiddenSuffixes(): string[] {
  const config = domainConfig(process.env);
  return [
    config.domain,
    config.rootDomain,
    config.shortDomain,
    config.discoverDomain,
    config.apiDomain,
    INTERNAL_GUMROAD_DOMAINS[railsEnv()],
  ];
}

function findAlive(domain: string): Promise<Row[]> {
  return selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`custom_domains`.*")} FROM ${table("custom_domains")} WHERE ${column("custom_domains", "deleted_at")} IS NULL AND ${column("custom_domains", "domain")} = ${domain} LIMIT 1`,
  );
}

// CustomDomain.find_by_host
async function findByHost(host: string | null): Promise<Row | undefined> {
  if (host === null || !isValidDomain(host)) return undefined;
  const parsed = parseDomain(host);
  if (parsed.trd === null || parsed.trd === WWW_PREFIX) {
    return (
      (await findAlive(String(parsed.domain)))[0] ?? (await findAlive(`${WWW_PREFIX}.${String(parsed.domain)}`))[0]
    );
  }
  return (await findAlive(host))[0];
}

// What a save may change: the soft delete, and what Settings::AdvancedController sets from a domain that does not point at Gumroad
// (the domain, the verification state, and the owner of a new row). The routability and certificate columns have their own paths.
const PORTED_CHANGES = new Set<string>([
  "deleted_at",
  "domain",
  "state",
  "user_id",
  "created_at",
  "updated_at",
  "ssl_certificate_issued_at",
  "routable",
  "routability_checked_at",
]);

const refuseUnportedSave: Callback<CustomDomain> = {
  name: "(guard) refuse unported changes",
  run(record) {
    record.untracked(() => {
      const unported = record.changedAttributeNames().filter((name) => !PORTED_CHANGES.has(name));
      if (unported.length > 0) {
        throw new NotPortedError(`CustomDomain#save changing ${unported.join(", ")}`, "app/models/custom_domain.rb");
      }
    });
  },
};

// `certificate_domain_valid?`'s `ip_address?`: IPAddr.new accepts a dotted quad of 0-255 without zero-filled octets. The characters
// the format check lets through cannot spell an IPv6 address or carry a prefix length.
export function isIpAddress(domain: string): boolean {
  const octets = domain.split(".");
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
}

// LetsEncrypt allows only valid hostnames; an empty label or one starting or ending with a hyphen is refused too (`malformed_label?`).
export function certificateDomainValid(domain: string | null): boolean {
  if (domain === null || isBlank(domain)) return false;
  if (!/^[a-zA-Z0-9\-.]+[^.]$/u.test(domain)) return false;
  if (domain.split(".").some((label) => label === "" || label.startsWith("-") || label.endsWith("-"))) return false;
  return isValidDomain(domain) && !isIpAddress(domain);
}

export const CustomDomains = defineModel<CustomDomain>({
  rubyClass: "CustomDomain",
  prismaModel: "CustomDomain",
  delegate: (tx) => tx.customDomain as never,
  beforeValidation: [
    refuseUnportedSave,
    {
      name: "stripped_fields :domain, transform: downcase",
      run: (record) => record.set("domain", strippedField(record.get("domain"))?.toLowerCase() ?? null),
    },
  ],
  validations: [
    {
      name: "user_or_product_present",
      async run(record, ctx) {
        if ((await loadBelongsTo(record, USER, ctx)) !== null || (await loadBelongsTo(record, PRODUCT, ctx)) !== null)
          return;
        record.errors.add("base", "Requires an associated user or product.");
      },
    },
    {
      name: "validate_domain_uniqueness",
      async run(record) {
        const found = await findByHost(record.get("domain"));
        if (found === undefined || Number(found.id) === Number(record.get("id"))) return;
        record.errors.add("base", "The custom domain is already in use.");
      },
    },
    {
      name: "validate_domain_format, unless: :deleted?",
      run(record) {
        if (record.get("deleted_at") !== null) return;
        if (!certificateDomainValid(record.get("domain")))
          record.errors.add("base", `${record.get("domain") ?? ""} is not a valid domain name.`);
      },
    },
    {
      name: "validate_domain_is_allowed",
      run(record) {
        const domain = record.get("domain");
        if (forbiddenSuffixes().some((suffix) => domain === suffix || (domain ?? "").endsWith(`.${suffix}`))) {
          record.errors.add("base", `${domain ?? ""} is not a valid domain name.`);
        }
      },
    },
  ],
  beforeSave: [
    {
      name: "reset_ssl_certificate_issued_at",
      if: (record) => record.attributeChanged("domain"),
      run(record) {
        record.set("ssl_certificate_issued_at", null);
        record.set("routable", null);
        record.set("routability_checked_at", null);
      },
    },
  ],
  afterCommit: [
    {
      name: "generate_ssl_certificate",
      if: (record) => record.savedChangeTo("domain"),
      run: (record) =>
        performAsync("GenerateSslCertificate", [record.get("id")], { delaySeconds: SSL_CERTIFICATE_DELAY_SECONDS }),
    },
  ],
});

export const CustomDomainDeletable = deletable(CustomDomains);

// `product.custom_domain` (has_one, -> { alive }, foreign_key: "product_id").
export async function aliveCustomDomainOfProduct(productId: unknown): Promise<CustomDomainRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`custom_domains`.*")} FROM ${table("custom_domains")} WHERE ${column("custom_domains", "product_id")} = ${productId} AND ${column("custom_domains", "deleted_at")} IS NULL LIMIT 1`,
  );
  return row ? CustomDomains.load(castRow<CustomDomain>("CustomDomain", row)) : null;
}

// `user.custom_domain` (has_one, -> { alive }), with the user set as its inverse.
export async function aliveCustomDomainOf(userId: unknown, userRow: Row): Promise<CustomDomainRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`custom_domains`.*")} FROM ${table("custom_domains")} WHERE ${column("custom_domains", "user_id")} = ${userId} AND ${column("custom_domains", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (!row) return null;
  const record = CustomDomains.load(castRow<CustomDomain>("CustomDomain", row));
  setAssociation(record, "user", record.get("user_id"), userRow);
  return record;
}
