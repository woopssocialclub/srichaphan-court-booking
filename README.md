# Srichaphan Tennis Academy — ระบบจองคอร์ท

ระบบจองคอร์ทเทนนิสออนไลน์ 5 คอร์ท (C1–C5) เปิด 06:00–23:00 ทุกวัน จองรายชั่วโมง

- ดูตารางและจองล่วงหน้าตามเลเวล: แอดมิน 30 วัน · สมาชิก 14 วัน · ผู้เล่นทั่วไป 7 วัน
- ค่าคอร์ท ฿250/ชม. (ก่อน 18:00) · ฿350/ชม. (18:00–23:00 เปิดไฟ)
- จองแล้วโอนเข้าบัญชีกรุงศรี + อัปโหลดสลิปภายใน 30 นาที → แอดมินยืนยันสลิป = จองสำเร็จ
- ยกเลิกได้ถึง 3 ชั่วโมงก่อนเวลาเล่น

**ระบบ:** หน้าเว็บ + หลังบ้านบน **Vercel** · ฐานข้อมูล + ที่เก็บสลิปบน **Supabase**

👉 คู่มือติดตั้ง/ใช้งาน: [docs/setup-guide.md](docs/setup-guide.md)

| ไฟล์ | คืออะไร |
|---|---|
| `index.html` | หน้าเว็บจองคอร์ท |
| `api/index.js` | Vercel Function — รับคำสั่งจากหน้าเว็บที่ `/api` |
| `lib/app.js` | กติกาทั้งหมด: สิทธิ์, ราคา, การจอง, ชำระเงิน, ตรวจสลิป |
| `lib/db.js`, `lib/storage.js` | ต่อฐานข้อมูล PostgreSQL / Supabase Storage |
| `supabase/schema.sql` | โครงสร้างฐานข้อมูล — รันใน Supabase SQL Editor |
| `tests/app.test.js` | เทสต์หลังบ้านกับ PostgreSQL จริง (`npm test`) |
| `scripts/dev-server.js` | รันทั้งระบบในเครื่อง (`npm run dev -- --reset`) |

Environment variables บน Vercel: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET` (ดูคู่มือส่วนที่ 2)
