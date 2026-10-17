/**
 * Srichaphan Tennis Academy — ระบบจองคอร์ทเทนนิส (backend: Google Sheet + Apps Script Web App)
 *
 * วิธีใช้ (ละเอียดใน docs/setup-guide.md):
 *   1) สร้าง Google Sheet ใหม่ → Extensions → Apps Script → วางโค้ดนี้ทั้งไฟล์
 *   2) เลือกฟังก์ชัน setup → Run
 *   3) Deploy → New deployment → Web app (Execute as: Me · Who has access: Anyone)
 *   4) เอา Web app URL ไปใส่ API_URL ใน index.html
 *
 * *** setup() รันซ้ำได้ปลอดภัย: ไม่ลบไม่ทับข้อมูลเดิม แค่เติมแท็บ/คอลัมน์/ค่าที่ยังขาด ***
 *
 * แท็บในชีท
 *   Users    — ผู้ใช้ (แก้คอลัมน์ role / status ในชีทได้โดยตรง)
 *   Bookings — การจองทุกช่อง (ไม่ลบแถว แค่เปลี่ยน status)
 *   Roles    — สิทธิ์ของแต่ละเลเวล (จองล่วงหน้ากี่วัน, กี่ ชม./วัน ฯลฯ) แก้ในชีทได้เลย
 *   Settings — ราคา, เลขบัญชีรับเงิน, เวลาที่ต้องชำระ แก้ในชีทได้เลย
 *   ⚠️ ห้ามเปลี่ยนชื่อหัวคอลัมน์ (แถวที่ 1) — โค้ดหาคอลัมน์จากชื่อหัว
 *
 * สถานะการจอง (คอลัมน์ status ใน Bookings)
 *   pending_payment → รอชำระ (ถ้าไม่อัปโหลดสลิปภายในเวลาที่กำหนด จะกลายเป็น expired และช่องว่างอีกครั้ง)
 *   pending_review  → อัปโหลดสลิปแล้ว รอแอดมินตรวจ
 *   confirmed       → แอดมินยืนยันแล้ว
 *   rejected        → แอดมินปฏิเสธสลิป (ช่องว่างอีกครั้ง)
 *   expired / cancelled
 */

// ===== แก้ตรงนี้ได้ =====
var CONFIG = {
  VENUE_NAME: 'Srichaphan Tennis Academy',
  COURTS: ['C1', 'C2', 'C3', 'C4', 'C5'],
  OPEN_HOUR: 6,            // ช่องแรก 06:00–07:00
  CLOSE_HOUR: 23,          // ปิด 23:00 → ช่องสุดท้าย 22:00–23:00
  TIMEZONE: 'Asia/Bangkok',
  UTC_OFFSET: '+07:00',
  SESSION_DAYS: 30,        // ล็อกอินค้างไว้ได้กี่วัน
  MAX_SLOTS_PER_REQUEST: 20,
  MAX_BLOCK_DAYS_AHEAD: 365, // แอดมินปิดคอร์ทล่วงหน้าได้ไกลสุดกี่วัน
  SLIP_FOLDER_NAME: 'Srichaphan Court Booking — สลิปโอนเงิน',
  MAX_SLIP_BYTES: 5 * 1024 * 1024
};
// ===== จบส่วนแก้ =====

var SHEETS = {
  Users: ['id', 'phone', 'name', 'nickname', 'role', 'status', 'salt', 'password_hash', 'created_at'],
  Bookings: ['id', 'order_id', 'date', 'hour', 'court', 'user_id', 'name', 'type', 'price', 'status', 'note',
             'expires_at', 'slip_file_id', 'slip_uploaded_at', 'reviewed_by', 'reviewed_at', 'review_note',
             'created_at', 'created_by', 'cancelled_at', 'cancelled_by'],
  Roles: ['role', 'label', 'advance_days', 'max_hours_per_day', 'max_active_bookings', 'cancel_before_hours',
          'can_book_for_others', 'can_block', 'can_cancel_any', 'can_manage_users', 'can_confirm_payments'],
  Settings: ['key', 'value', 'description']
};
var TEXT_COLUMNS = { Users: ['phone'], Bookings: ['date'], Settings: ['value'] };

// advance_days: ดูตาราง + จองล่วงหน้าได้กี่วัน (0 = แค่วันนี้, 7 = วันนี้ + อีก 7 วัน)
// ตัวเลขจำกัด (ชม./วัน, การจองค้าง) ที่เป็น 0 = ไม่จำกัด
var DEFAULT_ROLES = [
  ['admin',  'ผู้ดูแล / Admin',      30, 0, 0, 0, true,  true,  true,  true,  true],
  ['member', 'สมาชิก / Member',      14, 2, 4, 3, false, false, false, false, false],
  ['user',   'ผู้ใช้ทั่วไป / User',  7,  1, 2, 3, false, false, false, false, false]
];

var DEFAULT_SETTINGS = [
  ['price_day', 250, 'ราคาต่อชั่วโมง ช่วงกลางวัน (บาท)'],
  ['price_night', 350, 'ราคาต่อชั่วโมง ช่วงเปิดไฟ (บาท)'],
  ['lights_from_hour', 18, 'เริ่มคิดราคาเปิดไฟตั้งแต่ช่องเวลานี้ (18 = ช่อง 18:00 เป็นต้นไป)'],
  ['pay_within_minutes', 30, 'ต้องอัปโหลดสลิปภายในกี่นาทีหลังกดจอง ไม่งั้นการจองหลุดอัตโนมัติ'],
  ['bank_name', 'ธนาคารกรุงศรีอยุธยา (กรุงศรี)', 'ธนาคารที่รับโอน'],
  ['bank_account_no', '1731304053', 'เลขบัญชี (ตัวเลขล้วน)'],
  ['bank_account_name', 'ธนากร ศรีชาพันธุ์', 'ชื่อบัญชี']
];

var HOLDING = ['pending_payment', 'pending_review', 'confirmed'];
var PASSWORD_ROUNDS = 200;

// ───────────────────────────── setup ─────────────────────────────

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ต้องเปิด Apps Script จากในชีท (Extensions → Apps Script) แล้วค่อยรัน setup');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('TOKEN_SECRET')) {
    props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }

  var log = [];
  Object.keys(SHEETS).forEach(function (name) {
    var res = ensureSheet_(ss, name, SHEETS[name]);
    if (res.created) log.push('สร้างแท็บ ' + name);
    else if (res.added.length) log.push(name + ': เพิ่มคอลัมน์ ' + res.added.join(', '));

    if (name === 'Roles' && res.created) {
      res.sheet.getRange(2, 1, DEFAULT_ROLES.length, DEFAULT_ROLES[0].length).setValues(DEFAULT_ROLES);
    }
    if (name === 'Roles' && res.added.indexOf('can_confirm_payments') >= 0) {
      // อัปเกรดจากเวอร์ชันเก่า: ใครจัดการผู้ใช้ได้ ให้ยืนยันสลิปได้ด้วย
      var t = table_(name, ss);
      t.rows.forEach(function (r) { if (bool_(r.can_manage_users)) update_(t, r, { can_confirm_payments: true }); });
    }
    if (name === 'Settings') {
      var st = table_(name, ss);
      var have = st.rows.map(function (r) { return String(r.key).trim(); });
      var missing = DEFAULT_SETTINGS.filter(function (d) { return have.indexOf(d[0]) < 0; })
        .map(function (d) { return { key: d[0], value: d[1], description: d[2] }; });
      appendMany_(st, missing);
      if (missing.length && !res.created) log.push('Settings: เพิ่มค่า ' + missing.map(function (m) { return m.key; }).join(', '));
    }
  });

  ['Sheet1', 'ชีต1', 'แผ่นงาน1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  var folder = slipFolder_();   // ขอสิทธิ์ Google Drive + สร้างโฟลเดอร์เก็บสลิป
  Logger.log('✅ ' + (log.length ? log.join(' · ') : 'มีครบทุกแท็บอยู่แล้ว ไม่ได้แก้อะไร'));
  Logger.log('📁 โฟลเดอร์เก็บสลิป: ' + folder.getName());
  Logger.log('ขั้นต่อไป: Deploy → New deployment → Web app');
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  var created = !sh;
  var added = [];
  if (created) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    added = headers.slice();
  } else {
    var have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    while (have.length && !have[have.length - 1]) have.pop();
    added = headers.filter(function (h) { return have.indexOf(h) < 0; });
    if (added.length) sh.getRange(1, have.length + 1, 1, added.length).setValues([added]);
  }
  if (added.length) {
    var width = sh.getLastColumn();
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#2E75B6').setFontColor('#FFFFFF');
    // เก็บวันที่/เบอร์โทร/เลขบัญชีเป็นข้อความ ไม่ให้ชีทแปลงเป็น Date หรือตัด 0 หน้า
    var hdr = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
    (TEXT_COLUMNS[name] || []).forEach(function (col) {
      var c = hdr.indexOf(col) + 1;
      if (c > 0) sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return { sheet: sh, created: created, added: created ? [] : added };
}

// ───────────────────────────── router ─────────────────────────────

var ACTIONS = {
  bootstrap: bootstrap_,
  register: register_,
  login: login_,
  schedule: schedule_,
  book: book_,
  cancel: cancel_,
  myBookings: myBookings_,
  uploadSlip: uploadSlip_,
  slip: slip_,
  changePassword: changePassword_,
  adminUsers: adminUsers_,
  adminUpdateUser: adminUpdateUser_,
  adminOrders: adminOrders_,
  reviewOrder: reviewOrder_
};

function doGet() {
  return json_({ ok: true, service: CONFIG.VENUE_NAME + ' Court Booking', clock: clock_() });
}

function doPost(e) {
  var res;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = ACTIONS[req.action];
    if (!fn) throw err_('invalid_input');
    res = { ok: true, data: fn(req.payload || {}, req.token || '') };
  } catch (ex) {
    res = ex.code
      ? { ok: false, error: ex.code, params: ex.params || {} }
      : { ok: false, error: 'server_error', message: String(ex && ex.message || ex) };
    if (!ex.code) console.error(ex);
  }
  return json_(res);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function err_(code, params) {
  var e = new Error(code);
  e.code = code;
  e.params = params || {};
  return e;
}

// ───────────────────────────── actions ─────────────────────────────

function bootstrap_(p, token) {
  var roles = roles_();
  var me = token ? userFromToken_(token, roles) : null;
  var s = settings_();
  var out = {
    courts: CONFIG.COURTS,
    openHour: CONFIG.OPEN_HOUR,
    closeHour: CONFIG.CLOSE_HOUR,
    nightFromHour: s.lights_from_hour,
    pricing: { day: s.price_day, night: s.price_night, lightsFromHour: s.lights_from_hour },
    payment: { bankName: s.bank_name, accountNo: s.bank_account_no, accountName: s.bank_account_name,
               payWithinMinutes: s.pay_within_minutes },
    clock: clock_(),
    roles: roles.list,
    guestPerms: permsFor_('user', roles),
    user: me ? publicUser_(me) : null
  };
  if (me && me.perms.can_confirm_payments) {
    out.pendingReview = orders_(bookings_(), Date.now())
      .filter(function (o) { return o.status === 'pending_review'; }).length;
  }
  return out;
}

function register_(p) {
  var phone = normPhone_(p.phone);
  var name = String(p.name || '').trim().slice(0, 60);
  var nickname = String(p.nickname || '').trim().slice(0, 30);
  var password = String(p.password || '');
  if (!/^0\d{8,9}$/.test(phone)) throw err_('invalid_phone');
  if (!name) throw err_('name_required');
  if (password.length < 6) throw err_('weak_password');

  return withLock_(function () {
    var t = table_('Users');
    var users = t.rows.map(normUser_);
    if (users.some(function (u) { return u.phone === phone; })) throw err_('phone_taken');
    // คนแรกที่สมัคร (ตอนยังไม่มี admin) จะได้เป็น admin อัตโนมัติ
    var hasAdmin = users.some(function (u) { return u.role === 'admin'; });
    var salt = Utilities.getUuid();
    var user = {
      id: newId_('U'), phone: phone, name: name, nickname: nickname,
      role: hasAdmin ? 'user' : 'admin', status: 'active',
      salt: salt, password_hash: hashPassword_(salt, password), created_at: stamp_()
    };
    append_(t, user);
    user.perms = permsFor_(user.role, roles_());
    return { token: makeToken_(user.id), user: publicUser_(user) };
  });
}

function login_(p) {
  var phone = normPhone_(p.phone);
  var password = String(p.password || '');
  var u = table_('Users').rows.map(normUser_).filter(function (x) { return x.phone === phone; })[0];
  if (!u || hashPassword_(u.salt, password) !== u.password_hash) throw err_('invalid_login');
  if (u.status !== 'active') throw err_('suspended');
  u.perms = permsFor_(u.role, roles_());
  return { token: makeToken_(u.id), user: publicUser_(u) };
}

function schedule_(p, token) {
  var date = String(p.date || '');
  if (!isDate_(date)) throw err_('invalid_input');
  var roles = roles_();
  var me = token ? userFromToken_(token, roles) : null;
  var perms = me ? me.perms : permsFor_('user', roles);   // ยังไม่ล็อกอิน = เห็นเท่าผู้ใช้ทั่วไป
  var clock = clock_();
  var ahead = daysBetween_(clock.today, date);
  // ดูตารางได้แค่ช่วงวันตามเลเวล (คนที่ปิดคอร์ทได้ ดูได้ทุกวัน)
  if (!perms.can_block && (ahead < 0 || ahead > perms.advance_days)) throw err_('too_far_ahead', { days: perms.advance_days });
  var seeNames = !!(me && me.perms.can_cancel_any);
  var list = bookings_().filter(function (b) { return b.date === date && isHolding_(b, clock.now); }).map(function (b) {
    var mine = !!(me && b.user_id === me.id);
    var status = effStatus_(b, clock.now);
    var out = { court: b.court, hour: b.hour, type: b.type, mine: mine, pending: status !== 'confirmed' };
    if (b.type === 'block') out.note = b.note;
    if (mine || seeNames) {
      out.id = b.id; out.order_id = b.order_id; out.name = b.name; out.note = b.note;
      out.price = b.price; out.status = status;
    }
    return out;
  });
  return { date: date, clock: clock, bookings: list };
}

function book_(p, token) {
  var me = requireUser_(token);
  var perms = me.perms;
  var type = p.type === 'block' ? 'block' : 'booking';
  if (type === 'block' && !perms.can_block) throw err_('forbidden');
  var forName = String(p.forName || '').trim().slice(0, 60);
  if (forName && !perms.can_book_for_others) throw err_('forbidden');
  var note = String(p.note || '').trim().slice(0, 120);
  var raw = Array.isArray(p.slots) ? p.slots : [];
  if (!raw.length || raw.length > CONFIG.MAX_SLOTS_PER_REQUEST) throw err_('invalid_input');

  var clock = clock_();
  var maxAhead = type === 'block' ? CONFIG.MAX_BLOCK_DAYS_AHEAD : perms.advance_days;
  var seen = {};
  var slots = raw.map(function (s) {
    var date = String(s.date || ''), hour = Number(s.hour), court = String(s.court || '');
    if (!isDate_(date) || CONFIG.COURTS.indexOf(court) < 0 || hour % 1 !== 0 ||
        hour < CONFIG.OPEN_HOUR || hour >= CONFIG.CLOSE_HOUR) throw err_('invalid_input');
    var ahead = daysBetween_(clock.today, date);
    if (ahead < 0 || (ahead === 0 && hour <= clock.hour)) throw err_('slot_past', { date: date, hour: hour, court: court });
    if (ahead > maxAhead) throw err_('too_far_ahead', { days: maxAhead });
    var key = slotKey_(date, hour, court);
    if (seen[key]) throw err_('invalid_input');
    seen[key] = true;
    return { date: date, hour: hour, court: court, key: key };
  });

  var s = settings_();
  return withLock_(function () {
    var t = table_('Bookings');
    expireStale_(t, clock.now);
    var active = t.rows.map(normBooking_).filter(function (b) { return isHolding_(b, clock.now); });
    var taken = {};
    active.forEach(function (b) { taken[slotKey_(b.date, b.hour, b.court)] = true; });
    slots.forEach(function (sl) {
      if (taken[sl.key]) throw err_('slot_taken', { date: sl.date, hour: sl.hour, court: sl.court });
    });

    if (type === 'booking') checkLimits_(me, active, slots, clock);

    // คนที่ยืนยันสลิปได้ (แอดมิน) จอง/ปิดคอร์ท = ยืนยันทันที ไม่ต้องชำระผ่านระบบ
    var direct = type === 'block' || perms.can_confirm_payments;
    var orderId = newId_('R');
    var now = stamp_();
    var rows = slots.map(function (sl) {
      return {
        id: newId_('B'), order_id: orderId, date: sl.date, hour: sl.hour, court: sl.court, user_id: me.id,
        name: forName || displayName_(me), type: type, price: type === 'block' ? 0 : priceFor_(sl.hour, s),
        status: direct ? 'confirmed' : 'pending_payment', note: note,
        expires_at: direct ? '' : clock.now + s.pay_within_minutes * 60000,
        created_at: now, created_by: me.id
      };
    });
    appendMany_(t, rows);
    return { order: orders_(rows.map(normBooking_), clock.now)[0] };
  });
}

function checkLimits_(me, active, slots, clock) {
  var perms = me.perms;
  var mine = active.filter(function (b) { return b.user_id === me.id && b.type === 'booking'; });
  if (perms.max_hours_per_day > 0) {
    var perDay = {};
    mine.forEach(function (b) { perDay[b.date] = (perDay[b.date] || 0) + 1; });
    slots.forEach(function (s) {
      perDay[s.date] = (perDay[s.date] || 0) + 1;
      if (perDay[s.date] > perms.max_hours_per_day) throw err_('daily_limit', { limit: perms.max_hours_per_day, date: s.date });
    });
  }
  if (perms.max_active_bookings > 0) {
    var upcoming = mine.filter(function (b) { return isUpcoming_(b, clock); }).length;
    if (upcoming + slots.length > perms.max_active_bookings) throw err_('active_limit', { limit: perms.max_active_bookings });
  }
}

// ยกเลิกทีละช่อง ({id}) หรือทั้งคำสั่งจอง ({orderId})
function cancel_(p, token) {
  var me = requireUser_(token);
  var id = String(p.id || ''), orderId = String(p.orderId || '');
  if (!id && !orderId) throw err_('invalid_input');
  return withLock_(function () {
    var now = Date.now();
    var t = table_('Bookings');
    expireStale_(t, now);
    var rows = t.rows.filter(function (r) {
      var b = normBooking_(r);
      return (id ? b.id === id : b.order_id === orderId) && isHolding_(b, now);
    });
    if (!rows.length) throw err_('not_found');
    rows.forEach(function (r) {
      var b = normBooking_(r);
      if (b.user_id !== me.id && !me.perms.can_cancel_any) throw err_('forbidden');
      if (me.perms.can_cancel_any) return;
      var hoursLeft = (slotStart_(b.date, b.hour) - now) / 3600000;
      if (hoursLeft <= 0) throw err_('slot_past');
      // ยังไม่ได้จ่ายเงิน ยกเลิกได้ตลอด · จ่ายแล้วต้องยกเลิกก่อนเวลาเล่นตามสิทธิ์
      if (b.status !== 'pending_payment' && hoursLeft < me.perms.cancel_before_hours) {
        throw err_('cancel_too_late', { hours: me.perms.cancel_before_hours });
      }
    });
    var stamp = stamp_();
    rows.forEach(function (r) { update_(t, r, { status: 'cancelled', cancelled_at: stamp, cancelled_by: me.id }); });
    return { cancelled: rows.length };
  });
}

function myBookings_(p, token) {
  var me = requireUser_(token);
  var clock = clock_();
  var orders = orders_(bookings_().filter(function (b) { return b.user_id === me.id; }), clock.now);
  orders.forEach(function (o) {
    o.upcoming = HOLDING.indexOf(o.status) >= 0 &&
      o.items.some(function (i) { return i.status !== 'cancelled' && isUpcoming_(i, clock, true); });
  });
  var firstSlot = function (o) { return o.items[0].date + pad_(o.items[0].hour); };
  return {
    clock: clock,
    upcoming: orders.filter(function (o) { return o.upcoming; })
      .sort(function (a, b) { return firstSlot(a).localeCompare(firstSlot(b)); }),
    history: orders.filter(function (o) { return !o.upcoming; })
      .sort(function (a, b) { return firstSlot(b).localeCompare(firstSlot(a)); }).slice(0, 30)
  };
}

function uploadSlip_(p, token) {
  var me = requireUser_(token);
  var orderId = String(p.orderId || '');
  var m = /^data:(image\/(?:png|jpe?g|webp|gif|heic|heif));base64,([A-Za-z0-9+\/=]+)$/.exec(String(p.image || ''));
  if (!m) throw err_('invalid_slip');
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > CONFIG.MAX_SLIP_BYTES) throw err_('slip_too_large');

  var check = function (list, now) {
    var order = orders_(list.filter(function (b) { return b.order_id === orderId; }), now)[0];
    if (!order || (order.user_id !== me.id && !me.perms.can_confirm_payments)) throw err_('not_found');
    if (order.status === 'expired') throw err_('payment_expired');
    if (order.status !== 'pending_payment' && order.status !== 'pending_review') throw err_('not_found');
    return order;
  };
  check(bookings_(), Date.now());   // ตรวจก่อนอัปโหลดไฟล์ จะได้ไม่สร้างไฟล์ทิ้งเปล่า ๆ

  var ext = m[1].split('/')[1].replace('jpeg', 'jpg');
  var name = 'slip_' + orderId + '_' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd_HHmmss') + '.' + ext;
  var file = slipFolder_().createFile(Utilities.newBlob(bytes, m[1], name));

  try {
    return withLock_(function () {
      var now = Date.now();
      var t = table_('Bookings');
      expireStale_(t, now);
      var order = check(t.rows.map(normBooking_), now);
      var stamp = stamp_();
      t.rows.forEach(function (r) {
        var b = normBooking_(r);
        if (b.order_id === orderId && isHolding_(b, now)) {
          update_(t, r, { status: 'pending_review', slip_file_id: file.getId(), slip_uploaded_at: stamp });
        }
      });
      return { orderId: orderId, status: 'pending_review', amount: order.amount };
    });
  } catch (ex) {
    file.setTrashed(true);
    throw ex;
  }
}

function slip_(p, token) {
  var me = requireUser_(token);
  var orderId = String(p.orderId || '');
  var b = bookings_().filter(function (x) { return x.order_id === orderId && x.slip_file_id; })[0];
  if (!b || (b.user_id !== me.id && !me.perms.can_confirm_payments)) throw err_('not_found');
  var blob = DriveApp.getFileById(b.slip_file_id).getBlob();
  return { image: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()),
           uploadedAt: b.slip_uploaded_at };
}

function adminOrders_(p, token) {
  var me = requireUser_(token);
  if (!me.perms.can_confirm_payments) throw err_('forbidden');
  var now = Date.now();
  var phones = {};
  table_('Users').rows.map(normUser_).forEach(function (u) { phones[u.id] = u.phone; });
  var orders = orders_(bookings_().filter(function (b) { return b.type === 'booking'; }), now);
  orders.forEach(function (o) { o.phone = phones[o.user_id] || ''; });
  var by = function (key, desc) {
    return function (a, b) { var r = String(a[key]).localeCompare(String(b[key])); return desc ? -r : r; };
  };
  return {
    review: orders.filter(function (o) { return o.status === 'pending_review'; }).sort(by('slip_uploaded_at')),
    awaiting: orders.filter(function (o) { return o.status === 'pending_payment'; }).sort(by('created_at')),
    recent: orders.filter(function (o) { return o.reviewed_at; }).sort(by('reviewed_at', true)).slice(0, 20)
  };
}

function reviewOrder_(p, token) {
  var me = requireUser_(token);
  if (!me.perms.can_confirm_payments) throw err_('forbidden');
  var orderId = String(p.orderId || '');
  var approve = p.approve === true;
  var note = String(p.note || '').trim().slice(0, 200);
  return withLock_(function () {
    var now = Date.now();
    var t = table_('Bookings');
    expireStale_(t, now);
    var rows = t.rows.filter(function (r) {
      var b = normBooking_(r);
      var st = effStatus_(b, now);
      return b.order_id === orderId && (st === 'pending_review' || st === 'pending_payment');
    });
    if (!rows.length) throw err_('not_found');
    var stamp = stamp_();
    rows.forEach(function (r) {
      update_(t, r, { status: approve ? 'confirmed' : 'rejected', reviewed_by: me.id, reviewed_at: stamp, review_note: note });
    });
    return { orderId: orderId, status: approve ? 'confirmed' : 'rejected' };
  });
}

function changePassword_(p, token) {
  var me = requireUser_(token);
  var t = table_('Users');
  var row = t.rows.filter(function (r) { return String(r.id) === me.id; })[0];
  if (hashPassword_(String(row.salt), String(p.oldPassword || '')) !== String(row.password_hash)) throw err_('invalid_login');
  var pw = String(p.newPassword || '');
  if (pw.length < 6) throw err_('weak_password');
  var salt = Utilities.getUuid();
  update_(t, row, { salt: salt, password_hash: hashPassword_(salt, pw) });
  return { ok: true };
}

function adminUsers_(p, token) {
  var me = requireUser_(token);
  if (!me.perms.can_manage_users) throw err_('forbidden');
  var users = table_('Users').rows.map(normUser_).map(function (u) {
    return { id: u.id, phone: u.phone, name: u.name, nickname: u.nickname, role: u.role,
             status: u.status, created_at: u.created_at };
  });
  return { users: users, roles: roles_().list };
}

function adminUpdateUser_(p, token) {
  var me = requireUser_(token);
  if (!me.perms.can_manage_users) throw err_('forbidden');
  var id = String(p.id || '');
  var roles = roles_();
  return withLock_(function () {
    var t = table_('Users');
    var row = t.rows.filter(function (r) { return String(r.id) === id; })[0];
    if (!row) throw err_('not_found');
    var patch = {};
    if (p.role !== undefined) {
      if (!roles.byName[p.role]) throw err_('invalid_input');
      if (id === me.id && p.role !== String(row.role)) throw err_('self_edit');
      patch.role = p.role;
    }
    if (p.status !== undefined) {
      if (['active', 'suspended'].indexOf(p.status) < 0) throw err_('invalid_input');
      if (id === me.id && p.status !== 'active') throw err_('self_edit');
      patch.status = p.status;
    }
    if (p.password) {
      if (String(p.password).length < 6) throw err_('weak_password');
      patch.salt = Utilities.getUuid();
      patch.password_hash = hashPassword_(patch.salt, String(p.password));
    }
    update_(t, row, patch);
    return { id: id };
  });
}

// ───────────────────────────── orders / payment ─────────────────────────────

function priceFor_(hour, s) {
  return hour >= s.lights_from_hour ? s.price_night : s.price_day;
}

// สถานะจริง ณ ตอนนี้: รอชำระที่เลยเวลา = expired · ค่า active จากเวอร์ชันเก่า = confirmed
function effStatus_(b, now) {
  if (b.status === 'active') return 'confirmed';
  if (b.status === 'pending_payment' && b.expires_at && b.expires_at <= now) return 'expired';
  return b.status;
}

function isHolding_(b, now) {
  return HOLDING.indexOf(effStatus_(b, now)) >= 0;
}

// เขียนสถานะ expired ลงชีทให้คนเปิดดูชีทเข้าใจตรงกัน (เรียกในล็อกเท่านั้น)
function expireStale_(t, now) {
  t.rows.forEach(function (r) {
    if (String(r.status) === 'pending_payment' && effStatus_(normBooking_(r), now) === 'expired') {
      update_(t, r, { status: 'expired' });
    }
  });
}

// รวมช่องที่จองพร้อมกันเป็น 1 คำสั่งจอง (order) — จ่ายเงิน/ส่งสลิป/ยืนยันทีละ order
function orders_(list, now) {
  var map = {}, keys = [];
  list.forEach(function (b) {
    var k = b.order_id || b.id;
    if (!map[k]) { map[k] = []; keys.push(k); }
    map[k].push(b);
  });
  return keys.map(function (k) {
    var items = map[k].slice().sort(function (a, b) {
      return (a.date + pad_(a.hour) + a.court).localeCompare(b.date + pad_(b.hour) + b.court);
    });
    var live = items.filter(function (b) { return b.status !== 'cancelled'; });
    var head = live[0] || items[0];
    return {
      order_id: k, user_id: head.user_id, name: head.name, type: head.type,
      status: live.length ? effStatus_(head, now) : 'cancelled',
      amount: live.reduce(function (sum, b) { return sum + b.price; }, 0),
      expires_at: head.expires_at || null, created_at: head.created_at,
      slip: !!head.slip_file_id, slip_uploaded_at: head.slip_uploaded_at,
      reviewed_at: head.reviewed_at, review_note: head.review_note,
      items: items.map(function (b) {
        return { id: b.id, date: b.date, hour: b.hour, court: b.court, price: b.price, note: b.note,
                 status: b.status === 'cancelled' ? 'cancelled' : effStatus_(b, now) };
      })
    };
  });
}

function slipFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SLIP_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* ถูกลบไปแล้ว → สร้างใหม่ */ }
  }
  var folder = DriveApp.createFolder(CONFIG.SLIP_FOLDER_NAME);
  props.setProperty('SLIP_FOLDER_ID', folder.getId());
  return folder;
}

function settings_() {
  var raw = {};
  DEFAULT_SETTINGS.forEach(function (d) { raw[d[0]] = d[1]; });
  table_('Settings').rows.forEach(function (r) {
    var k = String(r.key).trim();
    if (k && String(r.value).trim() !== '') raw[k] = r.value;
  });
  return {
    price_day: num_(raw.price_day),
    price_night: num_(raw.price_night),
    lights_from_hour: num_(raw.lights_from_hour),
    pay_within_minutes: num_(raw.pay_within_minutes) || 30,
    bank_name: String(raw.bank_name),
    bank_account_no: String(raw.bank_account_no).replace(/\D/g, ''),
    bank_account_name: String(raw.bank_account_name)
  };
}

// ───────────────────────────── auth ─────────────────────────────

function hashPassword_(salt, password) {
  var h = salt + '|' + password;
  for (var i = 0; i < PASSWORD_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function makeToken_(userId) {
  var payload = userId + '.' + (Date.now() + CONFIG.SESSION_DAYS * 86400000);
  return payload + '.' + sign_(payload);
}

function sign_(payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret)).replace(/=+$/, '');
}

function userFromToken_(token, roles) {
  var parts = String(token).split('.');
  if (parts.length !== 3) return null;
  var payload = parts[0] + '.' + parts[1];
  if (sign_(payload) !== parts[2] || Number(parts[1]) < Date.now()) return null;
  var u = table_('Users').rows.map(normUser_).filter(function (x) { return x.id === parts[0]; })[0];
  if (!u || u.status !== 'active') return null;
  u.perms = permsFor_(u.role, roles);
  return u;
}

function requireUser_(token) {
  var u = token ? userFromToken_(token, roles_()) : null;
  if (!u) throw err_('auth_required');
  return u;
}

function publicUser_(u) {
  return { id: u.id, phone: u.phone, name: u.name, nickname: u.nickname, role: u.role, perms: u.perms };
}

function displayName_(u) {
  return u.nickname ? u.name + ' (' + u.nickname + ')' : u.name;
}

// ───────────────────────────── roles ─────────────────────────────

function roles_() {
  var list = table_('Roles').rows.filter(function (r) { return String(r.role).trim(); }).map(function (r) {
    return {
      role: String(r.role).trim(),
      label: String(r.label || r.role),
      advance_days: num_(r.advance_days),
      max_hours_per_day: num_(r.max_hours_per_day),
      max_active_bookings: num_(r.max_active_bookings),
      cancel_before_hours: num_(r.cancel_before_hours),
      can_book_for_others: bool_(r.can_book_for_others),
      can_block: bool_(r.can_block),
      can_cancel_any: bool_(r.can_cancel_any),
      can_manage_users: bool_(r.can_manage_users),
      can_confirm_payments: bool_(r.can_confirm_payments)
    };
  });
  var byName = {};
  list.forEach(function (r) { byName[r.role] = r; });
  return { list: list, byName: byName };
}

function permsFor_(role, roles) {
  // role ที่ไม่มีในแท็บ Roles → ใช้สิทธิ์ของ user · ถ้าไม่มี user ด้วย → จองได้แค่วันนี้ 1 ชม.
  return roles.byName[role] || roles.byName.user || {
    role: role, label: role, advance_days: 0, max_hours_per_day: 1, max_active_bookings: 1,
    cancel_before_hours: 0, can_book_for_others: false, can_block: false, can_cancel_any: false,
    can_manage_users: false, can_confirm_payments: false
  };
}

// ───────────────────────────── sheet helpers ─────────────────────────────

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('ยังไม่ได้รัน setup()');
  return SpreadsheetApp.openById(id);
}

function table_(name, ss) {
  var sh = (ss || ss_()).getSheetByName(name);
  if (!sh) throw new Error('ไม่พบแท็บ ' + name + ' — รัน setup() ใหม่');
  var vals = sh.getDataRange().getValues();
  var headers = vals[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var r = 1; r < vals.length; r++) {
    var o = { _row: r + 1 };
    headers.forEach(function (h, c) { o[h] = vals[r][c]; });
    rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function rowValues_(t, obj) {
  return t.headers.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : obj[h]; });
}

function append_(t, obj) {
  appendMany_(t, [obj]);
}

function appendMany_(t, objs) {
  if (!objs.length) return;
  var start = t.sheet.getLastRow() + 1;
  t.sheet.getRange(start, 1, objs.length, t.headers.length)
    .setValues(objs.map(function (o) { return rowValues_(t, o); }));
}

function update_(t, row, patch) {
  Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
  t.sheet.getRange(row._row, 1, 1, t.headers.length).setValues([rowValues_(t, row)]);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw err_('busy');
  try { return fn(); } finally { lock.releaseLock(); }
}

function bookings_() {
  return table_('Bookings').rows.map(normBooking_);
}

function normBooking_(r) {
  var exp = r.expires_at instanceof Date ? r.expires_at.getTime() : num_(r.expires_at);
  return {
    id: String(r.id), order_id: String(r.order_id || ''), date: normDate_(r.date), hour: Number(r.hour),
    court: String(r.court), user_id: String(r.user_id), name: String(r.name), type: String(r.type || 'booking'),
    price: num_(r.price), status: String(r.status || 'confirmed').trim(), note: String(r.note || ''),
    expires_at: exp, slip_file_id: String(r.slip_file_id || ''), slip_uploaded_at: String(r.slip_uploaded_at || ''),
    reviewed_at: String(r.reviewed_at || ''), review_note: String(r.review_note || ''),
    created_at: String(r.created_at || '')
  };
}

function normUser_(r) {
  return {
    id: String(r.id), phone: normPhone_(r.phone), name: String(r.name), nickname: String(r.nickname || ''),
    role: String(r.role || 'user').trim(), status: String(r.status || 'active').trim(),
    salt: String(r.salt), password_hash: String(r.password_hash), created_at: String(r.created_at)
  };
}

// ───────────────────────────── utils ─────────────────────────────

function clock_() {
  var now = new Date();
  return {
    today: Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    hour: Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'H')),
    now: now.getTime()
  };
}

function isUpcoming_(b, clock, includeInProgress) {
  var ahead = daysBetween_(clock.today, b.date);
  return ahead > 0 || (ahead === 0 && (includeInProgress ? b.hour >= clock.hour : b.hour > clock.hour));
}

function slotStart_(date, hour) {
  return new Date(date + 'T' + pad_(hour) + ':00:00' + CONFIG.UTC_OFFSET).getTime();
}

function daysBetween_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], pa[1] - 1, +pa[2])) / 86400000);
}

function isDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
}

function normDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd') : String(v).trim();
}

function normPhone_(v) {
  var d = String(v === undefined ? '' : v).replace(/\D/g, '');
  if (d.indexOf('66') === 0 && d.length === 11) d = '0' + d.slice(2);
  if (d.length === 9 && d[0] !== '0') d = '0' + d;   // ชีทตัด 0 หน้าเบอร์ทิ้ง
  return d;
}

function slotKey_(date, hour, court) { return date + '|' + hour + '|' + court; }
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function num_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
function bool_(v) { return v === true || /^(true|yes|y|1|ใช่)$/i.test(String(v).trim()); }
function stamp_() { return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function newId_(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
