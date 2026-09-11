"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCurrency } from "@/lib/format";

// One chart instead of three.
//
// Project margin, Billing timeline and Cash Out timeline each drew their own
// picture from the same projection rows: money coming in, money going out, and
// the running total. Three charts of one dataset is three places to read and
// three chances to disagree, and they did disagree - all three claimed there
// was no data while the table beside them showed $290,388.
//
// This is the shape the question actually has. Cash in stacks upward, cash out
// hangs below the axis, and the line is the position you are actually in. The
// thing a PM needs off this page is "when does money move, and am I ever
// short", and that is one glance rather than three.
//
// Retainage is drawn as its own lighter band on the cash-in bar rather than
// folded into it, because withheld money is not money you have.

export type CashflowDatum = {
  month: string;
  label: string;
  /** Reaches the bank this month. */
  cashInActual: number;
  cashInForecast: number;
  /** Earned but withheld, so it is visible without being counted as cash. */
  retainageHeld: number;
  /** Negative, so the bars hang below the axis without any transform. */
  cashOutActual: number;
  cashOutForecast: number;
  cumulative: number;
  isFuture: boolean;
};

const SERIES_LABEL: Record<string, string> = {
  cashInActual: "Cash in (received)",
  cashInForecast: "Cash in (forecast)",
  retainageHeld: "Retainage held",
  cashOutActual: "Cash out (paid)",
  cashOutForecast: "Cash out (forecast)",
  cumulative: "Cash position",
};

// Received and forecast share a hue so the eye groups them; the forecast is the
// lighter of the pair, the same convention the old billing chart used.
const FILL: Record<string, string> = {
  cashInActual: "hsl(142, 71%, 40%)",
  cashInForecast: "hsl(142, 60%, 72%)",
  retainageHeld: "hsl(142, 30%, 88%)",
  cashOutActual: "hsl(24, 90%, 48%)",
  cashOutForecast: "hsl(24, 85%, 76%)",
};

export function DashboardCashflowChart({ data }: { data: CashflowDatum[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        Nothing to project yet - link the SOV to schedule tasks and this fills in
      </div>
    );
  }

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) =>
              Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
            }
            width={56}
          />
          <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeWidth={1} />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              borderRadius: 6,
              border: "1px solid hsl(var(--border))",
              fontSize: 12,
            }}
            formatter={(value, name) => {
              const num = typeof value === "number" ? value : Number(value);
              // Cash out is stored negative so it hangs below the axis. Nobody
              // wants to read "-$18,216 paid out".
              return [formatCurrency(Math.abs(num)), SERIES_LABEL[String(name)] ?? String(name)];
            }}
          />
          <Legend
            iconSize={10}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            formatter={(v) => SERIES_LABEL[String(v)] ?? String(v)}
          />

          <Bar dataKey="cashInActual" stackId="in" fill={FILL.cashInActual} />
          <Bar dataKey="cashInForecast" stackId="in" fill={FILL.cashInForecast} />
          <Bar dataKey="retainageHeld" stackId="in" fill={FILL.retainageHeld} />

          <Bar dataKey="cashOutActual" stackId="out" fill={FILL.cashOutActual} />
          <Bar dataKey="cashOutForecast" stackId="out" fill={FILL.cashOutForecast} />

          <Line
            type="monotone"
            dataKey="cumulative"
            stroke="hsl(217, 91%, 55%)"
            strokeWidth={2.5}
            dot={{ r: 2 }}
            activeDot={{ r: 4 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
