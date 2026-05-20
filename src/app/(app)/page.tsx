import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { count } = await supabase
    .from("projects")
    .select("*", { count: "exact", head: true });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{user.email}</span>
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/projects"
          className="rounded-lg border bg-card p-6 shadow-sm transition-colors hover:bg-accent/50"
        >
          <div className="text-3xl font-semibold tabular-nums">{count ?? 0}</div>
          <div className="mt-1 text-sm text-muted-foreground">Active projects</div>
        </Link>
      </div>
    </div>
  );
}
