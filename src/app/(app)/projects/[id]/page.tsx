import { DashboardBilling } from "./dashboard-billing";
import { DashboardCashOut } from "./dashboard-cashout";
import { DashboardCompliance } from "./dashboard-compliance";
import { DashboardCost } from "./dashboard-cost";
import { DashboardFieldStatus } from "./dashboard-field-status";
import { DashboardFinancial } from "./dashboard-financial";
import { DashboardKpis } from "./dashboard-kpis";
import { DashboardMilestones } from "./dashboard-milestones";
import { DashboardNetCash } from "./dashboard-netcash";
import { DashboardPlanActual } from "./dashboard-plan-actual";
import { DashboardSchedule } from "./dashboard-schedule";
import { DashboardToday } from "./dashboard-today";
import { ProjectChat } from "./project-chat";

type Params = { id: string };

function SectionHeader({ id, title, sub }: { id: string; title: string; sub: string }) {
  return (
    <div id={id} className="scroll-mt-20 border-b pb-1">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

export default function ProjectDashboardPage({ params }: { params: Params }) {
  const aiEnabled = Boolean(
    process.env.RELAY_URL && process.env.RELAY_SHARED_SECRET,
  );

  return (
    <div className="space-y-8">
      <DashboardToday projectId={params.id} />

      <nav className="sticky top-0 z-10 -mx-4 flex gap-1 overflow-x-auto border-b bg-background/95 px-4 py-2 text-xs backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:mx-0 sm:rounded-md sm:border sm:px-2">
        <a
          href="#operations"
          className="whitespace-nowrap rounded px-2 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Operations
        </a>
        <a
          href="#financial"
          className="whitespace-nowrap rounded px-2 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Financial
        </a>
        <a
          href="#compliance"
          className="whitespace-nowrap rounded px-2 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Compliance
        </a>
      </nav>

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

      <section className="space-y-4">
        <SectionHeader
          id="financial"
          title="Financial"
          sub="Cash position, billing, spend, cost variance"
        />
        <DashboardKpis projectId={params.id} />
        <DashboardNetCash projectId={params.id} />
        <DashboardBilling projectId={params.id} />
        <DashboardCashOut projectId={params.id} />
        <div className="grid gap-4 md:grid-cols-2">
          <DashboardFinancial projectId={params.id} />
          <DashboardCost projectId={params.id} />
        </div>
      </section>

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
