import { PageShell } from "@/components/nav/page-shell";
import { guardCapability } from "@/lib/roles-server";
import { BdTabs } from "./_components/bd-tabs";

export const metadata = {
  title: "Business Development - AHC PM Platform",
};

export default async function BdLayout({ children }: { children: React.ReactNode }) {
  await guardCapability("viewBD");
  return (
    <PageShell wide>
      <div className="space-y-6">
        <BdTabs />
        {children}
      </div>
    </PageShell>
  );
}
