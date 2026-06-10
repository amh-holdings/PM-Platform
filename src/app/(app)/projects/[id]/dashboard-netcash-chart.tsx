"use client";

import {
  Bar,
  CartesianGrid,
  Cell,
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

type Datum = {
  month: string;
  label: string;
  net: number;
  cumulative: number;
  isFuture: boolean;
};

type Props = {
  data: Datum[];
};

export function DashboardNetCashChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        No cash flow yet
      </div>
    );
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
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
              Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
            }
            width={56}
          />
          <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1.5} />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              borderRadius: 6,
              border: "1px solid hsl(var(--border))",
              fontSize: 12,
            }}
            formatter={(value, name) => {
              const num = typeof value === "number" ? value : Number(value);
              const label =
                name === "net"
                  ? "Margin (month)"
                  : "Cumulative margin";
              return [formatCurrency(num), label];
            }}
          />
          <Legend
            iconSize={10}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            formatter={(value) =>
              value === "net" ? "Margin (month)" : "Cumulative margin"
            }
          />
          <Bar dataKey="net">
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={
                  d.net >= 0
                    ? d.isFuture
                      ? "hsl(142, 71%, 80%)"
                      : "hsl(142, 71%, 45%)"
                    : d.isFuture
                      ? "hsl(0, 84%, 80%)"
                      : "hsl(0, 84%, 60%)"
                }
              />
            ))}
          </Bar>
          <Line
            type="monotone"
            dataKey="cumulative"
            stroke="hsl(217, 91%, 60%)"
            strokeWidth={2}
            dot={{ r: 2 }}
            activeDot={{ r: 4 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
