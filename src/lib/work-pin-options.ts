// The dropdown values a work-done pin is filled in with. Shared by the Field
// Report form (where the pin is created) and the rejected-pin correction card
// (where it is fixed), so the two lists cannot drift apart.

export const WORK_STATUS_OPTIONS = [
  "Not Started",
  "In Progress",
  "Complete",
  "Awaiting",
  "Approved",
  "Rejected",
];

/** Units a work item's installed quantity can be reported in. */
export const UNIT_OPTIONS = [
  "EA",
  "LF",
  "SF",
  "SY",
  "CY",
  "LB",
  "TON",
  "GAL",
  "HR",
  "KW",
  "LS",
];
