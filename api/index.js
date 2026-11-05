// Vercel Serverless Function: หน้าเว็บส่งคำสั่งมาที่ POST /api → ส่งต่อให้ lib/app.js
import { createApp, CONFIG } from '../lib/app.js';
import { createPostgresDb } from '../lib/db.js';
import { createSupabaseStorage } from '../lib/storage.js';

const REQUIRED = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET'];
let app;

function getApp() {
  if (!app) {
    app = createApp({
      db: createPostgresDb(process.env.DATABASE_URL),
      storage: createSupabaseStorage(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY),
      secret: process.env.SESSION_SECRET
    });
  }
  return app;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Missing environment variables: ' + missing.join(', ') });
  }
  if (req.method === 'GET') {
    // ใช้เช็คว่าระบบออนไลน์: เปิด https://<เว็บ>/api ในเบราว์เซอร์
    try {
      await getApp().handle('bootstrap', {}, '').then((r) => { if (!r.ok) throw new Error(r.error); });
      return res.status(200).json({ ok: true, service: CONFIG.VENUE_NAME + ' Court Booking', database: 'connected' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'database_unreachable' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { return res.status(400).json({ ok: false, error: 'invalid_input' }); }
  }
  body = body || {};
  const out = await getApp().handle(body.action, body.payload || {}, body.token || '');
  return res.status(200).json(out);
}
