import { redirect } from "next/navigation";

type Params = { id: string; dprId: string };

// Retired: the Field Reports viewer supersedes this one. Kept as a redirect so
// existing bookmarks and emailed links still land on the right report.
export default function DprDetailPage({ params }: { params: Params }) {
  redirect(`/projects/${params.id}/field-reports/${params.dprId}`);
}
