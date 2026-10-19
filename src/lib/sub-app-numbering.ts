// Which number the next subcontractor application gets, and which recorded
// applications a later one replaced.
//
// A rejected application does not consume its number. The sub revises the
// same G702 and sends it back under the same application number, because
// that is what their own paperwork, their lien waivers and their accounting
// all say. Numbering straight off the highest row we hold pushed the
// resubmission to the next number and left our file disagreeing with theirs.
//
// Zarina, on Pyramid: "I rejected the previous pay app 3, the new approved
// should still be pay app 3."
//
// This needs migration 0078: the plain unique key on
// (subcontractor_id, app_number) is replaced by a partial one that ignores
// rejected rows, so a rejected 3 and a live 3 can sit side by side.
//
// Continuity is a separate question and already has a separate answer: the
// baseline a bill opens from excludes rejected applications (sub-billing-run,
// and recordSubBill). This file is only about the label on the front page.

export type NumberedApp = {
  app_number: number;
  status: string;
};

export function isRejected(app: { status: string }): boolean {
  return app.status === "rejected";
}

/**
 * The number to put on the next application.
 *
 * The highest LIVE number plus one. A rejected application is skipped, so the
 * next bill reuses the number it was refused under. With nothing on record at
 * all, or nothing but rejections, the next one is 1.
 */
export function nextAppNumber(apps: readonly NumberedApp[]): number {
  let highest = 0;
  for (const a of apps) {
    if (isRejected(a)) continue;
    if (a.app_number > highest) highest = a.app_number;
  }
  return highest + 1;
}

/**
 * Whether a new application at this number replaces a rejected one.
 *
 * Used to say so on the entry form, so nobody wonders why the number did not
 * move on.
 */
export function replacesRejected(
  apps: readonly NumberedApp[],
  appNumber: number,
): boolean {
  return apps.some((a) => isRejected(a) && a.app_number === appNumber);
}

/**
 * The ids of rejected applications whose number a live application now
 * carries. The bill list marks these superseded, so two rows reading "#3" are
 * self-explaining rather than a mystery.
 *
 * A rejected application whose number nobody has reused is NOT superseded. It
 * is simply refused and still waiting to be replaced, which is a different
 * thing to tell somebody.
 */
export function supersededAppIds<T extends NumberedApp & { id: string }>(
  apps: readonly T[],
): Set<string> {
  const live = new Set<number>();
  for (const a of apps) if (!isRejected(a)) live.add(a.app_number);
  const out = new Set<string>();
  for (const a of apps) if (isRejected(a) && live.has(a.app_number)) out.add(a.id);
  return out;
}

/**
 * Newest first, with a resubmission above the rejection it replaced.
 *
 * Ordering on the number alone stopped being enough the moment two rows could
 * share one. Within a number the live application sorts first, then the most
 * recently entered, so "the newest bill" is a stable answer rather than
 * whichever row the database happened to return first.
 */
export function compareAppsNewestFirst(
  a: NumberedApp & { created_at?: string | null },
  b: NumberedApp & { created_at?: string | null },
): number {
  if (a.app_number !== b.app_number) return b.app_number - a.app_number;
  const aRej = isRejected(a) ? 1 : 0;
  const bRej = isRejected(b) ? 1 : 0;
  if (aRej !== bRej) return aRej - bRej;
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

/**
 * The newest application that still counts: the one every "already billed"
 * figure should read from.
 *
 * Never a rejected one. Reading billed-to-date off a bill AHC refused reports
 * the sub as further along than anybody agreed they were, and on Pyramid that
 * was 326,390.50 billed to date against the 310,236.89 actually recorded.
 */
export function newestLiveApp<T extends NumberedApp & { created_at?: string | null }>(
  apps: readonly T[],
): T | null {
  const live = apps.filter((a) => !isRejected(a));
  if (!live.length) return null;
  return [...live].sort(compareAppsNewestFirst)[0];
}
