import Link from "next/link";

import { DprForm } from "../../dprs/new/dpr-form";
import { loadFieldReportFormData } from "../form-data";

type Params = { id: string };

export default async function NewFieldReportPage({
  params,
}: {
  params: Params;
}) {
  const data = await loadFieldReportFormData(params.id);

  if (data.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {data.error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/field-reports`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Field Reports
        </Link>
        <h2 className="mt-1 text-lg font-semibold">Daily Field Report</h2>
        <p className="text-xs text-muted-foreground">
          One report for the day: the progress narrative plus the work you did,
          marked on the site map. Save it and come back to it as many times as
          you need - it is only filed when you submit.
        </p>
      </div>

      <DprForm
        projectId={params.id}
        tasks={data.tasks}
        subs={data.subs}
        procurementOrders={data.procurementOrders}
        variant="fieldReport"
      />
    </div>
  );
}
