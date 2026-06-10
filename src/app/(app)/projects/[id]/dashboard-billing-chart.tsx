"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCurrency } from "@/lib/format";

type Datum = {
  month: string;
  label: string;
  actualCash: number;
  actualRetainage: number;
  plannedCash: number;
  plannedRetainage: number;
  isFuture: boolean;
};

type Props = {
  data: Datum[];
};

// Color palette: each pair shares hue; the retainage shade is lighter +
// shifted toward background so the "held back" portion reads as deferred.
const ACTUAL_CASH = "hsl(142, 71%, 45%)";        // billed + paid cash (green)
const ACTUAL_RETAINAGE = "hsl(142, 50%, 75%)";   // billed + held in retainage (pale green)
const PLANNED_CASH = "hsl(217, 91%, 60%)";       // planned cash to come (blue)
const PLANNED_RETAINAGE = "hsl(217, 70%, 80%)";  // planned retainage (pale blue)

const NAME_LABELS: Record<string, string> = {
  actualCash: "Billed (cash)",
  actualRetainage: "Billed (retainage held)",
  plannedCash: "Planned (cash)",
  plannedRetainage: "Planned (retainage)",
};

export function DashboardBillingChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        No billing data yet
      </div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) =>
              v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
            }
            width={56}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              borderRadius: 6,
              border: "1px solid hsl(var(--border))",
              fontSize: 12,
            }}
            formatter={(value, name) => {
              const num = typeof value === "number" ? value : Number(value);
              return [
                formatCurrency(num),
                NAME_LABELS[name as string] ?? String(name),
              ];
            }}
          />
          <Legend
            iconSize={10}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            formatter={(value) => NAME_LABELS[value as string] ?? String(value)}
          />
          {/* Stack order bottom -> top: cash sits below retainage so the
              "held back" portion visually caps each bar. Each month has at
              most one (cash, retainage) pair: actual XOR planned per row. */}
          <Bar dataKey="actualCash" stackId="a" fill={ACTUAL_CASH} />
          <Bar dataKey="actualRetainage" stackId="a" fill={ACTUAL_RETAINAGE} />
          <Bar dataKey="plannedCash" stackId="a" fill={PLANNED_CASH} />
          <Bar dataKey="plannedRetainage" stackId="a" fill={PLANNED_RETAINAGE} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
