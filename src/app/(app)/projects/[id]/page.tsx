import { DashboardCost } from "./dashboard-cost";
import { DashboardFinancial } from "./dashboard-financial";
import { DashboardKpis } from "./dashboard-kpis";
import { DashboardSchedule } from "./dashboard-schedule";
import { ProjectChat } from "./project-chat";

type Params = { id: string };

export default function ProjectDashboardPage({ params }: { params: Params }) {
  const aiEnabled = Boolean(
    process.env.RELAY_URL && process.env.RELAY_SHARED_SECRET,
  );

  return (
    <div className="space-y-6">
      <DashboardKpis projectId={params.id} />

      <div className="grid gap-4 md:grid-cols-2">
        <DashboardSchedule projectId={params.id} />
        <DashboardFinancial projectId={params.id} />
        <DashboardCost projectId={params.id} />
      </div>

      {aiEnabled && <ProjectChat projectId={params.id} />}
    </div>
  );
}
