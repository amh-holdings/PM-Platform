import { SubcontractorsSection } from "../subs-section";

type Params = { id: string };

export default function ProjectSubsPage({ params }: { params: Params }) {
  return <SubcontractorsSection projectId={params.id} />;
}
