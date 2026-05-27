import { DashboardKpis } from "./dashboard-kpis";
import { ProjectChat } from "./project-chat";

type Params = { id: string };

export default function ProjectDashboardPage({ params }: { params: Params }) {
  const aiEnabled = Boolean(
    process.env.RELAY_URL && process.env.RELAY_SHARED_SECRET,
  );

  return (
    <div className="space-y-6">
      <DashboardKpis projectId={params.id} />

      {aiEnabled && <ProjectChat projectId={params.id} />}
    </div>
  );
}
