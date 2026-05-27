import { WbsSection } from "../wbs-section";

type Params = { id: string };

export default function ProjectWbsPage({ params }: { params: Params }) {
  const aiEnabled = Boolean(
    process.env.RELAY_URL && process.env.RELAY_SHARED_SECRET,
  );
  return <WbsSection projectId={params.id} aiEnabled={aiEnabled} />;
}
