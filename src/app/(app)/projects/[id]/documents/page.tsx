import { DocumentsSection } from "../documents-section";

type Params = { id: string };

export default function ProjectDocumentsPage({ params }: { params: Params }) {
  return <DocumentsSection projectId={params.id} />;
}
