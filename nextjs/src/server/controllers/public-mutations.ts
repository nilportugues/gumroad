// PublicController#working_webhook: the endpoint the webhook documentation tells sellers to point a ping at to see it work.
import { registerMutations } from "./mutation.ts";

registerMutations({
  method: "POST",
  pattern: "/working-webhook",
  options: { optOutOfCsp: true },
  run: async () => ({ status: 200, body: "http://www.gumroad.com", contentType: "text/plain; charset=utf-8" }),
});
