import Link from "next/link";

import { STAGE_LABEL, isOpenStage, todayIso, type BdStage } from "@/lib/bd";
import { formatDate } from "@/lib/format";
import {
  RFP_PHASES,
  bidderFlags,
  currentPhase,
  packageCoverage,
  phaseProgress,
  stateCode,
} from "@/lib/rfp";
import { rfpClient } from "@/lib/rfp-db";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { Card, Empty, StagePill, tdClass, thClass } from "../bd/_components/fields";
import { Pill } from "./_components/flag-pill";

/**
 * Every open bid and where it sits in the runbook. The list Zarina works
 * from: which phase each bid is in, which packages are thin, who has gone
 * quiet.
 */
export default async function RfpIndexPage() {
  const db = rfpClient(createClient());
  const [opps, companies, checks, bidders, profiles] = await Promise.all([
    db.from("bd_opportunities").select("*").order("bid_due_date", { ascending: true, nullsFirst: false }),
    db.from("bd_companies").select("id, name"),
    db.from("rfp_step_checks").select("opportunity_id, step_key"),
    db.from("rfp_bidders").select("*"),
    db.from("bd_state_profiles").select("state"),
  ]);

  const today = todayIso();
  const companyName = new Map((companies.data ?? []).map((c) => [c.id, c.name]));
  const profileStates = new Set((profiles.data ?? []).map((p) => p.state));
  const checksBy = new Map<string, string[]>();
  for (const c of checks.data ?? []) checksBy.set(c.opportunity_id, [...(checksBy.get(c.opportunity_id) ?? []), c.step_key]);
  const biddersBy = new Map<string, NonNullable<typeof bidders.data>>();
  for (const b of bidders.data ?? []) biddersBy.set(b.opportunity_id, [...(biddersBy.get(b.opportunity_id) ?? []), b]);

  const open = (opps.data ?? []).filter((o) => isOpenStage(o.stage));
  const totalSteps = RFP_PHASES.reduce((n, p) => n + p.steps.length, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">RFPs</h1>
        <p className="text-sm text-muted-foreground">
          Every open bid, run through the AHC RFP Process. Zarina runs it. Phil reviews at the bid package, the
          price and the submission.
        </p>
      </div>

      <Card title={`Open bids (${open.length})`}>
        {open.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Bid</th>
                  <th className={thClass}>Client</th>
                  <th className={thClass}>State</th>
                  <th className={thClass}>Stage</th>
                  <th className={thClass}>Bid due</th>
                  <th className={thClass}>Runbook</th>
                  <th className={thClass}>Bidders</th>
                  <th className={thClass}>Needs attention</th>
                </tr>
              </thead>
              <tbody>
                {open.map((o) => {
                  const done = checksBy.get(o.id) ?? [];
                  const phase = currentPhase(done);
                  const doneCount = phaseProgress(done).reduce((n, p) => n + p.done, 0);
                  const list = biddersBy.get(o.id) ?? [];
                  const thin = packageCoverage(list).filter((c) => c.thin).length;
                  const flagged = list.filter((b) => bidderFlags(b, today).some((f) => f.kind !== "license_unverified")).length;
                  const unlicensed = list.filter((b) => bidderFlags(b, today).some((f) => f.kind === "license_unverified")).length;
                  const st = stateCode(o.state);
                  const overdue = !!o.bid_due_date && o.bid_due_date < today;
                  return (
                    <tr key={o.id} className="border-b last:border-0">
                      <td className={tdClass}>
                        <Link href={`/rfp/${o.id}`} className="font-medium underline-offset-4 hover:underline">
                          {o.name}
                        </Link>
                      </td>
                      <td className={tdClass}>{companyName.get(o.company_id) ?? "-"}</td>
                      <td className={tdClass}>
                        {st ?? o.state ?? "-"}
                        {st && !profileStates.has(st) && (
                          <span className="ml-2">
                            <Pill tone="warn">No profile</Pill>
                          </span>
                        )}
                        {!st && (
                          <span className="ml-2">
                            <Pill tone="warn">Set state</Pill>
                          </span>
                        )}
                      </td>
                      <td className={tdClass}>
                        <StagePill stage={o.stage} label={STAGE_LABEL[o.stage as BdStage] ?? o.stage} />
                      </td>
                      <td className={cn(tdClass, "whitespace-nowrap", overdue && "text-destructive")}>
                        {formatDate(o.bid_due_date)}
                      </td>
                      <td className={tdClass}>
                        <div className="whitespace-nowrap">{phase ? `${phase.num}. ${phase.title}` : "Complete"}</div>
                        <div className="text-xs text-muted-foreground">
                          {doneCount} of {totalSteps} steps
                        </div>
                      </td>
                      <td className={cn(tdClass, "tabular-nums")}>{list.length}</td>
                      <td className={tdClass}>
                        <div className="flex flex-wrap gap-1">
                          {thin > 0 && <Pill tone="bad">{thin} thin package{thin === 1 ? "" : "s"}</Pill>}
                          {flagged > 0 && <Pill tone="warn">{flagged} to chase</Pill>}
                          {unlicensed > 0 && <Pill tone="warn">{unlicensed} license unchecked</Pill>}
                          {!thin && !flagged && !unlicensed && <span className="text-muted-foreground">-</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No open bids. New bids start as an opportunity in Business Dev.</Empty>
        )}
      </Card>
    </div>
  );
}
