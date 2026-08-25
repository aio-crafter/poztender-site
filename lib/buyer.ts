export type BuyerType = "individual" | "business";

export interface BuyerDetails {
  buyerType: BuyerType;
  /** Only ever set for a business buyer. */
  buyerInn: string | null;
  /** Only ever set for a business buyer. */
  buyerName: string | null;
}

export const BUYER_NAME_MAX_LENGTH = 200;

/**
 * Checksum for a Russian taxpayer number.
 *
 * Length alone is not enough: a ten-digit run of zeros is well-formed but not a
 * real INN, and this receipt data ends up on a tax document. The weights below
 * are the ones defined by the Federal Tax Service — ten digits for an
 * organisation, twelve for a sole trader, each with its own control digits.
 */
function hasValidInnChecksum(inn: string) {
  const digits = [...inn].map(Number);
  const checksum = (weights: number[]) =>
    (weights.reduce((total, weight, index) => total + weight * digits[index], 0) % 11) % 10;

  if (digits.length === 10) {
    return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[9];
  }
  if (digits.length === 12) {
    return (
      checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[10] &&
      checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[11]
    );
  }
  return false;
}

export function isValidInn(value: string) {
  if (!/^(\d{10}|\d{12})$/.test(value)) return false;
  // A run of zeros satisfies the checksum arithmetic (every weighted sum is
  // zero) but is not an INN anyone holds, and it would go onto a tax document.
  if (/^0+$/.test(value)) return false;
  return hasValidInnChecksum(value);
}

export type BuyerValidation =
  | { ok: true; buyer: BuyerDetails }
  | { ok: false; error: "buyer" | "inn" | "name" };

/**
 * Resolves the buyer from raw form input. Anything that is not exactly the
 * string "business" is treated as an individual, so a tampered or absent buyer
 * type can only ever downgrade to the case that requires no tax details — it
 * can never let a business buyer through without them.
 */
export function validateBuyer(input: {
  buyerType?: string | null;
  buyerInn?: string | null;
  buyerName?: string | null;
}): BuyerValidation {
  const buyerType: BuyerType = input.buyerType === "business" ? "business" : "individual";

  if (buyerType === "individual") {
    // Requisites are dropped rather than carried along: an individual buyer has
    // none, and storing whatever the form happened to send would put unverified
    // data next to a payment record.
    return { ok: true, buyer: { buyerType, buyerInn: null, buyerName: null } };
  }

  const buyerInn = (input.buyerInn ?? "").replace(/\s/g, "");
  if (!isValidInn(buyerInn)) return { ok: false, error: "inn" };

  const buyerName = (input.buyerName ?? "").trim().replace(/\s+/g, " ");
  if (buyerName.length < 2 || buyerName.length > BUYER_NAME_MAX_LENGTH) {
    return { ok: false, error: "name" };
  }

  return { ok: true, buyer: { buyerType, buyerInn, buyerName } };
}
