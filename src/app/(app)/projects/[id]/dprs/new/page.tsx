import { redirect } from "next/navigation";

type Params = { id: string };

// Retired: daily reports are filed as Field Reports now. The form component
// next door (dpr-form.tsx) is still the live one - /field-reports/new imports
// it - so only this route is gone, not the code behind it.
export default function NewDprPage({ params }: { params: Params }) {
  redirect(`/projects/${params.id}/field-reports/new`);
}
