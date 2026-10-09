import Link from "next/link";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Plain form pieces for the BD section. Server-safe, so pages can compose
// them inside ActionForm without a client boundary of their own.

export const controlClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function Field({
  label,
  htmlFor,
  required,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Select({
  id,
  name,
  options,
  defaultValue,
  required,
  blank,
}: {
  id?: string;
  name: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string | null;
  required?: boolean;
  /** Label for an empty first option; omit for no empty option. */
  blank?: string;
}) {
  return (
    <select
      id={id ?? name}
      name={name}
      defaultValue={defaultValue ?? ""}
      required={required}
      className={controlClass}
    >
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextArea({
  id,
  name,
  defaultValue,
  rows = 3,
  placeholder,
}: {
  id?: string;
  name: string;
  defaultValue?: string | null;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      id={id ?? name}
      name={name}
      rows={rows}
      defaultValue={defaultValue ?? ""}
      placeholder={placeholder}
      className={cn(controlClass, "h-auto")}
    />
  );
}

export function Card({
  title,
  action,
  id,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="rounded-lg border bg-card p-5 shadow-sm">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const STAGE_TONE: Record<string, string> = {
  lead: "bg-muted text-muted-foreground",
  bidding: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  submitted: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  shortlist: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  won: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  lost: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  no_bid: "bg-muted text-muted-foreground",
  dead: "bg-muted text-muted-foreground",
};

export function StagePill({ stage, label }: { stage: string; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        STAGE_TONE[stage] ?? STAGE_TONE.lead,
      )}
    >
      {label}
    </span>
  );
}

export function TextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium text-foreground underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export const thClass = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground";
export const tdClass = "px-3 py-2 align-top";
