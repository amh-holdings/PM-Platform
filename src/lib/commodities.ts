// The 18 commodities on the Sweet Spring Solar Commodity Tracker.
//
// This list is the contract between three systems that name the same things
// slightly differently:
//
//   1. The client's Smartsheet form / "Live Production Report" intake sheet,
//      whose column titles we must match exactly on export.
//   2. The client's "Commodity Tracker Roll-up" sheet, whose row labels differ
//      from the form's column titles on four commodities (the roll-up appends
//      "Installed" / "Terminated" and spells Site Prep out in full).
//   3. Our own `commodities` table, keyed by the stable `key` slug.
//
// `key` is what code and the database use and must never change. `formColumn`
// and `rollupLabel` describe the client's sheets and may drift if DE edits them.
//
// Units follow the client's form exactly. `pct` commodities take a DAILY
// percent (0-100), matching the form's instruction: "Please input *DAILY*
// production values, not cumulative."

export type CommodityCategory = "civil" | "electrical" | "mechanical";
export type CommodityUom = "ft" | "ea" | "rows" | "pct";

export type CommoditySpec = {
  key: string;
  /** Column title on the client's Live Production Report intake sheet. */
  formColumn: string;
  /** Row label on the client's Commodity Tracker Roll-up sheet. */
  rollupLabel: string;
  category: CommodityCategory;
  uom: CommodityUom;
  /** SOV item on the roll-up. Null where the roll-up leaves it blank. */
  sovItem: string | null;
  /**
   * SOV item on the EXECUTED CONTRACT, which is what billing may use.
   *
   * This differs from `sovItem` on four rows. The client's roll-up maps
   * fencing to 6.02 and road install to 6.03, but the contract has 6.02 =
   * "Civil, Roads and Landscaping" and 6.03 = "Fencing/SWPPP" - the reverse.
   * Phil confirmed the contract descriptions are authoritative (2026-08-19).
   * `sovItem` still records the roll-up verbatim because the Smartsheet export
   * has to match the client's sheet; only this field may drive money.
   *
   * Null means the commodity does not map cleanly to one contract line and
   * must never be used to compute a billing percentage.
   */
  contractSovItem: string | null;
  /**
   * Row id on the roll-up sheet (4657028358164356), captured 2026-08-19.
   * Lets the automated push target the row without re-matching on label.
   */
  rollupRowId: number;
  /**
   * Total quantity currently on the client's roll-up. These are Jan-2025
   * template placeholders - 250 ft of road install and 500 ft of trenching on a
   * $3.95M project are not real numbers. Seeded with total_verified = false and
   * must be replaced from the contract SOV before any % complete is published.
   */
  placeholderTotal: number | null;
};

// Order matters: this is the left-to-right column order of the client's intake
// sheet, after Submitter Name / CM Verification / Submitter Email / Production
// Date. Export builds rows from this array directly.
export const COMMODITIES: CommoditySpec[] = [
  // ---- Civil ----
  {
    key: "fencing",
    formColumn: "Fencing",
    rollupLabel: "Fencing",
    category: "civil",
    uom: "ft",
    sovItem: "6.02",
    // roll-up says 6.02; contract 6.03 is Fencing/SWPPP
    contractSovItem: "6.03",
    rollupRowId: 5108332002283396,
    placeholderTotal: 1000,
  },
  {
    key: "site_prep",
    formColumn: "Site Prep",
    rollupLabel: "Site Prep (Silt Fence, Timbering Clearing/Grubbing)",
    category: "civil",
    uom: "pct",
    sovItem: "6.02",
    // spans 6.02 (timbering/clearing/grubbing) and 6.03 (silt fence) - unmapped until split
    contractSovItem: null,
    rollupRowId: 7360131815968644,
    placeholderTotal: 1,
  },
  {
    key: "civil_work",
    formColumn: "Civil Work",
    rollupLabel: "Civil Work",
    category: "civil",
    uom: "pct",
    sovItem: "6.02",
    contractSovItem: "6.02",
    rollupRowId: 2856532188598148,
    placeholderTotal: 1,
  },
  {
    key: "road_install",
    formColumn: "Road Install",
    rollupLabel: "Road Install",
    category: "civil",
    uom: "ft",
    sovItem: "6.03",
    // roll-up says 6.03; contract 6.02 is Civil, Roads and Landscaping
    contractSovItem: "6.02",
    rollupRowId: 1730632281755524,
    placeholderTotal: 250,
  },
  {
    key: "inverter_pads",
    formColumn: "Inverter Pads",
    rollupLabel: "Inverter Pads",
    category: "civil",
    uom: "ea",
    sovItem: "6.03",
    // roll-up says 6.03; concrete pads are named in 7.02
    contractSovItem: "7.02",
    rollupRowId: 6234231909126020,
    placeholderTotal: 15,
  },

  // ---- Electrical ----
  {
    key: "inverters_installed",
    formColumn: "Inverters Installed",
    rollupLabel: "Inverters Installed",
    category: "electrical",
    uom: "ea",
    sovItem: "7.01",
    contractSovItem: "7.01",
    rollupRowId: 8486031722811268,
    placeholderTotal: 50,
  },
  {
    key: "trenching",
    formColumn: "Trenching",
    rollupLabel: "Trenching",
    category: "electrical",
    uom: "ft",
    sovItem: "7.02",
    contractSovItem: "7.02",
    rollupRowId: 323257398202244,
    placeholderTotal: 500,
  },
  {
    key: "lv_ac_wire",
    formColumn: "LV/AC Wire",
    rollupLabel: "LV/AC Wire",
    category: "electrical",
    uom: "pct",
    sovItem: "7.02",
    contractSovItem: "7.02",
    rollupRowId: 4826857025572740,
    placeholderTotal: 1,
  },
  {
    key: "ac_panels",
    formColumn: "AC Panels",
    rollupLabel: "AC Panels Terminated",
    category: "electrical",
    uom: "ea",
    sovItem: "7.02",
    contractSovItem: "7.02",
    rollupRowId: 2575057211887492,
    placeholderTotal: 2,
  },
  {
    key: "lv_dc_wire",
    formColumn: "LV/DC Wire",
    rollupLabel: "LV/DC Wire",
    category: "electrical",
    uom: "pct",
    sovItem: "7.02",
    contractSovItem: "7.02",
    rollupRowId: 7078656839257988,
    placeholderTotal: 1,
  },
  {
    key: "dc_combiner_boxes",
    formColumn: "DC Combiner Boxes",
    rollupLabel: "DC Combiner Boxes Terminated",
    category: "electrical",
    uom: "ea",
    sovItem: "7.02",
    contractSovItem: "7.02",
    rollupRowId: 1449157305044868,
    placeholderTotal: 20,
  },
  {
    key: "transformers_installed",
    formColumn: "Transformers Installed",
    rollupLabel: "Transformers Installed",
    category: "electrical",
    uom: "ea",
    sovItem: "7.03",
    contractSovItem: "7.03",
    rollupRowId: 5952756932415364,
    placeholderTotal: 2,
  },
  {
    key: "switchgear_installed",
    formColumn: "Switchgear Installed",
    rollupLabel: "Switchgear Installed",
    category: "electrical",
    uom: "ea",
    sovItem: "7.04",
    contractSovItem: "7.04",
    rollupRowId: 3700957118730116,
    placeholderTotal: 2,
  },
  {
    key: "mv_install",
    formColumn: "MV Install",
    rollupLabel: "MV Install",
    category: "electrical",
    uom: "pct",
    // The roll-up leaves SOV Item blank on this row.
    sovItem: null,
    // roll-up leaves SOV Item blank
    contractSovItem: null,
    rollupRowId: 8204556746100612,
    placeholderTotal: 1,
  },

  // ---- Mechanical ----
  {
    key: "piles",
    formColumn: "Piles",
    rollupLabel: "Piles",
    category: "mechanical",
    uom: "ea",
    sovItem: "8.01",
    contractSovItem: "8.01",
    rollupRowId: 5389806978994052,
    placeholderTotal: 500,
  },
  {
    key: "racking",
    formColumn: "Racking",
    rollupLabel: "Racking",
    category: "mechanical",
    uom: "rows",
    sovItem: "8.01",
    contractSovItem: "8.01",
    rollupRowId: 3138007165308804,
    placeholderTotal: 100,
  },
  {
    key: "modules",
    formColumn: "Modules",
    rollupLabel: "Modules Installed",
    category: "mechanical",
    uom: "ea",
    sovItem: "8.02",
    contractSovItem: "8.02",
    rollupRowId: 7641606792679300,
    placeholderTotal: 12000,
  },
  {
    key: "cab_string_wire",
    formColumn: "CAB/String Wire Management",
    rollupLabel: "CAB/String Wire Management",
    category: "mechanical",
    uom: "pct",
    sovItem: "8.03",
    contractSovItem: "8.03",
    rollupRowId: 2012107258466180,
    placeholderTotal: 1,
  },
];

export const CATEGORY_LABEL: Record<CommodityCategory, string> = {
  civil: "Civil",
  electrical: "Electrical",
  mechanical: "Mechanical",
};

export const UOM_LABEL: Record<CommodityUom, string> = {
  ft: "ft",
  ea: "ea",
  rows: "rows",
  pct: "%",
};

/** Commodity keys in the client's intake-sheet column order. */
export const COMMODITY_KEY_ORDER: string[] = COMMODITIES.map((c) => c.key);

/**
 * Fixed columns on the intake sheet, left to right, before the 18 commodities.
 * Kept here so the export script and any future push agree on one definition.
 */
export const SMARTSHEET_FIXED_COLUMNS = [
  "Submitter Name",
  "CM Verification",
  "Submitter Email",
  "Production Date",
] as const;

export function commodityByKey(key: string): CommoditySpec | undefined {
  return COMMODITIES.find((c) => c.key === key);
}

export function commoditiesByCategory(
  category: CommodityCategory
): CommoditySpec[] {
  return COMMODITIES.filter((c) => c.category === category);
}

/**
 * A daily value is valid if it is a non-negative number, and for percent
 * commodities also at most 100. Percent commodities carry a DAILY percent, so a
 * single day may legitimately be small; it is the running total that must not
 * exceed 100, which is checked at export rather than at entry.
 */
export function isValidDailyValue(spec: CommoditySpec, value: number): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  if (spec.uom === "pct" && value > 100) return false;
  return true;
}

/**
 * Commodities that map to one contract SOV line, grouped by that line.
 * Rows whose contractSovItem is null are excluded - they cannot be used to
 * compute a percentage against a single line.
 */
export function commoditiesByContractSovItem(): Map<string, CommoditySpec[]> {
  const byItem = new Map<string, CommoditySpec[]>();
  for (const c of COMMODITIES) {
    if (!c.contractSovItem) continue;
    const list = byItem.get(c.contractSovItem) ?? [];
    list.push(c);
    byItem.set(c.contractSovItem, list);
  }
  return byItem;
}
