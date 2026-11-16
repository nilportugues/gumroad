// PaypalRestApi (app/business/payments/charging/implementations/paypal/paypal_rest_api.rb) and PaypalIntegrationRestApi
// (app/business/payments/integrations/paypal_integration_rest_api.rb): the REST calls Rails makes to PayPal, with the same paths,
// headers, bodies and request ids. Rails' paypal-checkout-sdk returns a failed call (HttpError) as `{status_code, result}` instead
// of raising; so does this client. A failure below HTTP propagates.
import { getConfig } from "../infra/config.ts";
import { domainConfig } from "../infra/domain.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { partnerAuthToken, restEndpoint } from "../webhooks/paypal-webhook.ts";

export const PAYPAL_INTENT_CAPTURE = "CAPTURE";
const gumroadLogoUrl = () => getConfig("LOGO_URL", "https://gumroad.com/button/button_logo.png");
const PARTNER_REFERRAL_FEATURES = [
  "PAYMENT",
  "REFUND",
  "PARTNER_FEE",
  "DELAY_FUNDS_DISBURSEMENT",
  "ACCESS_MERCHANT_INFORMATION",
  "READ_SELLER_DISPUTE",
];

export type PaypalResponse = { statusCode: number; result: unknown };
type Json = Record<string, unknown> | unknown[];
export type PaypalMoney = { currency_code: string; value: string | number };

export type PaypalRequest = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers: Record<string, string>;
  body: string | null;
};
export type PaypalTransport = (
  request: PaypalRequest,
) => Promise<{ status: number; contentType: string; body: string }>;

const fetchTransport: PaypalTransport = async (request) => {
  const response = await outboundFetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === null ? {} : { body: request.body }),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
};

// PayPalHttp::Encoder / Decoder: a JSON content type parses to an object, anything else stays the raw string.
function decode(contentType: string, body: string): unknown {
  if (!/^application\/json/iu.test(contentType)) return body;
  return body.trim() === "" ? null : (JSON.parse(body) as unknown);
}

const moneyObject = (currency: string, value: string | number): PaypalMoney => ({
  currency_code: currency.toUpperCase(),
  value,
});

// The default Rails sends in PayPal-Request-Id: `Time.current.to_f.to_s.delete(".")`.
const timestamp = (now: () => number): string => String(now() / 1000).replace(".", "");

export type PaypalMerchantAccount = { charge_processor_merchant_id: string | null; currency: string | null };

export type PurchaseUnitInfo = {
  currency: string;
  total: string | number;
  shipping: string | number;
  tax: string | number;
  price: string | number;
  merchant_id: string;
  items?: unknown[];
  item_name?: string;
  unit_price?: string | number;
  quantity?: number;
  product_permalink?: string;
  descriptor?: string;
  fee: string | number;
  invoice_id?: string | null;
};

export type PaypalRestApiOptions = {
  transport?: PaypalTransport;
  authToken?: () => Promise<string>;
  now?: () => number;
  // UrlService.domain_with_protocol, for the billing agreement return URLs.
  domainWithProtocol?: () => string;
};

export class PaypalRestApi {
  private readonly transport: PaypalTransport;
  private readonly authToken: () => Promise<string>;
  private readonly now: () => number;
  private readonly domainWithProtocol: () => string;

  constructor(options: PaypalRestApiOptions = {}) {
    this.transport = options.transport ?? fetchTransport;
    this.authToken = options.authToken ?? partnerAuthToken;
    this.now = options.now ?? (() => Date.now());
    this.domainWithProtocol =
      options.domainWithProtocol ?? (() => `${domainConfig().protocol}://${domainConfig().domain}`);
  }

  // new_request / rest_api_headers.
  private async headers(): Promise<Record<string, string>> {
    return {
      Accept: "application/json",
      "Accept-Language": "en_US",
      Authorization: await this.authToken(),
      "Content-Type": "application/json",
      "PayPal-Partner-Attribution-Id": getConfig("PAYPAL_BN_CODE") ?? "",
      "PayPal-Request-Id": timestamp(this.now),
    };
  }

  // execute_request: a 2xx is the response, anything else is the HttpError Rails rescues into the same shape.
  private async execute(
    method: PaypalRequest["method"],
    path: string,
    headers: Record<string, string>,
    body: Json | null,
  ): Promise<PaypalResponse> {
    const response = await this.transport({
      method,
      url: `${restEndpoint()}${path}`,
      headers,
      // paypalhttp serializes the OpenStruct's `body: {}` default too, so a body-less GET or POST still sends "{}".
      body: JSON.stringify(body ?? {}),
    });
    return { statusCode: response.status, result: decode(response.contentType, response.body) };
  }

  generateBillingAgreementToken({ shipping = false }: { shipping?: boolean } = {}): Promise<PaypalResponse> {
    return this.send(
      "POST",
      "/v1/billing-agreements/agreement-tokens",
      {},
      {
        payer: { payment_method: "PAYPAL" },
        plan: {
          type: "CHANNEL_INITIATED_BILLING",
          merchant_preferences: {
            return_url: `${this.domainWithProtocol()}/paypal_ba_return`,
            cancel_url: `${this.domainWithProtocol()}/paypal_ba_cancel`,
            accepted_pymt_type: "INSTANT",
            skip_shipping_address: !shipping,
          },
        },
      },
    );
  }

  createBillingAgreement({ billingAgreementTokenId }: { billingAgreementTokenId: string }): Promise<PaypalResponse> {
    return this.send(
      "POST",
      "/v1/billing-agreements/agreements",
      { "PayPal-Request-Id": `create-billing-agreement-${billingAgreementTokenId}` },
      { token_id: billingAgreementTokenId },
    );
  }

  createOrder({ purchaseUnitInfo }: { purchaseUnitInfo: PurchaseUnitInfo }): Promise<PaypalResponse> {
    const extra: Record<string, string> = {};
    if (railsEnv() === "production" && purchaseUnitInfo.invoice_id)
      extra["PayPal-Request-Id"] = `create-order-${purchaseUnitInfo.invoice_id}`;
    extra.Prefer = "return=representation";
    return this.send("POST", "/v2/checkout/orders", extra, {
      intent: PAYPAL_INTENT_CAPTURE,
      purchase_units: [this.purchaseUnit(purchaseUnitInfo)],
      application_context: { brand_name: "Gumroad", shipping_preference: "NO_SHIPPING" },
    });
  }

  updateInvoiceId({ orderId, invoiceId }: { orderId: string; invoiceId: string }): Promise<PaypalResponse> {
    return this.send("PATCH", `/v2/checkout/orders/${orderId}`, { Prefer: "return=representation" }, [
      { op: "add", path: "/purchase_units/@reference_id=='default'/invoice_id", value: invoiceId },
    ]);
  }

  fetchOrder({ orderId }: { orderId: string }): Promise<PaypalResponse> {
    return this.send("GET", `/v2/checkout/orders/${orderId}`, {}, null);
  }

  capture({
    orderId,
    billingAgreementId,
  }: {
    orderId: string;
    billingAgreementId?: string | null;
  }): Promise<PaypalResponse> {
    return this.send(
      "POST",
      `/v2/checkout/orders/${orderId}/capture`,
      { "PayPal-Request-Id": `capture-${orderId}`, Prefer: "return=representation" },
      billingAgreementId ? { payment_source: { token: { id: billingAgreementId, type: "BILLING_AGREEMENT" } } } : null,
    );
  }

  // `orderForCapture` is Rails' `Purchase.where(stripe_transaction_id: capture_id).last` followed by fetch_order: it runs only
  // when the merchant account lacks the PayPal account id or currency, and returns the order to read them from.
  async refund({
    captureId,
    merchantAccount = null,
    amount = null,
    orderForCapture,
  }: {
    captureId: string;
    merchantAccount?: PaypalMerchantAccount | null;
    amount?: string | number | null;
    orderForCapture?: (
      captureId: string,
    ) => Promise<{ purchase_units?: { payee?: { merchant_id?: string }; amount?: { currency_code?: string } }[] }>;
  }): Promise<PaypalResponse> {
    let paypalAccountId = merchantAccount?.charge_processor_merchant_id || null;
    let currency = merchantAccount?.currency || null;
    if (!paypalAccountId || !currency) {
      if (!orderForCapture) throw new Error(`No purchase found for PayPal transaction id ${captureId}`);
      const order = await orderForCapture(captureId);
      const unit = order.purchase_units?.[0];
      if (unit) {
        paypalAccountId ||= unit.payee?.merchant_id ?? null;
        currency ||= unit.amount?.currency_code ?? null;
      }
    }
    return this.send(
      "POST",
      `/v2/payments/captures/${captureId}/refund`,
      {
        "PayPal-Request-Id": `refund-${captureId}-${amount ?? ""}-${timestamp(this.now)}`,
        Prefer: "return=representation",
        "Paypal-Auth-Assertion": this.authAssertion(paypalAccountId),
      },
      Number(amount) > 0 ? { amount: moneyObject(currency!, amount!) } : {},
    );
  }

  successfulResponse(response: PaypalResponse): boolean {
    return response.statusCode >= 200 && response.statusCode < 300;
  }

  fetchRefund({
    refundId,
    merchantAccount = null,
  }: {
    refundId: string;
    merchantAccount?: PaypalMerchantAccount | null;
  }): Promise<PaypalResponse> {
    const accountId = merchantAccount?.charge_processor_merchant_id;
    return this.send(
      "GET",
      `/v2/payments/refunds/${refundId}`,
      accountId ? { "Paypal-Auth-Assertion": this.authAssertion(accountId) } : {},
      null,
    );
  }

  fetchDispute({
    disputeId,
    merchantAccount,
  }: {
    disputeId: string;
    merchantAccount: PaypalMerchantAccount;
  }): Promise<PaypalResponse> {
    return this.send(
      "GET",
      `/v1/customer/disputes/${disputeId}`,
      { "Paypal-Auth-Assertion": this.authAssertion(merchantAccount.charge_processor_merchant_id) },
      null,
    );
  }

  // The multipart `input` part is what paypalhttp's FormPart encodes; no cassette records it, so it is left to the port that needs it.
  provideDisputeSupportingInfo(): never {
    throw new Error("provide-supporting-info sends multipart/form-data, which this client does not build yet");
  }

  private async send(
    method: PaypalRequest["method"],
    path: string,
    extraHeaders: Record<string, string>,
    body: Json | null,
  ): Promise<PaypalResponse> {
    return this.execute(method, path, { ...(await this.headers()), ...extraHeaders }, body);
  }

  // paypal_auth_assertion_header: an unsigned JWT naming the seller, issued by the partner client.
  private authAssertion(sellerMerchantId: string | null): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    return `${part({ alg: "none" })}.${part({ payer_id: sellerMerchantId, iss: getConfig("PAYPAL_PARTNER_CLIENT_ID") })}.`;
  }

  private purchaseUnit(info: PurchaseUnitInfo): Record<string, unknown> {
    const currency = info.currency;
    const unit: Record<string, unknown> = {
      amount: {
        currency_code: currency,
        value: info.total,
        breakdown: {
          shipping: moneyObject(currency, info.shipping),
          tax_total: moneyObject(currency, info.tax),
          item_total: moneyObject(currency, info.price),
        },
      },
      payee: { merchant_id: info.merchant_id },
      items:
        info.items && info.items.length > 0
          ? info.items
          : [
              {
                name: info.item_name ?? null,
                unit_amount: moneyObject(currency, info.unit_price!),
                quantity: info.quantity ?? null,
                sku: info.product_permalink ?? null,
              },
            ],
      soft_descriptor: info.descriptor ?? null,
      payment_instruction: {
        platform_fees: [
          {
            amount: moneyObject(currency, info.fee),
            payee: { email_address: getConfig("PAYPAL_PARTNER_MERCHANT_EMAIL") },
          },
        ],
      },
    };
    if (info.invoice_id) unit.invoice_id = info.invoice_id;
    return unit;
  }
}

export type PartnerReferralMerchant = { external_id: string; email: string | null };

// PaypalIntegrationRestApi: the partner calls take the caller's Authorization header and send their own two headers.
export class PaypalIntegrationRestApi {
  private readonly transport: PaypalTransport;
  private readonly now: () => number;

  constructor(
    private readonly merchant: PartnerReferralMerchant,
    private readonly options: { authorizationHeader: string },
    deps: { transport?: PaypalTransport; now?: () => number } = {},
  ) {
    this.transport = deps.transport ?? fetchTransport;
    this.now = deps.now ?? (() => Date.now());
  }

  private async call(method: "GET" | "POST", path: string, body: string | null): Promise<PaypalResponse> {
    const response = await this.transport({
      method,
      url: `${restEndpoint()}${path}`,
      headers: { "Content-Type": "application/json", Authorization: this.options.authorizationHeader },
      body,
    });
    return { statusCode: response.status, result: decode(response.contentType, response.body) };
  }

  createPartnerReferral(returnUrl: string): Promise<PaypalResponse> {
    return this.call("POST", "/v2/customer/partner-referrals", JSON.stringify(this.partnerReferralData(returnUrl)));
  }

  getMerchantAccountByMerchantId(paypalMerchantId: string): Promise<PaypalResponse> {
    return this.call(
      "GET",
      `/v1/customer/partners/${getConfig("PAYPAL_PARTNER_MERCHANT_ID") ?? ""}/merchant-integrations/${paypalMerchantId}`,
      null,
    );
  }

  private partnerReferralData(returnUrl: string): Record<string, unknown> {
    return {
      tracking_id: `${this.merchant.external_id}-${Math.trunc(this.now() / 1000)}`,
      email: this.merchant.email,
      partner_config_override: { return_url: returnUrl, partner_logo_url: gumroadLogoUrl() },
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "PAYPAL",
              integration_type: "THIRD_PARTY",
              third_party_details: { features: PARTNER_REFERRAL_FEATURES },
            },
          },
        },
      ],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
    };
  }
}
