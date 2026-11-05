/**
 * Srichaphan Tennis Academy — ระบบจองคอร์ท (หลังบ้าน)
 *
 * ทุกคำสั่งจากหน้าเว็บเข้ามาที่ handle(action, payload, token) แล้วตรวจสิทธิ์ที่นี่ทุกครั้ง
 * ราคา สิทธิ์เลเวล และบัญชีรับเงิน อ่านจากตาราง settings / roles (แก้ใน Supabase Table Editor ได้เลย)
 *
 * สถานะการจอง (bookings.status)
 *   pending_payment → รอชำระ (ไม่ส่งสลิปภายในเวลาที่กำหนด = expired ช่องว่างอีกครั้ง)
 *   pending_review  → ส่งสลิปแล้ว รอแอดมินตรวจ
 *   confirmed       → แอดมินยืนยันแล้ว
 *   rejected / expired / cancelled
 */
import crypto from 'node:crypto';

export const CONFIG = {
  VENUE_NAME: 'Srichaphan Tennis Academy',
  COURTS: ['C1', 'C2', 'C3', 'C4', 'C5'],
  OPEN_HOUR: 6,             // ช่องแรก 06:00–07:00
  CLOSE_HOUR: 23,           // ปิด 23:00 → ช่องสุดท้าย 22:00–23:00
  TIMEZONE: 'Asia/Bangkok',
  UTC_OFFSET: '+07:00',
  SESSION_DAYS: 30,
  MAX_SLOTS_PER_REQUEST: 20,
  MAX_BLOCK_DAYS_AHEAD: 365,
  MAX_SLIP_BYTES: 3 * 1024 * 1024,   // Vercel รับ request ได้ ~4.5MB (base64 ใหญ่ขึ้น 1/3)
  ADMIN_RECENT_DAYS: 14
};

const HOLDING = ['pending_payment', 'pending_review', 'confirmed'];
const HOLDING_SQL = "('pending_payment','pending_review','confirmed')";
const BOOKING_COLS = `id, order_id, date::text as date, hour, court, user_id, name, type, price, status, note,
  expires_at, slip_path, slip_uploaded_at, reviewed_at, review_note, created_at`;
const DEFAULT_SETTINGS = {
  price_day: '250', price_night: '350', lights_from_hour: '18', pay_within_minutes: '30',
  bank_name: 'ธนาคารกรุงศรีอยุธยา (กรุงศรี)', bank_account_no: '1731304053', bank_account_name: 'ธนากร ศรีชาพันธุ์'
};

class AppError extends Error {
  constructor(code, params) { super(code); this.code = code; this.params = params || {}; }
}
const err = (code, params) => new AppError(code, params);

export function createApp({ db, storage, secret, now = () => Date.now(), log = console }) {
  if (!secret || String(secret).length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');

  const ACTIONS = {
    bootstrap, register, login, schedule, book, cancel, myBookings, uploadSlip, slip,
    changePassword, adminUsers, adminUpdateUser, adminOrders, reviewOrder
  };

  async function handle(action, payload, token) {
    try {
      const fn = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
      if (!fn) throw err('invalid_input');
      return { ok: true, data: await fn(payload || {}, token || '') };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: e.code, params: e.params };
      log.error(e);
      return { ok: false, error: 'server_error' };
    }
  }

  // ───────────────────────────── actions ─────────────────────────────

  async function bootstrap(p, token) {
    const roles = await loadRoles();
    const me = token ? await userFromToken(token, roles) : null;
    const s = await loadSettings();
    const out = {
      courts: CONFIG.COURTS,
      openHour: CONFIG.OPEN_HOUR,
      closeHour: CONFIG.CLOSE_HOUR,
      nightFromHour: s.lights_from_hour,
      pricing: { day: s.price_day, night: s.price_night, lightsFromHour: s.lights_from_hour },
      payment: { bankName: s.bank_name, accountNo: s.bank_account_no, accountName: s.bank_account_name,
                 payWithinMinutes: s.pay_within_minutes },
      clock: clock(),
      roles: roles.list,
      guestPerms: permsFor('user', roles),
      user: me ? publicUser(me) : null
    };
    if (me && me.perms.can_confirm_payments) {
      const [r] = await db.query("select count(distinct order_id)::int as n from bookings where status = 'pending_review'");
      out.pendingReview = r.n;
    }
    return out;
  }

  async function register(p) {
    const phone = normPhone(p.phone);
    const name = String(p.name || '').trim().slice(0, 60);
    const nickname = String(p.nickname || '').trim().slice(0, 30);
    const password = String(p.password || '');
    if (!/^0\d{8,9}$/.test(phone)) throw err('invalid_phone');
    if (!name) throw err('name_required');
    if (password.length < 6) throw err('weak_password');
    const hash = await hashPassword(password);

    const user = await db.tx(async (q) => {
      await q('select pg_advisory_xact_lock(4242)');   // กันสองคนสมัครพร้อมกันแล้วได้เป็นแอดมินทั้งคู่
      const [dup] = await q('select 1 from users where phone = $1', [phone]);
      if (dup) throw err('phone_taken');
      const [admin] = await q("select 1 from users where role = 'admin' limit 1");
      // คนแรกที่สมัคร (ตอนยังไม่มีแอดมิน) ได้เป็นแอดมินอัตโนมัติ
      const [row] = await q(
        `insert into users (phone, name, nickname, role, password_hash, created_at)
         values ($1, $2, $3, $4, $5, $6) returning id, phone, name, nickname, role, status`,
        [phone, name, nickname, admin ? 'user' : 'admin', hash, new Date(now())]);
      return row;
    }).catch((e) => { if (e.code === '23505') throw err('phone_taken'); throw e; });

    user.perms = permsFor(user.role, await loadRoles());
    return { token: makeToken(user.id), user: publicUser(user) };
  }

  async function login(p) {
    const phone = normPhone(p.phone);
    const [u] = await db.query('select id, phone, name, nickname, role, status, password_hash from users where phone = $1', [phone]);
    if (!u || !(await verifyPassword(String(p.password || ''), u.password_hash))) throw err('invalid_login');
    if (u.status !== 'active') throw err('suspended');
    u.perms = permsFor(u.role, await loadRoles());
    return { token: makeToken(u.id), user: publicUser(u) };
  }

  async function schedule(p, token) {
    const date = String(p.date || '');
    if (!isDate(date)) throw err('invalid_input');
    const roles = await loadRoles();
    const me = token ? await userFromToken(token, roles) : null;
    const perms = me ? me.perms : permsFor('user', roles);   // ยังไม่ล็อกอิน = เห็นเท่าผู้ใช้ทั่วไป
    const c = clock();
    const ahead = daysBetween(c.today, date);
    // ดูตารางได้แค่ช่วงวันตามเลเวล (คนที่ปิดคอร์ทได้ ดูได้ทุกวัน)
    if (!perms.can_block && (ahead < 0 || ahead > perms.advance_days)) throw err('too_far_ahead', { days: perms.advance_days });
    const seeNames = !!(me && me.perms.can_cancel_any);
    const rows = await db.query(
      `select ${BOOKING_COLS} from bookings
       where date = $1::date and (status in ('pending_review','confirmed') or (status = 'pending_payment' and expires_at > $2))`,
      [date, new Date(c.now)]);
    const bookings = rows.map(normBooking).map((b) => {
      const mine = !!(me && b.user_id === me.id);
      const status = effStatus(b, c.now);
      const out = { court: b.court, hour: b.hour, type: b.type, mine, pending: status !== 'confirmed' };
      if (b.type === 'block') out.note = b.note;
      if (mine || seeNames) Object.assign(out, { id: b.id, order_id: b.order_id, name: b.name, note: b.note, price: b.price, status });
      return out;
    });
    return { date, clock: c, bookings };
  }

  async function book(p, token) {
    const me = await requireUser(token);
    const perms = me.perms;
    const type = p.type === 'block' ? 'block' : 'booking';
    if (type === 'block' && !perms.can_block) throw err('forbidden');
    const forName = String(p.forName || '').trim().slice(0, 60);
    if (forName && !perms.can_book_for_others) throw err('forbidden');
    const note = String(p.note || '').trim().slice(0, 120);
    const raw = Array.isArray(p.slots) ? p.slots : [];
    if (!raw.length || raw.length > CONFIG.MAX_SLOTS_PER_REQUEST) throw err('invalid_input');

    const c = clock();
    const maxAhead = type === 'block' ? CONFIG.MAX_BLOCK_DAYS_AHEAD : perms.advance_days;
    const seen = new Set();
    const slots = raw.map((s) => {
      const date = String((s && s.date) || ''), hour = Number(s && s.hour), court = String((s && s.court) || '');
      if (!isDate(date) || !CONFIG.COURTS.includes(court) || !Number.isInteger(hour) ||
          hour < CONFIG.OPEN_HOUR || hour >= CONFIG.CLOSE_HOUR) throw err('invalid_input');
      const ahead = daysBetween(c.today, date);
      if (ahead < 0 || (ahead === 0 && hour <= c.hour)) throw err('slot_past', { date, hour, court });
      if (ahead > maxAhead) throw err('too_far_ahead', { days: maxAhead });
      const key = date + '|' + hour + '|' + court;
      if (seen.has(key)) throw err('invalid_input');
      seen.add(key);
      return { date, hour, court };
    });

    const s = await loadSettings();
    // คนที่ยืนยันสลิปได้ (แอดมิน) จอง/ปิดคอร์ท = ยืนยันทันที ไม่ต้องชำระผ่านระบบ
    const direct = type === 'block' || perms.can_confirm_payments;
    const orderId = crypto.randomUUID();
    const created = new Date(c.now);
    const expires = direct ? null : new Date(c.now + s.pay_within_minutes * 60000);

    const rows = await db.tx(async (q) => {
      await q('select pg_advisory_xact_lock(hashtext($1))', [me.id]);   // กดจองรัว ๆ ก็นับโควต้าถูก
      await expireStale(q, c.now);
      const slotParams = [];
      const tuples = slots.map((sl, i) => {
        slotParams.push(sl.date, sl.hour, sl.court);
        return `($${i * 3 + 1}::date, $${i * 3 + 2}::int, $${i * 3 + 3})`;
      }).join(', ');
      const [taken] = await q(
        `select date::text as date, hour, court from bookings
         where status in ${HOLDING_SQL} and (date, hour, court) in (${tuples}) limit 1`, slotParams);
      if (taken) throw err('slot_taken', { date: taken.date, hour: taken.hour, court: taken.court });

      if (type === 'booking') {
        const mine = await q(
          `select date::text as date, hour from bookings where user_id = $1 and type = 'booking' and status in ${HOLDING_SQL}`,
          [me.id]);
        checkLimits(perms, mine, slots, c);
      }

      const casts = ['::uuid', '::date', '::int', '', '::uuid', '', '', '::int', '', '', '::timestamptz', '::timestamptz', '::uuid'];
      const params = [];
      const values = slots.map((sl) => {
        const base = params.length;
        params.push(orderId, sl.date, sl.hour, sl.court, me.id, forName || displayName(me), type,
          type === 'block' ? 0 : priceFor(sl.hour, s), direct ? 'confirmed' : 'pending_payment', note, expires, created, me.id);
        return '(' + casts.map((cast, k) => '$' + (base + k + 1) + cast).join(', ') + ')';
      }).join(', ');
      return q(
        `insert into bookings (order_id, date, hour, court, user_id, name, type, price, status, note, expires_at, created_at, created_by)
         values ${values} returning ${BOOKING_COLS}`, params);
    }).catch((e) => {
      if (e.code === '23505') throw err('slot_taken', {});   // มีคนจองช่องเดียวกันชิงไปในเสี้ยววินาที
      throw e;
    });
    return { order: orders(rows.map(normBooking), c.now)[0] };
  }

  // ยกเลิกทีละช่อง ({id}) หรือทั้งการจอง ({orderId})
  async function cancel(p, token) {
    const me = await requireUser(token);
    const id = String(p.id || ''), orderId = String(p.orderId || '');
    const key = id || orderId;
    if (!isUuid(key)) throw err(key ? 'not_found' : 'invalid_input');
    const t = now();
    const count = await db.tx(async (q) => {
      await expireStale(q, t);
      const rows = (await q(
        `select ${BOOKING_COLS} from bookings where ${id ? 'id' : 'order_id'} = $1 and status in ${HOLDING_SQL} for update`,
        [key])).map(normBooking);
      if (!rows.length) throw err('not_found');
      for (const b of rows) {
        if (b.user_id !== me.id && !me.perms.can_cancel_any) throw err('forbidden');
        if (me.perms.can_cancel_any) continue;
        const hoursLeft = (slotStart(b.date, b.hour) - t) / 3600000;
        if (hoursLeft <= 0) throw err('slot_past');
        // ยังไม่ได้จ่ายเงิน ยกเลิกได้ตลอด · จ่ายแล้วต้องยกเลิกก่อนเวลาเล่นตามสิทธิ์
        if (b.status !== 'pending_payment' && hoursLeft < me.perms.cancel_before_hours) {
          throw err('cancel_too_late', { hours: me.perms.cancel_before_hours });
        }
      }
      await q(
        `update bookings set status = 'cancelled', cancelled_at = $2, cancelled_by = $3
         where ${id ? 'id' : 'order_id'} = $1 and status in ${HOLDING_SQL}`, [key, new Date(t), me.id]);
      return rows.length;
    });
    return { cancelled: count };
  }

  async function myBookings(p, token) {
    const me = await requireUser(token);
    const c = clock();
    const rows = await db.query(`select ${BOOKING_COLS} from bookings where user_id = $1 order by date, hour, court`, [me.id]);
    const list = orders(rows.map(normBooking), c.now);
    list.forEach((o) => {
      o.upcoming = HOLDING.includes(o.status) &&
        o.items.some((i) => i.status !== 'cancelled' && isUpcoming(i, c, true));
    });
    const first = (o) => o.items[0].date + pad(o.items[0].hour);
    return {
      clock: c,
      upcoming: list.filter((o) => o.upcoming).sort((a, b) => first(a).localeCompare(first(b))),
      history: list.filter((o) => !o.upcoming).sort((a, b) => first(b).localeCompare(first(a))).slice(0, 30)
    };
  }

  async function uploadSlip(p, token) {
    const me = await requireUser(token);
    const orderId = String(p.orderId || '');
    if (!isUuid(orderId)) throw err('not_found');
    const m = /^data:(image\/(?:png|jpe?g|webp|gif|heic|heif));base64,([A-Za-z0-9+/=]+)$/.exec(String(p.image || ''));
    if (!m) throw err('invalid_slip');
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length) throw err('invalid_slip');
    if (bytes.length > CONFIG.MAX_SLIP_BYTES) throw err('slip_too_large');

    const check = (rows, t) => {
      const order = orders(rows.map(normBooking), t)[0];
      if (!order || (order.user_id !== me.id && !me.perms.can_confirm_payments)) throw err('not_found');
      if (order.status === 'expired') throw err('payment_expired');
      if (order.status !== 'pending_payment' && order.status !== 'pending_review') throw err('not_found');
      return order;
    };
    // ตรวจก่อนอัปโหลด จะได้ไม่มีไฟล์ค้างเปล่า ๆ
    check(await db.query(`select ${BOOKING_COLS} from bookings where order_id = $1`, [orderId]), now());

    const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
    const path = orderId + '/' + now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    await storage.put(path, bytes, m[1]);
    try {
      return await db.tx(async (q) => {
        const t = now();
        await expireStale(q, t);
        const order = check(await q(`select ${BOOKING_COLS} from bookings where order_id = $1 for update`, [orderId]), t);
        await q(
          `update bookings set status = 'pending_review', slip_path = $2, slip_uploaded_at = $3
           where order_id = $1 and status in ('pending_payment','pending_review')`, [orderId, path, new Date(t)]);
        return { orderId, status: 'pending_review', amount: order.amount };
      });
    } catch (e) {
      await storage.remove(path).catch(() => {});
      throw e;
    }
  }

  async function slip(p, token) {
    const me = await requireUser(token);
    const orderId = String(p.orderId || '');
    if (!isUuid(orderId)) throw err('not_found');
    const [b] = await db.query(
      'select user_id, slip_path, slip_uploaded_at from bookings where order_id = $1 and slip_path is not null limit 1', [orderId]);
    if (!b || (b.user_id !== me.id && !me.perms.can_confirm_payments)) throw err('not_found');
    return { image: await storage.signedUrl(b.slip_path, 600), uploadedAt: stamp(b.slip_uploaded_at) };
  }

  async function adminOrders(p, token) {
    const me = await requireUser(token);
    if (!me.perms.can_confirm_payments) throw err('forbidden');
    const t = now();
    const rows = await db.query(
      `select ${BOOKING_COLS} from bookings where type = 'booking' and order_id in (
         select order_id from bookings where status in ('pending_payment','pending_review') or reviewed_at > $1)`,
      [new Date(t - CONFIG.ADMIN_RECENT_DAYS * 864e5)]);
    const phones = {};
    (await db.query('select id, phone from users')).forEach((u) => { phones[u.id] = u.phone; });
    const list = orders(rows.map(normBooking), t);
    list.forEach((o) => { o.phone = phones[o.user_id] || ''; });
    const by = (key, desc) => (a, b) => (desc ? -1 : 1) * String(a[key]).localeCompare(String(b[key]));
    return {
      review: list.filter((o) => o.status === 'pending_review').sort(by('slip_uploaded_at')),
      awaiting: list.filter((o) => o.status === 'pending_payment').sort(by('created_at')),
      recent: list.filter((o) => o.reviewed_at).sort(by('reviewed_at', true)).slice(0, 20)
    };
  }

  async function reviewOrder(p, token) {
    const me = await requireUser(token);
    if (!me.perms.can_confirm_payments) throw err('forbidden');
    const orderId = String(p.orderId || '');
    if (!isUuid(orderId)) throw err('not_found');
    const approve = p.approve === true;
    const note = String(p.note || '').trim().slice(0, 200);
    return db.tx(async (q) => {
      const t = now();
      await expireStale(q, t);
      const rows = await q(
        "select id from bookings where order_id = $1 and status in ('pending_review','pending_payment') for update", [orderId]);
      if (!rows.length) throw err('not_found');
      await q(
        `update bookings set status = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5
         where order_id = $1 and status in ('pending_review','pending_payment')`,
        [orderId, approve ? 'confirmed' : 'rejected', me.id, new Date(t), note]);
      return { orderId, status: approve ? 'confirmed' : 'rejected' };
    });
  }

  async function changePassword(p, token) {
    const me = await requireUser(token);
    const [u] = await db.query('select password_hash from users where id = $1', [me.id]);
    if (!(await verifyPassword(String(p.oldPassword || ''), u.password_hash))) throw err('invalid_login');
    const pw = String(p.newPassword || '');
    if (pw.length < 6) throw err('weak_password');
    await db.query('update users set password_hash = $2 where id = $1', [me.id, await hashPassword(pw)]);
    return { ok: true };
  }

  async function adminUsers(p, token) {
    const me = await requireUser(token);
    if (!me.perms.can_manage_users) throw err('forbidden');
    const users = await db.query('select id, phone, name, nickname, role, status, created_at from users order by created_at');
    return {
      users: users.map((u) => ({ id: u.id, phone: u.phone, name: u.name, nickname: u.nickname, role: u.role,
                                 status: u.status, created_at: stamp(u.created_at) })),
      roles: (await loadRoles()).list
    };
  }

  async function adminUpdateUser(p, token) {
    const me = await requireUser(token);
    if (!me.perms.can_manage_users) throw err('forbidden');
    const id = String(p.id || '');
    if (!isUuid(id)) throw err('not_found');
    const [u] = await db.query('select id, role from users where id = $1', [id]);
    if (!u) throw err('not_found');
    const sets = [], params = [id];
    const set = (col, v) => { params.push(v); sets.push(col + ' = $' + params.length); };
    if (p.role !== undefined) {
      if (!(await loadRoles()).byName[p.role]) throw err('invalid_input');
      if (id === me.id && p.role !== u.role) throw err('self_edit');
      set('role', p.role);
    }
    if (p.status !== undefined) {
      if (!['active', 'suspended'].includes(p.status)) throw err('invalid_input');
      if (id === me.id && p.status !== 'active') throw err('self_edit');
      set('status', p.status);
    }
    if (p.password) {
      if (String(p.password).length < 6) throw err('weak_password');
      set('password_hash', await hashPassword(String(p.password)));
    }
    if (sets.length) await db.query('update users set ' + sets.join(', ') + ' where id = $1', params);
    return { id };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  function clock() {
    const t = now();
    const p = bkkParts(t);
    return { today: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) % 24, now: t };
  }

  function checkLimits(perms, mine, slots, c) {
    if (perms.max_hours_per_day > 0) {
      const perDay = {};
      mine.forEach((b) => { perDay[b.date] = (perDay[b.date] || 0) + 1; });
      slots.forEach((s) => {
        perDay[s.date] = (perDay[s.date] || 0) + 1;
        if (perDay[s.date] > perms.max_hours_per_day) throw err('daily_limit', { limit: perms.max_hours_per_day, date: s.date });
      });
    }
    if (perms.max_active_bookings > 0) {
      const upcoming = mine.filter((b) => isUpcoming(b, c)).length;
      if (upcoming + slots.length > perms.max_active_bookings) throw err('active_limit', { limit: perms.max_active_bookings });
    }
  }

  // รอชำระที่เลยเวลา → expired (ทำในทรานแซกชันก่อนจอง/ยกเลิก/ส่งสลิป/ตรวจ)
  function expireStale(q, t) {
    return q("update bookings set status = 'expired' where status = 'pending_payment' and expires_at <= $1", [new Date(t)]);
  }

  async function loadRoles() {
    const list = (await db.query('select * from roles order by sort, role')).map((r) => ({
      role: r.role, label: r.label,
      advance_days: num(r.advance_days), max_hours_per_day: num(r.max_hours_per_day),
      max_active_bookings: num(r.max_active_bookings), cancel_before_hours: num(r.cancel_before_hours),
      can_book_for_others: !!r.can_book_for_others, can_block: !!r.can_block, can_cancel_any: !!r.can_cancel_any,
      can_manage_users: !!r.can_manage_users, can_confirm_payments: !!r.can_confirm_payments
    }));
    const byName = {};
    list.forEach((r) => { byName[r.role] = r; });
    return { list, byName };
  }

  async function loadSettings() {
    const raw = Object.assign({}, DEFAULT_SETTINGS);
    (await db.query('select key, value from settings')).forEach((r) => {
      if (String(r.value).trim() !== '') raw[r.key] = r.value;
    });
    return {
      price_day: num(raw.price_day), price_night: num(raw.price_night),
      lights_from_hour: num(raw.lights_from_hour), pay_within_minutes: num(raw.pay_within_minutes) || 30,
      bank_name: String(raw.bank_name), bank_account_no: String(raw.bank_account_no).replace(/\D/g, ''),
      bank_account_name: String(raw.bank_account_name)
    };
  }

  function makeToken(userId) {
    const payload = userId + '.' + (now() + CONFIG.SESSION_DAYS * 864e5);
    return payload + '.' + sign(payload);
  }
  function sign(payload) { return crypto.createHmac('sha256', secret).update(payload).digest('base64url'); }

  async function userFromToken(token, roles) {
    const parts = String(token).split('.');
    if (parts.length !== 3 || !isUuid(parts[0])) return null;
    const expect = Buffer.from(sign(parts[0] + '.' + parts[1]));
    const got = Buffer.from(parts[2]);
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect) || Number(parts[1]) < now()) return null;
    const [u] = await db.query('select id, phone, name, nickname, role, status from users where id = $1', [parts[0]]);
    if (!u || u.status !== 'active') return null;
    u.perms = permsFor(u.role, roles);
    return u;
  }

  async function requireUser(token) {
    const u = token ? await userFromToken(token, await loadRoles()) : null;
    if (!u) throw err('auth_required');
    return u;
  }

  return { handle };
}

// ───────────────────────────── pure helpers ─────────────────────────────

function permsFor(role, roles) {
  // role ที่ไม่มีในตาราง roles → ใช้สิทธิ์ของ user · ถ้าไม่มี user ด้วย → จองได้แค่วันนี้ 1 ชม.
  return roles.byName[role] || roles.byName.user || {
    role, label: role, advance_days: 0, max_hours_per_day: 1, max_active_bookings: 1, cancel_before_hours: 0,
    can_book_for_others: false, can_block: false, can_cancel_any: false, can_manage_users: false, can_confirm_payments: false
  };
}

function publicUser(u) {
  return { id: u.id, phone: u.phone, name: u.name, nickname: u.nickname, role: u.role, perms: u.perms };
}
function displayName(u) { return u.nickname ? u.name + ' (' + u.nickname + ')' : u.name; }
function priceFor(hour, s) { return hour >= s.lights_from_hour ? s.price_night : s.price_day; }

function normBooking(r) {
  return {
    id: r.id, order_id: r.order_id, date: r.date, hour: Number(r.hour), court: r.court, user_id: r.user_id,
    name: r.name, type: r.type, price: Number(r.price), status: r.status, note: r.note || '',
    expires_at: r.expires_at ? new Date(r.expires_at).getTime() : null,
    slip_path: r.slip_path || '', slip_uploaded_at: stamp(r.slip_uploaded_at),
    reviewed_at: stamp(r.reviewed_at), review_note: r.review_note || '', created_at: stamp(r.created_at)
  };
}

function effStatus(b, t) {
  return b.status === 'pending_payment' && b.expires_at && b.expires_at <= t ? 'expired' : b.status;
}

// รวมช่องที่จองพร้อมกันเป็น 1 การจอง (order) — จ่ายเงิน/ส่งสลิป/ยืนยันทีละ order
function orders(list, t) {
  const map = new Map();
  list.forEach((b) => {
    if (!map.has(b.order_id)) map.set(b.order_id, []);
    map.get(b.order_id).push(b);
  });
  return [...map.entries()].map(([orderId, raw]) => {
    const items = raw.slice().sort((a, b) => (a.date + pad(a.hour) + a.court).localeCompare(b.date + pad(b.hour) + b.court));
    const live = items.filter((b) => b.status !== 'cancelled');
    const head = live[0] || items[0];
    return {
      order_id: orderId, user_id: head.user_id, name: head.name, type: head.type,
      status: live.length ? effStatus(head, t) : 'cancelled',
      amount: live.reduce((sum, b) => sum + b.price, 0),
      expires_at: head.expires_at, created_at: head.created_at,
      slip: !!head.slip_path, slip_uploaded_at: head.slip_uploaded_at,
      reviewed_at: head.reviewed_at, review_note: head.review_note,
      items: items.map((b) => ({
        id: b.id, date: b.date, hour: b.hour, court: b.court, price: b.price, note: b.note,
        status: b.status === 'cancelled' ? 'cancelled' : effStatus(b, t)
      }))
    };
  });
}

const BKK = new Intl.DateTimeFormat('en-CA', {
  timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function bkkParts(ms) {
  const p = {};
  BKK.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p;
}
function stamp(v) {
  if (!v) return '';
  const p = bkkParts(v instanceof Date ? v.getTime() : Date.parse(v));
  return `${p.year}-${p.month}-${p.day} ${pad(Number(p.hour) % 24)}:${p.minute}:${p.second}`;
}

function isUpcoming(b, c, includeInProgress) {
  const ahead = daysBetween(c.today, b.date);
  return ahead > 0 || (ahead === 0 && (includeInProgress ? b.hour >= c.hour : b.hour > c.hour));
}
function slotStart(date, hour) { return Date.parse(date + 'T' + pad(hour) + ':00:00' + CONFIG.UTC_OFFSET); }
function daysBetween(a, b) {
  const pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], pa[1] - 1, +pa[2])) / 864e5);
}
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s)); }
function normPhone(v) {
  let d = String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
  if (d.startsWith('66') && d.length === 11) d = '0' + d.slice(2);
  return d;
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// รหัสผ่าน: scrypt + salt สุ่ม (ไม่มีใครอ่านรหัสจริงได้ แม้แต่แอดมินฐานข้อมูล)
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 32, (e, key) => e ? reject(e) : resolve('scrypt$' + salt.toString('base64') + '$' + key.toString('base64')));
  });
}
function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return Promise.resolve(false);
  const expect = Buffer.from(h, 'base64');
  return new Promise((resolve) => {
    crypto.scrypt(pw, Buffer.from(s, 'base64'), expect.length, (e, key) => resolve(!e && crypto.timingSafeEqual(key, expect)));
  });
}
