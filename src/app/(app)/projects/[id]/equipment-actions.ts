"use server";

import { createClient } from "@/lib/supabase/server";

// The per-subcontractor equipment catalog behind the Field Report's equipment
// dropdown (migration 0047).
//
// Adding and retiring are both exposed to the form. A foreman who turns up
// with a machine that is not on the list adds it in one step, and takes it off
// the list the day it leaves site. Zarina: "we just need to be able to delete
// equipment as it leaves site."
//
// Renaming stays with AHC, so nobody can change an entry out from under the
// rest of their crew mid-report. RLS enforces that - these actions do not
// re-check the caller's role, they let the policy decide, which keeps one
// source of truth for who may write.

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

export type RetireEquipmentResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Take a machine off the list the day it leaves site.
 *
 * Retires rather than deletes, and that is not a hedge. Every dpr_equipment
 * row on a filed report points at this id, and a filed report is a record of
 * what was on site on a day that happened. Deleting the row would either
 * orphan those references or cascade the machine out of reports already
 * submitted to the owner. Migration 0047 put `active` here for exactly this.
 *
 * Goes through the retire_project_equipment function (0066) rather than
 * updating the table directly. 0047 gave subs INSERT and nothing else, so a
 * foreman's UPDATE matched zero rows under RLS - and a zero-row UPDATE is not
 * an error to PostgREST. The machine disappeared from the screen, the write
 * never happened, and it was back on the next load. Zarina: "It does it for
 * one pin. As soon as you set another pin it populates back what you have
 * deleted from the first pin."
 *
 * The function is a narrow grant: it sets active=false, it checks the caller
 * owns the crew, and it can do nothing else. Until it is applied, the fallback
 * below keeps AHC working and - unlike before - says plainly when a write
 * reached nothing instead of reporting success.
 */
export async function retireProjectEquipment(input: {
  projectId: string;
  equipmentId: string;
}): Promise<RetireEquipmentResult> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };
  if (!input.equipmentId) return { ok: false, error: "No equipment selected" };

  // Cast because db/types.ts is generated from the applied schema and 0066 is
  // not in it yet. Narrowed to what this call actually needs rather than any.
  const callRpc = supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ error: { code?: string; message: string } | null }>;

  const rpc = await callRpc("retire_project_equipment", {
    p_equipment_id: input.equipmentId,
  });

  if (!rpc.error) {
    // false = already retired by someone else. Same outcome either way.
    return { ok: true };
  }

  // PGRST202 (no such function) / 42883 (undefined_function) mean 0066 has not
  // been applied yet. Anything else is a real refusal and belongs on screen.
  const missing = rpc.error.code === "PGRST202" || rpc.error.code === "42883";
  if (!missing) {
    if (rpc.error.code === "42501") {
      return {
        ok: false,
        error:
          "Your sign-in cannot change this crew's equipment list. Ask AHC to remove it.",
      };
    }
    return { ok: false, error: `Could not remove equipment: ${rpc.error.message}` };
  }

  const { data, error } = await supabase
    .from("project_equipment")
    .update({ active: false })
    .eq("id", input.equipmentId)
    .eq("project_id", input.projectId)
    .select("id");

  if (error) {
    return { ok: false, error: `Could not remove equipment: ${error.message}` };
  }
  // The silent case. An empty result means RLS let the statement run and it
  // matched nothing - the row is another project's, or the caller is a sub and
  // 0066 is not applied. Saying so beats removing it from the screen and
  // letting it reappear.
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        "That equipment was not removed - your sign-in cannot change the crew's list. Ask AHC to remove it, or apply migration 0066.",
    };
  }
  return { ok: true };
}
