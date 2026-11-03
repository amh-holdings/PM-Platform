import { PageShell } from "@/components/nav/page-shell";
import { guardCapability } from "@/lib/roles-server";
import { RfpTabs } from "./_components/rfp-tabs";

export const metadata = {
  title: "RFPs - AHC PM Platform",
};

// Top level on purpose: an RFP comes before any project exists, so it lives
// outside every project, beside Business Dev, not as a project tab.
export default async function RfpLayout({ children }: { children: React.ReactNode }) {
  await guardCapability("runRfp");
  return (
    <PageShell wide>
      <div className="space-y-6">
        <RfpTabs />
        {children}
      </div>
    </PageShell>
  );
}
