-- Moonetix offerwall rewards: wallets, a ledger with one row per balance change, and the
-- function that applies a verified postback. Run with: supabase db push

-- One wallet per Supabase Auth user. The offerwall user_id is auth.users.id (a UUID).
create table public.wallets (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  coins      numeric(24, 6) not null default 0,
  updated_at timestamptz not null default now()
);

-- One row per credit (status 1) and per reversal (status 2) of a transaction.
-- The unique key is the idempotency guarantee: a transaction is credited once and reversed once.
create table public.coin_ledger (
  id             bigint generated always as identity primary key,
  user_id        uuid not null,
  transaction_id text not null check (length(transaction_id) between 1 and 255),
  status         smallint not null check (status in (1, 2)),
  amount         numeric(24, 6) not null,
  created_at     timestamptz not null default now(),
  unique (transaction_id, status)
);
create index coin_ledger_user_idx on public.coin_ledger (user_id, created_at desc);

-- Row Level Security: users read their own rows. Nobody writes from a client.
alter table public.wallets enable row level security;
alter table public.coin_ledger enable row level security;

create policy "Users read their own wallet" on public.wallets
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own ledger" on public.coin_ledger
  for select to authenticated using ((select auth.uid()) = user_id);

revoke insert, update, delete, truncate on public.wallets, public.coin_ledger from anon, authenticated;

-- A wallet for every new user, and for users that already exist.
create function public.create_wallet()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.wallets (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_wallet
  after insert on auth.users
  for each row execute procedure public.create_wallet();

insert into public.wallets (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- Applies one verified postback, all or nothing (one rpc() call is one transaction).
-- Returns: credited, reversed, duplicate, not_credited or unknown_user.
create function public.moonetix_apply_event(
  p_tx text, p_user uuid, p_reward numeric, p_status smallint
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_credit public.coin_ledger%rowtype;
begin
  if p_reward is null or p_reward < 0 then
    raise exception 'reward must be zero or positive';
  end if;

  -- Copies of one transaction run one after the other, never side by side.
  perform pg_advisory_xact_lock(hashtextextended(p_tx, 0));

  if p_status = 1 then
    -- Any row means this credit was applied, or the transaction was reversed before we saw it.
    if exists (select 1 from public.coin_ledger where transaction_id = p_tx) then
      return 'duplicate';
    end if;
    update public.wallets
      set coins = coins + p_reward, updated_at = now()
      where user_id = p_user;
    if not found then
      return 'unknown_user';
    end if;
    insert into public.coin_ledger (user_id, transaction_id, status, amount)
      values (p_user, p_tx, 1, p_reward);
    return 'credited';
  end if;

  if p_status = 2 then
    if exists (select 1 from public.coin_ledger where transaction_id = p_tx and status = 2) then
      return 'duplicate';
    end if;
    select * into v_credit from public.coin_ledger
      where transaction_id = p_tx and status = 1;
    if not found then
      -- Never credited: store a zero row so a late copy of the credit cannot pay.
      insert into public.coin_ledger (user_id, transaction_id, status, amount)
        values (p_user, p_tx, 2, 0);
      return 'not_credited';
    end if;
    -- Take back exactly what was credited, from the user who got it.
    update public.wallets
      set coins = coins - v_credit.amount, updated_at = now()
      where user_id = v_credit.user_id;
    insert into public.coin_ledger (user_id, transaction_id, status, amount)
      values (v_credit.user_id, p_tx, 2, -v_credit.amount);
    return 'reversed';
  end if;

  raise exception 'unknown status %', p_status;
end;
$$;

-- By default any role may run a function. Only the service role (your secret key) may run this one.
revoke execute on function public.moonetix_apply_event(text, uuid, numeric, smallint)
  from public, anon, authenticated;
grant execute on function public.moonetix_apply_event(text, uuid, numeric, smallint)
  to service_role;
