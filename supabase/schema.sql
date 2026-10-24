-- Generation Game：Supabase 資料表、RPC 與 RLS
-- 可重複執行。請在 Supabase Dashboard > SQL Editor 貼上並執行。

create table if not exists public.rooms (
  code text primary key check (code ~ '^[0-9]{4}$'),
  current_question integer not null default -1,
  phase text not null default 'waiting' check (phase in ('waiting', 'open', 'locked', 'revealed', 'ended')),
  question_count integer not null check (question_count between 1 and 20),
  reveal_answer jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_secrets (
  room_code text primary key references public.rooms(code) on delete cascade,
  host_token uuid not null
);

create table if not exists public.participants (
  room_code text not null references public.rooms(code) on delete cascade,
  device_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 24),
  joined_at timestamptz not null default now(),
  primary key (room_code, device_id)
);

create table if not exists public.responses (
  room_code text not null references public.rooms(code) on delete cascade,
  question_index integer not null check (question_index between 0 and 19),
  device_id uuid not null,
  answer jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (room_code, question_index, device_id),
  foreign key (room_code, device_id)
    references public.participants(room_code, device_id) on delete cascade
);

alter table public.rooms enable row level security;
alter table public.room_secrets enable row level security;
alter table public.participants enable row level security;
alter table public.responses enable row level security;

drop policy if exists "rooms are publicly readable" on public.rooms;
create policy "rooms are publicly readable"
  on public.rooms for select to anon, authenticated using (true);

revoke all on public.rooms, public.room_secrets, public.participants, public.responses
  from anon, authenticated;
grant select on public.rooms to anon, authenticated;

create or replace function public.create_live_room(
  p_host_token uuid,
  p_question_count integer default 5
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_attempt integer := 0;
begin
  if p_question_count < 1 or p_question_count > 20 then
    raise exception 'invalid question count';
  end if;

  loop
    v_code := lpad((floor(random() * 9000) + 1000)::integer::text, 4, '0');
    begin
      insert into public.rooms(code, question_count) values (v_code, p_question_count);
      insert into public.room_secrets(room_code, host_token)
      values (v_code, p_host_token);
      return v_code;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 20 then raise exception 'unable to allocate room code'; end if;
    end;
  end loop;
end;
$$;

create or replace function public.join_live_room(
  p_room_code text,
  p_device_id uuid,
  p_nickname text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := trim(p_nickname);
begin
  if not exists (
    select 1 from public.rooms where code = p_room_code and phase <> 'ended'
  ) then
    raise exception 'room not found or already ended';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 24 then
    raise exception 'nickname must be 1 to 24 characters';
  end if;

  insert into public.participants(room_code, device_id, nickname)
    values (p_room_code, p_device_id, v_name)
  on conflict (room_code, device_id)
    do update set nickname = excluded.nickname;
end;
$$;

create or replace function public.submit_live_answer(
  p_room_code text,
  p_device_id uuid,
  p_question_index integer,
  p_answer jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms where code = p_room_code;
  if not found or v_room.phase <> 'open' or v_room.current_question <> p_question_index then
    raise exception 'question is not open';
  end if;
  if not exists (
    select 1 from public.participants
    where room_code = p_room_code and device_id = p_device_id
  ) then
    raise exception 'participant has not joined';
  end if;
  if jsonb_typeof(p_answer) not in ('number', 'array') then
    raise exception 'invalid answer';
  end if;
  if pg_column_size(p_answer) > 512 then
    raise exception 'answer is too large';
  end if;

  insert into public.responses(room_code, question_index, device_id, answer)
    values (p_room_code, p_question_index, p_device_id, p_answer)
  on conflict (room_code, question_index, device_id)
    do update set answer = excluded.answer, updated_at = now();
end;
$$;

create or replace function public.set_live_room_state(
  p_room_code text,
  p_host_token uuid,
  p_question_index integer,
  p_phase text,
  p_reveal_answer jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.room_secrets
    where room_code = p_room_code
      and host_token = p_host_token
  ) then
    raise exception 'invalid host token';
  end if;
  if p_phase not in ('waiting', 'open', 'locked', 'revealed', 'ended') then
    raise exception 'invalid phase';
  end if;
  if p_question_index < -1 or p_question_index >= (
    select question_count from public.rooms where code = p_room_code
  ) then
    raise exception 'invalid question index';
  end if;

  update public.rooms
  set current_question = p_question_index,
      phase = p_phase,
      reveal_answer = case when p_phase = 'revealed' then p_reveal_answer else null end,
      updated_at = now()
  where code = p_room_code;
end;
$$;

create or replace function public.get_live_host_results(
  p_room_code text,
  p_host_token uuid
)
returns table(device_id uuid, nickname text, question_index integer, answer jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.room_secrets
    where room_code = p_room_code
      and host_token = p_host_token
  ) then
    raise exception 'invalid host token';
  end if;

  return query
    select p.device_id, p.nickname, r.question_index, r.answer
    from public.participants p
    left join public.responses r
      on r.room_code = p.room_code and r.device_id = p.device_id
    where p.room_code = p_room_code
    order by p.joined_at;
end;
$$;

revoke all on function public.create_live_room(uuid, integer) from public;
revoke all on function public.join_live_room(text, uuid, text) from public;
revoke all on function public.submit_live_answer(text, uuid, integer, jsonb) from public;
revoke all on function public.set_live_room_state(text, uuid, integer, text, jsonb) from public;
revoke all on function public.get_live_host_results(text, uuid) from public;

grant execute on function public.create_live_room(uuid, integer) to anon, authenticated;
grant execute on function public.join_live_room(text, uuid, text) to anon, authenticated;
grant execute on function public.submit_live_answer(text, uuid, integer, jsonb) to anon, authenticated;
grant execute on function public.set_live_room_state(text, uuid, integer, text, jsonb) to anon, authenticated;
grant execute on function public.get_live_host_results(text, uuid) to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end $$;
