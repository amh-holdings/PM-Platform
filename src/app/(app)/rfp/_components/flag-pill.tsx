import { cn } from "@/lib/utils";

const TONE = {
  bad: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  good: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  muted: "bg-muted text-muted-foreground",
} as const;

export function Pill({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", TONE[tone])}>
      {children}
    </span>
  );
}
