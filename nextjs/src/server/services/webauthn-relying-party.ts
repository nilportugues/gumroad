// config/initializers/webauthn.rb: the relying party is the host of ROOT_DOMAIN, and every request host (with the domains) is an origin.
import { domainConfig } from "../page-props/domain.ts";

const config = () => domainConfig(process.env);

export const rpId = (): string => config().rootDomain.split(":")[0]!;

export const allowedOrigins = (): string[] => {
  const { protocol, domain, rootDomain, validRequestHosts } = config();
  return [...new Set([...validRequestHosts, domain, rootDomain])].map((host) => `${protocol}://${host}`);
};
