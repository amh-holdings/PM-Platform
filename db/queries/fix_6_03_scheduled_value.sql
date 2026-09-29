-- 6.03 Fencing/SWPPP is $203,835.79, not what the SOV says.
--
-- Zarina, on the gap between the SOV and the cash-flow spreadsheet:
-- "203,835.79 is correct."
--
-- The app has the line at roughly $124,994, short by about $78,842. That value
-- is the denominator under every percentage on the line, so it decides what
-- the G703 says is complete, what the rule of credit earns in dollars, and how
-- far over-billed 6.03 is. It is worth getting right before the next AFP.
--
-- DO NOT SKIP STEP 1. Setting one line's value without checking the total is
-- how an SOV stops summing to the contract. Either the project total is right
-- and $78,842 is sitting on some other line that is overstated, or the SOV was
-- short all along and the total moves too. Those need different fixes, and
-- only the query tells you which one this is.
--
-- Steps 1 and 2 are read only. Step 3 writes one row and is commented out.

-- ---------------------------------------------------------------------------
-- 1. Where does the $78,842 sit? Run this first and read the answer.
-- ---------------------------------------------------------------------------

select
  p.contract_value                                  as project_contract_value,
  sum(bl.scheduled_value)                           as sov_total_now,
  p.contract_value - sum(bl.scheduled_value)        as sov_short_by,
  sum(bl.scheduled_value) + 78841.68                as sov_total_after_fix,
  p.contract_value - (sum(bl.scheduled_value) + 78841.68) as short_after_fix
from public.billing_lines bl
join public.projects p on p.id = bl.project_id
where bl.project_id = :project_id
group by p.contract_value;

--   sov_short_by ~ 78,842   the SOV was simply missing it. Fix 6.03 alone and
--                           the total comes right. Step 3 is the whole fix.
--   sov_short_by ~ 0        the total already balances, so $78,842 is
--                           overstated on some other line. Find it below and
--                           correct both in one transaction, or the SOV will
--                           exceed the contract.
--   anything else           stop and reconcile the SOV against the executed
--                           agreement line by line before touching anything.

-- Every line, so an overstatement elsewhere can be spotted by eye.
select item_number, description, scheduled_value
  from public.billing_lines
 where project_id = :project_id
 order by item_number;

-- ---------------------------------------------------------------------------
-- 2. What the correction does to 6.03. Read only.
--
-- The rule of credit is unchanged: SWPPP 30% of the line at 65.1% done, fence
-- 70% at 0%, so the line has earned 19.52% of whatever it is worth.
-- ---------------------------------------------------------------------------

select
  bl.item_number,
  bl.scheduled_value                                as value_now,
  203835.79                                         as value_corrected,
  round(203835.79 * 0.1952, 2)                      as earned_after,
  t.total_billed                                    as already_billed,
  round(t.total_billed - 203835.79 * 0.1952, 2)     as over_billed_after,
  round(203835.79 * 0.30, 2)                        as ceiling_until_fencing_starts,
  round(t.total_billed - 203835.79 * 0.30, 2)       as past_that_ceiling_by
from public.billing_lines bl
join public.v_billing_line_totals t on t.billing_line_id = bl.id
where bl.project_id = :project_id
  and bl.item_number = '6.03';

-- Expect roughly: earned $39,797, billed $93,000.08, over-billed $53,203,
-- ceiling $61,150.74, past it by $31,849. Note the ceiling is exactly the
-- September cash-flow figure, because that figure was always 30% of the line.

-- ---------------------------------------------------------------------------
-- 3. The correction. Uncomment only after step 1 says it is safe.
-- ---------------------------------------------------------------------------

-- update public.billing_lines
--    set scheduled_value = 203835.79
--  where project_id = :project_id
--    and item_number = '6.03';
--
-- notify pgrst, 'reload schema';
