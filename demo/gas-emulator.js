/*
 * จำลอง Google Apps Script (SpreadsheetApp, DriveApp, Utilities ฯลฯ) ใน browser
 * ใช้ตอนโหมดทดลอง: index.html โหลดโค้ดหลังบ้านตัวจริง (apps-script/Srichaphan_Court_Booking.gs)
 * มารันกับตัวจำลองนี้ — กติกาทุกข้อจึงเหมือนระบบจริงเป๊ะ ข้อมูลเก็บใน localStorage
 * ใช้ใน Node สำหรับเทสต์ได้ด้วย (require แล้วส่ง storage ของตัวเองเข้าไป)
 */
(function (root) {
  'use strict';

  // ── SHA-256 / HMAC (sync) ──
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length;
    var withPad = ((l + 9 + 63) >> 6) << 6;
    var m = new Uint8Array(withPad);
    m.set(bytes);
    m[l] = 0x80;
    var bits = l * 8;
    m[withPad - 4] = (bits >>> 24) & 255; m[withPad - 3] = (bits >>> 16) & 255;
    m[withPad - 2] = (bits >>> 8) & 255; m[withPad - 1] = bits & 255;
    m[withPad - 5] = Math.floor(bits / 4294967296) & 255;
    var w = new Array(64);
    for (var off = 0; off < withPad; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var a0 = w[i - 15], a1 = w[i - 2];
        var s0 = ((a0 >>> 7) | (a0 << 25)) ^ ((a0 >>> 18) | (a0 << 14)) ^ (a0 >>> 3);
        var s1 = ((a1 >>> 17) | (a1 << 15)) ^ ((a1 >>> 19) | (a1 << 13)) ^ (a1 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    H.forEach(function (x) { out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255); });
    return out;
  }

  function hmacSha256(keyBytes, msgBytes) {
    if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
    var ipad = [], opad = [];
    for (var i = 0; i < 64; i++) {
      var k = keyBytes[i] || 0;
      ipad.push(k ^ 0x36); opad.push(k ^ 0x5c);
    }
    return sha256(opad.concat(sha256(ipad.concat(msgBytes))));
  }

  function utf8(str) { return Array.from(new TextEncoder().encode(String(str))); }
  function unsigned(bytes) { return Array.from(bytes, function (b) { return b & 255; }); }
  function signed(bytes) { return bytes.map(function (b) { return b > 127 ? b - 256 : b; }); }

  function b64encode(bytes) {
    var bin = '', u = unsigned(bytes);
    for (var i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.slice(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(str) {
    var bin = atob(str), out = new Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function create(storage, opts) {
    var db = storage.get('db') || { sheets: {}, order: [], props: {}, folders: {} };
    function save() { storage.set('db', db); }

    // ── SpreadsheetApp ──
    function width(data) { return data.reduce(function (w, r) { return Math.max(w, r.length); }, 0); }
    function makeSheet(name) {
      var sheet = {
        getName: function () { return name; },
        getLastRow: function () { return db.sheets[name].length; },
        getLastColumn: function () { return width(db.sheets[name]); },
        getMaxRows: function () { return Math.max(1000, db.sheets[name].length); },
        setFrozenRows: function () {},
        getDataRange: function () {
          return rangeOf(1, 1, Math.max(db.sheets[name].length, 1), Math.max(width(db.sheets[name]), 1));
        },
        getRange: function (r, c, nr, nc) {
          if (typeof r === 'string') return rangeOf(1, 1, 0, 0);
          return rangeOf(r, c, nr || 1, nc || 1);
        }
      };
      function rangeOf(r, c, nr, nc) {
        var range = {
          getValues: function () {
            var data = db.sheets[name], out = [];
            for (var i = 0; i < nr; i++) {
              var row = [];
              for (var j = 0; j < nc; j++) {
                var v = data[r - 1 + i] ? data[r - 1 + i][c - 1 + j] : undefined;
                row.push(v === undefined || v === null ? '' : v);
              }
              out.push(row);
            }
            return out;
          },
          setValues: function (vals) {
            var data = db.sheets[name];
            vals.forEach(function (rowVals, i) {
              var row = data[r - 1 + i] || (data[r - 1 + i] = []);
              rowVals.forEach(function (v, j) {
                while (row.length < c - 1 + j) row.push('');
                row[c - 1 + j] = v;
              });
            });
            for (var k = 0; k < data.length; k++) if (!data[k]) data[k] = [];
            save();
            return range;
          }
        };
        ['setFontWeight', 'setBackground', 'setFontColor', 'setNumberFormat'].forEach(function (fn) {
          range[fn] = function () { return range; };
        });
        return range;
      }
      return sheet;
    }
    var spreadsheet = {
      getId: function () { return 'demo-spreadsheet'; },
      getSheetByName: function (n) { return db.sheets[n] ? makeSheet(n) : null; },
      insertSheet: function (n) { db.sheets[n] = []; db.order.push(n); save(); return makeSheet(n); },
      getSheets: function () { return db.order.map(makeSheet); },
      deleteSheet: function (s) { delete db.sheets[s.getName()]; db.order.splice(db.order.indexOf(s.getName()), 1); save(); }
    };

    // ── DriveApp (ไฟล์เก็บแยก key เพื่อไม่ต้องเขียนรูปซ้ำทุกครั้ง) ──
    function fileObj(id) {
      var meta = db.files && db.files[id];
      if (!meta) throw new Error('File not found: ' + id);
      return {
        getId: function () { return id; },
        getName: function () { return meta.name; },
        getBlob: function () {
          var bytes = b64decode(storage.get('file:' + id) || '');
          return { getBytes: function () { return bytes; }, getContentType: function () { return meta.mime; } };
        },
        setTrashed: function (v) { meta.trashed = !!v; save(); }
      };
    }
    function folderObj(id) {
      var f = db.folders[id];
      if (!f) throw new Error('Folder not found: ' + id);
      return {
        getId: function () { return id; },
        getName: function () { return f.name; },
        createFile: function (blob) {
          var fid = 'F' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          db.files = db.files || {};
          db.files[fid] = { name: blob.getName(), mime: blob.getContentType(), folder: id };
          storage.set('file:' + fid, b64encode(blob.getBytes()));
          save();
          return fileObj(fid);
        }
      };
    }

    var g = {
      SpreadsheetApp: {
        getActiveSpreadsheet: function () { return spreadsheet; },
        openById: function () { return spreadsheet; }
      },
      PropertiesService: {
        getScriptProperties: function () {
          return {
            getProperty: function (k) { return db.props[k] === undefined ? null : db.props[k]; },
            setProperty: function (k, v) { db.props[k] = String(v); save(); }
          };
        }
      },
      LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } },
      ContentService: {
        MimeType: { JSON: 'JSON' },
        createTextOutput: function (text) {
          return { getContent: function () { return text; }, setMimeType: function () { return this; } };
        }
      },
      DriveApp: {
        createFolder: function (name) {
          var id = 'D' + Date.now().toString(36);
          db.folders[id] = { name: name };
          save();
          return folderObj(id);
        },
        getFolderById: folderObj,
        getFileById: fileObj
      },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        Charset: { UTF_8: 'UTF_8' },
        getUuid: function () {
          if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
            var r = Math.random() * 16 | 0;
            return (ch === 'x' ? r : (r & 3 | 8)).toString(16);
          });
        },
        formatDate: function (date, tz, fmt) {
          var p = {};
          new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
          }).formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
          var hour = String(+p.hour % 24);
          return fmt.replace(/yyyy|MM|dd|HH|H|mm|ss/g, function (tok) {
            return { yyyy: p.year, MM: p.month, dd: p.day, HH: (hour.length < 2 ? '0' : '') + hour, H: hour, mm: p.minute, ss: p.second }[tok];
          });
        },
        computeDigest: function (alg, value) { return signed(sha256(utf8(value))); },
        computeHmacSha256Signature: function (value, key) { return signed(hmacSha256(utf8(key), utf8(value))); },
        base64Encode: function (v) { return b64encode(typeof v === 'string' ? utf8(v) : v); },
        base64EncodeWebSafe: function (v) {
          return b64encode(typeof v === 'string' ? utf8(v) : v).replace(/\+/g, '-').replace(/\//g, '_');
        },
        base64Decode: function (s) { return signed(b64decode(s)); },
        newBlob: function (bytes, mime, name) {
          return {
            getBytes: function () { return bytes; },
            getContentType: function () { return mime; },
            getName: function () { return name; }
          };
        }
      },
      Logger: { log: (opts && opts.log) || function () {} },
      console: root.console
    };
    if (opts && opts.Date) g.Date = opts.Date;   // เทสต์ใช้นาฬิกาปลอมได้

    function load(code) {
      var names = Object.keys(g);
      var exportsList = ['doPost', 'doGet', 'setup', 'table_', 'appendMany_', 'update_', 'slipFolder_', 'stamp_', 'newId_'];
      var factory = new Function(names.join(','),
        code + '\n;return {' + exportsList.map(function (n) { return n + ':' + n; }).join(',') + '};');
      return factory.apply(null, names.map(function (n) { return g[n]; }));
    }

    return { globals: g, load: load };
  }

  var api = { create: create, sha256: sha256 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GasEmulator = api;
})(typeof window !== 'undefined' ? window : globalThis);
