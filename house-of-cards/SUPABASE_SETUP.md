# Cloud setup — profiles & friends (one time, ~10 minutes)

The Friends feature and cross-device profile pictures need three things in your
Supabase project: two database tables, an image bucket, and email sign-in turned
on. Do these once and it works for everyone.

Your project is already connected in `config.js`, so you only need the steps below.

---

## 1. Create the tables + security rules

1. Open your Supabase project → left sidebar → **SQL Editor** → **New query**.
2. Paste **everything** below and click **Run**.

```sql
-- House of Cards — cloud profiles + friends
create extension if not exists "uuid-ossp";

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  name        text,
  handle      text unique,
  company     text,
  bio         text,
  avatar_url  text,
  city        text,
  lat         double precision,
  lng         double precision,
  discoverable boolean default true,
  created_at  timestamptz default now()
);

create table if not exists public.friendships (
  id         uuid primary key default uuid_generate_v4(),
  requester  uuid references public.profiles(id) on delete cascade,
  addressee  uuid references public.profiles(id) on delete cascade,
  status     text default 'pending',
  created_at timestamptz default now(),
  unique (requester, addressee)
);

alter table public.profiles    enable row level security;
alter table public.friendships enable row level security;

-- public directory: anyone can read profiles; you can only edit your own
create policy "profiles readable"  on public.profiles for select using (true);
create policy "insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles for update using (auth.uid() = id);

-- friendships: only the two people involved can see/act on them
create policy "read own friendships"   on public.friendships for select using (auth.uid() = requester or auth.uid() = addressee);
create policy "create friendship"      on public.friendships for insert with check (auth.uid() = requester);
create policy "update friendship"      on public.friendships for update using (auth.uid() = requester or auth.uid() = addressee);
create policy "delete friendship"      on public.friendships for delete using (auth.uid() = requester or auth.uid() = addressee);
```

You should see **Success. No rows returned.**

---

## 2. Create the avatar image bucket

1. Left sidebar → **Storage** → **New bucket**.
2. Name it exactly **`avatars`**, toggle **Public bucket = ON**, click **Save**.
3. Go back to **SQL Editor** → **New query**, paste this, and **Run**:

```sql
-- anyone can view avatars; people can only upload to their own folder
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatars user write" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "avatars user update" on storage.objects
  for update using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
```

---

## 3. Turn on email sign-in

1. Left sidebar → **Authentication** → **Providers** → make sure **Email** is **enabled**.
2. (Recommended for now) **Authentication → Providers → Email → turn OFF
   "Confirm email."** This lets people use the app immediately after signing up
   without clicking a confirmation link. You can turn it back on later.

---

## That's it

Open the app → **Friends** tab → **Create cloud account** (or **Sign in**).
Set your photo, company, and city/GPS, then search for other sellers by name,
username, company, or distance. Your profile photo now follows you on every
device you sign in on.
