-- Srichaphan Tennis Academy — ระบบจองคอร์ท: โครงสร้างฐานข้อมูล (Supabase / PostgreSQL)
--
-- วิธีใช้: Supabase → SQL Editor → New query → วางไฟล์นี้ทั้งไฟล์ → Run
-- *** รันซ้ำได้ปลอดภัย: ไม่ลบไม่ทับข้อมูลเดิม แค่เติมตาราง/คอลัมน์/ค่าเริ่มต้นที่ยังขาด ***
--
-- ตาราง
--   roles    — สิทธิ์แต่ละเลเวล (จองล่วงหน้ากี่วัน, กี่ ชม./วัน ฯลฯ) แก้ใน Table Editor ได้เลย
--   settings — ราคา, บัญชีรับเงิน, เวลาที่ต้องชำระ แก้ใน Table Editor ได้เลย
--   users    — ผู้ใช้ (แก้ role / status ได้)
--   bookings — การจองทุกช่อง (ไม่ลบแถว แค่เปลี่ยน status)

create table if not exists roles (
  role                 text primary key,
  label                text    not null,
  advance_days         int     not null default 7,
  max_hours_per_day    int     not null default 1,
  max_active_bookings  int     not null default 2,
  cancel_before_hours  int     not null default 3,
  can_book_for_others  boolean not null default false,
  can_block            boolean not null default false,
  can_cancel_any       boolean not null default false,
  can_manage_users     boolean not null default false,
  can_confirm_payments boolean not null default false,
  sort                 int     not null default 0
);
comment on column roles.advance_days is 'ดูตาราง + จองล่วงหน้าได้กี่วัน (0 = วันนี้อย่างเดียว)';
comment on column roles.max_hours_per_day is 'จองได้กี่ชั่วโมงต่อวัน · 0 = ไม่จำกัด';
comment on column roles.max_active_bookings is 'การจองที่ยังไม่ถึงเวลาเล่นค้างได้กี่ช่อง · 0 = ไม่จำกัด';
comment on column roles.cancel_before_hours is 'ยกเลิกการจองที่ชำระแล้วได้ถึงกี่ชั่วโมงก่อนเวลาเล่น';

create table if not exists settings (
  key         text primary key,
  value       text not null,
  description text not null default ''
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null unique,
  name          text not null,
  nickname      text not null default '',
  role          text not null default 'user' references roles(role) on update cascade,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists bookings (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null,
  date             date not null,
  hour             int  not null check (hour between 0 and 23),
  court            text not null,
  user_id          uuid not null references users(id),
  name             text not null,
  type             text not null default 'booking' check (type in ('booking', 'block')),
  price            int  not null default 0,
  status           text not null check (status in
                     ('pending_payment', 'pending_review', 'confirmed', 'rejected', 'expired', 'cancelled')),
  note             text not null default '',
  expires_at       timestamptz,
  slip_path        text,
  slip_uploaded_at timestamptz,
  reviewed_by      uuid references users(id),
  reviewed_at      timestamptz,
  review_note      text not null default '',
  created_at       timestamptz not null default now(),
  created_by       uuid references users(id),
  cancelled_at     timestamptz,
  cancelled_by     uuid references users(id)
);

-- หัวใจของการกันจองซ้อน: 1 คอร์ท 1 ชั่วโมง มีการจองที่ "ยังถือช่องอยู่" ได้แค่แถวเดียว
-- ต่อให้สองคนกดพร้อมกันเป๊ะ ฐานข้อมูลก็รับแค่คนแรก
create unique index if not exists bookings_one_per_slot
  on bookings (date, hour, court)
  where status in ('pending_payment', 'pending_review', 'confirmed');
create index if not exists bookings_order_idx on bookings (order_id);
create index if not exists bookings_user_idx on bookings (user_id, date);
create index if not exists bookings_status_idx on bookings (status) where status in ('pending_payment', 'pending_review');

-- ปิดการเข้าถึงตารางผ่าน API สาธารณะของ Supabase (anon key)
-- เว็บเข้าฐานข้อมูลผ่านฟังก์ชันบน Vercel เท่านั้น ซึ่งตรวจสิทธิ์ทุกครั้ง
alter table roles    enable row level security;
alter table settings enable row level security;
alter table users    enable row level security;
alter table bookings enable row level security;

insert into roles (role, label, advance_days, max_hours_per_day, max_active_bookings, cancel_before_hours,
                   can_book_for_others, can_block, can_cancel_any, can_manage_users, can_confirm_payments, sort)
values
  ('admin',  'ผู้ดูแล / Admin',     30, 0, 0, 0, true,  true,  true,  true,  true,  1),
  ('member', 'สมาชิก / Member',     14, 2, 4, 3, false, false, false, false, false, 2),
  ('user',   'ผู้ใช้ทั่วไป / User', 7,  1, 2, 3, false, false, false, false, false, 3)
on conflict (role) do nothing;

insert into settings (key, value, description) values
  ('price_day',          '250',                           'ราคาต่อชั่วโมง ช่วงกลางวัน (บาท)'),
  ('price_night',        '350',                           'ราคาต่อชั่วโมง ช่วงเปิดไฟ (บาท)'),
  ('lights_from_hour',   '18',                            'เริ่มคิดราคาเปิดไฟตั้งแต่ช่องเวลานี้ (18 = ช่อง 18:00 เป็นต้นไป)'),
  ('pay_within_minutes', '30',                            'ต้องอัปโหลดสลิปภายในกี่นาทีหลังกดจอง ไม่งั้นการจองหลุดอัตโนมัติ'),
  ('bank_name',          'ธนาคารกรุงศรีอยุธยา (กรุงศรี)', 'ธนาคารที่รับโอน'),
  ('bank_account_no',    '1731304053',                    'เลขบัญชี (ตัวเลขล้วน)'),
  ('bank_account_name',  'ธนากร ศรีชาพันธุ์',              'ชื่อบัญชี')
on conflict (key) do nothing;

-- ที่เก็บรูปสลิป (private — ไม่มีลิงก์สาธารณะ เว็บออกลิงก์ชั่วคราวให้เฉพาะเจ้าของการจองและแอดมิน)
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('slips', 'slips', false)
    on conflict (id) do nothing;
  end if;
end $$;
