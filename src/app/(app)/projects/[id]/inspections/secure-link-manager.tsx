"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createSecureLink, revokeSecureLink } from "./inspection-actions";

type Sub = { id: string; company_name: string };
type LinkRow = {
  id: string;
  subName: string;
  label: string | null;
  token: string;
  active: boolean;
  expires_at: string | null;
  last_used_at: string | null;
};

export function SecureLinkManager({
  projectId,
  subs,
  links,
}: {
  projectId: string;
  subs: Sub[];
  links: LinkRow[];
}) {
  const [subId, setSubId] = useState(subs[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  // Resolve absolute URL on the client so copy-link works in any environment.
  if (typeof window !== "undefined" && !origin) setOrigin(window.location.origin);

  function linkUrl(token: string) {
    return `${origin}/inspect/${token}`;
  }

  function handleCreate() {
    if (!subId) return;
    setError(null);
    startTransition(async () => {
      const res = await createSecureLink({
        projectId,
        subcontractorId: subId,
        label: label.trim() || null,
      });
      if (!res.ok) setError(res.error);
      else setLabel("");
    });
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Scoped secure links</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Issue a no-login link to a subcontractor. They can submit inspections
        for their own scope only. No portal, no account.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Subcontractor</Label>
          <select
            value={subId}
            onChange={(e) => setSubId(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {subs.length === 0 && <option value="">No subs on project</option>}
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.company_name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Label (optional)</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Grading crew"
            className="h-9 w-48"
          />
        </div>
        <Button onClick={handleCreate} disabled={pending || !subId}>
          {pending ? "Creating…" : "Create link"}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {links.length > 0 && (
        <div className="mt-4 space-y-2">
          {links.map((l) => (
            <div
              key={l.id}
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs",
                !l.active && "opacity-50",
              )}
            >
              <div>
                <span className="font-medium">{l.subName}</span>
                {l.label ? ` · ${l.label}` : ""}
                <div className="font-mono text-[11px] text-muted-foreground">
                  {origin ? linkUrl(l.token) : `/inspect/${l.token}`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={l.active ? "text-green-700" : "text-muted-foreground"}>
                  {l.active ? "Active" : "Revoked"}
                </span>
                {l.active && (
                  <RevokeButton linkId={l.id} projectId={projectId} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RevokeButton({
  linkId,
  projectId,
}: {
  linkId: string;
  projectId: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await revokeSecureLink(linkId, projectId);
        })
      }
    >
      Revoke
    </Button>
  );
}
