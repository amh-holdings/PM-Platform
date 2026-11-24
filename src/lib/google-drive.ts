// Saving files to Google Drive as Phil (phil@amh.holdings), server side.
//
// The app holds Phil's Drive sign-in: the OAuth client and refresh token his
// post-upload script already uses (scripts/gdrive_token.json), set in Vercel
// as GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and
// GOOGLE_DRIVE_REFRESH_TOKEN. Without them Drive is off and packages stay in
// the app for download.

export function driveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
  );
}

/** The folder id from a Drive folder link, or the id itself. */
export function folderIdFromLink(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}

async function accessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_DRIVE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "",
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "",
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(
      body.error === "invalid_grant"
        ? "Phil's Google Drive sign-in has expired. Refresh GOOGLE_DRIVE_REFRESH_TOKEN in Vercel."
        : `Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`,
    );
  }
  return body.access_token;
}

/** Upload a PDF into a folder (shared drives included). Returns its id and link. */
export async function uploadPdfToDrive(
  folderId: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ id: string; url: string }> {
  const token = await accessToken();
  // Resumable upload: one call for the metadata, one for the bytes, so a
  // 40 MB drawing set goes up the same way as a one-page report.
  const start = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/pdf",
        "X-Upload-Content-Length": String(bytes.byteLength),
      },
      body: JSON.stringify({ name, parents: [folderId], mimeType: "application/pdf" }),
    },
  );
  const session = start.headers.get("location");
  if (!start.ok || !session) {
    const t = await start.text().catch(() => "");
    throw new Error(/notFound|File not found/i.test(t)
      ? "Phil's Drive can't see that folder. Check the submittal folder link."
      : `Drive refused the upload (${start.status}).`);
  }
  const put = await fetch(session, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.byteLength) },
    body: Buffer.from(bytes),
  });
  const file = (await put.json().catch(() => ({}))) as { id?: string; webViewLink?: string };
  if (!put.ok || !file.id) throw new Error(`Drive upload failed (${put.status}).`);
  return { id: file.id, url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view` };
}

/** The folder's name, to show which folder the link points at. */
export async function driveFolderName(folderId: string): Promise<string | null> {
  try {
    const token = await accessToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=name,mimeType&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const f = (await res.json()) as { name?: string; mimeType?: string };
    return f.mimeType === "application/vnd.google-apps.folder" ? f.name ?? null : null;
  } catch {
    return null;
  }
}
