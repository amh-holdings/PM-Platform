import { PageShell } from "@/components/nav/page-shell";
import { guardCapability } from "@/lib/roles-server";
import { RfpTabs } from "./_components/rfp-tabs";

export const metadata = {
  title: "RFPs - AHC PM Platform",
};

// Top level on purpose: a round can belong to a BD opportunity or a live
// project, so it lives outside every project, beside Business Dev. Business
// Dev keeps only the overall status of each bid; every RFP function is here.
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
