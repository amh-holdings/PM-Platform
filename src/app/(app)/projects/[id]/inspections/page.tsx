import { redirect } from "next/navigation";

type Params = { id: string };

// Retired: QA/QC inspections are now filed and reviewed inside Field Reports.
export default function ProjectInspectionsPage({ params }: { params: Params }) {
  redirect(`/projects/${params.id}/field-reports`);
}
