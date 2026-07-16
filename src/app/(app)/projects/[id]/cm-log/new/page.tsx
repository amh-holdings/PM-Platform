import Link from "next/link";

import { guardCapability } from "@/lib/roles-server";

import { CmLogForm } from "./cm-log-form";

type Params = { id: string };

export default async function NewCmLogPage({ params }: { params: Params }) {
  // CM Daily Log is CM/Phil-only, same gate as the Review Board.
  await guardCapability("viewAllReports");

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/cm-log`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; My Daily Log
        </Link>
        <h2 className="mt-1 text-lg font-semibold">New CM Daily Log</h2>
        <p className="text-xs text-muted-foreground">
          Your own record of the day: site conditions, overall progress, safety,
          and photos. This stands on its own - it is not part of the sub review
          cycle.
        </p>
      </div>

      <CmLogForm projectId={params.id} defaultDate={today} />
    </div>
  );
}
