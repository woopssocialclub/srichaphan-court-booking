// ข้อมูลตัวอย่างสำหรับทดสอบในเครื่อง: ผู้ใช้ 3 เลเวล + ผู้เล่น 12 คน + การจอง 15 วัน + สลิปรอตรวจ 1 รายการ
// ⚠️ ใช้กับฐานข้อมูลทดสอบเท่านั้น ห้ามรันกับฐานข้อมูลจริง
import crypto from 'node:crypto';

export async function seedDemo({ db, storage, app }) {
  const reg = async (phone, password, name, nickname) => {
    const r = await app.handle('register', { phone, password, name, nickname });
    if (!r.ok) throw new Error('seed register ' + phone + ': ' + r.error);
    return r.data.user;
  };
  const admin = await reg('0800000001', 'admin123', 'Admin Srichaphan', 'Admin');
  const mem = await reg('0800000002', 'member123', 'สมาชิก ทดลอง', 'Mem');
  await reg('0800000003', 'user123', 'ผู้ใช้ ทดลอง', 'Guest');
  const names = ['Nok', 'Ton', 'Ploy', 'Beam', 'Mike', 'Fah', 'Joe', 'Pim', 'Bank', 'Mint', 'Arm', 'Kate'];
  const players = [];
  for (let i = 0; i < names.length; i++) {
    players.push(await reg('08100000' + String(i).padStart(2, '0'), crypto.randomBytes(9).toString('hex'), names[i] + ' Player', names[i]));
  }
  await db.query("update users set role = 'member' where id = any($1::uuid[])",
    [[mem.id, ...players.filter((_, i) => i % 3 === 0).map((p) => p.id)]]);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const label = (u) => u.name + ' (' + u.nickname + ')';
  const price = (h) => (h >= 18 ? 350 : 250);
  const tmr = addDays(today, 1), d2 = addDays(today, 2);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="860" font-family="sans-serif">' +
    '<rect width="600" height="860" fill="#fff"/><rect width="600" height="150" fill="#FFD400"/>' +
    '<text x="300" y="90" font-size="40" font-weight="700" text-anchor="middle" fill="#4A3A00">โอนเงินสำเร็จ</text>' +
    '<text x="300" y="260" font-size="72" font-weight="700" text-anchor="middle" fill="#1E293B">฿700.00</text>' +
    '<text x="60" y="380" font-size="26" fill="#64748B">จาก</text><text x="60" y="420" font-size="30" fill="#1E293B">NOK PLAYER</text>' +
    '<text x="60" y="510" font-size="26" fill="#64748B">ไปยัง</text><text x="60" y="550" font-size="30" fill="#1E293B">ธนากร ศรีชาพันธุ์</text>' +
    '<text x="60" y="590" font-size="26" fill="#1E293B">กรุงศรี 173-1-30405-3</text>' +
    '<text x="300" y="780" font-size="24" text-anchor="middle" fill="#DC2626">สลิปตัวอย่าง (ข้อมูลทดสอบ)</text></svg>';
  const reviewOrder = crypto.randomUUID(), blockOrder = crypto.randomUUID(), awaitOrder = crypto.randomUUID();
  const slipPath = reviewOrder + '/demo.svg';
  await storage.put(slipPath, Buffer.from(svg), 'image/svg+xml');

  const nok = players[0], ploy = players[2];
  const rows = [
    { order_id: blockOrder, date: tmr, hour: 6, court: 'C5', user: admin, type: 'block', price: 0, note: 'ซ่อมพื้นคอร์ท / Maintenance' },
    { order_id: blockOrder, date: tmr, hour: 7, court: 'C5', user: admin, type: 'block', price: 0, note: 'ซ่อมพื้นคอร์ท / Maintenance' },
    { order_id: reviewOrder, date: tmr, hour: 19, court: 'C1', user: nok, price: 350, status: 'pending_review', slip_path: slipPath, slip_uploaded_at: new Date() },
    { order_id: reviewOrder, date: tmr, hour: 20, court: 'C1', user: nok, price: 350, status: 'pending_review', slip_path: slipPath, slip_uploaded_at: new Date() },
    { order_id: awaitOrder, date: d2, hour: 18, court: 'C2', user: ploy, price: 350, status: 'pending_payment', expires_at: new Date(Date.now() + 25 * 60000) }
  ];
  const used = new Set(rows.map((r) => r.date + '|' + r.hour + '|' + r.court));
  let seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (let d = 0; d <= 14; d++) {
    const date = addDays(today, d);
    for (let h = 6; h < 23; h++) {
      const busy = h >= 17 && h <= 21 ? 0.62 : h <= 8 ? 0.35 : 0.18;
      for (const c of ['C1', 'C2', 'C3', 'C4', 'C5']) {
        if (rand() < busy * Math.max(0.15, 1.2 - d * 0.12) && !used.has(date + '|' + h + '|' + c)) {
          rows.push({ order_id: crypto.randomUUID(), date, hour: h, court: c, user: players[Math.floor(rand() * players.length)], price: price(h) });
        }
      }
    }
  }
  for (const r of rows) {
    await db.query(
      `insert into bookings (order_id, date, hour, court, user_id, name, type, price, status, note, expires_at, slip_path, slip_uploaded_at, created_by)
       values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $5)`,
      [r.order_id, r.date, r.hour, r.court, r.user.id, label(r.user), r.type || 'booking', r.price, r.status || 'confirmed',
       r.note || '', r.expires_at || null, r.slip_path || null, r.slip_uploaded_at || null]);
  }
  return rows.length;
}
