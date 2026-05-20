"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type CreateProjectState = {
  error?: string;
  fieldErrors?: Partial<Record<"name" | "contract_value" | "ntp_date" | "cod_date", string>>;
};

const STATUS_OPTIONS = [
  "Planning",
  "Permitting",
  "Construction",
  "Commissioning",
  "Operational",
  "On Hold",
  "Cancelled",
] as const;

type StatusOption = (typeof STATUS_OPTIONS)[number];

function parseDate(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  // <input type="date"> already returns YYYY-MM-DD, which Postgres date accepts.
  return value;
}

function parseCurrency(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return "invalid";
  return num;
}

export async function createProject(
  _previous: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const name = formData.get("name");
  if (typeof name !== "string" || !name.trim()) {
    return { fieldErrors: { name: "Name is required" } };
  }

  const contractValue = parseCurrency(formData.get("contract_value"));
  if (contractValue === "invalid") {
    return { fieldErrors: { contract_value: "Enter a valid dollar amount" } };
  }

  const statusRaw = formData.get("status");
  const status =
    typeof statusRaw === "string" && (STATUS_OPTIONS as readonly string[]).includes(statusRaw)
      ? (statusRaw as StatusOption)
      : null;

  const client = formData.get("client");
  const zipCode = formData.get("zip_code");

  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name: name.trim(),
      client: typeof client === "string" && client.trim() ? client.trim() : null,
      status,
      contract_value: contractValue,
      ntp_date: parseDate(formData.get("ntp_date")),
      cod_date: parseDate(formData.get("cod_date")),
      zip_code: typeof zipCode === "string" && zipCode.trim() ? zipCode.trim() : null,
    })
    .select("id")
    .single();

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/projects");
  revalidatePath("/");
  redirect(`/projects/${data.id}`);
}

export const PROJECT_STATUS_OPTIONS = STATUS_OPTIONS;
