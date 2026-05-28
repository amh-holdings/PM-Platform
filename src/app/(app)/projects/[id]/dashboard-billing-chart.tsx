"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
                name === "actual" ? "Billed" : "Planned",
              ];
            }}
          />
          <Legend
            iconSize={10}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            formatter={(value) => (value === "actual" ? "Billed" : "Planned")}
          />
          <Bar dataKey="actual" stackId="a" fill="hsl(142, 71%, 45%)">
            {data.map((d, i) => (
              <Cell key={i} fill={d.isFuture ? "transparent" : "hsl(142, 71%, 45%)"} />
            ))}
          </Bar>
          <Bar dataKey="planned" stackId="a" fill="hsl(217, 91%, 60%)">
            {data.map((d, i) => (
              <Cell key={i} fill={d.isFuture ? "hsl(217, 91%, 60%)" : "transparent"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
