-- =====================================================================
-- PokerOut — Supabase schema
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run: tables use IF NOT EXISTS, functions use CREATE OR REPLACE.
--
-- Security model (no accounts; game code + username):
--   • Every player row has a random `secret` returned only to the device
--     that created/joined it. The browser keeps it in localStorage.
--   • All tables have Row Level Security ON with NO policies, so the public
--     anon key cannot read or write any table directly.
--   • The only entry points are the SECURITY DEFINER functions below. Each
--     one verifies (game, player, secret) and enforces host/player rules,
--     game stage, and amount validation on the server.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.games (
  id              uuid primary key default gen_random_uuid(),
  code            text not null check (code ~ '^[0-9]{4}$'),
  name            text not null,
  host_player_id  uuid,
  status          text not null default 'lobby' check (status in ('lobby','playing','ended','settled')),
  currency        text not null default 'INR',
  default_buy_in  integer not null check (default_buy_in > 0),
  default_rebuy   integer not null check (default_rebuy > 0),
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  ended_at        timestamptz,
  settled_at      timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists games_code_idx on public.games (code, created_at desc);

create table if not exists public.players (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games(id) on delete cascade,
  username    text not null,
  role        text not null default 'player' check (role in ('host','player')),
  approved    text not null default 'pending' check (approved in ('pending','approved','rejected')),
  removed     boolean not null default false,
  secret      uuid not null default gen_random_uuid(),
  joined_at   timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists players_game_idx on public.players (game_id);

create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.games(id) on delete cascade,
  player_id     uuid not null references public.players(id) on delete cascade,
  type          text not null check (type in ('buy-in','rebuy')),
  amount        integer not null check (amount > 0 and amount <= 100000000),
  status        text not null check (status in ('pending','approved','rejected','cancelled')),
  approved_by   uuid,
  note          text,
  edited        boolean not null default false,
  requested_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists transactions_game_idx on public.transactions (game_id);
create index if not exists transactions_player_idx on public.transactions (player_id);

create table if not exists public.final_stacks (
  player_id     uuid primary key references public.players(id) on delete cascade,
  game_id       uuid not null references public.games(id) on delete cascade,
  amount        integer not null check (amount >= 0 and amount <= 100000000),
  entered_by    uuid,
  submitted_at  timestamptz not null default now()
);
create index if not exists final_stacks_game_idx on public.final_stacks (game_id);

create table if not exists public.settlements (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  position     integer not null,
  from_player  uuid not null references public.players(id) on delete cascade,
  to_player    uuid not null references public.players(id) on delete cascade,
  amount       integer not null check (amount > 0),
  paid         boolean not null default false,
  paid_at      timestamptz,
  marked_by    uuid
);
create index if not exists settlements_game_idx on public.settlements (game_id);

-- Lock the tables: RLS on, no policies, no grants to the public roles.
alter table public.games        enable row level security;
alter table public.players      enable row level security;
alter table public.transactions enable row level security;
alter table public.final_stacks enable row level security;
alter table public.settlements  enable row level security;
revoke all on public.games, public.players, public.transactions, public.final_stacks, public.settlements from anon, authenticated;

-- ---------- internal helpers (not callable from the browser) ----------
create or replace function public._ms(t timestamptz) returns bigint
language sql immutable as $$ select case when t is null then null else (extract(epoch from t) * 1000)::bigint end $$;

create or replace function public._fail(msg text) returns void
language plpgsql as $$ begin raise exception using message = msg, errcode = 'P0001'; end $$;

create or replace function public._clean(t text, n int) returns text
language sql immutable as $$ select left(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g')), n) $$;

-- Buy-ins move in ₹100 steps; rebuys may be any positive whole-rupee amount.
create or replace function public._check_amount(a integer, stepped boolean) returns void
language plpgsql as $$
begin
  if a is null or a <= 0 then perform public._fail('Amount must be more than ₹0.'); end if;
  if a > 100000000 then perform public._fail('That amount looks too large.'); end if;
  if stepped and a % 100 <> 0 then perform public._fail('Please enter an amount in multiples of ₹100.'); end if;
end $$;

create or replace function public._auth(p_game uuid, p_player uuid, p_secret uuid) returns public.players
language plpgsql security definer set search_path = public as $$
declare pl public.players;
begin
  select * into pl from public.players where id = p_player and game_id = p_game and secret = p_secret;
  if not found then perform public._fail('This device lost its seat — rejoin with the game code.'); end if;
  return pl;
end $$;

create or replace function public._lock(p_game uuid) returns public.games
language plpgsql security definer set search_path = public as $$
declare g public.games;
begin
  select * into g from public.games where id = p_game for update;
  if not found then perform public._fail('That game doesn''t exist. Check the code and try again.'); end if;
  return g;
end $$;

create or replace function public._host(g public.games, me public.players) returns void
language plpgsql as $$
begin
  if g.host_player_id is distinct from me.id then perform public._fail('Only the host can do that.'); end if;
end $$;

create or replace function public._has_buy_in(p_player uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.transactions where player_id = p_player and type = 'buy-in' and status = 'approved')
$$;

-- Seated players with their totals: the single source of truth for P/L on the server.
create or replace function public._nets(p_game uuid)
returns table (player_id uuid, invested bigint, stack integer)
language sql stable security definer set search_path = public as $$
  select p.id,
         coalesce((select sum(t.amount) from public.transactions t where t.player_id = p.id and t.status = 'approved'), 0)::bigint,
         (select f.amount from public.final_stacks f where f.player_id = p.id)
  from public.players p
  where p.game_id = p_game and p.approved = 'approved' and public._has_buy_in(p.id)
$$;

-- Game state in the exact shape the app uses. Pending/rejected viewers only see themselves + host.
create or replace function public._state(p_game uuid, p_viewer uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g public.games; v public.players; full_view boolean;
begin
  select * into g from public.games where id = p_game;
  select * into v from public.players where id = p_viewer;
  full_view := coalesce(v.approved = 'approved', false);
  return jsonb_build_object(
    'gameId', g.id, 'gameCode', g.code, 'gameName', g.name, 'hostId', g.host_player_id, 'status', g.status,
    'currency', g.currency, 'defaultBuyIn', g.default_buy_in, 'defaultRebuy', g.default_rebuy,
    'createdAt', public._ms(g.created_at), 'startedAt', public._ms(g.started_at), 'endedAt', public._ms(g.ended_at),
    'settledAt', public._ms(g.settled_at), 'version', g.version,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'playerId', p.id, 'username', p.username, 'gameId', p.game_id, 'approved', p.approved, 'role', p.role,
        'removed', p.removed, 'joinedAt', public._ms(p.joined_at), 'decidedAt', public._ms(p.decided_at)) order by p.joined_at, p.id)
      from public.players p
      where p.game_id = g.id and (full_view or p.id = v.id or p.id = g.host_player_id)), '[]'::jsonb),
    'transactions', case when full_view then coalesce((
      select jsonb_agg(jsonb_build_object(
        'transactionId', t.id, 'playerId', t.player_id, 'type', t.type, 'amount', t.amount, 'status', t.status,
        'approvedBy', t.approved_by, 'note', t.note, 'edited', t.edited,
        'requestedAt', public._ms(t.requested_at), 'timestamp', public._ms(t.updated_at)) order by t.requested_at, t.id)
      from public.transactions t where t.game_id = g.id), '[]'::jsonb) else '[]'::jsonb end,
    'finalStacks', case when full_view then coalesce((
      select jsonb_object_agg(f.player_id::text, jsonb_build_object(
        'playerId', f.player_id, 'amount', f.amount, 'submitted', true,
        'submittedAt', public._ms(f.submitted_at), 'enteredBy', f.entered_by))
      from public.final_stacks f where f.game_id = g.id), '{}'::jsonb) else '{}'::jsonb end,
    'settlements', case when full_view then coalesce((
      select jsonb_agg(jsonb_build_object(
        'settlementId', s.id, 'fromPlayer', s.from_player, 'toPlayer', s.to_player, 'amount', s.amount,
        'paid', s.paid, 'paidAt', public._ms(s.paid_at), 'markedBy', s.marked_by) order by s.position)
      from public.settlements s where s.game_id = g.id), '[]'::jsonb) else '[]'::jsonb end
  );
end $$;

create or replace function public._done(p_game uuid, p_viewer uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.games set version = version + 1, updated_at = now() where id = p_game;
  return public._state(p_game, p_viewer);
end $$;

-- ---------- public API (called by the app via supabase.rpc) ----------
create or replace function public.create_game(p_name text, p_username text, p_buy_in integer, p_rebuy integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_name text := public._clean(p_name, 40); v_user text := public._clean(p_username, 20);
        v_code text; v_game uuid; v_player uuid; v_secret uuid; tries int := 0;
begin
  if v_name = '' then perform public._fail('Give your game a name.'); end if;
  if v_user = '' then perform public._fail('Enter your username.'); end if;
  perform public._check_amount(p_buy_in, true);
  perform public._check_amount(p_rebuy, true);
  perform pg_advisory_xact_lock(hashtext('pokerout:codes'));
  loop
    v_code := (1000 + floor(random() * 9000))::int::text;
    exit when not exists (select 1 from public.games where code = v_code and status <> 'settled' and created_at > now() - interval '3 days');
    tries := tries + 1;
    if tries > 300 then perform public._fail('No game codes free right now — try again in a minute.'); end if;
  end loop;
  insert into public.games (code, name, default_buy_in, default_rebuy) values (v_code, v_name, p_buy_in, p_rebuy) returning id into v_game;
  insert into public.players (game_id, username, role, approved, decided_at) values (v_game, v_user, 'host', 'approved', now())
    returning id, secret into v_player, v_secret;
  update public.games set host_player_id = v_player where id = v_game;
  insert into public.transactions (game_id, player_id, type, amount, status, approved_by) values (v_game, v_player, 'buy-in', p_buy_in, 'approved', v_player);
  return jsonb_build_object('state', public._state(v_game, v_player), 'playerId', v_player, 'secret', v_secret);
end $$;

create or replace function public.peek_game(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g public.games;
begin
  select * into g from public.games
   where code = regexp_replace(coalesce(p_code, ''), '\D', '', 'g') and status in ('lobby','playing') and created_at > now() - interval '3 days'
   order by created_at desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('gameName', g.name, 'status', g.status,
    'hostName', (select username from public.players where id = g.host_player_id));
end $$;

create or replace function public.join_game(p_code text, p_username text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.games; v_user text := public._clean(p_username, 20); v_player uuid; v_secret uuid;
begin
  if v_user = '' then perform public._fail('Pick a username so the host knows who you are.'); end if;
  select * into g from public.games
   where code = regexp_replace(coalesce(p_code, ''), '\D', '', 'g') and status <> 'settled' and created_at > now() - interval '3 days'
   order by created_at desc limit 1 for update;
  if not found then perform public._fail('That game doesn''t exist or has expired. Check the code and try again.'); end if;
  if g.status = 'ended' then perform public._fail('This game has ended — new players can''t join.'); end if;
  if exists (select 1 from public.players where game_id = g.id and approved <> 'rejected' and lower(username) = lower(v_user)) then
    perform public._fail('“' || v_user || '” is already taken in this game. Try another name.');
  end if;
  if (select count(*) from public.players where game_id = g.id and approved <> 'rejected') >= 30 then
    perform public._fail('This table is full.');
  end if;
  insert into public.players (game_id, username) values (g.id, v_user) returning id, secret into v_player, v_secret;
  update public.games set version = version + 1, updated_at = now() where id = g.id;
  return jsonb_build_object('state', public._state(g.id, v_player), 'playerId', v_player, 'secret', v_secret);
end $$;

create or replace function public.get_game(p_game uuid, p_player uuid, p_secret uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._auth(p_game, p_player, p_secret);
  return public._state(p_game, p_player);
end $$;

create or replace function public.withdraw_join(p_game uuid, p_player uuid, p_secret uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret);
begin
  perform public._lock(p_game);
  if me.approved = 'pending' then delete from public.players where id = me.id; end if;
  update public.games set version = version + 1, updated_at = now() where id = p_game;
  return null;
end $$;

create or replace function public.decide_player(p_game uuid, p_player uuid, p_secret uuid, p_target uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); t public.players;
begin
  perform public._host(g, me);
  select * into t from public.players where id = p_target and game_id = p_game;
  if not found then perform public._fail('That player left before you decided.'); end if;
  if t.approved <> 'pending' then perform public._fail(t.username || ' was already ' || t.approved || '.'); end if;
  if p_approve and g.status not in ('lobby','playing') then perform public._fail('The session has ended — no new players.'); end if;
  update public.players set approved = case when p_approve then 'approved' else 'rejected' end, decided_at = now() where id = t.id;
  return public._done(p_game, p_player);
end $$;

create or replace function public.request_buy_in(p_game uuid, p_player uuid, p_secret uuid, p_amount integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game);
begin
  if g.status not in ('lobby','playing') then perform public._fail('Buy-ins are closed — the session has ended.'); end if;
  if me.approved <> 'approved' then perform public._fail('The host needs to approve you first.'); end if;
  if public._has_buy_in(me.id) then perform public._fail('Your buy-in is already recorded.'); end if;
  if exists (select 1 from public.transactions where player_id = me.id and status = 'pending') then
    perform public._fail('Your buy-in is waiting for host approval.');
  end if;
  perform public._check_amount(p_amount, true);
  insert into public.transactions (game_id, player_id, type, amount, status) values (p_game, me.id, 'buy-in', p_amount, 'pending');
  return public._done(p_game, p_player);
end $$;

create or replace function public.cancel_request(p_game uuid, p_player uuid, p_secret uuid, p_tx uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); t public.transactions;
begin
  perform public._lock(p_game);
  select * into t from public.transactions where id = p_tx and game_id = p_game;
  if not found or t.player_id <> me.id then perform public._fail('Request not found.'); end if;
  if t.status <> 'pending' then perform public._fail('The host already handled this request.'); end if;
  update public.transactions set status = 'cancelled', updated_at = now() where id = t.id;
  return public._done(p_game, p_player);
end $$;

create or replace function public.start_game(p_game uuid, p_player uuid, p_secret uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); waiting text;
begin
  perform public._host(g, me);
  if g.status <> 'lobby' then perform public._fail('The game has already started.'); end if;
  select string_agg(username, ', ' order by joined_at) into waiting
    from public.players where game_id = p_game and approved = 'approved' and not public._has_buy_in(id);
  if waiting is not null then perform public._fail('Waiting for ' || waiting || ' to buy in.'); end if;
  if (select count(*) from public._nets(p_game)) < 2 then perform public._fail('You need at least 2 players to start.'); end if;
  update public.games set status = 'playing', started_at = now() where id = p_game;
  return public._done(p_game, p_player);
end $$;

create or replace function public.remove_player(p_game uuid, p_player uuid, p_secret uuid, p_target uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); t public.players;
begin
  perform public._host(g, me);
  if g.status not in ('lobby','playing') then perform public._fail('Players can''t be removed after the session ends.'); end if;
  if p_target = g.host_player_id then perform public._fail('The host can''t be removed.'); end if;
  select * into t from public.players where id = p_target and game_id = p_game;
  if not found then perform public._fail('Player not found.'); end if;
  if public._has_buy_in(t.id) then perform public._fail('This player has money in the game — correct their amounts instead.'); end if;
  update public.transactions set status = 'rejected', note = 'Removed by host', updated_at = now() where player_id = t.id and status = 'pending';
  update public.players set approved = 'rejected', removed = true, decided_at = now() where id = t.id;
  return public._done(p_game, p_player);
end $$;

create or replace function public.request_rebuy(p_game uuid, p_player uuid, p_secret uuid, p_amount integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game);
begin
  if g.status = 'lobby' then perform public._fail('Rebuys open once the host starts the game.'); end if;
  if g.status <> 'playing' then perform public._fail('Buy-ins are closed — the session has ended.'); end if;
  if me.approved <> 'approved' then perform public._fail('You''re not an active player in this game.'); end if;
  if not public._has_buy_in(me.id) then perform public._fail('Make your initial buy-in first.'); end if;
  if exists (select 1 from public.transactions where player_id = me.id and status = 'pending') then
    perform public._fail('You already have a rebuy waiting for host approval.');
  end if;
  perform public._check_amount(p_amount, false);
  insert into public.transactions (game_id, player_id, type, amount, status) values (p_game, me.id, 'rebuy', p_amount, 'pending');
  return public._done(p_game, p_player);
end $$;

create or replace function public.decide_tx(p_game uuid, p_player uuid, p_secret uuid, p_tx uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); t public.transactions;
begin
  perform public._host(g, me);
  select * into t from public.transactions where id = p_tx and game_id = p_game;
  if not found then perform public._fail('Request not found.'); end if;
  if t.status <> 'pending' then perform public._fail('This request was already ' || t.status || '.'); end if;
  if g.status not in ('lobby','playing') then perform public._fail('The session has ended — this can''t be approved.'); end if;
  if p_approve and t.type = 'rebuy' and g.status <> 'playing' then perform public._fail('Rebuys open once the game starts.'); end if;
  update public.transactions
     set status = case when p_approve then 'approved' else 'rejected' end,
         approved_by = case when p_approve then me.id else null end, updated_at = now()
   where id = t.id;
  return public._done(p_game, p_player);
end $$;

create or replace function public.add_rebuy(p_game uuid, p_player uuid, p_secret uuid, p_target uuid, p_amount integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); t public.players;
begin
  perform public._host(g, me);
  if g.status <> 'playing' then perform public._fail('Rebuys are only open while the game is running.'); end if;
  select * into t from public.players where id = p_target and game_id = p_game;
  if not found or t.approved <> 'approved' or not public._has_buy_in(t.id) then perform public._fail('That player has no buy-in yet.'); end if;
  perform public._check_amount(p_amount, false);
  insert into public.transactions (game_id, player_id, type, amount, status, approved_by) values (p_game, t.id, 'rebuy', p_amount, 'approved', me.id);
  return public._done(p_game, p_player);
end $$;

create or replace function public.edit_tx(p_game uuid, p_player uuid, p_secret uuid, p_tx uuid, p_amount integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); t public.transactions;
begin
  perform public._host(g, me);
  if g.status = 'settled' then perform public._fail('This game is settled — amounts are locked.'); end if;
  select * into t from public.transactions where id = p_tx and game_id = p_game;
  if not found or t.status <> 'approved' then perform public._fail('Only approved amounts can be corrected.'); end if;
  perform public._check_amount(p_amount, t.type = 'buy-in');
  update public.transactions set amount = p_amount, edited = true, updated_at = now() where id = t.id;
  return public._done(p_game, p_player);
end $$;

create or replace function public.void_tx(p_game uuid, p_player uuid, p_secret uuid, p_tx uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); t public.transactions;
begin
  perform public._host(g, me);
  if g.status = 'settled' then perform public._fail('This game is settled — amounts are locked.'); end if;
  select * into t from public.transactions where id = p_tx and game_id = p_game;
  if not found or t.status <> 'approved' or t.type <> 'rebuy' then perform public._fail('Only approved rebuys can be removed.'); end if;
  update public.transactions set status = 'rejected', note = 'Removed by host', updated_at = now() where id = t.id;
  return public._done(p_game, p_player);
end $$;

create or replace function public.end_session(p_game uuid, p_player uuid, p_secret uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game);
begin
  perform public._host(g, me);
  if g.status = 'lobby' then perform public._fail('Start the game before ending it.'); end if;
  if g.status <> 'playing' then perform public._fail('The session has already ended.'); end if;
  update public.transactions set status = 'rejected', note = 'Session ended', updated_at = now() where game_id = p_game and status = 'pending';
  update public.players set approved = 'rejected', decided_at = now() where game_id = p_game and approved = 'pending';
  update public.games set status = 'ended', ended_at = now() where id = p_game;
  return public._done(p_game, p_player);
end $$;

create or replace function public.reopen_session(p_game uuid, p_player uuid, p_secret uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game);
begin
  perform public._host(g, me);
  if g.status <> 'ended' then perform public._fail('Only an ended session can be reopened.'); end if;
  update public.games set status = 'playing', ended_at = null where id = p_game;
  return public._done(p_game, p_player);
end $$;

create or replace function public.submit_stack(p_game uuid, p_player uuid, p_secret uuid, p_target uuid, p_amount integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); t public.players;
begin
  if p_target <> me.id and g.host_player_id is distinct from me.id then perform public._fail('You can only enter your own final stack.'); end if;
  if g.status in ('lobby','playing') then perform public._fail('Final stacks open once the host ends the session.'); end if;
  if g.status = 'settled' then perform public._fail('This game is settled — stacks are locked.'); end if;
  select * into t from public.players where id = p_target and game_id = p_game;
  if not found or t.approved <> 'approved' or not public._has_buy_in(t.id) then perform public._fail('That player never bought in.'); end if;
  if p_amount is null or p_amount < 0 then perform public._fail('Amounts can''t be negative.'); end if;
  if p_amount > 100000000 then perform public._fail('That amount looks too large.'); end if;
  insert into public.final_stacks (player_id, game_id, amount, entered_by, submitted_at) values (t.id, p_game, p_amount, me.id, now())
  on conflict (player_id) do update set amount = excluded.amount, entered_by = excluded.entered_by, submitted_at = excluded.submitted_at;
  return public._done(p_game, p_player);
end $$;

-- The app computes the minimum-payment plan; the server independently re-derives every
-- seated player's Net P/L and accepts the plan only if it reproduces those balances exactly.
create or replace function public.finalize_game(p_game uuid, p_player uuid, p_secret uuid, p_payments jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game);
        v_n int; v_sub int; v_in bigint; v_out bigint;
begin
  perform public._host(g, me);
  if g.status <> 'ended' then perform public._fail('End the session before settling.'); end if;
  select count(*), count(stack), coalesce(sum(invested), 0), coalesce(sum(stack), 0) into v_n, v_sub, v_in, v_out from public._nets(p_game);
  if v_sub < v_n then perform public._fail('Waiting for ' || (v_n - v_sub) || ' more final stack(s).'); end if;
  if v_in <> v_out then perform public._fail('Numbers don''t match — settlement is locked until they do.'); end if;
  if jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) > greatest(v_n - 1, 0) then
    perform public._fail('Settlement plan rejected — try again.');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_payments) x
     where (x->>'amount')::int is null or (x->>'amount')::int <= 0 or (x->>'from') = (x->>'to')
        or (x->>'from')::uuid not in (select player_id from public._nets(p_game))
        or (x->>'to')::uuid not in (select player_id from public._nets(p_game))
  ) then perform public._fail('Settlement plan rejected — try again.'); end if;
  if exists (
    select 1 from public._nets(p_game) n
     where (n.stack - n.invested) <>
           coalesce((select sum((x->>'amount')::int) from jsonb_array_elements(p_payments) x where (x->>'to')::uuid = n.player_id), 0)
         - coalesce((select sum((x->>'amount')::int) from jsonb_array_elements(p_payments) x where (x->>'from')::uuid = n.player_id), 0)
  ) then perform public._fail('Settlement plan doesn''t match the table''s P/L — try again.'); end if;
  delete from public.settlements where game_id = p_game;
  insert into public.settlements (game_id, position, from_player, to_player, amount)
    select p_game, ord::int, (x->>'from')::uuid, (x->>'to')::uuid, (x->>'amount')::int
      from jsonb_array_elements(p_payments) with ordinality as e(x, ord);
  update public.games set status = 'settled', settled_at = now() where id = p_game;
  return public._done(p_game, p_player);
end $$;

create or replace function public.set_paid(p_game uuid, p_player uuid, p_secret uuid, p_settlement uuid, p_paid boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.players := public._auth(p_game, p_player, p_secret); g public.games := public._lock(p_game); s public.settlements;
begin
  select * into s from public.settlements where id = p_settlement and game_id = p_game;
  if not found then perform public._fail('Payment not found.'); end if;
  if g.host_player_id is distinct from me.id and s.from_player <> me.id then perform public._fail('Only the payer or the host can mark this.'); end if;
  update public.settlements set paid = coalesce(p_paid, false), paid_at = case when p_paid then now() else null end, marked_by = me.id where id = s.id;
  return public._done(p_game, p_player);
end $$;

-- ---------- permissions ----------
-- Supabase grants EXECUTE on new functions to anon by default — take it back from the helpers.
revoke execute on function public._ms(timestamptz), public._fail(text), public._clean(text, int), public._check_amount(integer, boolean),
  public._auth(uuid, uuid, uuid), public._lock(uuid), public._host(public.games, public.players), public._has_buy_in(uuid),
  public._nets(uuid), public._state(uuid, uuid), public._done(uuid, uuid)
  from public, anon, authenticated;

grant execute on function
  public.create_game(text, text, integer, integer), public.peek_game(text), public.join_game(text, text),
  public.get_game(uuid, uuid, uuid), public.withdraw_join(uuid, uuid, uuid),
  public.decide_player(uuid, uuid, uuid, uuid, boolean), public.request_buy_in(uuid, uuid, uuid, integer),
  public.cancel_request(uuid, uuid, uuid, uuid), public.start_game(uuid, uuid, uuid), public.remove_player(uuid, uuid, uuid, uuid),
  public.request_rebuy(uuid, uuid, uuid, integer), public.decide_tx(uuid, uuid, uuid, uuid, boolean),
  public.add_rebuy(uuid, uuid, uuid, uuid, integer), public.edit_tx(uuid, uuid, uuid, uuid, integer), public.void_tx(uuid, uuid, uuid, uuid),
  public.end_session(uuid, uuid, uuid), public.reopen_session(uuid, uuid, uuid), public.submit_stack(uuid, uuid, uuid, uuid, integer),
  public.finalize_game(uuid, uuid, uuid, jsonb), public.set_paid(uuid, uuid, uuid, uuid, boolean)
  to anon, authenticated;

-- Optional housekeeping (Database → Cron): delete games older than 60 days.
-- select cron.schedule('pokerout-cleanup', '0 4 * * *', $$ delete from public.games where created_at < now() - interval '60 days' $$);
