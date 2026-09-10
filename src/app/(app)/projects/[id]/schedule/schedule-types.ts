// The row shape the schedule views share.
//
// It lived in schedule-table.tsx, which meant every other component imported a
// type from a sibling view. Once the table and the grid merged there was no
// obvious owner left, so it lives on its own.

import type { TaskFormValues } from "./task-edit-dialog";

export type ScheduleTaskRow = TaskFormValues & {
  sort_order: number | null;
  level_code: number | null;
  pct_complete: number | null;
  status_source: string | null;
  last_dpr_at: string | null;
  baseline_start?: string | null;
  baseline_end?: string | null;
};
