import { randomBytes } from "node:crypto";

// Opaque, URL-safe secure-link token. 32 bytes of entropy, base64url. The token
// is the only credential the scoped link carries, so it must be unguessable.
export function generateInspectionToken(): string {
  return randomBytes(32).toString("base64url");
}

// A link is usable only if active and not past its expiry.
export function isLinkUsable(link: {
  active: boolean;
  expires_at: string | null;
}): boolean {
  if (!link.active) return false;
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    return false;
  }
  return true;
}
