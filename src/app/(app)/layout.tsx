import { SiteNav } from "@/components/site-nav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30">
      <SiteNav />
      <div className="mx-auto max-w-5xl px-4 py-8">{children}</div>
    </div>
  );
}
