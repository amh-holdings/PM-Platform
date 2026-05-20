import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { signOut } from "./actions";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware should have redirected an unauthenticated user already.
  // This is a defensive fallback in case middleware is bypassed.
  if (!user) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold">AHC PM Platform</h1>
          <p className="text-sm text-muted-foreground">Phase 1 - Day 1 scaffold</p>
        </div>
        <div className="space-y-1.5 text-sm">
          <p className="text-muted-foreground">Signed in as</p>
          <p className="font-medium">{user.email}</p>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
      </div>
    </main>
  );
}
