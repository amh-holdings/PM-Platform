-- Itemized purchase orders + freight excluded from deposit math
--
-- Before this, a PO was a single free-text description and one total_value.
-- Real vendor quotes are itemized (modules, inverters, racking, crating,
-- freight), and vendors quote deposits as a percentage of the EQUIPMENT,
-- not of the invoice total - freight bills on delivery.
--
-- 1. procurement_order_items: one row per line on the PO. is_freight marks
--    the shipping/freight lines.
-- 2. procurement_orders.freight_value: rolled up from the freight items.
--    procurement_orders.total_value: rolled up from ALL items once a PO is
--    itemized (legacy POs with no items keep their hand-entered value).
--    procurement_orders.deposit_basis: generated, total_value - freight_value.
--    This is what a milestone percentage applies to.
-- 3. procurement_payments.includes_freight: when true, that milestone also
--    carries the full freight_value on top of its percentage. Freight
--    normally rides the delivery milestone, so the milestones still sum to
--    the PO total while no deposit is charged on shipping.
--
-- Apply via scripts/db/migrate.mjs (npm run db:migrate) or the Supabase SQL
-- Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

-- ============ LINE ITEMS ============

create table if not exists public.procurement_order_items (
  id uuid primary key default gen_random_uuid(),
  procurement_order_id uuid references public.procurement_orders(id) on delete cascade not null,
  sort_order integer,
  item_number text,
  description text not null,
  quantity numeric(14,4) not null default 1,
  unit text,
  unit_price numeric(14,2) not null default 0,
  amount numeric(14,2) generated always as
    (round(coalesce(quantity, 0) * coalesce(unit_price, 0), 2)) stored,
  is_freight boolean not null default false,
  notes text,
  created_at timestamptz default now()
);

create index if not exists procurement_order_items_order_idx
  on public.procurement_order_items(procurement_order_id, sort_order);
create index if not exists procurement_order_items_freight_idx
  on public.procurement_order_items(procurement_order_id)
  where is_freight;

alter table public.procurement_order_items enable row level security;
drop policy if exists "ahc_read_procurement_order_items"  on public.procurement_order_items;
drop policy if exists "ahc_write_procurement_order_items" on public.procurement_order_items;
create policy "ahc_read_procurement_order_items" on public.procurement_order_items
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_procurement_order_items" on public.procurement_order_items
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ PO ROLLUP COLUMNS ============

alter table public.procurement_orders
  add column if not exists freight_value numeric(14,2) not null default 0;

-- deposit_basis is what a milestone percentage multiplies. Freight is out.
alter table public.procurement_orders
  add column if not exists deposit_basis numeric(14,2)
  generated always as (greatest(coalesce(total_value, 0) - coalesce(freight_value, 0), 0)) stored;

-- ============ ROLLUP TRIGGER ============
-- Recompute total_value + freight_value from the line items whenever items
-- change. A PO with no items is left alone: those are the pre-itemization
-- rows whose total_value was typed in by hand.

create or replace function public.recalc_procurement_order_totals(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count   integer;
  v_total   numeric(14,2);
  v_freight numeric(14,2);
begin
  select count(*),
         coalesce(sum(amount), 0),
         coalesce(sum(amount) filter (where is_freight), 0)
    into v_count, v_total, v_freight
    from public.procurement_order_items
   where procurement_order_id = p_order_id;

  if v_count = 0 then
    -- Last item removed (or never itemized): keep the hand-entered total,
    -- but there is no freight to carve out any more.
    update public.procurement_orders
       set freight_value = 0
     where id = p_order_id;
  else
    update public.procurement_orders
       set total_value   = v_total,
           freight_value = v_freight
     where id = p_order_id;
  end if;
end;
$$;

create or replace function public.procurement_order_items_rollup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalc_procurement_order_totals(old.procurement_order_id);
    return old;
  end if;

  perform public.recalc_procurement_order_totals(new.procurement_order_id);
  if tg_op = 'UPDATE' and old.procurement_order_id is distinct from new.procurement_order_id then
    perform public.recalc_procurement_order_totals(old.procurement_order_id);
  end if;
  return new;
end;
$$;

drop trigger if exists procurement_order_items_rollup_trg on public.procurement_order_items;
create trigger procurement_order_items_rollup_trg
  after insert or update or delete on public.procurement_order_items
  for each row execute function public.procurement_order_items_rollup();

-- ============ MILESTONE FREIGHT FLAG ============

alter table public.procurement_payments
  add column if not exists includes_freight boolean not null default false;

comment on column public.procurement_payments.includes_freight is
  'When true this milestone carries the PO freight_value on top of pct_of_total x deposit_basis. Freight normally rides the delivery milestone.';
comment on column public.procurement_orders.deposit_basis is
  'total_value minus freight_value. Milestone percentages apply to this, so no deposit is charged on shipping.';

-- ============ BACKFILL ============
-- Re-sync every PO that already has items (no-op on a first run).

do $$
declare r record;
begin
  for r in select distinct procurement_order_id from public.procurement_order_items loop
    perform public.recalc_procurement_order_totals(r.procurement_order_id);
  end loop;
end $$;
