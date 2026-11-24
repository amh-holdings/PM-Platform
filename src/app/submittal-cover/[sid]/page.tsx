import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";

import { guardCapability } from "@/lib/roles-server";
import { createClient } from "@/lib/supabase/server";
import {
  CATALOG_BY_KEY,
  deliverableFileName,
  submittalNumber,
  type ReviewDecision,
} from "@/lib/exhibit-s";

import { PrintButton } from "./print-button";

// The AHC submittal cover (20260327_SS_AHC_SubmittalCover_TEMPLATE), filled
// from the submittal. Outside the app shell so it prints as one clean page:
// Print, then Save as PDF, and attach it in front of the documents.

type Params = { sid: string };

const fmt = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC" })
    : "";

export default async function SubmittalCoverPage({ params }: { params: Params }) {
  await guardCapability("viewDeliverables");
  const supabase = createClient();
  const db = supabase as unknown as SupabaseClient;

  const { data: sub } = await db.from("project_submittals").select("*").eq("id", params.sid).maybeSingle();
  if (!sub) notFound();
  const { data: project } = await db
    .from("projects").select("name, spv_name, submittal_prefix").eq("id", sub.project_id).maybeSingle();
  const { data: revs } = await db
    .from("project_deliverable_revisions")
    .select("id, deliverable_id, rev_no, version_date, decision, notes")
    .eq("submittal_id", sub.id);
  const delivIds = (revs ?? []).map((r: { deliverable_id: string }) => r.deliverable_id);
  const { data: delivs } = delivIds.length
    ? await db.from("project_deliverables").select("id, catalog_key, device_id").in("id", delivIds)
    : { data: [] };
  const byId = new Map((delivs ?? []).map((d: { id: string; catalog_key: string; device_id: string }) => [d.id, d]));
  const spv = project?.spv_name || project?.name || "";
  const items = (revs ?? [])
    .map((r: { deliverable_id: string; rev_no: number; version_date: string; decision: string; notes: string | null }) => {
      const d = byId.get(r.deliverable_id);
      const c = d ? CATALOG_BY_KEY.get(d.catalog_key) : undefined;
      if (!d || !c) return null;
      return {
        name: deliverableFileName({ spv, item: c, versionDate: r.version_date, deviceId: d.device_id || null }),
        rev: r.rev_no,
        decision: r.decision,
        note: r.notes,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  // Only a single document can show the owner's answer on the cover; a
  // bundle is answered line by line.
  const decided = items.length > 0 && items.every((i) => i.decision === items[0].decision) && items[0].decision !== "submitted"
    ? (items[0].decision as ReviewDecision)
    : null;
  const number = submittalNumber(project?.submittal_prefix, sub.submittal_no);
  const rows = Math.max(5, items.length);

  const box = (on: boolean) => (
    <span className="mr-2 inline-block h-3 w-3 border border-black text-center align-middle text-[9px] leading-[10px]">{on ? "X" : ""}</span>
  );

  return (
    <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-3 flex max-w-[816px] items-center justify-between px-4 text-sm print:hidden">
        <span className="text-neutral-600">Submittal {number}. Print, then choose Save as PDF.</span>
        <PrintButton />
      </div>
      <div
        className="mx-auto max-w-[816px] bg-white px-14 py-10 text-[12px] text-black shadow print:max-w-none print:px-10 print:py-6 print:shadow-none"
        style={{ fontFamily: "'Times New Roman', Times, serif" }}
      >
        <div className="flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/submittal/ahc-logo.png" alt="American Helios Constructors" className="h-[62px] w-auto" />
          <div className="flex-1 pr-24 text-center text-[28px] tracking-wide text-[#1f3864]">SUBMITTAL</div>
        </div>
        <div className="mt-1 text-center">
          <span className="text-[#2f5597]">PROJECT:</span> <span>{sub.project_label || project?.name}</span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-y-1.5">
          <div className="flex"><span className="w-20 text-right pr-2">DATE:</span><span>{fmt(sub.submitted_on)}</span></div>
          <div className="flex"><span className="w-32 text-right pr-2">SUBMITTAL #:</span><span className="font-bold">{number}</span></div>
          <div className="flex"><span className="w-20 text-right pr-2">TO:</span><span>{sub.to_name}</span></div>
          <div className="flex"><span className="w-32 text-right pr-2">FROM:</span><span>{sub.from_name}</span></div>
          <div className="flex"><span className="w-20 text-right pr-2">SUBJECT:</span><span>{sub.subject}</span></div>
          <div className="flex"><span className="w-32 text-right pr-2">CC:</span><span>{sub.cc}</span></div>
        </div>

        <table className="mt-5 w-full border border-black">
          <tbody>
            <tr><td colSpan={2} className="border-b-2 border-[#2f5597] py-1 text-center">DOCUMENTS ARE BEING TRANSMITTED TO YOU</td></tr>
            <tr>
              <td className="w-1/2 py-1 pl-24">
                {box(sub.transmitted_for === "approval")}For Approval<br />
                {box(sub.transmitted_for === "signature")}For Signature
              </td>
              <td className="py-1 pl-10">
                {box(sub.transmitted_for === "record")}For Record<br />
                {box(sub.transmitted_for === "other")}Other (Specify):{" "}
                {sub.transmitted_for === "other" ? sub.transmitted_other : ""}
              </td>
            </tr>
          </tbody>
        </table>

        <table className="mt-4 w-full border-collapse border border-black">
          <thead>
            <tr>
              <th className="w-14 border border-black py-1 font-normal">ITEM #</th>
              <th className="border border-black py-1 font-normal">DOCUMENT NAME / DESCRIPTION</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i} className="h-[22px]">
                <td className="border border-black px-1">{items[i] ? i + 1 : ""}</td>
                <td className="border border-black px-2">
                  {items[i] ? (
                    <>
                      {items[i].name}
                      {items[i].rev > 0 && <span> (Rev {items[i].rev}{items[i].note ? `: ${items[i].note}` : ""})</span>}
                    </>
                  ) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4">ADDITIONAL NOTES:</div>
        <div className="min-h-[66px] whitespace-pre-wrap border-b border-black leading-[22px]"
          style={{ backgroundImage: "linear-gradient(to bottom, transparent 21px, #000 21px)", backgroundSize: "100% 22px" }}>
          {sub.notes}
        </div>

        <div className="mt-4 flex justify-center gap-2">
          <span>REQUESTED RESPONSE DATE:</span>
          <span className="inline-block min-w-[160px] border-b border-black text-center">{fmt(sub.requested_response_date)}</span>
        </div>

        <table className="mt-4 w-full border border-black">
          <tbody>
            <tr><td colSpan={2} className="border-b-2 border-[#2f5597] py-1 text-center">APPROVER RESPONSE</td></tr>
            <tr>
              <td className="w-1/2 py-1 pl-24">
                {box(decided === "approved")}APPROVED<br />
                {box(decided === "approved_as_noted")}APPROVED AS NOTED
              </td>
              <td className="py-1 pl-10">
                {box(decided === "revise_resubmit")}REVISE AND RESUBMIT<br />
                {box(decided === "rejected")}REJECTED
              </td>
            </tr>
          </tbody>
        </table>

        <table className="mt-4 w-full border-collapse border border-black">
          <thead>
            <tr>
              <th className="w-14 border border-black py-1 font-normal">ITEM #</th>
              <th className="border border-black py-1 font-normal">RESPONSE</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i} className="h-[22px]">
                <td className="border border-black px-1"></td>
                <td className="border border-black px-2"></td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-5 space-y-2 pr-2 text-right">
          <div>RESPONDENT NAME AND AFFILIATION: <span className="inline-block w-56 border-b border-black" /></div>
          <div>RESPONDENT SIGNATURE: <span className="inline-block w-56 border-b border-black" /></div>
        </div>

        <div className="mt-8 border-t border-black pt-2 text-center text-[#c00000]">
          PLEASE REFERENCE SUBMITTAL NUMBER &amp; DATE IN CORRESPONDENCE. THANK YOU.
        </div>
      </div>
    </div>
  );
}
