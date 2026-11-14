# frozen_string_literal: true

# Writes the constant data the Checkout page reads (CheckoutPresenter#checkout_common and friends), for
# src/server/page-props/checkout/checkout-data.generated.json:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-checkout-data.rb
#
# Re-run it when Compliance::Countries (the countries gem, the blocked list), the subdivisions of Canada,
# STATES or the tip option defaults change.
require "json"

data = {
  "countries" => Compliance::Countries.for_select.to_h,
  "usStates" => STATES,
  "caProvinces" => Compliance::Countries.subdivisions_for_select(Compliance::Countries::CAN.alpha2).map(&:first),
  "usaCommonName" => Compliance::Countries::USA.common_name,
  "canCommonName" => Compliance::Countries::CAN.common_name,
  "maxAllowedCartProducts" => Cart::MAX_ALLOWED_CART_PRODUCTS,
  "cartSaveDebounceMs" => CheckoutPresenter::CART_SAVE_DEBOUNCE_DURATION_IN_SECONDS.in_milliseconds,
  "defaultTipOptions" => TipOptionsService::DEFAULT_TIP_OPTIONS,
  "defaultDefaultTipOption" => TipOptionsService::DEFAULT_DEFAULT_TIP_OPTION,
  "recaptchaCohortFeature" => CheckoutRecaptcha::COHORT_FEATURE.to_s,
}

File.write(File.expand_path("../src/server/page-props/checkout/checkout-data.generated.json", __dir__), "#{JSON.pretty_generate(data)}\n")
