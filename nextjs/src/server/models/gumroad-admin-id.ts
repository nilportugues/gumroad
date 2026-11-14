// GUMROAD_ADMIN_ID (config/initializers/004_constants.rb)
import { getConfigValue } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";

export const gumroadAdminId = () => getConfigValue("GUMROAD_ADMIN_ID", railsEnv() === "staging" ? 978 : 767082);
