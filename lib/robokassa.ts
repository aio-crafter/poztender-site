const PAYMENT_AMOUNT = "4900.00";

export const paymentProduct = {
  amount: PAYMENT_AMOUNT,
  description: "7-дневная калибровка радара АПС и СОУЭ",
  receiptName:
    "Информационно-аналитические услуги: 7-дневная калибровка тендерного радара АПС и СОУЭ",
} as const;

export interface RobokassaEnvironment {
  ROBOKASSA_MERCHANT_LOGIN?: string;
  ROBOKASSA_PASSWORD_1?: string;
  ROBOKASSA_PASSWORD_2?: string;
  ROBOKASSA_TEST_MODE?: string;
  ROBOKASSA_B2B_RECEIPT_CONFIRMED?: string;
}

export function isPaymentReady(env: RobokassaEnvironment) {
  const isTestPayment = env.ROBOKASSA_TEST_MODE === "true";
  const isLiveReceiptConfirmed =
    env.ROBOKASSA_B2B_RECEIPT_CONFIRMED === "true";

  return Boolean(
    env.ROBOKASSA_MERCHANT_LOGIN &&
      env.ROBOKASSA_PASSWORD_1 &&
      env.ROBOKASSA_PASSWORD_2 &&
      (isTestPayment || isLiveReceiptConfirmed),
  );
}

export function createInvoiceId() {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  // Robokassa accepts positive integers up to 2^63-1. Keeping 52 random bits
  // makes the value safe in JavaScript while leaving collisions negligible.
  return ((bytes[0] & 0x000fffff) * 0x100000000 + bytes[1] + 1).toString();
}

export function createReceipt() {
  return encodeURIComponent(
    JSON.stringify({
      items: [
        {
          name: paymentProduct.receiptName,
          quantity: 1,
          sum: Number(paymentProduct.amount),
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
  invoiceId: string;
  password: string;
  receipt: string;
  successUrl: string;
  failUrl: string;
}) {
  const signatureBase = [
    input.merchantLogin,
    paymentProduct.amount,
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

export async function createIntakeAccessToken(input: {
  invoiceId: string;
  outSum: string;
  expires: string;
  password: string;
}) {
  return sha256Hex(
    `poztender-intake:${input.invoiceId}:${input.outSum}:${input.expires}:${input.password}`,
  );
}

export async function isIntakeAccessValid(input: {
  invoiceId: string;
  outSum: string;
  expires: string;
  accessToken: string;
  password: string;
}) {
  if (
    !/^\d{1,19}$/.test(input.invoiceId) ||
    Number(input.outSum) !== Number(paymentProduct.amount) ||
    !/^\d{10}$/.test(input.expires) ||
    !/^[a-f\d]{64}$/i.test(input.accessToken)
  ) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const expires = Number(input.expires);
  if (expires <= now || expires > now + 7 * 24 * 60 * 60 + 300) return false;

  const expected = await createIntakeAccessToken(input);
  return safeEqualHex(input.accessToken, expected);
}

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
