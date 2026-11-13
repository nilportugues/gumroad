// Settings::AdvancedController#rotate_ping_signing_secret and #disable_ping_signing (app/controllers/settings/advanced_controller.rb), JSON
// endpoints behind the advanced settings policy. The secret is random, so the parity replay checks its shape and that it is the stored one.
import { generateSecret, disablePingSigning, rotatePingSigningSecret } from "../models/ping-signing-setting.ts";
import { settingsAdvancedUserPolicy } from "../policies/settings/advanced-user.ts";

import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const rotate = (input: MutationInput) =>
  sellerJsonAction(
    input,
    (sellerContext) => settingsAdvancedUserPolicy.rotatePingSigningSecret(sellerContext),
    async () => {
      const secret = generateSecret();
      await rotatePingSigningSecret(input.context.currentSeller!.id, secret, new Date());
      return jsonResponse({ success: true, secret });
    },
  );

const disable = (input: MutationInput) =>
  sellerJsonAction(
    input,
    (sellerContext) => settingsAdvancedUserPolicy.disablePingSigning(sellerContext),
    async () => {
      await disablePingSigning(input.context.currentSeller!.id);
      return jsonResponse({ success: true });
    },
  );

registerMutations(
  { method: "POST", pattern: "/settings/advanced/rotate_ping_signing_secret", formats: ["json"], run: rotate },
  { method: "DELETE", pattern: "/settings/advanced/disable_ping_signing", formats: ["json"], run: disable },
);
