import { DOC_STAGE_LABEL, REQUIRED_DOCS, RFP_PHASES, type DocStage } from "@/lib/rfp";
import { Card } from "../../bd/_components/fields";

const STANDING_RULES = [
  "Nothing state-specific lives in a phase. It lives in the State Profile",
  "A PDF proposal without the bid sheet is not a bid",
  "Analyze the whole document set before building anything",
  "Scope comes from the drawings, not the last project's bid sheet",
  "Claude finds scope and drafts language. We decide what we bid",
  "License check before inviting, every time, even for known subs",
  "Silence is not a bid in progress",
  "A decline is a hole in the bidder list. Replace it the same week",
  "A sub keeps its whole bid scope. Count sub general conditions once",
  "Compare unit prices, not lump sums",
  "An allowance is not a price. Label it everywhere",
  "Zero on the sheet is exposure, not savings",
  "The price is firm to the Owner and open with the subs. Never conflate the two",
  "If the client gave us a form, we submit on their form",
  "Nothing counts until it's in the vendor folder",
  "Nothing goes to the Owner without review by someone other than the author",
];

/** The runbook itself, read-only. Every bid's checklist is built from this. */
export default function RunbookPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">AHC RFP Process</h1>
        <p className="text-sm text-muted-foreground">
          Data room to submitted EPC price. Client and state agnostic. Built from the Sweet Springs, Standard Solar
          and Sussex CSG 1 RFPs. Zarina runs it, Phil reviews at the bid package, the price and the submission.
        </p>
      </div>

      <Card title="Phases">
        <ol className="space-y-4">
          {RFP_PHASES.map((p) => (
            <li key={p.key}>
              <div className="font-medium">
                {p.num}. {p.title} <span className="font-normal text-muted-foreground">- {p.owner}</span>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {p.steps.map((s) => (
                  <li key={s.key}>{s.text}</li>
                ))}
              </ul>
              {p.notes?.length ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {p.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>

      <Card title="What subs and suppliers provide">
        <div className="grid gap-6 md:grid-cols-2">
          {(Object.keys(REQUIRED_DOCS) as DocStage[]).map((stage) => (
            <div key={stage}>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {DOC_STAGE_LABEL[stage]}
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {REQUIRED_DOCS[stage].map((d) => (
                  <li key={d.key}>{d.label}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Standing rules">
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {STANDING_RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
