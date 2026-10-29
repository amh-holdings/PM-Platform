-- 0081_email_updates_schedule_start.sql
-- Email updates can now propose that a task has started, such as a design
-- package's internal review once its page turn is held. Proposed only: a
-- person approves it on the Email updates page, and Undo puts it back.

alter table public.email_updates drop constraint if exists email_updates_kind_chk;
alter table public.email_updates add constraint email_updates_kind_chk
  check (kind in (
    'schedule_complete', 'schedule_constraint', 'schedule_start', 'sub_pay_app',
    'compliance_doc', 'afp_status', 'afp_paid', 'inspection_result', 'change_order',
    'percent_complete', 'owner_dispute', 'unmatched'
  ));
