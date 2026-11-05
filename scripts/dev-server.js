// รันเว็บ + หลังบ้านในเครื่อง (ไว้ทดสอบก่อนขึ้น Vercel)
//   npm run dev               ใช้ฐานข้อมูลใน DATABASE_URL (ค่าเริ่มต้น: Postgres ในเครื่อง court_dev)
//   npm run dev -- --reset    ล้างตารางแล้วใส่ข้อมูลตัวอย่างใหม่ (ห้ามใช้กับฐานข้อมูลจริง)
// ไม่ได้ตั้ง SUPABASE_URL → เก็บสลิปไว้ในหน่วยความจำ (หายเมื่อปิดเซิร์ฟเวอร์)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';
import { createPostgresDb } from '../lib/db.js';
import { createMemoryStorage, createSupabaseStorage } from '../lib/storage.js';
import { seedDemo } from './seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/court_dev';
if (process.argv.includes('--reset') && !/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
  console.error('--reset ลบทุกตาราง: ใช้ได้กับฐานข้อมูลในเครื่อง (localhost) เท่านั้น');
  process.exit(1);
}
const db = createPostgresDb(DATABASE_URL, { max: 5 });
const storage = process.env.SUPABASE_URL
  ? createSupabaseStorage(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : createMemoryStorage();
const app = createApp({ db, storage, secret: process.env.SESSION_SECRET || 'local-dev-secret-not-for-production' });

if (process.argv.includes('--reset')) {
  await db.query('drop table if exists bookings, users, settings, roles cascade');
}
await db.query(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
if (process.argv.includes('--reset')) console.log('seeded', await seedDemo({ db, storage, app }), 'bookings');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch (e) { /* invalid → handled below */ }
    const out = req.method === 'POST'
      ? await app.handle(data.action, data.payload || {}, data.token || '')
      : { ok: true, service: 'local dev' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT + path.sep) || file.includes('node_modules') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('http://localhost:' + PORT));
