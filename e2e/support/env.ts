/** Accounts and products created by `bin/rails db:seed` (db/seeds/020_development_staging). */
export const SEED = {
  sellerEmail: process.env.E2E_SELLER_EMAIL ?? "seller@gumroad.com",
  sellerPassword: process.env.E2E_SELLER_PASSWORD ?? "password",
  sellerUsername: "seller",
  freeProductPermalink: "demo",
  freeProductName: "Beautiful widget",
  // A confirmed seeded account (same password) that can buy: the seller's own purchases are test purchases and never reach the library.
  buyerEmail: "gumbo_audio@gumroad.com",
  membershipPermalink: "membershipdemo",
  // Development accepts this token on the two-factor page (User::DEFAULT_AUTH_TOKEN); the page prefills it.
  twoFactorToken: "000000",
};

/** Paid-card specs run only when Stripe *test* keys are configured; they never touch live Stripe. */
export const stripeTestKeysConfigured = () => {
  const publishable = process.env.STRIPE_PUBLISHABLE_KEY ?? "";
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  return publishable.startsWith("pk_test_") && secret.startsWith("sk_test_");
};

export const uniqueSuffix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const uniqueEmail = (prefix = "e2e") => `${prefix}+${uniqueSuffix()}@example.com`;
export const NEW_PASSWORD = "e2e-Passw0rd-local";
