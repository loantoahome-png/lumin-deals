-- Per-deal document attachments (OneDrive, future: Google Drive, etc.)
create table if not exists deal_documents (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references deals(id) on delete cascade,
  source        text not null default 'onedrive',
  source_id     text not null,
  name          text not null,
  web_url       text not null,
  thumbnail_url text,
  mime_type     text,
  size_bytes    bigint,
  attached_by   text,
  attached_at   timestamptz default now()
);

create index if not exists deal_documents_deal_id_idx on deal_documents(deal_id);

-- Open RLS policies (dashboard already requires auth before reaching this table)
alter table deal_documents enable row level security;

drop policy if exists "deal_documents select" on deal_documents;
drop policy if exists "deal_documents insert" on deal_documents;
drop policy if exists "deal_documents delete" on deal_documents;

create policy "deal_documents select" on deal_documents for select using (true);
create policy "deal_documents insert" on deal_documents for insert with check (true);
create policy "deal_documents delete" on deal_documents for delete using (true);
