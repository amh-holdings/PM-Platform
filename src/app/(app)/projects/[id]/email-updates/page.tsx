import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { guardCapability, readDbRole } from "@/lib/roles-server";
import { formatDate } from "@/lib/format";
import {
  DECIDER_ROLES,
  EMAIL_UPDATE_TABS,
  KIND_LABEL,
  canDecide,
  requiresPhil,
  type EmailUpdateKind,
} from "@/lib/email-updates";

import { DecisionButtons } from "./decision-buttons";

type Params = { id: string };

const STATUS_LABEL: Record<string, string> = {
  proposed: "Waiting",
  approved: "Approved",
  applied: "Applied",
  rejected: "Rejected",
  undone: "Undone",
};

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (/email_updates/.test(error.message ?? "") &&
      /does not exist|schema cache/i.test(error.message ?? ""))
  );
}

export default async function EmailUpdatesPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: { tab?: string };
}) {
  await guardCapability("reviewEmailUpdates");
  const dbRole = await readDbRole();

  if (!(DECIDER_ROLES as readonly string[]).includes(dbRole)) {
    return (
      <p className="text-sm text-muted-foreground">
        Email updates go to Phil and Zarina. Nothing here needs you.
      </p>
    );
  }

  const tab = EMAIL_UPDATE_TABS.find((t) => t.key === searchParams.tab) ?? EMAIL_UPDATE_TABS[0];
  const supabase = createClient();

  const [rowsRes, countRes] = await Promise.all([
    supabase
      .from("email_updates")
      .select("*")
      .eq("project_id", params.id)
      .in("status", [...tab.statuses])
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("email_updates")
      .select("id", { count: "exact", head: true })
      .eq("project_id", params.id)
      .eq("status", "proposed"),
  ]);

  if (isMissingTable(rowsRes.error)) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        Email updates need migration 0080 run in Supabase before this page can load.
      </div>
    );
  }
  if (rowsRes.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load email updates: {rowsRes.error.message}
      </div>
    );
  }

  const rows = rowsRes.data ?? [];
  const waiting = countRes.count ?? 0;

  // Task names for the "matched to" column, in one read.
  const taskIds = Array.from(
    new Set(
      rows
        .filter((r) => r.target_table === "schedule_tasks" && r.target_id)
        .map((r) => r.target_id as string),
    ),
  );
  const taskNames = new Map<string, string>();
  if (taskIds.length > 0) {
    const { data } = await supabase
      .from("schedule_tasks")
      .select("id, wbs_code, task_name")
      .in("id", taskIds);
    for (const t of data ?? []) taskNames.set(t.id, `${t.wbs_code} ${t.task_name}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Email updates</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Changes the email automation made or wants to make on this project. Applied changes
          can be undone. Proposed ones wait for Zarina or Phil. Percent complete, owner
          disputes and change orders wait for Phil. Every row links to the email it came from.
        </p>
      </div>

      <nav className="flex flex-wrap gap-2 text-sm">
        {EMAIL_UPDATE_TABS.map((t) => (
          <Link
            key={t.key}
            href={`/projects/${params.id}/email-updates?tab=${t.key}`}
            className={
              t.key === tab.key
                ? "rounded-md bg-primary px-3 py-1.5 text-primary-foreground"
                : "rounded-md border px-3 py-1.5 hover:bg-accent"
            }
          >
            {t.label}
            {t.key === "proposed" && waiting > 0 ? ` (${waiting})` : ""}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Received</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">What changes</th>
                <th className="px-3 py-2">Matched to</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const blocked = (() => {
                  const decision = r.status === "applied" ? "undo" : "reject";
                  if (r.status !== "proposed" && r.status !== "applied") return null;
                  const res = canDecide(r, dbRole, decision);
                  return res.ok ? null : res.reason;
                })();
                const matched =
                  r.target_id && taskNames.get(r.target_id)
                    ? taskNames.get(r.target_id)
                    : r.target_id
                      ? "Record removed"
                      : "No match";
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatDate(r.source_received_at ?? r.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {r.source_url ? (
                          <a href={r.source_url} target="_blank" rel="noreferrer" className="underline">
                            {r.source_subject || "(no subject)"}
                          </a>
                        ) : (
                          r.source_subject || "(no subject)"
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{r.source_from}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {KIND_LABEL[r.kind as EmailUpdateKind] ?? r.kind}
                      {requiresPhil(r) && (
                        <div className="text-xs text-amber-700 dark:text-amber-400">Phil only</div>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.summary}</td>
                    <td className="px-3 py-2">
                      <div>{matched}</div>
                      {r.match_reason && (
                        <div className="text-xs text-muted-foreground">{r.match_reason}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {STATUS_LABEL[r.status] ?? r.status}
                      {r.auto_applied && <div className="text-xs text-muted-foreground">Automatic</div>}
                      {r.decided_at && (
                        <div className="text-xs text-muted-foreground">{formatDate(r.decided_at)}</div>
                      )}
                      {r.decision_note && (
                        <div className="text-xs text-muted-foreground">{r.decision_note}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {(r.status === "proposed" || r.status === "applied") && (
                        <DecisionButtons
                          projectId={params.id}
                          updateId={r.id}
                          status={r.status}
                          canApprove={r.kind !== "unmatched"}
                          blockedReason={blocked}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
