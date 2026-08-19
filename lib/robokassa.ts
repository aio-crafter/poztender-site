const PAYMENT_AMOUNT = "4900.00";
const SUBSCRIPTION_AMOUNT = "7900.00";

export const paymentProduct = {
  amount: PAYMENT_AMOUNT,
  description: "7-дневная калибровка радара АПС и СОУЭ",
  receiptName:
    "Информационно-аналитические услуги: 7-дневная калибровка тендерного радара АПС и СОУЭ",
} as const;

export const subscriptionProduct = {
  amount: SUBSCRIPTION_AMOUNT,
  description: "Ежемесячное обслуживание тендерного радара АПС и СОУЭ",
  receiptName:
    "Информационно-аналитические услуги: ежемесячное обслуживание тендерного радара АПС и СОУЭ",
} as const;

export type PaymentPlan = "pilot" | "subscription";

export function productForPlan(plan: string | null | undefined) {
  return plan === "subscription" ? subscriptionProduct : paymentProduct;
}

// Robokassa documents OutSum as a decimal string with a dot separator, but the
// number of fractional digits is not fixed: checkout sends "4900.00" while
// notifications arrive with two decimals in test mode and six in live mode
// ("4900.000000"). So the amount must be compared numerically, never as a
// string. The pattern runs first because bare Number() also accepts forms
// Robokassa never sends — " 4900", "+4900", "4.9e3", "0x1324" — and those must
// not be able to masquerade as a known tariff.
const OUT_SUM_PATTERN = /^\d{1,10}(?:\.\d{1,6})?$/;

export function planForAmount(outSum: string): PaymentPlan | null {
  if (typeof outSum !== "string" || !OUT_SUM_PATTERN.test(outSum)) return null;

  const amount = Number(outSum);
  if (amount === Number(paymentProduct.amount)) return "pilot";
  if (amount === Number(subscriptionProduct.amount)) return "subscription";
  return null;
}

export interface RobokassaEnvironment {
  ROBOKASSA_MERCHANT_LOGIN?: string;
  ROBOKASSA_PASSWORD_1?: string;
  ROBOKASSA_PASSWORD_2?: string;
  ROBOKASSA_TEST_MODE?: string;
  ROBOKASSA_B2B_RECEIPT_CONFIRMED?: string;
}

export type PaymentMode = "test" | "live";

/**
 * Why the payment channel is closed. Every value is a fixed identifier that
 * names the misconfigured variable — never its value — so it is safe to log.
 */
export type PaymentModeBlockReason =
  | "missing-credentials"
  | "ambiguous-ROBOKASSA_TEST_MODE"
  | "ambiguous-ROBOKASSA_B2B_RECEIPT_CONFIRMED"
  | "live-blocked-until-receipt-confirmed";

export type PaymentModeResult =
  | { mode: PaymentMode; reason: null }
  | { mode: null; reason: PaymentModeBlockReason };

// Only the exact strings "true" and "false" count. Anything else — unset,
// "True", "TRUE", "1", "yes", a stray trailing space — is ambiguous. Treating
// ambiguity as `false` is what made a typo in ROBOKASSA_TEST_MODE silently
// select live mode and charge real cards, so ambiguity must fail closed.
function readStrictFlag(value: string | undefined) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Resolves which Robokassa mode the current environment authorises, or refuses
 * to pick one. Live mode requires two independent, explicit confirmations:
 * ROBOKASSA_TEST_MODE=false *and* ROBOKASSA_B2B_RECEIPT_CONFIRMED=true. Test
 * mode requires ROBOKASSA_TEST_MODE=true. There is deliberately no path that
 * reaches live mode by omission.
 */
export function resolvePaymentMode(env: RobokassaEnvironment): PaymentModeResult {
  if (
    !env.ROBOKASSA_MERCHANT_LOGIN ||
    !env.ROBOKASSA_PASSWORD_1 ||
    !env.ROBOKASSA_PASSWORD_2
  ) {
    return { mode: null, reason: "missing-credentials" };
  }

  const testMode = readStrictFlag(env.ROBOKASSA_TEST_MODE);
  if (testMode === null) {
    return { mode: null, reason: "ambiguous-ROBOKASSA_TEST_MODE" };
  }
  if (testMode) return { mode: "test", reason: null };

  const receiptConfirmed = readStrictFlag(env.ROBOKASSA_B2B_RECEIPT_CONFIRMED);
  if (receiptConfirmed === null) {
    return { mode: null, reason: "ambiguous-ROBOKASSA_B2B_RECEIPT_CONFIRMED" };
  }
  if (!receiptConfirmed) {
    return { mode: null, reason: "live-blocked-until-receipt-confirmed" };
  }

  return { mode: "live", reason: null };
}

export function isPaymentReady(env: RobokassaEnvironment) {
  return resolvePaymentMode(env).mode !== null;
}

export function createInvoiceId() {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  // Robokassa accepts positive integers up to 2^63-1. Keeping 52 random bits
  // makes the value safe in JavaScript while leaving collisions negligible.
  return ((bytes[0] & 0x000fffff) * 0x100000000 + bytes[1] + 1).toString();
}

export function createReceipt(product: { amount: string; receiptName: string }) {
  return encodeURIComponent(
    JSON.stringify({
      items: [
        {
          name: product.receiptName,
          quantity: 1,
          sum: Number(product.amount),
          payment_method: "full_prepayment",
          payment_object: "service",
          tax: "none",
        },
      ],
    }),
  );
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createPaymentSignature(input: {
  merchantLogin: string;
  amount: string;
  invoiceId: string;
  password: string;
  receipt: string;
  successUrl: string;
  failUrl: string;
}) {
  const signatureBase = [
    input.merchantLogin,
    input.amount,
    input.invoiceId,
    input.receipt,
    input.successUrl,
    "GET",
    input.failUrl,
    "GET",
    input.password,
  ].join(":");

  return sha256Hex(signatureBase);
}

export async function createResultSignature(input: {
  outSum: string;
  invoiceId: string;
  password: string;
}) {
  return sha256Hex(`${input.outSum}:${input.invoiceId}:${input.password}`);
}

// NOTE: intake access used to be a stateless hash derived from InvId, OutSum
// and an expiry, recomputed on every request. That made a paid SuccessURL
// replayable forever — each visit minted a fresh window — and the link was
// transferable to anyone. Access now lives in `access_grants`, created once
// inside the ResultURL transaction. See lib/orders.ts.

export function safeEqualHex(left: string, right: string) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
