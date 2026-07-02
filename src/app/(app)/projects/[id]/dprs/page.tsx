import { redirect } from "next/navigation";

type Params = { id: string };

// Retired: daily reports are now filed as Field Reports.
export default function ProjectDprsPage({ params }: { params: Params }) {
  redirect(`/projects/${params.id}/field-reports`);
}
