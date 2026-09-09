// A work pin's notes column carries two different things: the sub's own note
// about the work, and the audit trail of every correction round ("[Fix
// 2026-09-09] ...", plus what changed). They share one column because there is
// no dedicated table for the trail yet.
//
// That is fine while the notes are read-only, but the sub can now edit the note
// when correcting a rejected pin - and the trail is exactly what the CM reads
// to see what moved. So the two are split apart here: the editor only ever
// shows the body, and the server re-attaches the trail on write.

const FIX_PREFIX = "[Fix ";

export type SplitNotes = {
  /** The sub's own note about the work. Editable. */
  body: string;
  /** Correction history, newest last. Append-only. */
  trail: string[];
};

export function splitPinNotes(notes: string | null | undefined): SplitNotes {
  if (!notes) return { body: "", trail: [] };
  const blocks = notes.split("\n\n");
  const body: string[] = [];
  const trail: string[] = [];
  for (const b of blocks) {
    if (b.startsWith(FIX_PREFIX)) trail.push(b);
    else body.push(b);
  }
  return { body: body.join("\n\n").trim(), trail };
}

export function joinPinNotes(body: string, trail: string[]): string | null {
  const parts = [body.trim(), ...trail].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : null;
}
