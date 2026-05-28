import { DashboardBilling } from "./dashboard-billing";
import { DashboardCompliance } from "./dashboard-compliance";
import { DashboardCost } from "./dashboard-cost";
import { DashboardFinancial } from "./dashboard-financial";
import { DashboardKpis } from "./dashboard-kpis";
import { DashboardMilestones } from "./dashboard-milestones";
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

      <DashboardBilling projectId={params.id} />

      <div className="grid gap-4 md:grid-cols-2">
        <DashboardSchedule projectId={params.id} />
        <DashboardFinancial projectId={params.id} />
        <DashboardCost projectId={params.id} />
        <DashboardCompliance projectId={params.id} />
      </div>

      <DashboardMilestones projectId={params.id} />

      {aiEnabled && <ProjectChat projectId={params.id} />}
    </div>
  );
}
