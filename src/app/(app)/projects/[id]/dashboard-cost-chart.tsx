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
  code: string;
  estimated: number;
  actual: number;
};

type Props = {
  data: Datum[];
};

export function DashboardCostChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        No cost codes
      </div>
    );
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="code"
            tick={{ fontSize: 11 }}
            interval={0}
            tickFormatter={(v: string) =>
              v.length > 10 ? `${v.slice(0, 10)}...` : v
            }
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
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
              return [formatCurrency(num), name === "estimated" ? "Estimated" : "Actual"];
            }}
          />
          <Legend
            iconSize={10}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            formatter={(value) =>
              value === "estimated" ? "Estimated" : "Actual"
            }
          />
          <Bar dataKey="estimated" fill="hsl(217, 91%, 60%)" radius={[3, 3, 0, 0]} />
          <Bar dataKey="actual" fill="hsl(0, 84%, 60%)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
