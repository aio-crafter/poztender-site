import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { accessGrants, intakeSubmissions, type IntakeSubmission } from "../db/schema";
import type { IntakeSubmission as ValidatedIntake } from "./intake";

export type IntakeStoreOutcome =
  | { outcome: "stored"; submission: IntakeSubmission }
  | { outcome: "already-submitted"; submission: IntakeSubmission | null };

/**
 * Records a validated intake form and spends the grant, in one transaction.
 *
 * This is the whole point of the table: acceptance is decided here, by
 * PostgreSQL, and not by whether Telegram and SMTP happen to be reachable a
 * moment later. Once this commits the form is accepted, and every delivery
 * that follows is a retryable side effect.
 *
 * Idempotency has two independent guards. The conditional UPDATE is the
 * serialisation point: under READ COMMITTED a second concurrent transaction
 * blocks on the grant row, then re-evaluates `used_at IS NULL` against the
 * committed version and matches nothing, so exactly one caller proceeds. The
 * UNIQUE constraint on `order_id` is the second: even if the predicate above
 * were ever refactored away, the database still refuses a second row.
 */
export async function storeIntakeSubmission(input: {
  orderId: number;
  grantId: number;
  data: ValidatedIntake;
}): Promise<IntakeStoreOutcome> {
  const db = getDb();
  const { orderId, grantId, data } = input;

  return db.transaction(async (tx) => {
    const existing = async () => {
      const [row] = await tx
        .select()
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.grantId, grantId))
        .limit(1);
      return row ?? null;
    };

    const claimed = await tx
      .update(accessGrants)
      .set({ usedAt: new Date() })
      .where(and(eq(accessGrants.id, grantId), isNull(accessGrants.usedAt)))
      .returning({ id: accessGrants.id });

    if (claimed.length === 0) {
      // Someone already submitted this form: a double click, a retry, or the
      // other half of a concurrent pair. Their row stands; nothing is written.
      return { outcome: "already-submitted", submission: await existing() };
    }

    const [stored] = await tx
      .insert(intakeSubmissions)
      .values({
        orderId,
        grantId,
        company: data.company,
        inn: data.inn,
        contactName: data.contactName,
        email: data.email,
        telegram: data.telegram,
        replyChannel: data.replyChannel,
        regions: data.regions,
        workTypes: data.workTypes,
        budget: data.budget,
        licenses: data.licenses,
        exclusions: data.exclusions,
      })
      .onConflictDoNothing({ target: intakeSubmissions.orderId })
      .returning();

    // Unreachable while the grant and the submission are written together, and
    // handled anyway: reporting the stored row beats rolling back a form the
    // customer has already been told about.
    if (!stored) return { outcome: "already-submitted", submission: await existing() };

    return { outcome: "stored", submission: stored };
  });
}

/**
 * Records that a notification reached its destination.
 *
 * Deliberately separate from the transaction above: delivery happens after the
 * commit, and a failure to stamp must never undo an accepted form. Callers
 * treat this as best effort — an unstamped row is simply picked up again by
 * scripts/resend-intake-notifications.mjs.
 */
export async function markIntakeNotified(
  submissionId: number,
  channels: { telegram?: boolean; email?: boolean },
): Promise<void> {
  const now = new Date();
  const values: { telegramNotifiedAt?: Date; emailNotifiedAt?: Date } = {};
  if (channels.telegram) values.telegramNotifiedAt = now;
  if (channels.email) values.emailNotifiedAt = now;
  if (Object.keys(values).length === 0) return;

  const db = getDb();
  await db
    .update(intakeSubmissions)
    .set(values)
    .where(eq(intakeSubmissions.id, submissionId));
}

/** The stored form for one order, if it has one. */
export async function findIntakeSubmission(orderId: number): Promise<IntakeSubmission | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(intakeSubmissions)
    .where(eq(intakeSubmissions.orderId, orderId))
    .limit(1);
  return row ?? null;
}
