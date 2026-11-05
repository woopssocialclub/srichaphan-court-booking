// ที่เก็บรูปสลิป: Supabase Storage (bucket "slips" แบบ private)
import { createClient } from '@supabase/supabase-js';

export function createSupabaseStorage(url, key, bucket = 'slips') {
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not set');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const files = () => client.storage.from(bucket);
  return {
    async put(path, bytes, contentType) {
      const { error } = await files().upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error('storage upload: ' + error.message);
    },
    // ลิงก์ชั่วคราว ให้หน้าเว็บแสดงรูปได้โดยไม่ต้องเปิด bucket เป็นสาธารณะ
    async signedUrl(path, seconds = 600) {
      const { data, error } = await files().createSignedUrl(path, seconds);
      if (error) throw new Error('storage sign: ' + error.message);
      return data.signedUrl;
    },
    async remove(path) {
      await files().remove([path]);
    }
  };
}

// ใช้ตอนเทสต์ / รันในเครื่อง: เก็บไว้ในหน่วยความจำ ลิงก์เป็น data URL
export function createMemoryStorage() {
  const files = new Map();
  return {
    files,
    async put(path, bytes, contentType) { files.set(path, { bytes: Buffer.from(bytes), contentType }); },
    async signedUrl(path) {
      const f = files.get(path);
      if (!f) throw new Error('storage: not found');
      return 'data:' + f.contentType + ';base64,' + f.bytes.toString('base64');
    },
    async remove(path) { files.delete(path); }
  };
}
