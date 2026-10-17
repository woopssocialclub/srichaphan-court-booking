// รันโค้ดหลังบ้านตัวจริงกับตัวจำลอง Apps Script: node tests/backend.test.js
const fs = require('fs'), path = require('path');
const G = require('../demo/gas-emulator.js');
const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Srichaphan_Court_Booking.gs'), 'utf8');

let NOW = Date.parse('2026-10-17T12:52:00+07:00');
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } }

const mem = new Map();
const storage = { get: k => mem.has(k) ? JSON.parse(mem.get(k)) : null, set: (k, v) => mem.set(k, JSON.stringify(v)) };
const logs = [];
let gas = G.create(storage, { Date: FakeDate, log: m => logs.push(m) });
let be = gas.load(CODE);
const call = (action, payload, token) => JSON.parse(be.doPost({ postData: { contents: JSON.stringify({ action, payload, token }) } }).getContent());

let pass = 0, fail = 0;
function ok(label, r, expect) {
  const got = r.ok ? 'ok' : r.error;
  const good = expect === undefined ? r.ok : got === expect;
  good ? pass++ : fail++;
  if (!good) console.log('FAIL', label, '→', got, JSON.stringify(r.params || r.message || ''));
  return r;
}
function eq(label, a, b) { const good = JSON.stringify(a) === JSON.stringify(b); good ? pass++ : fail++; if (!good) console.log('FAIL', label, JSON.stringify(a), '!=', JSON.stringify(b)); }
const PNG = 'data:image/png;base64,' + Buffer.from('fake-slip-image-bytes').toString('base64');

// ── setup ──
be.setup(); be.setup();
eq('setup idempotent (no dup settings)', be.table_('Settings').rows.length, 7);
eq('roles defaults user cancel 3h', be.table_('Roles').rows.find(r => r.role === 'user').cancel_before_hours, 3);

// ── accounts ──
const A = ok('admin register', call('register', { phone: '081-234-5678', password: 'secret1', name: 'Owner' }));
eq('first = admin', A.data.user.role, 'admin');
const U = ok('user register', call('register', { phone: '0899999999', password: 'secret2', name: 'Player' }));
const U2 = ok('user2 register', call('register', { phone: '0888888888', password: 'secret3', name: 'Other' }));
const AT = A.data.token, UT = U.data.token, U2T = U2.data.token;

// ── bootstrap / pricing ──
const boot = call('bootstrap', {}, AT).data;
eq('pricing', boot.pricing, { day: 250, night: 350, lightsFromHour: 18 });
eq('bank', [boot.payment.bankName, boot.payment.accountNo, boot.payment.accountName, boot.payment.payWithinMinutes],
   ['ธนาคารกรุงศรีอยุธยา (กรุงศรี)', '1731304053', 'ธนากร ศรีชาพันธุ์', 30]);
eq('user perms cancel 3', call('bootstrap', {}, UT).data.user.perms.cancel_before_hours, 3);

// ── range / limits (from v1) ──
ok('past slot', call('book', { slots: [{ date: '2026-10-17', hour: 12, court: 'C1' }] }, UT), 'slot_past');
ok('user too far (8 days)', call('book', { slots: [{ date: '2026-10-25', hour: 10, court: 'C1' }] }, UT), 'too_far_ahead');
ok('guest view +8 blocked', call('schedule', { date: '2026-10-25' }), 'too_far_ahead');
ok('2h same day over limit', call('book', { slots: [{ date: '2026-10-18', hour: 10, court: 'C1' }, { date: '2026-10-18', hour: 11, court: 'C1' }] }, UT), 'daily_limit');

// ── booking → pending_payment with price ──
const b1 = ok('user books 17:00 (day rate)', call('book', { slots: [{ date: '2026-10-18', hour: 17, court: 'C1' }] }, UT));
eq('order pending', [b1.data.order.status, b1.data.order.amount], ['pending_payment', 250]);
eq('expires in 30 min', b1.data.order.expires_at - NOW, 30 * 60000);
const b2 = ok('user books 18:00 other day (night rate)', call('book', { slots: [{ date: '2026-10-19', hour: 18, court: 'C2' }] }, UT));
eq('night price', b2.data.order.amount, 350);
ok('active limit 2', call('book', { slots: [{ date: '2026-10-20', hour: 9, court: 'C2' }] }, UT), 'active_limit');
ok('pending slot blocks others', call('book', { slots: [{ date: '2026-10-18', hour: 17, court: 'C1' }] }, U2T), 'slot_taken');
const sch2 = call('schedule', { date: '2026-10-18' }, U2T).data.bookings[0];
eq('others see pending as taken, no name', [sch2.pending, sch2.name], [true, undefined]);

// ── slip upload / view / review ──
const o1 = b1.data.order.order_id;
ok('other user cannot upload', call('uploadSlip', { orderId: o1, image: PNG }, U2T), 'not_found');
ok('bad image rejected', call('uploadSlip', { orderId: o1, image: 'data:text/plain;base64,aGk=' }, UT), 'invalid_slip');
ok('upload slip', call('uploadSlip', { orderId: o1, image: PNG }, UT));
eq('now pending_review', call('myBookings', {}, UT).data.upcoming.find(o => o.order_id === o1).status, 'pending_review');
eq('owner sees slip', call('slip', { orderId: o1 }, UT).data.image, PNG);
eq('admin sees slip', call('slip', { orderId: o1 }, AT).data.image, PNG);
ok('other cannot see slip', call('slip', { orderId: o1 }, U2T), 'not_found');
eq('admin pending count', call('bootstrap', {}, AT).data.pendingReview, 1);
const ao = call('adminOrders', {}, AT).data;
eq('admin queues', [ao.review.length, ao.awaiting.length, ao.review[0].phone], [1, 1, '0899999999']);
ok('user cannot review', call('reviewOrder', { orderId: o1, approve: true }, UT), 'forbidden');
ok('admin approves', call('reviewOrder', { orderId: o1, approve: true }, AT));
eq('confirmed', call('schedule', { date: '2026-10-18' }, UT).data.bookings[0].status, 'confirmed');
ok('review twice → not_found', call('reviewOrder', { orderId: o1, approve: true }, AT), 'not_found');

// ── reject frees slot ──
const o2 = b2.data.order.order_id;
ok('upload slip 2', call('uploadSlip', { orderId: o2, image: PNG }, UT));
ok('admin rejects', call('reviewOrder', { orderId: o2, approve: false, note: 'ยอดไม่ตรง' }, AT));
const hist = call('myBookings', {}, UT).data.history.find(o => o.order_id === o2);
eq('rejected w/ note', [hist.status, hist.review_note], ['rejected', 'ยอดไม่ตรง']);
ok('rejected slot free again', call('book', { slots: [{ date: '2026-10-19', hour: 18, court: 'C2' }] }, U2T));

// ── expiry ──
const b3 = ok('user books 2 slots? (limit 1/day) – one slot', call('book', { slots: [{ date: '2026-10-20', hour: 19, court: 'C3' }] }, UT));
NOW += 31 * 60000;
ok('after 31 min slot free for others', call('book', { slots: [{ date: '2026-10-20', hour: 19, court: 'C3' }] }, U2T));
ok('late upload → payment_expired', call('uploadSlip', { orderId: b3.data.order.order_id, image: PNG }, UT), 'payment_expired');
eq('expired shows in history', call('myBookings', {}, UT).data.history.find(o => o.order_id === b3.data.order.order_id).status, 'expired');
eq('expired written to sheet', be.table_('Bookings').rows.find(r => r.order_id === b3.data.order.order_id).status, 'expired');

// ── cancel rules (3h) ──
NOW = Date.parse('2026-10-18T14:30:00+07:00');   // 2.5h before the confirmed 17:00 booking
ok('confirmed <3h → too late', call('cancel', { orderId: o1 }, UT), 'cancel_too_late');
const b4 = ok('book today 16:00 (pending)', call('book', { slots: [{ date: '2026-10-18', hour: 16, court: 'C5' }] }, U2T));
ok('pending <3h can cancel (no money yet)', call('cancel', { orderId: b4.data.order.order_id }, U2T));
NOW = Date.parse('2026-10-18T13:30:00+07:00');
ok('confirmed ≥3h → cancel ok', call('cancel', { id: call('myBookings', {}, UT).data.upcoming.find(o => o.order_id === o1).items[0].id }, UT));

// ── admin bookings confirmed directly ──
const ab = ok('admin books for coach', call('book', { forName: 'Coach', slots: [{ date: '2026-11-06', hour: 19, court: 'C5' }, { date: '2026-11-06', hour: 20, court: 'C5' }] }, AT));
eq('admin order confirmed, priced', [ab.data.order.status, ab.data.order.amount], ['confirmed', 700]);
const blk = ok('admin block', call('book', { type: 'block', note: 'ซ่อม', slots: [{ date: '2026-12-16', hour: 9, court: 'C5' }] }, AT));
eq('block free', [blk.data.order.status, blk.data.order.amount], ['confirmed', 0]);

// ── settings editable in sheet ──
const st = be.table_('Settings');
be.update_(st, st.rows.find(r => r.key === 'price_night'), { value: 400 });
eq('price change applies', call('bootstrap', {}).data.pricing.night, 400);

// ── auth basics ──
ok('tampered token', call('myBookings', {}, AT.slice(0, -2) + 'xx'), 'auth_required');
ok('suspend', call('adminUpdateUser', { id: U2.data.user.id, status: 'suspended' }, AT));
ok('suspended token', call('myBookings', {}, U2T), 'auth_required');

// ── migration from v1 sheet layout ──
mem.clear(); gas = G.create(storage, { Date: FakeDate }); be = gas.load(CODE);
const ss = gas.globals.SpreadsheetApp.getActiveSpreadsheet();
const roles = ss.insertSheet('Roles');
roles.getRange(1, 1, 3, 10).setValues([
  ['role', 'label', 'advance_days', 'max_hours_per_day', 'max_active_bookings', 'cancel_before_hours', 'can_book_for_others', 'can_block', 'can_cancel_any', 'can_manage_users'],
  ['admin', 'Admin', 30, 0, 0, 0, true, true, true, true], ['user', 'User', 7, 1, 2, 6, false, false, false, false]]);
const bk = ss.insertSheet('Bookings');
bk.getRange(1, 1, 2, 4).setValues([['id', 'date', 'hour', 'court'], ['Bold', '2026-10-18', 9, 'C1']]);
ss.insertSheet('Settings');   // empty tab
be.setup();
const rr = be.table_('Roles').rows;
eq('migrated admin can confirm', [rr[0].can_confirm_payments, rr[1].can_confirm_payments], [true, '']);
eq('bookings cols appended', be.table_('Bookings').headers.slice(0, 5), ['id', 'date', 'hour', 'court', 'order_id']);
eq('empty Settings tab filled from A1', be.table_('Settings').headers, ['key', 'value', 'description']);
eq('legacy row (no status) counts as confirmed', call('schedule', { date: '2026-10-18' }).data.bookings.length, 1);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
