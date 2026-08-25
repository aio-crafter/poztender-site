import {
  hasTelegramToken as hasTelegramTokenImpl,
  sendOwnerMessage as sendOwnerMessageImpl,
} from "./telegram.mjs";

export interface TelegramEnvironment {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
  TELEGRAM_OWNER_USERNAME?: string;
  TELEGRAM_RELAY_AUTH_TOKEN?: string;
  TELEGRAM_RELAY_SECRET?: string;
  TELEGRAM_RELAY_URL?: string;
}

export type TelegramDelivery =
  | { ok: true; via: "relay" | "direct" }
  | { ok: false; reason: "not-configured" | "no-chat-id" | "request-failed" | "rejected" };

/**
 * The transport itself lives in telegram.mjs so the administrative scripts,
 * which run from source without a build step, share one implementation of the
 * relay-then-direct fallback. These wrappers add nothing but the types.
 */
export function hasTelegramToken(env: TelegramEnvironment): boolean {
  return hasTelegramTokenImpl(env);
}

export function sendOwnerMessage(
  env: TelegramEnvironment,
  text: string,
  logPrefix: string,
): Promise<TelegramDelivery> {
  return sendOwnerMessageImpl(env, text, logPrefix) as Promise<TelegramDelivery>;
}
