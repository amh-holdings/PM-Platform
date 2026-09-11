import { DashboardCashflow } from "./dashboard-cashflow";
import { DashboardCompliance } from "./dashboard-compliance";
import { DashboardCost } from "./dashboard-cost";
import { DashboardFieldStatus } from "./dashboard-field-status";
import { DashboardFinancial } from "./dashboard-financial";
import { DashboardKpis } from "./dashboard-kpis";
import { DashboardMilestones } from "./dashboard-milestones";
import { DashboardPlanActual } from "./dashboard-plan-actual";
import { DashboardProjection } from "./dashboard-projection";
import { DashboardSchedule } from "./dashboard-schedule";
import { redirect } from "next/navigation";

import { DashboardToday } from "./dashboard-today";
import { ProjectChat } from "./project-chat";
import { can } from "@/lib/roles";
import { getEffectiveRole } from "@/lib/roles-server";

type Params = { id: string };

function SectionHeader({ id, title, sub }: { id: string; title: string; sub: string }) {
  return (
    <div id={id} className="scroll-mt-20 border-b pb-1">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

export default async function ProjectDashboardPage({ params }: { params: Params }) {
  const aiEnabled = Boolean(
    process.env.RELAY_URL && process.env.RELAY_SHARED_SECRET,
  );

  const { effective } = await getEffectiveRole();
  // Subs have no dashboard - send them to their field reports so the project
  // root never exposes the financial dashboard to them.
  if (!can(effective, "viewDashboard")) {
    redirect(`/projects/${params.id}/field-reports`);
  }
  // Construction Manager sees Operations + Compliance only - the entire
  // Financial section (billing, cash, spend, cost variance) is Phil-only.
  const showFinancials = can(effective, "viewBilling");
  // Within the Financial section, cost/profit margin is a further Phil-only cut.
  const showCosts = can(effective, "viewCosts");

  return (
    <div className="space-y-8">
      <DashboardToday projectId={params.id} />

      <section className="space-y-4">
        <SectionHeader
          id="operations"
          title="Operations"
          sub="Schedule, field activity, blockers"
        />
        <DashboardPlanActual projectId={params.id} />
        <div className="grid gap-4 md:grid-cols-2">
          <DashboardFieldStatus projectId={params.id} />
          <DashboardSchedule projectId={params.id} />
        </div>
        <DashboardMilestones projectId={params.id} />
      </section>

      {showFinancials && (
        <section className="space-y-4">
          <SectionHeader
            id="financial"
            title="Financial"
            sub="Cash position, billing, spend, cost variance"
          />
          <DashboardKpis projectId={params.id} showCosts={showCosts} />
          {/* One chart where there were three. Margin, billing and cash-out all
              drew the same projection rows; see dashboard-cashflow.tsx. The
              month-by-month numbers behind it are the projection table. */}
          <DashboardCashflow projectId={params.id} />
          {showCosts && <DashboardProjection projectId={params.id} />}
          <div className={showCosts ? "grid gap-4 md:grid-cols-2" : ""}>
            <DashboardFinancial projectId={params.id} />
            {showCosts && <DashboardCost projectId={params.id} />}
          </div>
        </section>
      )}

      <section className="space-y-4">
        <SectionHeader
          id="compliance"
          title="Compliance"
          sub="Sub paperwork, certifications"
        />
        <DashboardCompliance projectId={params.id} />
      </section>

      {aiEnabled && <ProjectChat projectId={params.id} />}
    </div>
  );
}
