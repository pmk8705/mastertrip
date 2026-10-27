-- MasterTrip 3단계: 로그인 + 동기화 서버 (Supabase)
-- 설계: docs/sync-design.md
-- 실행: Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여 넣고 Run (한 번만)
-- id는 앱이 만든 글자 그대로(text). 예: trip-spain, mvp9ko798ruvh

-- ───────────── 표 ─────────────

-- 여행 1개 = 1줄. 여행 정보(이름·날짜·예산…)는 trip_items의 'meta' 항목에 있다.
create table public.trips (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 이 여행을 함께 쓰는 사람. 직접 쓰는 권한은 없고, 아래 함수(주인 자동 등록·초대 코드)로만 들어간다.
create table public.trip_members (
  trip_id text not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

-- 항목 1개 = 1줄 (meta·day·item·check·expense·booking·contact). payload = 앱 모양 그대로.
create table public.trip_items (
  trip_id text not null references public.trips(id) on delete cascade,
  id text not null,
  type text not null check (type in ('meta', 'day', 'item', 'check', 'expense', 'booking', 'contact')),
  order_index double precision,
  payload jsonb not null default '{}'::jsonb,
  is_deleted boolean not null default false,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (trip_id, id)
);
create index trip_items_changed on public.trip_items (trip_id, updated_at);

-- 배우자 초대 코드 (8자리, 7일, 한 번만). 직접 읽는 권한은 없고 함수로만 쓴다.
create table public.trip_invites (
  code text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid,
  created_at timestamptz not null default now()
);

-- ───────────── 멤버 확인 (잠금 규칙에서 씀) ─────────────
-- security definer: 멤버 표의 잠금 규칙이 자기 자신을 다시 확인하다 무한 반복되는 것을 피한다
create or replace function public.is_trip_member(p_trip text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = p_trip and user_id = auth.uid());
$$;

-- ───────────── 시각·버전은 서버가 찍는다 ─────────────
create or replace function public.trips_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.owner_id := auth.uid();
    new.created_at := now();
  else
    new.owner_id := old.owner_id;     -- 주인은 바꿀 수 없음
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger trips_stamp before insert or update on public.trips
  for each row execute function public.trips_stamp();

-- 여행을 만든 사람은 자동으로 주인 멤버
create or replace function public.trips_add_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.trip_members (trip_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end $$;
create trigger trips_add_owner after insert on public.trips
  for each row execute function public.trips_add_owner();

create or replace function public.items_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
  else
    new.version := old.version + 1;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger items_stamp before insert or update on public.trip_items
  for each row execute function public.items_stamp();

-- ───────────── 잠금 규칙 (RLS): 내가 멤버인 여행만 ─────────────
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.trip_items enable row level security;
alter table public.trip_invites enable row level security; -- 규칙 없음 = 직접 접근 불가 (함수로만)

create policy "trips: members read" on public.trips for select to authenticated
  using (owner_id = auth.uid() or public.is_trip_member(id));
create policy "trips: owner updates" on public.trips for update to authenticated
  using (owner_id = auth.uid());
-- 여행 만들기는 claim_trip 함수로만 (직접 insert 권한 없음)

create policy "members: members read" on public.trip_members for select to authenticated
  using (public.is_trip_member(trip_id));
create policy "members: leave or owner removes" on public.trip_members for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid()));

create policy "items: members read" on public.trip_items for select to authenticated
  using (public.is_trip_member(trip_id));
create policy "items: members add" on public.trip_items for insert to authenticated
  with check (public.is_trip_member(trip_id));
create policy "items: members change" on public.trip_items for update to authenticated
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));
-- 항목 진짜 지우기는 없음 (is_deleted 표시만)

-- ───────────── 함수 ─────────────
-- 여행 올리기 전에: 없으면 만들고 내가 주인('new'), 이미 멤버('member'), 남의 여행('taken')
create or replace function public.claim_trip(p_trip text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  if not exists (select 1 from public.trips where id = p_trip) then
    insert into public.trips (id) values (p_trip);
    return 'new';
  end if;
  if public.is_trip_member(p_trip) then return 'member'; end if;
  return 'taken';
end $$;

-- 항목 보내기. items = [{id, type, order_index, payload, is_deleted, base_version, force}]
-- 서버 버전이 base_version과 다르면(그사이 배우자가 고침) 저장하지 않고 conflict + 서버 내용을 돌려준다.
create or replace function public.push_items(p_trip text, p_items jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  it jsonb;
  cur public.trip_items;
  base bigint;
  res jsonb := '[]'::jsonb;
begin
  if not public.is_trip_member(p_trip) then raise exception 'not a member'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    base := nullif(it->>'base_version', '')::bigint;
    select * into cur from public.trip_items where trip_id = p_trip and id = it->>'id' for update;
    if found and base is distinct from cur.version and not coalesce((it->>'force')::boolean, false) then
      res := res || jsonb_build_object('id', cur.id, 'status', 'conflict', 'version', cur.version,
        'updated_at', cur.updated_at, 'payload', cur.payload, 'is_deleted', cur.is_deleted, 'order_index', cur.order_index);
      continue;
    end if;
    insert into public.trip_items (trip_id, id, type, order_index, payload, is_deleted)
    values (p_trip, it->>'id', it->>'type', nullif(it->>'order_index', '')::double precision,
            coalesce(it->'payload', '{}'::jsonb), coalesce((it->>'is_deleted')::boolean, false))
    on conflict (trip_id, id) do update
      set type = excluded.type, order_index = excluded.order_index, payload = excluded.payload, is_deleted = excluded.is_deleted
    returning * into cur;
    res := res || jsonb_build_object('id', cur.id, 'status', 'ok', 'version', cur.version, 'updated_at', cur.updated_at);
  end loop;
  return res;
end $$;

-- 초대 코드 만들기 (멤버만). 8자리 대문자·숫자
create or replace function public.create_invite(p_trip text) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_trip_member(p_trip) then raise exception 'not a member'; end if;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.trip_invites (code, trip_id, created_by) values (c, p_trip, auth.uid());
  return c;
end $$;

-- 코드로 여행에 들어가기 → 여행 id
create or replace function public.join_trip(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare inv public.trip_invites;
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  select * into inv from public.trip_invites
    where code = upper(trim(p_code)) and expires_at > now() and used_by is null
    for update;
  if not found then raise exception 'invalid or expired code'; end if;
  insert into public.trip_members (trip_id, user_id, role) values (inv.trip_id, auth.uid(), 'editor')
  on conflict do nothing;
  update public.trip_invites set used_by = auth.uid() where code = inv.code;
  return inv.trip_id;
end $$;

-- ───────────── 권한: 로그인한 사람에게만 (자동 노출을 껐으므로 직접 준다) ─────────────
grant usage on schema public to authenticated;
grant select, update on public.trips to authenticated;
grant select, delete on public.trip_members to authenticated;
grant select, insert, update on public.trip_items to authenticated;

revoke execute on function public.is_trip_member(text), public.claim_trip(text), public.push_items(text, jsonb),
  public.create_invite(text), public.join_trip(text) from public, anon;
grant execute on function public.is_trip_member(text), public.claim_trip(text), public.push_items(text, jsonb),
  public.create_invite(text), public.join_trip(text) to authenticated;

-- ───────────── 사진·바우처 파일 보관함 (4단계에서 사용) ─────────────
-- 경로: trip-media/{여행id}/{파일id}. 비공개, 그 여행 멤버만 읽고 올림.
insert into storage.buckets (id, name, public, file_size_limit)
values ('trip-media', 'trip-media', false, 20971520)
on conflict (id) do nothing;

create policy "trip-media: members read" on storage.objects for select to authenticated
  using (bucket_id = 'trip-media' and public.is_trip_member((storage.foldername(name))[1]));
create policy "trip-media: members upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'trip-media' and public.is_trip_member((storage.foldername(name))[1]));
create policy "trip-media: members replace" on storage.objects for update to authenticated
  using (bucket_id = 'trip-media' and public.is_trip_member((storage.foldername(name))[1]));
create policy "trip-media: members delete" on storage.objects for delete to authenticated
  using (bucket_id = 'trip-media' and public.is_trip_member((storage.foldername(name))[1]));
