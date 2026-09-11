-- 0049_billing_line_milestone_task.sql
--
-- Lets an owner SOV line name the task whose completion earns it.
--
-- Most of these lines are milestone payments: "Civil IFP (Stamped)" is earned
-- when the stamped set goes out, not progressively while it is drawn. The
-- engine now infers that milestone when a line is linked to a package - it
-- takes the deliverable-shaped leaf inside, a page turn or an issue - and that
-- inference is right on every line Sussexx has.
--
-- But it IS an inference, resting on a naming convention. This column is the
-- override for when the convention does not hold: name the task explicitly and
-- nothing has to be guessed. It mirrors sub_sov_lines.milestone_task_wbs_code,
-- which has carried the same meaning on the subcontractor side since 0034.
--
-- Deliberately a bare wbs_code with no foreign key, matching
-- linked_task_wbs_codes beside it. Schedule codes get renumbered by indent and
-- outdent, and a hard reference would either block those edits or cascade them
-- somewhere the author could not see. The app validates the code against the
-- project's schedule when it is set, and shows it in amber when it stops
-- resolving - the same treatment a dangling link already gets.

alter table public.billing_lines
  add column if not exists milestone_task_wbs_code text;

comment on column public.billing_lines.milestone_task_wbs_code is
  'Task whose completion earns this line, when it should not be inferred. '
  'Overrides the milestone resolved from linked_task_wbs_codes. '
  'A bare WBS code by design - see 0049 for why there is no foreign key.';
