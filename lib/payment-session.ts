import { sha256Hex } from "./robokassa";

export const CHECKOUT_COOKIE = "poztender_checkout";

// The cookie identifies a browser; it never proves payment, so its lifetime is
// deliberately generous. It must comfortably outlive the longest access window
// (30 days for a subscription, counted from payment rather than from checkout),
// because a bank transfer can be confirmed days after the order was created.
// Access itself is still bounded by access_grants, which the server checks on
// every request.
export const CHECKOUT_COOKIE_MAX_AGE = 45 * 24 * 60 * 60;

/**
 * A checkout session secret. 32 bytes from the platform CSPRNG — the order id
 * and the Robokassa InvId are deliberately not reused here, because both are
 * predictable and one of them travels through the customer's URL bar.
 */
export function createSessionSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Only the hash is stored, so a database dump cannot be replayed as a session. */
export function hashSessionSecret(secret: string) {
  return sha256Hex(`poztender-checkout:${secret}`);
}

export function isWellFormedSecret(value: string | undefined | null): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function buildSetCookie(
  secret: string,
  options?: { secure?: boolean; maxAgeSeconds?: number },
) {
  // Secure is dropped only for plain-HTTP local development, where the browser
  // would otherwise refuse the cookie outright.
  const secure = options?.secure ?? true;
  // A recovery passes the grant's remaining lifetime so the restored session
  // cannot expire before the access it restores.
  const maxAge = Math.max(60, Math.round(options?.maxAgeSeconds ?? CHECKOUT_COOKIE_MAX_AGE));
  return [
    `${CHECKOUT_COOKIE}=${secret}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: the customer returns from Robokassa through a
    // top-level GET redirect, and Strict would withhold the cookie on exactly
    // that navigation.
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Reads the checkout secret out of a raw Cookie header. */
export function readSessionSecret(cookieHeader: string | null | undefined) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== CHECKOUT_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return isWellFormedSecret(value) ? value : null;
  }
  return null;
}

/**
 * A recovery token: 32 bytes from the platform CSPRNG, base64url — the same
 * strength as a checkout secret, and likewise stored only as a hash.
 *
 * It is not a credential for an order, it is a pointer to one. It resolves only
 * to an order that is already paid, it expires with the access it restores, and
 * everything downstream still requires a live access_grant.
 */
export function createAccessToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Namespaced separately from the checkout secret so the two can never collide. */
export function hashAccessToken(token: string) {
  return sha256Hex(`poztender-access-link:${token}`);
}

