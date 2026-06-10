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
  actual: number;
  planned: number;
  isFuture: boolean;
};

type Props = {
  data: Datum[];
};

export function DashboardCashOutChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        No cash-out data yet
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
                name === "actual" ? "Spent" : "Projected",
              ];
            }}
          />
          <Legend
            iconSize={10}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            formatter={(value) => (value === "actual" ? "Spent" : "Projected")}
          />
          {/* Actual = paid (red). Planned = scheduled but not yet paid (orange).
              The two are mutually exclusive per month per source row, so the
              stack never double-counts. Both visible regardless of isFuture -
              an overdue planned payment in the past still needs to show. */}
          <Bar dataKey="actual" stackId="a" fill="hsl(0, 84%, 60%)" />
          <Bar dataKey="planned" stackId="a" fill="hsl(24, 95%, 53%)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
