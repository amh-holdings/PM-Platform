"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  CATALOG_BY_KEY,
  DELIVERABLE_STATES,
  DEVICE_HINT,
  EXHIBIT_S,
  PART_LABEL,
  STATE_LABEL,
  deliverableFileName,
  isDone,
  type CatalogItem,
  type DeliverablePart,
  type DeliverableState,
} from "@/lib/exhibit-s";
import { cn } from "@/lib/utils";

import {
  addDeliverableDevice,
  loadExhibitS,
  removeDeliverableDevice,
  setSpvName,
  updateDeliverable,
  type DeliverablePatch,
} from "./deliverables-actions";

export type DeliverableRow = {
  id: string;
  catalog_key: string;
  device_id: string;
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
  not_applicable: "bg-muted text-muted-foreground line-through",
};

type Filter = "open" | "all" | "done";

export function DeliverablesView({
  projectId,
  spvName,
  projectName,
  rows,
  today,
}: {
  projectId: string;
  spvName: string | null;
  projectName: string;
  rows: DeliverableRow[];
  today: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("open");
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
    m.forEach((list) => list.sort((a, b) => a.device_id.localeCompare(b.device_id, undefined, { numeric: true })));
    return m;
  }, [rows]);

  const progress = useMemo(() => {
    const out: Record<DeliverablePart, { done: number; total: number }> = {
      I: { done: 0, total: 0 }, II: { done: 0, total: 0 }, III: { done: 0, total: 0 },
    };
    for (const r of rows) {
      const c = CATALOG_BY_KEY.get(r.catalog_key);
      if (!c) continue;
      out[c.part].total++;
      if (isDone(r.state)) out[c.part].done++;
    }
    return out;
  }, [rows]);

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
        <div className="flex items-end gap-3 text-xs">
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
        const sections = Array.from(new Set(EXHIBIT_S.filter((c) => c.part === part).map((c) => c.section)));
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
                  if (visible.length === 0 && (filter !== "open" || deviceItems.length === 0)) return null;
                  return (
                    <Fragment key={section}>
                      <tr className="border-b bg-muted/20">
                        <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold">{section}</td>
                      </tr>
                      {deviceItems.length > 0 && (
                        <tr className="border-b">
                          <td colSpan={5} className="px-3 py-1.5">
                            <AddDevice
                              items={deviceItems}
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
}: {
  item: CatalogItem;
  row: DeliverableRow;
  spv: string;
  today: string;
  disabled: boolean;
  onSave: (patch: DeliverablePatch) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState(row.file_url ?? "");
  const fileName = deliverableFileName({
    spv,
    item,
    versionDate: row.version_date ?? today,
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
    <tr className="border-b align-top">
      <td className="px-3 py-1.5">
        <div className={cn(row.state === "not_applicable" && "text-muted-foreground line-through")}>
          {item.item}
          {row.device_id && <span className="font-medium"> ({row.device_id})</span>}
        </div>
        <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
          {item.status && <span className="rounded bg-muted px-1">signed, {item.status}</span>}
          {item.recurring && <span className="rounded bg-muted px-1">{item.recurring}</span>}
          {item.asApplicable && <span className="rounded bg-muted px-1">as applicable</span>}
          {row.submitted_on && <span>uploaded {row.submitted_on}</span>}
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
        {!row.version_date && <div className="mt-0.5 text-[10px] text-muted-foreground">Dated today until a doc date is set</div>}
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
          {DELIVERABLE_STATES.filter((s) => s !== "not_applicable" || item.asApplicable || row.state === s).map((s) => (
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
  );
}

/** Per-device items: pick which item, type the Exhibit GG ID, add. */
function AddDevice({
  items,
  disabled,
  onAdd,
}: {
  items: CatalogItem[];
  disabled: boolean;
  onAdd: (catalogKey: string, deviceId: string) => Promise<boolean>;
}) {
  const [key, setKey] = useState(items.length === 1 ? items[0].key : "all");
  const [deviceId, setDeviceId] = useState("");
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
      <span className="text-muted-foreground">One file per {kind === "equipment" ? "piece of equipment" : kind === "road" ? "road" : "device"}:</span>
      {items.length > 1 && (
        <select value={key} onChange={(e) => setKey(e.target.value)} className="h-7 rounded-md border bg-background px-1">
          <option value="all">All {items.length} items</option>
          {items.map((i) => <option key={i.key} value={i.key}>{i.item}</option>)}
        </select>
      )}
      <input
        value={deviceId}
        onChange={(e) => setDeviceId(e.target.value)}
        placeholder={DEVICE_HINT[kind]}
        className="h-7 w-64 rounded-md border bg-background px-2"
      />
      <Button size="sm" variant="outline" disabled={disabled || !deviceId.trim()} onClick={() => void add()}>
        Add
      </Button>
    </div>
  );
}
