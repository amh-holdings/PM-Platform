"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Datum = {
  phase: string;
  pct: number;
  complete: number;
  total: number;
};

type Props = {
  data: Datum[];
};

export function DashboardScheduleChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        No phase data
      </div>
    );
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="phase"
            tick={{ fontSize: 11 }}
            interval={0}
            tickFormatter={(v: string) =>
              v.length > 14 ? `${v.slice(0, 14)}...` : v
            }
          />
          <YAxis
            tick={{ fontSize: 11 }}
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={48}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              borderRadius: 6,
              border: "1px solid hsl(var(--border))",
              fontSize: 12,
            }}
            formatter={(value, _name, info) => {
              const num = typeof value === "number" ? value : Number(value);
              const d = (info?.payload ?? {}) as Partial<Datum>;
              return [
                `${num.toFixed(0)}% (${d.complete ?? 0}/${d.total ?? 0})`,
                "Complete",
              ];
            }}
          />
          <Bar dataKey="pct" fill="hsl(142, 71%, 45%)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
