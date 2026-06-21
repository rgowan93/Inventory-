-- House of Cards — staff sign-in (username + password, claim-on-first-use, secret-question reset)
--
-- This backs the "Staff" sign-in on the public wall (openStaffLogin in app.js), which calls
-- the staff_* RPCs via PostgREST with the anon key. Passwords and security answers are stored
-- as the app's client-side hashes (hashPass()); the plain text never reaches the database.
--
-- The staff table is locked down (RLS on, no anon/authenticated policies); all access goes
-- through the SECURITY DEFINER functions below, so the password / answer hashes are never
-- readable directly with the anon key.
--
-- Run once in the Supabase SQL Editor (already applied to the project as migration
-- "staff_login_system").

create table if not exists public.staff (
  username   text primary key,
  phone      text,
  email      text,
  pass       text,
  sec_q      text,
  sec_a      text,
  claimed    boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.staff enable row level security;
-- (intentionally no policies: anon/authenticated cannot read or write the table directly)

-- Seed the five House of Cards staff (unclaimed until they set a password on first sign-in).
-- Reggie/Manny/Hailey are also on the public Contact Us page; Taylor and Ryan are staff only.
insert into public.staff (username, phone, claimed) values
  ('reggie', '7313639478', false),
  ('manny',  '2567633389', false),
  ('hailey', '3213059361', false),
  ('taylor', '7313639465', false),
  ('ryan',   '8505438759', false)
on conflict (username) do nothing;

-- staff_status: does this username exist, is it claimed, and what is its security question?
create or replace function public.staff_status(p_user text)
returns table(claimed boolean, sec_q text)
language sql security definer set search_path = public as $$
  select s.claimed, s.sec_q from public.staff s
  where lower(s.username) = lower(trim(p_user));
$$;

-- staff_login: returns the account (username/phone/email) only when claimed and the password matches.
create or replace function public.staff_login(p_user text, p_pass text)
returns table(username text, phone text, email text)
language sql security definer set search_path = public as $$
  select s.username, s.phone, s.email from public.staff s
  where lower(s.username) = lower(trim(p_user))
    and s.claimed = true
    and s.pass = p_pass;
$$;

-- staff_claim: first-time setup. Succeeds only if the account exists and is not yet claimed.
create or replace function public.staff_claim(p_user text, p_pass text, p_email text, p_q text, p_a text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.staff
     set pass = p_pass, email = p_email, sec_q = p_q, sec_a = p_a, claimed = true
   where lower(username) = lower(trim(p_user)) and claimed = false;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- staff_reset: set a new password if the security answer matches (claimed accounts only).
create or replace function public.staff_reset(p_user text, p_ans text, p_newpass text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.staff
     set pass = p_newpass
   where lower(username) = lower(trim(p_user)) and claimed = true and sec_a = p_ans;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- staff_update: change email (always) and optionally password; requires the current password.
create or replace function public.staff_update(p_user text, p_old text, p_newpass text, p_email text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.staff
     set email = p_email,
         pass  = case when coalesce(p_newpass, '') <> '' then p_newpass else pass end
   where lower(username) = lower(trim(p_user)) and pass = p_old;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- staff_create: an existing, claimed staff member (verified by their own username+password)
-- can add a new staff account. The new account starts unclaimed; the new person sets their
-- own password via the normal "First time / forgot password?" claim flow. This is the ONLY
-- way to add accounts — there is no public self-signup.
-- Returns a status string: 'ok' | 'auth' | 'exists' | 'baduser'.
create or replace function public.staff_create(p_user text, p_pass text, p_newuser text, p_newphone text)
returns text
language plpgsql security definer set search_path = public as $$
declare caller_ok boolean; clean text;
begin
  select true into caller_ok from public.staff
   where lower(username) = lower(trim(p_user)) and claimed = true and pass = p_pass;
  if not coalesce(caller_ok, false) then
    return 'auth';
  end if;

  clean := lower(trim(p_newuser));
  if clean = '' or clean !~ '^[a-z0-9_]{2,}$' then
    return 'baduser';
  end if;
  if exists (select 1 from public.staff where lower(username) = clean) then
    return 'exists';
  end if;

  insert into public.staff (username, phone, claimed)
  values (clean, nullif(trim(p_newphone), ''), false);
  return 'ok';
end;
$$;

-- staff_members: a claimed staff member (verified by their own username+password) can read
-- the member list (the "Join our page" sign-ups in public.leads). leads has no public SELECT
-- policy, so phone numbers are never exposed to the anon key except through this gated call.
-- Returns { ok:false } on bad auth, or { ok:true, members:[{name,phone,created_at}, ...] }.
create or replace function public.staff_members(p_user text, p_pass text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare caller_ok boolean; js jsonb;
begin
  select true into caller_ok from public.staff
   where lower(username) = lower(trim(p_user)) and claimed = true and pass = p_pass;
  if not coalesce(caller_ok, false) then
    return jsonb_build_object('ok', false);
  end if;
  select coalesce(
           jsonb_agg(jsonb_build_object('name', name, 'phone', phone, 'created_at', created_at)
                     order by created_at desc),
           '[]'::jsonb)
    into js
    from public.leads;
  return jsonb_build_object('ok', true, 'members', js);
end;
$$;

-- Allow the app (anon key) and signed-in users to call these RPCs.
grant execute on function public.staff_status(text)                        to anon, authenticated;
grant execute on function public.staff_login(text, text)                   to anon, authenticated;
grant execute on function public.staff_claim(text, text, text, text, text) to anon, authenticated;
grant execute on function public.staff_reset(text, text, text)             to anon, authenticated;
grant execute on function public.staff_update(text, text, text, text)      to anon, authenticated;
grant execute on function public.staff_create(text, text, text, text)      to anon, authenticated;
grant execute on function public.staff_members(text, text)                 to anon, authenticated;


-- ============================================================================
-- Wall write lockdown (migration: lock_down_wall_writes)
-- Admin actions on the public wall (add/delete shows, set flyer, add/delete
-- gallery posts, delete comments) require a verified staff member. The anon key
-- can no longer write shows/media directly. Public reads, public comments,
-- public reviews, and lead capture remain open.
-- ============================================================================

-- Reusable guard used by every write RPC below.
create or replace function public.staff_ok(p_user text, p_pass text)
returns boolean
language sql security definer set search_path = public stable as $$
  select exists(
    select 1 from public.staff
    where lower(username) = lower(trim(p_user)) and claimed = true and pass = p_pass
  );
$$;

create or replace function public.show_add(p_user text, p_pass text, p_name text, p_address text, p_date date, p_time text, p_flyer text)
returns bigint language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.staff_ok(p_user, p_pass) then return null; end if;
  if coalesce(trim(p_name),'') = '' or p_date is null then return null; end if;
  insert into public.shows(name, address, event_date, event_time, flyer_url)
  values (trim(p_name), nullif(trim(p_address),''), p_date, nullif(trim(p_time),''), nullif(trim(p_flyer),''))
  returning id into nid;
  return nid;
end;$$;

create or replace function public.show_set_flyer(p_user text, p_pass text, p_id bigint, p_flyer text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int; begin
  if not public.staff_ok(p_user, p_pass) then return false; end if;
  update public.shows set flyer_url = nullif(trim(p_flyer),'') where id = p_id;
  get diagnostics n = row_count; return n > 0;
end;$$;

create or replace function public.show_delete(p_user text, p_pass text, p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int; begin
  if not public.staff_ok(p_user, p_pass) then return false; end if;
  delete from public.shows where id = p_id;
  get diagnostics n = row_count; return n > 0;
end;$$;

create or replace function public.show_purge_past(p_user text, p_pass text)
returns integer language plpgsql security definer set search_path = public as $$
declare n int; begin
  if not public.staff_ok(p_user, p_pass) then return -1; end if;
  delete from public.shows where event_date < current_date;
  get diagnostics n = row_count; return n;
end;$$;

create or replace function public.media_add(p_user text, p_pass text, p_kind text, p_path text, p_url text, p_caption text, p_uploader text)
returns bigint language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.staff_ok(p_user, p_pass) then return null; end if;
  if coalesce(trim(p_url),'') = '' then return null; end if;
  insert into public.media(kind, path, url, caption, uploader)
  values (coalesce(nullif(trim(p_kind),''),'photo'), nullif(trim(p_path),''), trim(p_url), nullif(trim(p_caption),''), nullif(trim(p_uploader),''))
  returning id into nid;
  return nid;
end;$$;

create or replace function public.media_delete(p_user text, p_pass text, p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int; begin
  if not public.staff_ok(p_user, p_pass) then return false; end if;
  delete from public.media_comments where media_id = p_id;  -- clear comments first (FK)
  delete from public.media where id = p_id;
  get diagnostics n = row_count; return n > 0;
end;$$;

create or replace function public.comment_delete(p_user text, p_pass text, p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int; begin
  if not public.staff_ok(p_user, p_pass) then return false; end if;
  delete from public.media_comments where id = p_id;
  get diagnostics n = row_count; return n > 0;
end;$$;

grant execute on function public.staff_ok(text,text)                            to anon, authenticated;
grant execute on function public.show_add(text,text,text,text,date,text,text)   to anon, authenticated;
grant execute on function public.show_set_flyer(text,text,bigint,text)          to anon, authenticated;
grant execute on function public.show_delete(text,text,bigint)                  to anon, authenticated;
grant execute on function public.show_purge_past(text,text)                     to anon, authenticated;
grant execute on function public.media_add(text,text,text,text,text,text,text)  to anon, authenticated;
grant execute on function public.media_delete(text,text,bigint)                 to anon, authenticated;
grant execute on function public.comment_delete(text,text,bigint)               to anon, authenticated;

-- Remove the permissive anon write policies (keep public SELECT; keep public
-- comment INSERT, review INSERT, and lead INSERT).
drop policy if exists shows_insert on public.shows;
drop policy if exists shows_delete on public.shows;
drop policy if exists media_insert on public.media;
drop policy if exists media_delete on public.media;
drop policy if exists mc_delete   on public.media_comments;

-- Enable RLS on the visit counter (bump_visits is SECURITY DEFINER, so it keeps working).
alter table public.page_stats enable row level security;
