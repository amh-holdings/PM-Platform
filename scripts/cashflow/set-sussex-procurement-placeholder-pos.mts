// Sussex procurement terms as placeholder POs, 2026-10-12.
//
// Phil: "Procurement should be net 30 upon delivery and 30% deposit due upon
// PO." No vendor is bought out yet, so the two procurement codes with a
// budget were cost_forecasts paid at Net 0 in the delivery month. The engine
// already knows how to pay a PO in two halves - a deposit milestone fires on
// the PO date, a delivery milestone follows the linked delivery task plus net
// terms - so each code gets an unsigned placeholder PO and its cost code is
// pointed at it. A linked PO makes the code commitment-covered, so the
// cost_forecasts rows stop counting and nothing is doubled.
//
// The delivery half moves with the schedule on its own. The PO date does NOT:
// it is ordered_date, written here as delivery minus LEAD_WEEKS. Re-run this
// after a schedule revision moves a delivery, and replace each placeholder
// with the real PO once it is placed (delete the placeholder, link the real
// one to the cost code).
//
// 200-1050 cable has no delivery task yet. It rides 3.3 Modules Delivered,
// the zero-day milestone tied to the start of Electrical. Not 4.4 itself: the
// engine dates a delivery off the task FINISH, which for 4.4 is August.
//
// Idempotent: finds its own POs by po_number and rewrites them. Dry run by
// default; pass --apply to write.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const DEPOSIT_PCT = 30;
const DELIVERY_NET_DAYS = 30;
// Phil, 2026-10-14: "30% deposit and the rest upon delivery all net 30" - the
// deposit is Net 30 from the PO too, not paid on signing.
const DEPOSIT_NET_DAYS = 30;
// Assumed lead time from PO to delivery. Phil has not set one.
const LEAD_WEEKS = 16;

const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Racking delivers on 3.4.3, the trackers delivery in the equipment section.
// 200-1050 cable had a placeholder too until 2026-10-14, when Phil said the
// electrical sub buys it - RETIRED below removes it and unlinks the code so
// its cost counts as sub material again.
const PLACEHOLDERS = [
  { code: "200-1030", what: "Racking, Mounting & Trackers", delivery: "3.4.3" },
];
const RETIRED = ["200-1050"];

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

for (const p of PLACEHOLDERS) {
  const { data: code, error: ce } = await sb
    .from("cost_codes").select("*").eq("project_id", PID).eq("code", p.code).single();
  if (ce || !code) throw ce ?? new Error(`no cost code ${p.code}`);
  const { data: task } = await sb
    .from("schedule_tasks").select("wbs_code, task_name, start_date, end_date")
    .eq("project_id", PID).eq("wbs_code", p.delivery).single();
  if (!task) throw new Error(`no delivery task ${p.delivery}`);

  // The engine dates a delivery milestone off the task finish.
  const deliveryDate = task.end_date;
  const ordered = addDays(deliveryDate, -LEAD_WEEKS * 7);
  const total = Number(code.estimated_cost ?? 0);
  if (!(total > 0)) throw new Error(`${p.code} has no budget`);
  const deposit = Math.round(total * DEPOSIT_PCT) / 100;
  const balance = Math.round((total - deposit) * 100) / 100;
  const poNumber = `SX-PLACEHOLDER-${p.code}`;

  console.log(
    `${p.code} ${p.what}: ${money(total)}\n` +
      `  PO ${ordered} -> ${DEPOSIT_PCT}% deposit ${money(deposit)} Net ${DEPOSIT_NET_DAYS} = ${addDays(ordered, DEPOSIT_NET_DAYS)}\n` +
      `  delivery ${p.delivery} ${deliveryDate} -> ${100 - DEPOSIT_PCT}% ${money(balance)} Net ${DELIVERY_NET_DAYS} = ${addDays(deliveryDate, DELIVERY_NET_DAYS)}`,
  );
  if (!APPLY) continue;

  const po = {
    project_id: PID,
    po_number: poNumber,
    vendor_name: `TBD - ${p.what}`,
    description: `Placeholder until the ${p.what} PO is placed. Carries Sussex procurement terms for the cash flow.`,
    total_value: total,
    ordered_date: ordered,
    status: "active",
    payment_terms_summary: `${DEPOSIT_PCT}% deposit Net ${DEPOSIT_NET_DAYS} from PO, ${100 - DEPOSIT_PCT}% Net ${DELIVERY_NET_DAYS} after delivery`,
    net_terms_days: DELIVERY_NET_DAYS,
    linked_delivery_task_wbs_code: p.delivery,
    notes: `Placeholder written by scripts/cashflow/set-sussex-procurement-placeholder-pos.mts. PO date assumes ${LEAD_WEEKS} weeks lead time.`,
  };
  const { data: existing } = await sb
    .from("procurement_orders").select("id").eq("project_id", PID).eq("po_number", poNumber).maybeSingle();
  let poId = existing?.id as string | undefined;
  if (poId) {
    const { error } = await sb.from("procurement_orders").update(po as never).eq("id", poId);
    if (error) throw error;
    const { error: de } = await sb.from("procurement_payments").delete().eq("procurement_order_id", poId);
    if (de) throw de;
  } else {
    const { data, error } = await sb.from("procurement_orders").insert(po as never).select("id").single();
    if (error) throw error;
    poId = data.id as string;
  }

  const { error: me } = await sb.from("procurement_payments").insert([
    {
      procurement_order_id: poId,
      milestone_name: "Deposit on PO",
      trigger_event: "PO release",
      pct_of_total: DEPOSIT_PCT,
      amount: deposit,
      net_terms_days: DEPOSIT_NET_DAYS,
      sort_order: 1,
    },
    {
      procurement_order_id: poId,
      milestone_name: "Balance on delivery",
      trigger_event: "Delivery",
      pct_of_total: 100 - DEPOSIT_PCT,
      amount: balance,
      net_terms_days: DELIVERY_NET_DAYS,
      sort_order: 2,
    },
  ] as never);
  if (me) throw me;

  const { error: le } = await sb.from("cost_codes").update({ procurement_order_id: poId } as never).eq("id", code.id);
  if (le) throw le;
  console.log(`  written: PO ${poNumber}, cost code linked`);
}

for (const codeNo of RETIRED) {
  const poNumber = `SX-PLACEHOLDER-${codeNo}`;
  const { data: po } = await sb.from("procurement_orders").select("id").eq("project_id", PID).eq("po_number", poNumber).maybeSingle();
  console.log(`${codeNo}: retire ${poNumber}${po ? "" : " (already gone)"}`);
  if (!APPLY || !po) continue;
  const { error: ue } = await sb.from("cost_codes").update({ procurement_order_id: null } as never).eq("project_id", PID).eq("code", codeNo);
  if (ue) throw ue;
  const { error: de } = await sb.from("procurement_orders").delete().eq("id", po.id);
  if (de) throw de;
  console.log("  removed, cost code unlinked");
}

if (!APPLY) console.log("\nDry run. Pass --apply to write.");
