// เทสต์หลังบ้านกับ PostgreSQL จริง: TEST_DATABASE_URL=postgres://... npm test
// (ค่าเริ่มต้นใช้ฐานข้อมูล court_test บนเครื่อง — ตารางในฐานนี้จะถูกล้างทุกครั้ง)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../lib/app.js';
import { createPostgresDb } from '../lib/db.js';
import { createMemoryStorage } from '../lib/storage.js';

const URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/court_test';
const SCHEMA = fs.readFileSync(new globalThis.URL('../supabase/schema.sql', import.meta.url), 'utf8');
const PNG = 'data:image/png;base64,' + Buffer.from('fake-slip-image-bytes').toString('base64');

let NOW = Date.parse('2026-10-17T12:52:00+07:00');
let db, storage, app;
const call = (action, payload, token) => app.handle(action, payload, token);
const ok = (r, label) => { assert.equal(r.ok, true, label + ' → ' + JSON.stringify(r)); return r.data; };
const fails = (r, code, label) => assert.equal(r.ok ? 'ok' : r.error, code, label + ' → ' + JSON.stringify(r));

before(async () => {
  db = createPostgresDb(URL, { max: 12 });
  await db.query('drop table if exists bookings, users, settings, roles cascade');
  await db.query(SCHEMA);
  await db.query(SCHEMA);   // รันซ้ำต้องไม่พัง
  storage = createMemoryStorage();
  app = createApp({ db, storage, secret: 'test-secret-0123456789', now: () => NOW, log: { error() {} } });
});
after(async () => { await db.end(); });

let A, U, U2;   // tokens
let o1, o2;     // order ids

test('schema seeds roles and settings once', async () => {
  const [r] = await db.query('select count(*)::int as n from settings');
  assert.equal(r.n, 7);
  const [u] = await db.query("select advance_days, cancel_before_hours from roles where role = 'user'");
  assert.deepEqual([u.advance_days, u.cancel_before_hours], [7, 3]);
  const [m] = await db.query("select advance_days from roles where role = 'member'");
  assert.equal(m.advance_days, 14);
});

test('accounts', async () => {
  const a = ok(await call('register', { phone: '081-234-5678', password: 'secret1', name: 'Owner' }), 'admin register');
  assert.equal(a.user.role, 'admin');
  const u = ok(await call('register', { phone: '0899999999', password: 'secret2', name: 'Player' }), 'user register');
  assert.equal(u.user.role, 'user');
  U2 = ok(await call('register', { phone: '0888888888', password: 'secret3', name: 'Other' }), 'user2').token;
  fails(await call('register', { phone: '0899999999', password: 'xxxxxx', name: 'X' }), 'phone_taken', 'dup phone');
  fails(await call('register', { phone: '12', password: 'xxxxxx', name: 'X' }), 'invalid_phone', 'bad phone');
  fails(await call('register', { phone: '0877777777', password: '123', name: 'X' }), 'weak_password', 'weak pw');
  fails(await call('login', { phone: '0899999999', password: 'nope' }), 'invalid_login', 'bad login');
  ok(await call('login', { phone: '+66899999999', password: 'secret2' }), 'login with +66');
  A = a.token; U = u.token;
  const [h] = await db.query("select password_hash from users where phone = '0899999999'");
  assert.match(h.password_hash, /^scrypt\$/);
});

test('bootstrap: pricing, bank, perms', async () => {
  const b = ok(await call('bootstrap', {}, A), 'bootstrap');
  assert.deepEqual(b.pricing, { day: 250, night: 350, lightsFromHour: 18 });
  assert.deepEqual([b.payment.bankName, b.payment.accountNo, b.payment.accountName, b.payment.payWithinMinutes],
    ['ธนาคารกรุงศรีอยุธยา (กรุงศรี)', '1731304053', 'ธนากร ศรีชาพันธุ์', 30]);
  assert.equal(b.pendingReview, 0);
  assert.equal(ok(await call('bootstrap', {}, U), 'u').user.perms.cancel_before_hours, 3);
  assert.equal(ok(await call('bootstrap', {}), 'guest').user, null);
});

test('range and limits', async () => {
  fails(await call('book', { slots: [{ date: '2026-10-17', hour: 12, court: 'C1' }] }, U), 'slot_past', 'past');
  fails(await call('book', { slots: [{ date: '2026-10-25', hour: 10, court: 'C1' }] }, U), 'too_far_ahead', 'user +8');
  fails(await call('schedule', { date: '2026-10-25' }), 'too_far_ahead', 'guest view +8');
  fails(await call('schedule', { date: '2026-10-16' }), 'too_far_ahead', 'guest view yesterday');
  ok(await call('schedule', { date: '2026-10-24' }), 'guest view +7');
  ok(await call('schedule', { date: '2026-12-16' }, A), 'admin view +60');
  fails(await call('book', { slots: [{ date: '2026-10-18', hour: 10, court: 'C1' }, { date: '2026-10-18', hour: 11, court: 'C1' }] }, U), 'daily_limit', '2h/day');
  fails(await call('book', { slots: [{ date: '2026-10-18', hour: 10, court: 'C9' }] }, U), 'invalid_input', 'bad court');
  fails(await call('book', { type: 'block', slots: [{ date: '2026-10-18', hour: 9, court: 'C5' }] }, U), 'forbidden', 'user block');
  fails(await call('book', { slots: [{ date: '2026-10-18', hour: 9, court: 'C5' }] }, 'garbage'), 'auth_required', 'no auth');
});

test('booking is priced and pending payment', async () => {
  const b1 = ok(await call('book', { slots: [{ date: '2026-10-18', hour: 17, court: 'C1' }] }, U), 'day rate');
  assert.deepEqual([b1.order.status, b1.order.amount], ['pending_payment', 250]);
  assert.equal(b1.order.expires_at - NOW, 30 * 60000);
  const b2 = ok(await call('book', { slots: [{ date: '2026-10-19', hour: 18, court: 'C2' }] }, U), 'night rate');
  assert.equal(b2.order.amount, 350);
  fails(await call('book', { slots: [{ date: '2026-10-20', hour: 9, court: 'C2' }] }, U), 'active_limit', 'active limit 2');
  fails(await call('book', { slots: [{ date: '2026-10-18', hour: 17, court: 'C1' }] }, U2), 'slot_taken', 'pending holds slot');
  const s = ok(await call('schedule', { date: '2026-10-18' }, U2), 'sched').bookings[0];
  assert.deepEqual([s.pending, s.name], [true, undefined]);
  o1 = b1.order.order_id; o2 = b2.order.order_id;
});

test('slip upload, view, review', async () => {
  fails(await call('uploadSlip', { orderId: o1, image: PNG }, U2), 'not_found', 'other user upload');
  fails(await call('uploadSlip', { orderId: o1, image: 'data:text/plain;base64,aGk=' }, U), 'invalid_slip', 'not image');
  fails(await call('uploadSlip', { orderId: 'not-a-uuid', image: PNG }, U), 'not_found', 'bad id');
  ok(await call('uploadSlip', { orderId: o1, image: PNG }, U), 'upload');
  assert.equal(storage.files.size, 1);
  const mine = ok(await call('myBookings', {}, U), 'mine');
  assert.equal(mine.upcoming.find((o) => o.order_id === o1).status, 'pending_review');
  assert.equal(ok(await call('slip', { orderId: o1 }, U), 'owner slip').image, PNG);
  assert.equal(ok(await call('slip', { orderId: o1 }, A), 'admin slip').image, PNG);
  fails(await call('slip', { orderId: o1 }, U2), 'not_found', 'other slip');
  assert.equal(ok(await call('bootstrap', {}, A), 'b').pendingReview, 1);
  const q = ok(await call('adminOrders', {}, A), 'queues');
  assert.deepEqual([q.review.length, q.awaiting.length, q.review[0].phone], [1, 1, '0899999999']);
  fails(await call('reviewOrder', { orderId: o1, approve: true }, U), 'forbidden', 'user review');
  ok(await call('reviewOrder', { orderId: o1, approve: true }, A), 'approve');
  assert.equal(ok(await call('schedule', { date: '2026-10-18' }, U), 's').bookings[0].status, 'confirmed');
  fails(await call('reviewOrder', { orderId: o1, approve: true }, A), 'not_found', 'review twice');
});

test('reject frees the slot', async () => {
  ok(await call('uploadSlip', { orderId: o2, image: PNG }, U), 'upload 2');
  ok(await call('reviewOrder', { orderId: o2, approve: false, note: 'ยอดไม่ตรง' }, A), 'reject');
  const h = ok(await call('myBookings', {}, U), 'm').history.find((o) => o.order_id === o2);
  assert.deepEqual([h.status, h.review_note], ['rejected', 'ยอดไม่ตรง']);
  ok(await call('book', { slots: [{ date: '2026-10-19', hour: 18, court: 'C2' }] }, U2), 'slot free again');
});

test('unpaid booking expires after 30 minutes', async () => {
  const b3 = ok(await call('book', { slots: [{ date: '2026-10-20', hour: 19, court: 'C3' }] }, U), 'book');
  NOW += 31 * 60000;
  ok(await call('book', { slots: [{ date: '2026-10-20', hour: 19, court: 'C3' }] }, A), 'free for others');
  fails(await call('uploadSlip', { orderId: b3.order.order_id, image: PNG }, U), 'payment_expired', 'late upload');
  assert.equal(ok(await call('myBookings', {}, U), 'm').history.find((o) => o.order_id === b3.order.order_id).status, 'expired');
  const [row] = await db.query('select status from bookings where order_id = $1', [b3.order.order_id]);
  assert.equal(row.status, 'expired');
});

test('cancel rules (3 hours before play)', async () => {
  NOW = Date.parse('2026-10-18T14:30:00+07:00');   // 2.5 ชม. ก่อน 17:00
  fails(await call('cancel', { orderId: o1 }, U), 'cancel_too_late', 'confirmed <3h');
  const b4 = ok(await call('book', { slots: [{ date: '2026-10-18', hour: 16, court: 'C5' }] }, U2), 'pending today');
  ok(await call('cancel', { orderId: b4.order.order_id }, U2), 'pending <3h can cancel');
  NOW = Date.parse('2026-10-18T13:30:00+07:00');
  const item = ok(await call('myBookings', {}, U), 'm').upcoming.find((o) => o.order_id === o1).items[0];
  fails(await call('cancel', { id: item.id }, U2), 'forbidden', 'other user cancel');
  ok(await call('cancel', { id: item.id }, U), 'confirmed ≥3h');
  fails(await call('cancel', { id: item.id }, U), 'not_found', 'cancel twice');
});

test('admin bookings are confirmed directly', async () => {
  const ab = ok(await call('book', { forName: 'Coach', slots: [{ date: '2026-11-06', hour: 19, court: 'C5' }, { date: '2026-11-06', hour: 20, court: 'C5' }] }, A), 'for coach');
  assert.deepEqual([ab.order.status, ab.order.amount, ab.order.name], ['confirmed', 700, 'Coach']);
  const blk = ok(await call('book', { type: 'block', note: 'ซ่อม', slots: [{ date: '2026-12-16', hour: 9, court: 'C5' }] }, A), 'block');
  assert.deepEqual([blk.order.status, blk.order.amount], ['confirmed', 0]);
  fails(await call('book', { forName: 'X', slots: [{ date: '2026-10-19', hour: 9, court: 'C1' }] }, U), 'forbidden', 'user for others');
});

test('settings and roles edited in the database apply immediately', async () => {
  await db.query("update settings set value = '400' where key = 'price_night'");
  assert.equal(ok(await call('bootstrap', {}), 'b').pricing.night, 400);
  const uid = ok(await call('bootstrap', {}, U), 'b').user.id;
  ok(await call('adminUpdateUser', { id: uid, role: 'member' }, A), 'promote');
  ok(await call('schedule', { date: '2026-11-01' }, U), 'member +14');   // วันนี้ = 18 ต.ค.
  fails(await call('schedule', { date: '2026-11-02' }, U), 'too_far_ahead', 'member +15');
});

test('admin user management and auth', async () => {
  const me = ok(await call('bootstrap', {}, A), 'b').user;
  fails(await call('adminUpdateUser', { id: me.id, role: 'user' }, A), 'self_edit', 'self demote');
  fails(await call('adminUsers', {}, U), 'forbidden', 'user lists users');
  const users = ok(await call('adminUsers', {}, A), 'list').users;
  const other = users.find((x) => x.phone === '0888888888');
  ok(await call('adminUpdateUser', { id: other.id, password: 'newpass9' }, A), 'reset pw');
  ok(await call('login', { phone: '0888888888', password: 'newpass9' }), 'login new pw');
  ok(await call('adminUpdateUser', { id: other.id, status: 'suspended' }, A), 'suspend');
  fails(await call('myBookings', {}, U2), 'auth_required', 'suspended token');
  fails(await call('login', { phone: '0888888888', password: 'newpass9' }), 'suspended', 'suspended login');
  fails(await call('myBookings', {}, A.slice(0, -2) + 'xx'), 'auth_required', 'tampered token');
  ok(await call('changePassword', { oldPassword: 'secret1', newPassword: 'secret1b' }, A), 'change pw');
  fails(await call('changePassword', { oldPassword: 'wrong', newPassword: 'whatever' }, A), 'invalid_login', 'wrong old pw');
  const saved = NOW; NOW += 31 * 864e5;
  fails(await call('myBookings', {}, A), 'auth_required', 'expired token');
  NOW = saved;
  fails(await call('nope', {}, A), 'invalid_input', 'unknown action');
});

test('10 people booking the same slot at the same moment → exactly one wins', async () => {
  const tokens = [];
  for (let i = 0; i < 10; i++) {
    tokens.push(ok(await call('register', { phone: '08600000' + String(i).padStart(2, '0'), password: 'racer123', name: 'Racer ' + i }), 'r').token);
  }
  const slot = { date: '2026-10-21', hour: 20, court: 'C4' };
  const results = await Promise.all(tokens.map((t) => call('book', { slots: [slot] }, t)));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.ok || r.error)));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.error === 'slot_taken'));
  const [n] = await db.query("select count(*)::int as n from bookings where date = '2026-10-21' and hour = 20 and court = 'C4'");
  assert.equal(n.n, 1);
});

test('one user double-clicking cannot exceed the daily limit', async () => {
  const t = ok(await call('register', { phone: '0855555555', password: 'clicker1', name: 'Clicker' }), 'r').token;
  const results = await Promise.all([10, 11, 12, 13].map((h) => call('book', { slots: [{ date: '2026-10-22', hour: h, court: 'C1' }] }, t)));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.ok || r.error)));
});
