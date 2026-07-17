import { redirect } from "next/navigation";

type Params = { id: string };

// The Review Board is now embedded at the top of Field Reports (one place for
// the CM to work from), so this standalone route just forwards there. Kept so
// old bookmarks / links don't 404.
export default function ReviewBoardPage({ params }: { params: Params }) {
  redirect(`/projects/${params.id}/field-reports`);
}
