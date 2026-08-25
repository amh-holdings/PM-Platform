import { redirect } from "next/navigation";

type Params = { id: string };

// The Commodity Tracker lived at /production until it became one report among
// several. Bookmarks, emailed links and the revalidate paths in older server
// actions still point here, so this stays as a permanent forward rather than a
// 404. Query string (?from/?to) is preserved - those links are usually the
// specific date window somebody was asked to look at.
export default function ProductionRedirect({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value) && value[0]) qs.set(key, value[0]);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  redirect(`/projects/${params.id}/reports/commodity-tracker${suffix}`);
}
