// ต่อฐานข้อมูล PostgreSQL (Supabase) — โค้ดส่วนอื่นเรียกผ่าน query / tx เท่านั้น
import postgres from 'postgres';

export function createPostgresDb(url, { max = 1, ssl } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    max,
    prepare: false,                 // Supabase pooler (transaction mode) ใช้ prepared statement ไม่ได้
    ssl: ssl ?? (local ? false : 'require'),
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}
  });
  const run = (s) => (text, params = []) => s.unsafe(text, params);
  return {
    query: run(sql),
    tx: (fn) => sql.begin((t) => fn(run(t))),
    end: () => sql.end({ timeout: 5 })
  };
}
