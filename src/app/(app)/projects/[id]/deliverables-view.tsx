"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  CATALOG_BY_KEY,
  DECISION_LABEL,
  DELIVERABLE_STATES,
  DEVICE_HINT,
  EXHIBIT_S,
  EXHIBIT_S_TABS,
  PART_LABEL,
  PART_MILESTONE,
  sectionLabel,
  STATE_LABEL,
  TRANSMITTED_FOR,
  TRANSMITTED_LABEL,
  defaultTransmittedFor,
  submittalNumber,
  type TransmittedFor,
  tabOf,
  deliverableFileName,
  isDone,
  nextPeriod,
  REVIEW_DECISIONS,
  type CatalogItem,
  type DeliverablePart,
  type DeliverableState,
  type ExhibitSTab,
  type ReviewDecision,
} from "@/lib/exhibit-s";
import { cn } from "@/lib/utils";

import {
  addDeliverableDevice,
  addRevision,
  createSubmittal,
  setSubmittalPrefix,
  loadExhibitS,
  removeDeliverableDevice,
  setRevisionDecision,
  setSpvName,
  updateDeliverable,
  type DeliverablePatch,
} from "./deliverables-actions";

export type DeliverableRow = {
  id: string;
  catalog_key: string;
  device_id: string;
  control_no: number | null;
  state: string;
  version_date: string | null;
  submitted_on: string | null;
  file_url: string | null;
  notes: string | null;
};

const STATE_TONE: Record<string, string> = {
  not_started: "bg-muted text-muted-foreground",
  in_progress: "bg-amber-100 text-amber-900",
  submitted: "bg-blue-100 text-blue-900",
  accepted: "bg-emerald-100 text-emerald-900",
  missed: "bg-red-100 text-red-900",
  not_applicable: "bg-muted text-muted-foreground line-through",
};

export type RevisionRow = {
  id: string;
  deliverable_id: string;
  rev_no: number;
  version_date: string;
  submitted_on: string | null;
  decision: string;
  decided_on: string | null;
  notes: string | null;
  /** The submittal it went out on (0093). */
  submittal_id?: string | null;
};

export type SubmittalRow = {
  id: string;
  submittal_no: number;
  submitted_on: string;
  transmitted_for: string;
  transmitted_other: string | null;
  project_label: string | null;
  to_name: string | null;
  from_name: string | null;
  cc: string | null;
  subject: string | null;
  notes: string | null;
  requested_response_date: string | null;
};

/** What the submittal form starts with. */
type SubmittalDraft = {
  items: { deliverableId: string; versionDate: string; note: string }[];
  transmittedFor: TransmittedFor;
};

const coverHref = (id: string) => `/submittal-cover/${id}`;

const DECISION_TONE: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-900",
  approved: "bg-emerald-100 text-emerald-900",
  approved_as_noted: "bg-emerald-100 text-emerald-900",
  revise_resubmit: "bg-amber-100 text-amber-900",
  rejected: "bg-red-100 text-red-900",
};

type Filter = "open" | "all" | "done";

export function DeliverablesView({
  projectId,
  spvName,
  projectName,
  rows,
  revisions,
  revisionsEnabled,
  submittals,
  submittalsEnabled,
  submittalPrefix,
  userName,
  today,
}: {
  projectId: string;
  spvName: string | null;
  projectName: string;
  rows: DeliverableRow[];
  revisions: RevisionRow[];
  revisionsEnabled: boolean;
  submittals: SubmittalRow[];
  submittalsEnabled: boolean;
  submittalPrefix: string | null;
  userName: string;
  today: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("open");
  const [tab, setTab] = useState<ExhibitSTab | "log">("design");
  // Rows ticked for one submittal, and the open submittal form.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<SubmittalDraft | null>(null);
  const [created, setCreated] = useState<{ id: string; label: string } | null>(null);
  const [prefixDraft, setPrefixDraft] = useState(submittalPrefix ?? "");
  // The section shown inside the tab, "part|section", or "all".
  const [sub, setSub] = useState<string | null>(null);
  const [spvDraft, setSpvDraft] = useState(spvName ?? projectName);
  const spv = spvName ?? projectName;

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) setError(res.error ?? "Something went wrong");
    else startTransition(() => router.refresh());
    return res.ok;
  }

  const byKey = useMemo(() => {
    const m = new Map<string, DeliverableRow[]>();
    for (const r of rows) (m.get(r.catalog_key) ?? m.set(r.catalog_key, []).get(r.catalog_key)!).push(r);
    m.forEach((list, key) => {
      const newestFirst = CATALOG_BY_KEY.get(key)?.perDevice === "period";
      list.sort((a, b) => (newestFirst ? -1 : 1) * a.device_id.localeCompare(b.device_id, undefined, { numeric: true }));
    });
    return m;
  }, [rows]);

  const revsByRow = useMemo(() => {
    const m = new Map<string, RevisionRow[]>();
    for (const r of revisions) (m.get(r.deliverable_id) ?? m.set(r.deliverable_id, []).get(r.deliverable_id)!).push(r);
    return m;
  }, [revisions]);

  const subById = useMemo(() => new Map(submittals.map((x) => [x.id, x])), [submittals]);
  const subLabel = (id: string | null | undefined) => {
    const x = id ? subById.get(id) : undefined;
    return x ? submittalNumber(submittalPrefix, x.submittal_no) : null;
  };
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  function openSubmittal(items: SubmittalDraft["items"]) {
    const catalog = items
      .map((i) => CATALOG_BY_KEY.get(rowById.get(i.deliverableId)?.catalog_key ?? ""))
      .filter((c): c is CatalogItem => Boolean(c));
    setCreated(null);
    setDraft({ items, transmittedFor: defaultTransmittedFor(catalog) });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openFromSelection() {
    openSubmittal(
      Array.from(selected).map((id) => {
        const r = rowById.get(id);
        const c = r ? CATALOG_BY_KEY.get(r.catalog_key) : undefined;
        return { deliverableId: id, versionDate: r?.version_date ?? (c?.perDevice === "period" ? r?.device_id ?? today : today), note: "" };
      }),
    );
  }

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const progress = useMemo(() => {
    const out: Record<DeliverablePart, { done: number; total: number }> = {
      I: { done: 0, total: 0 }, II: { done: 0, total: 0 }, III: { done: 0, total: 0 },
    };
    for (const r of rows) {
      const c = CATALOG_BY_KEY.get(r.catalog_key);
      if (!c || c.recurring) continue;
      out[c.part].total++;
      if (isDone(r.state)) out[c.part].done++;
    }
    return out;
  }, [rows]);

  const tabProgress = useMemo(() => {
    const out = new Map<ExhibitSTab, { done: number; total: number }>();
    for (const r of rows) {
      const c = CATALOG_BY_KEY.get(r.catalog_key);
      if (!c || c.recurring) continue;
      const t = out.get(tabOf(c)) ?? { done: 0, total: 0 };
      t.total++;
      if (isDone(r.state)) t.done++;
      out.set(tabOf(c), t);
    }
    return out;
  }, [rows]);

  // Sections in the open tab, in Part order, each a sub-tab.
  const tabSections = useMemo(() => {
    const seen = new Map<string, { id: string; part: DeliverablePart; section: string; recurring: boolean }>();
    for (const c of EXHIBIT_S) {
      if (tabOf(c) !== tab) continue;
      const id = `${c.part}|${c.section}`;
      const s0 = seen.get(id);
      if (s0) s0.recurring = s0.recurring && Boolean(c.recurring);
      else seen.set(id, { id, part: c.part, section: c.section, recurring: Boolean(c.recurring) });
    }
    const list = Array.from(seen.values());
    const names = list.map((x) => sectionLabel(x.section));
    return list.map((x, i) => {
      const name = names[i];
      const dup = names.filter((n) => n === name).length > 1;
      let done = 0;
      let total = 0;
      let logged = 0;
      for (const c of EXHIBIT_S) {
        if (c.part !== x.part || c.section !== x.section) continue;
        for (const r of byKey.get(c.key) ?? []) {
          if (c.recurring) { logged++; continue; }
          total++;
          if (isDone(r.state)) done++;
        }
      }
      return { ...x, label: dup ? `${name} (${PART_MILESTONE[x.part]})` : name, done, total, logged };
    });
  }, [tab, byKey]);
  const activeSub = sub && (sub === "all" || tabSections.some((x) => x.id === sub)) ? sub : (tabSections[0]?.id ?? "all");

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <Header />
        <div className="rounded-md border bg-card p-4 text-sm">
          <p>
            No checklist on this project yet. Loading it puts every Exhibit S deliverable on the list,
            Parts I to III, each with the file name the owner&apos;s data room expects.
          </p>
          <Button
            className="mt-3"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => loadExhibitS(projectId))}
          >
            Load Exhibit S checklist
          </Button>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    );
  }

  const parts: DeliverablePart[] = ["I", "II", "III"];

  return (
    <div className="space-y-4">
      <Header />

      <div className="grid gap-3 rounded-md border bg-card p-3 sm:grid-cols-[1fr_auto]">
        <label className="block text-xs">
          <span className="font-medium">Project SPV name</span>
          <span className="text-muted-foreground"> - the start of every file name, as it appears on the owner&apos;s contract</span>
          <div className="mt-1 flex gap-2">
            <input
              value={spvDraft}
              onChange={(e) => setSpvDraft(e.target.value)}
              className="h-8 w-72 rounded-md border bg-background px-2 text-sm"
            />
            {spvDraft.trim() !== (spvName ?? "") && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => setSpvName(projectId, spvDraft))}>
                Save
              </Button>
            )}
          </div>
          {!spvName && (
            <span className="mt-1 block text-amber-800">
              Not saved yet. File names below use the project name until you save the SPV name.
            </span>
          )}
        </label>
        {submittalsEnabled && (
          <label className="block text-xs sm:col-span-2">
            <span className="font-medium">Submittal prefix</span>
            <span className="text-muted-foreground"> - the letters in front of every submittal number, e.g. SSS on Sweet Springs</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                value={prefixDraft}
                onChange={(e) => setPrefixDraft(e.target.value.toUpperCase())}
                className="h-8 w-28 rounded-md border bg-background px-2 text-sm uppercase"
              />
              <span className="text-muted-foreground">
                Next: <span className="font-medium text-foreground">{submittalNumber(prefixDraft || null, (submittals[submittals.length - 1]?.submittal_no ?? 0) + 1)}</span>
              </span>
              {prefixDraft.trim() !== (submittalPrefix ?? "") && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => setSubmittalPrefix(projectId, prefixDraft))}>
                  Save
                </Button>
              )}
            </div>
          </label>
        )}
        <div className="flex items-end gap-3 text-xs sm:col-start-2 sm:row-start-1">
          {parts.map((p) => (
            <div key={p} className="text-right">
              <div className="text-muted-foreground">Part {p}</div>
              <div className="font-semibold tabular-nums">
                {progress[p].done}/{progress[p].total}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b" role="tablist">
        {EXHIBIT_S_TABS.map((t) => {
          const p = tabProgress.get(t.key) ?? { done: 0, total: 0 };
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => { setTab(t.key); setSub(null); }}
              className={cn(
                "-mb-px rounded-t-md border px-3 py-1.5 text-sm",
                tab === t.key ? "border-b-background bg-background font-semibold" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                {p.total === 0 && EXHIBIT_S.some((c) => c.recurring && tabOf(c) === t.key) ? "ongoing" : `${p.done}/${p.total}`}
              </span>
            </button>
          );
        })}
        {submittalsEnabled && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "log"}
            onClick={() => { setTab("log"); setSub(null); }}
            className={cn(
              "-mb-px rounded-t-md border px-3 py-1.5 text-sm",
              tab === "log" ? "border-b-background bg-background font-semibold" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            Submittal Log
            <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{submittals.length}</span>
          </button>
        )}
      </div>

      {!submittalsEnabled && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Run migration 0093 in the Supabase SQL Editor to number submittals and print the cover sheet.
        </p>
      )}

      {created && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <span>Submittal <span className="font-semibold">{created.label}</span> created.</span>
          <a href={coverHref(created.id)} target="_blank" rel="noreferrer" className="font-medium underline">
            Open the cover sheet
          </a>
          <button type="button" className="ml-auto text-xs underline-offset-2 hover:underline" onClick={() => setCreated(null)}>
            Close
          </button>
        </div>
      )}

      {draft && (
        <SubmittalForm
          key={draft.items.map((i) => i.deliverableId).join(",")}
          draft={draft}
          rows={rowById}
          spv={spv}
          nextLabel={submittalNumber(submittalPrefix, (submittals[submittals.length - 1]?.submittal_no ?? 0) + 1)}
          last={submittals[submittals.length - 1] ?? null}
          defaultProject={spvName ? `${spvName} Solar` : projectName}
          userName={userName}
          today={today}
          disabled={busy}
          onCancel={() => setDraft(null)}
          onSubmit={async (input) => {
            setBusy(true);
            setError(null);
            const res = await createSubmittal(projectId, input);
            setBusy(false);
            if (!res.ok) { setError(res.error); return; }
            setDraft(null);
            setSelected(new Set());
            setCreated({ id: res.id ?? "", label: res.note ?? "" });
            startTransition(() => router.refresh());
          }}
        />
      )}

      {submittalsEnabled && selected.size > 0 && !draft && tab !== "log" && (
        <div className="sticky top-2 z-10 flex items-center gap-3 rounded-md border bg-foreground px-3 py-2 text-sm text-background shadow">
          <span>{selected.size} selected</span>
          <Button size="sm" variant="secondary" onClick={openFromSelection}>
            Create submittal
          </Button>
          <button type="button" className="ml-auto text-xs underline-offset-2 hover:underline" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {tab === "log" ? (
        <SubmittalLog
          submittals={submittals}
          revisions={revisions}
          rows={rowById}
          spv={spv}
          prefix={submittalPrefix}
        />
      ) : (
      <>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {tabSections.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setSub(x.id)}
            className={cn(
              "rounded-full border px-3 py-1",
              activeSub === x.id ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-muted",
            )}
          >
            {x.label}
            <span className={cn("ml-1.5 tabular-nums", activeSub === x.id ? "opacity-70" : "text-muted-foreground")}>
              {x.recurring ? `ongoing · ${x.logged} filed` : x.total === 0 ? "none added" : `${x.done}/${x.total}`}
            </span>
          </button>
        ))}
        {tabSections.length > 1 && (
          <button
            type="button"
            onClick={() => setSub("all")}
            className={cn(
              "rounded-full border px-3 py-1",
              activeSub === "all" ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-muted",
            )}
          >
            Whole tab
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs">
        {(["open", "all", "done"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn("rounded-md border px-3 py-1", filter === f ? "bg-foreground text-background" : "bg-card")}
          >
            {f === "open" ? "Still to do" : f === "all" ? "All" : "Done"}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto text-muted-foreground underline-offset-2 hover:underline"
          disabled={busy}
          onClick={() => void run(() => loadExhibitS(projectId))}
        >
          Add any missing Exhibit S items
        </button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {parts.map((part) => {
        const sections = Array.from(
          new Set(
            EXHIBIT_S.filter(
              (c) => c.part === part && tabOf(c) === tab && (activeSub === "all" || activeSub === `${part}|${c.section}`),
            ).map((c) => c.section),
          ),
        );
        if (sections.length === 0) return null;
        return (
          <section key={part} className="overflow-x-auto rounded-md border">
            <h3 className="bg-muted/50 px-3 py-2 text-sm font-semibold">{PART_LABEL[part]}</h3>
            <table className="w-full min-w-[980px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">File name</th>
                  <th className="px-3 py-2">Doc date</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Link</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => {
                  const catalog = EXHIBIT_S.filter((c) => c.part === part && c.section === section);
                  const visible = catalog.flatMap((c) =>
                    (byKey.get(c.key) ?? []).filter((r) =>
                      filter === "all" ? true : filter === "done" ? isDone(r.state) : !isDone(r.state),
                    ).map((r) => ({ c, r })),
                  );
                  const deviceItems = catalog.filter((c) => c.perDevice);
                  const recurring = deviceItems.length > 0 && deviceItems.every((c) => c.recurring);
                  if (visible.length === 0 && !recurring && (filter !== "open" || deviceItems.length === 0)) return null;
                  return (
                    <Fragment key={section}>
                      <tr className="border-b bg-muted/20">
                        <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold">{section}</td>
                      </tr>
                      {recurring && filter !== "done" && deviceItems.map((c) => {
                        const logged = (byKey.get(c.key) ?? []).map((r) => r.device_id).filter(Boolean).sort();
                        const latest = logged[logged.length - 1] ?? null;
                        return (
                          <tr key={`next-${c.key}`} className="border-b bg-amber-50/60">
                            <td colSpan={5} className="px-3 py-2">
                              <NextReport
                                key={`${c.key}:${logged.length}`}
                                item={c}
                                spv={spv}
                                latest={latest}
                                next={nextPeriod(c.recurring!, latest, today)}
                                disabled={busy}
                                onAdd={async (date) => {
                                  setBusy(true);
                                  setError(null);
                                  const res = await addDeliverableDevice(projectId, c.key, date);
                                  setBusy(false);
                                  if (!res.ok) { setError(res.error); return false; }
                                  startTransition(() => router.refresh());
                                  if (submittalsEnabled && res.id) openSubmittal([{ deliverableId: res.id, versionDate: date, note: "" }]);
                                  return true;
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {recurring && filter === "done" && visible.length === 0 && (
                        <tr className="border-b">
                          <td colSpan={5} className="px-3 py-2 text-xs text-muted-foreground">
                            No reports filed yet. Each report shows here once it&apos;s submitted; the item itself stays open until the job ends.
                          </td>
                        </tr>
                      )}
                      {deviceItems.length > 0 && !recurring && (
                        <tr className="border-b">
                          <td colSpan={5} className="px-3 py-1.5">
                            <AddDevice
                              key={`${section}:${(byKey.get(deviceItems[0].key) ?? []).length}`}
                              items={deviceItems}
                              suggested={(() => {
                                const c = deviceItems[0];
                                if (c.perDevice !== "period" || !c.recurring) return "";
                                const latest = (byKey.get(c.key) ?? []).map((r) => r.device_id).sort().pop() ?? null;
                                return nextPeriod(c.recurring, latest, today);
                              })()}
                              disabled={busy}
                              onAdd={(key, id) => run(() => addDeliverableDevice(projectId, key, id))}
                            />
                          </td>
                        </tr>
                      )}
                      {visible.map(({ c, r }) => (
                        <ItemRow
                          key={r.id}
                          item={c}
                          row={r}
                          spv={spv}
                          today={today}
                          disabled={busy}
                          onSave={(patch) => run(() => updateDeliverable(projectId, r.id, patch))}
                          revisions={revsByRow.get(r.id) ?? []}
                          revisionsEnabled={revisionsEnabled}
                          onAddRevision={(versionDate, notes) =>
                            submittalsEnabled
                              ? (openSubmittal([{ deliverableId: r.id, versionDate, note: notes }]), Promise.resolve(true))
                              : run(() => addRevision(projectId, r.id, { versionDate, notes }))}
                          selectable={submittalsEnabled}
                          selected={selected.has(r.id)}
                          onToggle={() => toggle(r.id)}
                          subLabel={subLabel}
                          onDecide={(revId, d) => run(() => setRevisionDecision(projectId, revId, d))}
                          onRemove={r.device_id ? () => run(() => removeDeliverableDevice(projectId, r.id)) : undefined}
                        />
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
      </>
      )}
    </div>
  );
}

function Header() {
  return (
    <div>
      <h2 className="text-lg font-semibold">Exhibit S deliverables</h2>
      <p className="text-xs text-muted-foreground">
        Every document the owner&apos;s data room needs before Mechanical, Substantial and Final Completion.
        File names follow Exhibit S (Project SPV_Item_Status_vYYYY-MM-DD). Per-device photos carry the
        Exhibit GG device ID.
      </p>
    </div>
  );
}

function ItemRow({
  item,
  row,
  spv,
  today,
  disabled,
  onSave,
  onRemove,
  revisions,
  revisionsEnabled,
  onAddRevision,
  onDecide,
  selectable,
  selected,
  onToggle,
  subLabel,
}: {
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  subLabel: (submittalId: string | null | undefined) => string | null;
  item: CatalogItem;
  row: DeliverableRow;
  spv: string;
  today: string;
  disabled: boolean;
  onSave: (patch: DeliverablePatch) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
  revisions: RevisionRow[];
  revisionsEnabled: boolean;
  onAddRevision: (versionDate: string, notes: string) => Promise<boolean>;
  onDecide: (revisionId: string, decision: ReviewDecision) => Promise<boolean>;
}) {
  const [showRevs, setShowRevs] = useState(false);
  const [revDate, setRevDate] = useState(today);
  const [revNote, setRevNote] = useState("");
  const latest = revisions[revisions.length - 1] ?? null;
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState(row.file_url ?? "");
  const period = item.perDevice === "period";
  const [note, setNote] = useState(row.notes ?? "");
  const fileName = deliverableFileName({
    spv,
    item,
    // The document's own date. A recurring report falls back to its week,
    // anything else to today, until a doc date is set.
    versionDate: row.version_date ?? (period ? row.device_id : today),
    deviceId: row.device_id || null,
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(fileName);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the name is on screen to select by hand.
    }
  }

  return (
    <>
    <tr className="border-b align-top">
      <td className="px-3 py-1.5">
        <div className={cn("flex items-start gap-2", row.state === "not_applicable" && "text-muted-foreground line-through")}>
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              aria-label={`Select ${item.item} for a submittal`}
              className="mt-1 h-3.5 w-3.5 shrink-0"
            />
          )}
          <span>
          {item.item}
          {row.device_id && (
            <span className="font-medium">
              {item.perDevice === "period"
                ? `, ${item.recurring === "monthly" ? "month of" : "week of"} ${row.device_id}`
                : ` (${row.device_id})`}
            </span>
          )}
          </span>
        </div>
        <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
          {item.status && <span className="rounded bg-muted px-1">signed, {item.status}</span>}
          {item.recurring && <span className="rounded bg-muted px-1">{item.recurring}</span>}
          {item.asApplicable && <span className="rounded bg-muted px-1">as applicable</span>}
          {row.submitted_on && <span>uploaded {row.submitted_on}</span>}
          {latest && (
            <span className={cn("rounded px-1", DECISION_TONE[latest.decision])}>
              {subLabel(latest.submittal_id) ? `${subLabel(latest.submittal_id)} · ` : ""}Rev {latest.rev_no}: {DECISION_LABEL[latest.decision as ReviewDecision] ?? latest.decision}
            </span>
          )}
          {revisionsEnabled && (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => setShowRevs((v) => !v)}>
              {revisions.length ? `revisions (${revisions.length})` : "log submission"}
            </button>
          )}
          {onRemove && (
            <button type="button" className="underline-offset-2 hover:underline" disabled={disabled} onClick={() => void onRemove()}>
              remove
            </button>
          )}
        </div>
        {item.note && <div className="mt-0.5 max-w-xs text-[10px] text-muted-foreground">{item.note}</div>}
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-start gap-2">
          <code className="break-all rounded bg-muted/50 px-1.5 py-0.5 text-xs">{fileName}</code>
          <button type="button" className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {row.state === "missed" ? (
          <div className="mt-0.5 text-[10px] text-red-800">Missed. No file for this week.</div>
        ) : !row.version_date && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">Dated today until a doc date is set</div>
        )}
        {period && (
          <input
            value={note}
            disabled={disabled}
            placeholder={row.state === "missed" ? "Reason it was missed (required)" : "Note"}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note !== (row.notes ?? "")) void onSave({ notes: note }); }}
            className={cn("mt-1 h-7 w-full rounded-md border bg-background px-2 text-xs", row.state === "missed" && !note.trim() && "border-red-400")}
          />
        )}
      </td>
      <td className="px-3 py-1.5">
        <input
          type="date"
          defaultValue={row.version_date ?? ""}
          disabled={disabled}
          onChange={(e) => void onSave({ versionDate: e.target.value || null })}
          className="h-8 rounded-md border bg-background px-1 text-xs"
        />
      </td>
      <td className="px-3 py-1.5">
        <select
          value={row.state}
          disabled={disabled}
          onChange={(e) => void onSave({ state: e.target.value as DeliverableState })}
          className={cn("h-8 rounded-md border px-1 text-xs", STATE_TONE[row.state])}
        >
          {DELIVERABLE_STATES.filter((s) =>
            (s !== "not_applicable" || item.asApplicable || row.state === s) &&
            (s !== "missed" || row.state === s),
          ).map((s) => (
            <option key={s} value={s}>{STATE_LABEL[s]}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-1.5">
        <input
          value={link}
          placeholder="Data room or Drive link"
          disabled={disabled}
          onChange={(e) => setLink(e.target.value)}
          onBlur={() => { if (link !== (row.file_url ?? "")) void onSave({ fileUrl: link }); }}
          className="h-8 w-48 rounded-md border bg-background px-2 text-xs"
        />
        {row.file_url && (
          <a href={row.file_url} target="_blank" rel="noreferrer" className="ml-1 text-xs underline-offset-2 hover:underline">
            open
          </a>
        )}
      </td>
    </tr>
    {showRevs && (
      <tr className="border-b bg-muted/10">
        <td colSpan={5} className="px-6 py-2">
          {revisions.length > 0 && (
            <table className="mb-2 w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Rev</th>
                  <th className="py-1 pr-3">Submittal</th>
                  <th className="py-1 pr-3">File name</th>
                  <th className="py-1 pr-3">Submitted</th>
                  <th className="py-1 pr-3">Review</th>
                  <th className="py-1">Why / reviewer note</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((rv) => (
                  <tr key={rv.id} className="align-top">
                    <td className="py-1 pr-3 font-medium">Rev {rv.rev_no}</td>
                    <td className="py-1 pr-3 whitespace-nowrap">
                      {rv.submittal_id && subLabel(rv.submittal_id) ? (
                        <a href={coverHref(rv.submittal_id)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                          {subLabel(rv.submittal_id)}
                        </a>
                      ) : "-"}
                    </td>
                    <td className="py-1 pr-3">
                      <code className="break-all">
                        {deliverableFileName({ spv, item, versionDate: rv.version_date, deviceId: row.device_id || null })}
                      </code>
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{rv.submitted_on ?? "-"}</td>
                    <td className="py-1 pr-3">
                      <select
                        value={rv.decision}
                        disabled={disabled}
                        onChange={(e) => void onDecide(rv.id, e.target.value as ReviewDecision)}
                        className={cn("h-7 rounded-md border px-1", DECISION_TONE[rv.decision])}
                      >
                        {REVIEW_DECISIONS.map((d) => <option key={d} value={d}>{DECISION_LABEL[d]}</option>)}
                      </select>
                      {rv.decided_on && <span className="ml-1 text-muted-foreground">{rv.decided_on}</span>}
                    </td>
                    <td className="py-1 text-muted-foreground">{rv.notes ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">
              {revisions.length ? `Resubmit as Rev ${(latest?.rev_no ?? -1) + 1}` : "Log the first submission (Rev 0)"}
            </span>
            <label className="flex items-center gap-1 text-muted-foreground">
              Doc date
              <input type="date" value={revDate} onChange={(e) => setRevDate(e.target.value)} className="h-7 rounded-md border bg-background px-1 text-foreground" />
            </label>
            <input
              value={revNote}
              onChange={(e) => setRevNote(e.target.value)}
              placeholder={revisions.length ? "Why: e.g. inverter changed to SMA 125, new cut sheet" : "Note (optional)"}
              className="h-7 w-80 rounded-md border bg-background px-2"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !revDate}
              onClick={() => void onAddRevision(revDate, revNote).then((ok) => ok && setRevNote(""))}
            >
              {selectable ? (revisions.length ? "Resubmit on a new submittal" : "Create submittal") : revisions.length ? "Resubmit" : "Log submission"}
            </Button>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

/** A recurring report: when the next one is due, and log it. */
function NextReport({
  item,
  spv,
  latest,
  next,
  disabled,
  onAdd,
}: {
  item: CatalogItem;
  spv: string;
  latest: string | null;
  next: string;
  disabled: boolean;
  onAdd: (date: string) => Promise<boolean>;
}) {
  const [date, setDate] = useState(next);
  const every = item.recurring === "monthly" ? "month" : "week";
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="rounded bg-amber-200/70 px-1.5 py-0.5 font-semibold text-amber-900">Ongoing</span>
      <span className="font-medium">{item.item}</span>
      <span className="text-muted-foreground">
        One every {every} until the job ends.{" "}
        {latest ? `Last filed ${fmt(latest)}. Next due ${fmt(next)}.` : "None filed yet. Log the first one when it goes out."}
      </span>
      <span className="flex items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-7 w-40 rounded-md border bg-background px-2"
        />
        <code className="rounded bg-muted px-1.5 py-0.5">
          {date ? deliverableFileName({ spv, item, versionDate: date, deviceId: date }) : ""}
        </code>
        <Button size="sm" variant="outline" disabled={disabled || !date} onClick={() => void onAdd(date)}>
          Log this {every}&apos;s report
        </Button>
      </span>
    </div>
  );
}

/** Per-device items: pick which item, type the Exhibit GG ID, add. */
function AddDevice({
  items,
  suggested,
  disabled,
  onAdd,
}: {
  items: CatalogItem[];
  /** For a recurring report, the next date after the latest on file. */
  suggested: string;
  disabled: boolean;
  onAdd: (catalogKey: string, deviceId: string) => Promise<boolean>;
}) {
  const [key, setKey] = useState(items.length === 1 ? items[0].key : "all");
  const [deviceId, setDeviceId] = useState(suggested);
  const kind = items[0].perDevice!;

  async function add() {
    const targets = key === "all" ? items : items.filter((i) => i.key === key);
    for (const t of targets) {
      if (!(await onAdd(t.key, deviceId))) return;
    }
    setDeviceId("");
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        {kind === "period"
          ? `One file per ${items[0].recurring === "monthly" ? "month" : "week"}. Add the next one:`
          : `One file per ${kind === "equipment" ? "piece of equipment" : kind === "road" ? "road" : "device"}:`}
      </span>
      {items.length > 1 && (
        <select value={key} onChange={(e) => setKey(e.target.value)} className="h-7 rounded-md border bg-background px-1">
          <option value="all">All {items.length} items</option>
          {items.map((i) => <option key={i.key} value={i.key}>{i.item}</option>)}
        </select>
      )}
      <input
        type={kind === "period" ? "date" : "text"}
        value={deviceId}
        onChange={(e) => setDeviceId(e.target.value)}
        placeholder={DEVICE_HINT[kind]}
        className={cn("h-7 rounded-md border bg-background px-2", kind === "period" ? "w-40" : "w-64")}
      />
      <Button size="sm" variant="outline" disabled={disabled || !deviceId.trim()} onClick={() => void add()}>
        Add
      </Button>
    </div>
  );
}

const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * One submittal: the documents going out together and the cover's header.
 * To, CC and the project line carry over from the last submittal.
 */
function SubmittalForm({
  draft,
  rows,
  spv,
  nextLabel,
  last,
  defaultProject,
  userName,
  today,
  disabled,
  onCancel,
  onSubmit,
}: {
  draft: SubmittalDraft;
  rows: Map<string, DeliverableRow>;
  spv: string;
  nextLabel: string;
  last: SubmittalRow | null;
  defaultProject: string;
  userName: string;
  today: string;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (input: Parameters<typeof createSubmittal>[1]) => Promise<void>;
}) {
  const [items, setItems] = useState(draft.items);
  const [submittedOn, setSubmittedOn] = useState(today);
  const [transmittedFor, setTransmittedFor] = useState<TransmittedFor>(draft.transmittedFor);
  const [other, setOther] = useState("");
  const [projectLabel, setProjectLabel] = useState(last?.project_label ?? defaultProject);
  const [toName, setToName] = useState(last?.to_name ?? "");
  const [fromName, setFromName] = useState(last?.from_name ?? userName);
  const [cc, setCc] = useState(last?.cc ?? "");
  const catalogOf = (id: string) => CATALOG_BY_KEY.get(rows.get(id)?.catalog_key ?? "");
  const [subject, setSubject] = useState(() => {
    const first = catalogOf(draft.items[0]?.deliverableId ?? "");
    if (!first) return "";
    if (draft.items.length === 1) return first.item;
    const sections = new Set(draft.items.map((i) => catalogOf(i.deliverableId)?.section));
    return sections.size === 1 ? sectionLabel(first.section) : `${draft.items.length} documents`;
  });
  const [respond, setRespond] = useState(draft.transmittedFor === "approval" ? plusDays(today, 14) : "");
  const [notes, setNotes] = useState("");
  const field = "h-8 w-full rounded-md border bg-background px-2 text-sm";

  return (
    <section className="space-y-3 rounded-md border-2 border-foreground/20 bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-semibold">New submittal</h3>
        <span className="text-sm text-muted-foreground">
          will be <span className="font-semibold text-foreground">{nextLabel}</span>
        </span>
      </div>

      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="w-10 py-1">Item #</th>
            <th className="py-1">Document (file name)</th>
            <th className="py-1">Doc date</th>
            <th className="py-1">Note on the cover (e.g. why it was revised)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => {
            const r = rows.get(it.deliverableId);
            const c = catalogOf(it.deliverableId);
            return (
              <tr key={it.deliverableId} className="align-top">
                <td className="py-1">{i + 1}</td>
                <td className="py-1 pr-2">
                  <code className="break-all">
                    {c && r ? deliverableFileName({ spv, item: c, versionDate: it.versionDate || today, deviceId: r.device_id || null }) : "?"}
                  </code>
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="date"
                    value={it.versionDate}
                    onChange={(e) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, versionDate: e.target.value } : x)))}
                    className="h-7 rounded-md border bg-background px-1"
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    value={it.note}
                    onChange={(e) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                    className="h-7 w-full rounded-md border bg-background px-2"
                  />
                </td>
                <td className="py-1">
                  {items.length > 1 && (
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => setItems((cur) => cur.filter((_, j) => j !== i))}
                    >
                      remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1"><span className="font-medium">Date</span>
          <input type="date" value={submittedOn} onChange={(e) => setSubmittedOn(e.target.value)} className={field} />
        </label>
        <label className="space-y-1"><span className="font-medium">Project (as printed)</span>
          <input value={projectLabel} onChange={(e) => setProjectLabel(e.target.value)} className={field} />
        </label>
        <label className="space-y-1"><span className="font-medium">Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={field} />
        </label>
        <label className="space-y-1"><span className="font-medium">To</span>
          <input value={toName} onChange={(e) => setToName(e.target.value)} placeholder="e.g. John Merriman" className={field} />
        </label>
        <label className="space-y-1"><span className="font-medium">From</span>
          <input value={fromName} onChange={(e) => setFromName(e.target.value)} className={field} />
        </label>
        <label className="space-y-1"><span className="font-medium">CC</span>
          <input value={cc} onChange={(e) => setCc(e.target.value)} className={field} />
        </label>
        <div className="space-y-1">
          <span className="font-medium">Transmitted</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
            {TRANSMITTED_FOR.map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input type="radio" checked={transmittedFor === t} onChange={() => setTransmittedFor(t)} />
                {TRANSMITTED_LABEL[t]}
              </label>
            ))}
          </div>
          {transmittedFor === "other" && (
            <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Specify" className={field} />
          )}
        </div>
        <label className="space-y-1"><span className="font-medium">Requested response date</span>
          <input type="date" value={respond} onChange={(e) => setRespond(e.target.value)} className={field} />
        </label>
        <label className="space-y-1 sm:col-span-2 lg:col-span-1"><span className="font-medium">Additional notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full rounded-md border bg-background px-2 py-1 text-sm" />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={disabled || items.length === 0 || items.some((i) => !i.versionDate) || !submittedOn}
          onClick={() =>
            void onSubmit({
              items,
              submittedOn,
              transmittedFor,
              transmittedOther: other,
              projectLabel,
              toName,
              fromName,
              cc,
              subject,
              notes,
              requestedResponseDate: respond || null,
            })
          }
        >
          Create {nextLabel}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-xs text-muted-foreground">
          Each document goes to Uploaded with its next revision. The cover sheet opens once it&apos;s created.
        </span>
      </div>
    </section>
  );
}

/** Every submittal on the project, newest first, with its documents and answers. */
function SubmittalLog({
  submittals,
  revisions,
  rows,
  spv,
  prefix,
}: {
  submittals: SubmittalRow[];
  revisions: RevisionRow[];
  rows: Map<string, DeliverableRow>;
  spv: string;
  prefix: string | null;
}) {
  const [q, setQ] = useState("");
  const bySub = useMemo(() => {
    const m = new Map<string, RevisionRow[]>();
    for (const r of revisions) if (r.submittal_id) (m.get(r.submittal_id) ?? m.set(r.submittal_id, []).get(r.submittal_id)!).push(r);
    return m;
  }, [revisions]);
  const list = submittals
    .map((x) => {
      const docs = (bySub.get(x.id) ?? []).map((rv) => {
        const d = rows.get(rv.deliverable_id);
        const c = d ? CATALOG_BY_KEY.get(d.catalog_key) : undefined;
        return {
          rv,
          name: c && d ? deliverableFileName({ spv, item: c, versionDate: rv.version_date, deviceId: d.device_id || null }) : "?",
        };
      });
      return { x, label: submittalNumber(prefix, x.submittal_no), docs };
    })
    .filter(({ x, label, docs }) => {
      const t = q.trim().toLowerCase();
      if (!t) return true;
      return [label, x.subject ?? "", x.to_name ?? "", ...docs.map((d) => d.name)].some((s) => s.toLowerCase().includes(t));
    })
    .reverse();

  if (submittals.length === 0) {
    return (
      <p className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
        No submittals yet. Tick documents on any tab and press Create submittal, or use Create submittal on a row.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find a submittal: number, subject, file name"
        className="h-8 w-80 rounded-md border bg-background px-2 text-sm"
      />
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Submittal #</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Documents</th>
              <th className="px-3 py-2">For</th>
              <th className="px-3 py-2">Response</th>
              <th className="px-3 py-2">Cover</th>
            </tr>
          </thead>
          <tbody>
            {list.map(({ x, label, docs }) => (
              <tr key={x.id} className="border-t align-top">
                <td className="whitespace-nowrap px-3 py-2 font-semibold">{label}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{x.submitted_on}</td>
                <td className="px-3 py-2">{x.subject}{x.to_name && <div className="text-xs text-muted-foreground">to {x.to_name}</div>}</td>
                <td className="px-3 py-2 text-xs">
                  {docs.map((d) => (
                    <div key={d.rv.id}>
                      <code className="break-all">{d.name}</code>
                      {d.rv.rev_no > 0 && <span className="text-muted-foreground"> Rev {d.rv.rev_no}</span>}
                    </div>
                  ))}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs">
                  {TRANSMITTED_LABEL[x.transmitted_for as TransmittedFor] ?? x.transmitted_for}
                </td>
                <td className="px-3 py-2 text-xs">
                  {docs.map((d) => (
                    <div key={d.rv.id}>
                      <span className={cn("rounded px-1", DECISION_TONE[d.rv.decision])}>
                        {DECISION_LABEL[d.rv.decision as ReviewDecision] ?? d.rv.decision}
                      </span>
                    </div>
                  ))}
                </td>
                <td className="px-3 py-2 text-xs">
                  <a href={coverHref(x.id)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Record the owner&apos;s answer on the document&apos;s row (its revisions). A revise and resubmit goes back out on a new submittal number.
      </p>
    </div>
  );
}
