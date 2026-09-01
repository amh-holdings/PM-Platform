import Link from "next/link";

import { Button } from "@/components/ui/button";
import { PaletteTrigger } from "@/components/nav/palette-trigger";
import { signOut } from "@/app/actions";
import { createClient } from "@/lib/supabase/server";

/**
 * The one bar that spans every page. Deliberately thin: project navigation
 * lives in the rail (desktop) and the bottom bar (phone), so all this carries
 * is the brand, search, and the account.
 */
export async function SiteNav() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return (
    // `print:hidden` because the report pages under this shell are printed and
    // handed to people outside AHC. Without it the search box, the signed-in
    // address and a "Sign out" link land on the PDF that goes to the owner or
    // to leadership. The project rail and the page header already opt out; this
    // bar did not, so every weekly report sent to Dimension carried it.
    <header className="sticky top-0 z-20 h-14 border-b bg-background print:hidden">
      <div className="flex h-14 items-center justify-between gap-3 px-4 lg:px-6">
        <nav className="flex items-center gap-1 text-sm">
          <Link
            href="/projects"
            className="rounded-md px-2 py-1.5 font-semibold text-foreground hover:bg-accent"
          >
            AHC PM
          </Link>
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <PaletteTrigger />
          <span className="hidden text-xs text-muted-foreground lg:inline">{user.email}</span>
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
