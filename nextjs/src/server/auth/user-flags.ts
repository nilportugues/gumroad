// The User flags auth reads (positions from `has_flags` in app/models/user.rb). WS-02 owns the full
// mapping; swap this for it once it lands.
import { defineFlags } from "../../lib/flags";

export const authUserFlags = defineFlags("users", {
  9: "two_factor_authentication_enabled",
  28: "is_team_member",
});
