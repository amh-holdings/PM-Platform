"use server";

import { createClient } from "@/lib/supabase/server";

// The per-subcontractor equipment catalog behind the Field Report's equipment
// dropdown (migration 0047).
//
// Only adding is exposed to the form. A foreman who turns up with a machine
// that is not on the list adds it in one step and carries on filing; renaming
// and retiring stay with AHC, so nobody can change an entry out from under the
// rest of their crew mid-report. RLS enforces both halves of that - this
// action does not re-check the caller's role, it lets the insert policy
// decide, which keeps one source of truth for who may write.

export type EquipmentCatalogEntry = {
  id: string;
  subcontractorId: string;
  name: string;
  category: string | null;
  rentalCompany: string | null;
  onRent: boolean;
};

export type AddEquipmentResult =
  | { ok: true; entry: EquipmentCatalogEntry }
  | { ok: false; error: string };

export async function addProjectEquipment(input: {
  projectId: string;
  subcontractorId: string;
  name: string;
}): Promise<AddEquipmentResult> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Equipment name is required" };
  if (!input.subcontractorId)
    return { ok: false, error: "Pick the subcontractor filing this report first" };

  const { data, error } = await supabase
    .from("project_equipment")
    .insert({
      project_id: input.projectId,
      subcontractor_id: input.subcontractorId,
      name,
      created_by: user.id,
    })
    .select("id, subcontractor_id, name, category, rental_company, on_rent")
    .single();

  if (error) {
    // 23505 = the (subcontractor_id, lower(btrim(name))) unique index. Two
    // foremen adding "40-ton crane" within the same minute is a race, not a
    // mistake, so hand back the row that already exists instead of an error
    // the second one cannot act on.
    if (error.code === "23505") {
      // Matched in JS rather than with ilike: an equipment name is free text
      // and "50% grade roller" would make ilike treat the % as a wildcard.
      const { data: rows } = await supabase
        .from("project_equipment")
        .select("id, subcontractor_id, name, category, rental_company, on_rent")
        .eq("subcontractor_id", input.subcontractorId);
      const existing = (rows ?? []).find(
        (r) => r.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (existing) {
        return {
          ok: true,
          entry: {
            id: existing.id,
            subcontractorId: existing.subcontractor_id,
            name: existing.name,
            category: existing.category,
            rentalCompany: existing.rental_company,
            onRent: existing.on_rent,
          },
        };
      }
      return { ok: false, error: "That equipment is already on the list" };
    }
    return { ok: false, error: `Could not add equipment: ${error.message}` };
  }

  return {
    ok: true,
    entry: {
      id: data.id,
      subcontractorId: data.subcontractor_id,
      name: data.name,
      category: data.category,
      rentalCompany: data.rental_company,
      onRent: data.on_rent,
    },
  };
}
