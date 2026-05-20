import Link from "next/link";

export const metadata = {
  title: "Sign-in error - AHC PM Platform",
};

export default function AuthCodeErrorPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold">Sign-in link expired</h1>
        <p className="text-sm text-muted-foreground">
          That magic link is no longer valid. Request a new one to continue.
        </p>
        <Link
          href="/login"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
