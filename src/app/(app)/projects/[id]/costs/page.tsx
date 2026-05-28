import { CostCodesSection } from "../cost-section";
import { CostSuggestionsPanel } from "./cost-suggestions-panel";

type Params = { id: string };

export default function ProjectCostsPage({ params }: { params: Params }) {
  return (
    <div className="space-y-6">
      <CostSuggestionsPanel projectId={params.id} />
      <CostCodesSection projectId={params.id} />
    </div>
  );
}
