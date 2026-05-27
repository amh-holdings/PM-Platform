import { CostCodesSection } from "../cost-section";

type Params = { id: string };

export default function ProjectCostsPage({ params }: { params: Params }) {
  return <CostCodesSection projectId={params.id} />;
}
