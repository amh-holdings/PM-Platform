import { createClient } from "@/lib/supabase/server";

// Diagnostic page: shows what the DB thinks the current session is.
// If "current_user_role" comes back as one of phil / zarina / ahc_super
// but the subcontractor INSERT still fails, the policy is wrong.
// If "current_user_role" comes back as null, the session isn't reaching
// the DB and we have an auth-cookie issue.

export default async function DebugPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // The whoami RPC was added in migration 0013; cast around the missing type.
  const { data: whoami, error: whoamiErr } = await (
    supabase.rpc as unknown as (name: string) => Promise<{ data: unknown; error: { message: string } | null }>
  )("whoami");
  const { data: profileFromQuery, error: profileErr } = user
    ? await supabase.from("profiles").select("id, email, role").eq("id", user.id).maybeSingle()
    : { data: null, error: null };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">RLS / auth diagnostic</h2>
        <p className="text-xs text-muted-foreground">
          This page shows what the server action AND the database see for
          your current session. If they disagree, that&apos;s the bug.
        </p>
      </div>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Server (Node) view</h3>
        <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
{JSON.stringify({
  user: user ? { id: user.id, email: user.email } : null,
  profileFromQuery,
  profileErr: profileErr ? profileErr.message : null,
}, null, 2)}
        </pre>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Database view (whoami RPC)</h3>
        <p className="text-xs text-muted-foreground">
          Calls public.whoami() which returns auth.uid(), auth.role(),
          current_user_role(), and whether your profile exists.
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
{whoamiErr
  ? JSON.stringify({ error: whoamiErr.message }, null, 2)
  : JSON.stringify(whoami, null, 2)}
        </pre>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">What to look for</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>
            <code>auth_uid</code> in the Database view should match{" "}
            <code>user.id</code> in the Server view.
          </li>
          <li>
            <code>current_user_role</code> should be{" "}
            <code>&quot;phil&quot;</code>.
          </li>
          <li>
            If <code>auth_uid</code> is <code>null</code>, the session
            isn&apos;t reaching the DB - the cookie isn&apos;t being passed.
            Sign out and back in, hard-refresh (Cmd+Shift+R).
          </li>
          <li>
            If <code>auth_uid</code> is set but <code>profile_exists</code> is
            false, somehow your auth user id doesn&apos;t match a profile row.
          </li>
          <li>
            If everything looks right and the INSERT still fails, paste the
            output back to me.
          </li>
        </ul>
      </section>
    </div>
  );
}
