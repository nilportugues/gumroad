// Api::Mobile::AgentController#meta: the tombstone shipped app builds still call when the removed Agent tab mounts. Every other
// /mobile/agent route is gone from Rails, so none is registered here.
import { registerMobile, renderJson } from "./mobile-api.ts";

const MOBILE_API_SCOPES = ["mobile_api"];

const NOTICE = "The Agent tab is gone. Connect Claude or ChatGPT to your store at gumroad.com/mcp.";

registerMobile({
  method: "GET",
  pattern: "/mobile/agent/meta",
  scopes: MOBILE_API_SCOPES,
  run: async () =>
    renderJson({ success: true, enabled: false, greeting: "", suggestions: [], available: false, notice: NOTICE }),
});
