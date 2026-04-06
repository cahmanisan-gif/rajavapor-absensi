const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');

const UPLOAD_DIR = path.join(process.env.UPLOAD_PATH || '/var/www/rajavapor-absensi/uploads', 'selfie');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.memoryStorage();
const upload  = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Haversine distance in meters
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Helper: ambil setting
async function getSettings() {
  const [rows] = await db.query('SELECT key_name, value FROM absensi_setting');
  const s = {};
  rows.forEach(r => { s[r.key_name] = r.value; });
  return s;
}

// Helper: WIB time string HH:MM:SS
function wibNow() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return {
    time: now.toISOString().slice(11, 19),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    totalMinutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
    date: now.toISOString().slice(0, 10)
  };
}

// ══════════════════════════════════════════
// POST /api/absensi/clock-in
// ══════════════════════════════════════════
router.post('/clock-in', auth(), upload.single('foto'), async (req, res) => {
  try {
    const s = await getSettings();
    const wib = wibNow();
    const today = wib.date;
    const userId = req.user.id;
    const cabangId = req.body.cabang_id || req.user.cabang_id;

    // 1. Cek sudah clock-in hari ini?
    const [[existing]] = await db.query(
      'SELECT id FROM absensi_log WHERE user_id=? AND tanggal=? AND tipe="masuk"',
      [userId, today]);
    if (existing) return res.status(400).json({ success: false, message: 'Anda sudah clock-in hari ini.' });

    // 2. Validasi jam
    const jamMulai = parseInt(s.jam_masuk_mulai?.replace(':', '') || '0600');
    const jamAkhir = parseInt(s.jam_masuk_akhir?.replace(':', '') || '1000');
    const shift2Mulai = parseInt(s.shift2_masuk_mulai?.replace(':', '') || '1300');
    const shift2Akhir = parseInt(s.shift2_masuk_akhir?.replace(':', '') || '1600');
    const jamNow = parseInt(wib.time.replace(/:/g, '').slice(0, 4));

    const isShift1 = jamNow >= jamMulai && jamNow <= jamAkhir;
    const isShift2 = jamNow >= shift2Mulai && jamNow <= shift2Akhir;
    if (!isShift1 && !isShift2) {
      return res.status(400).json({
        success: false,
        message: `Clock-in hanya bisa jam ${s.jam_masuk_mulai}-${s.jam_masuk_akhir} (shift 1) atau ${s.shift2_masuk_mulai}-${s.shift2_masuk_akhir} (shift 2). Sekarang ${wib.time.slice(0, 5)} WIB.`
      });
    }

    // 3. Validasi foto
    if (s.foto_wajib === '1' && !req.file) {
      return res.status(400).json({ success: false, message: 'Foto selfie wajib.' });
    }

    // 4. Validasi GPS
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    const accuracy = parseFloat(req.body.accuracy) || 0;

    if (s.gps_wajib === '1') {
      if (!lat || !lng) return res.status(400).json({ success: false, message: 'Lokasi GPS wajib diaktifkan.' });
      const maxAccuracy = parseInt(s.accuracy_max || '100');
      if (accuracy > maxAccuracy) {
        return res.status(400).json({
          success: false,
          message: `Akurasi GPS terlalu rendah (${Math.round(accuracy)}m). Pastikan GPS aktif dan tunggu sinyal stabil (maks ${maxAccuracy}m).`
        });
      }
    }

    // 5. Hitung jarak dari cabang
    let jarak = null;
    let valid = 1;
    if (lat && lng && cabangId) {
      const [[cab]] = await db.query('SELECT lat, lng, nama FROM cabang WHERE id=?', [cabangId]);
      if (cab?.lat && cab?.lng) {
        jarak = Math.round(haversineM(lat, lng, parseFloat(cab.lat), parseFloat(cab.lng)));
        const radiusMax = parseInt(s.radius_meter || '200');
        if (jarak > radiusMax) {
          valid = 0;
          return res.status(400).json({
            success: false,
            message: `Lokasi terlalu jauh dari ${cab.nama} (${jarak}m, batas ${radiusMax}m). Pastikan Anda di area toko.`
          });
        }
      }
    }

    // 6. Simpan foto selfie (compress to WebP)
    let fotoUrl = null;
    if (req.file) {
      const filename = `masuk_${userId}_${today}_${Date.now()}.webp`;
      const destPath = path.join(UPLOAD_DIR, filename);
      await sharp(req.file.buffer)
        .resize(480, 480, { fit: 'cover', position: 'centre' })
        .webp({ quality: 70 })
        .toFile(destPath);
      fotoUrl = 'selfie/' + filename;
    }

    // 7. Insert absensi_log
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    await db.query(
      `INSERT INTO absensi_log (user_id, cabang_id, tanggal, tipe, foto_url, lat, lng, accuracy, jarak_meter, waktu, valid, ip_address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, cabangId, today, 'masuk', fotoUrl, lat || null, lng || null, accuracy || null, jarak, wib.time, valid, ip]
    );

    // 8. Sinkron ke absensi_hari_ini (untuk kompatibilitas payroll & gate transaksi POS)
    await db.query(
      `INSERT INTO absensi_hari_ini (user_id, personnel_id, tanggal, clock_in, status)
       VALUES (?, (SELECT personnel_id FROM users WHERE id=?), ?, ?, 'hadir')
       ON DUPLICATE KEY UPDATE clock_in=VALUES(clock_in), status='hadir'`,
      [userId, userId, today, wib.time]
    );

    res.json({
      success: true,
      message: `Clock-in berhasil! ${wib.time.slice(0, 5)} WIB` + (jarak !== null ? ` (jarak ${jarak}m)` : ''),
      data: { waktu: wib.time, jarak, valid }
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'Anda sudah clock-in hari ini.' });
    console.error('clock-in error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════��══════════════════
// POST /api/absensi/clock-out
// ═══���══════════════��═══════════════════════
router.post('/clock-out', auth(), upload.single('foto'), async (req, res) => {
  try {
    const s = await getSettings();
    const wib = wibNow();
    const today = wib.date;
    const userId = req.user.id;
    const cabangId = req.body.cabang_id || req.user.cabang_id;

    // 1. Cek sudah clock-in?
    const [[clockIn]] = await db.query(
      'SELECT id FROM absensi_log WHERE user_id=? AND tanggal=? AND tipe="masuk"',
      [userId, today]);
    if (!clockIn) return res.status(400).json({ success: false, message: 'Anda belum clock-in hari ini.' });

    // 2. Cek sudah clock-out?
    const [[clockOut]] = await db.query(
      'SELECT id FROM absensi_log WHERE user_id=? AND tanggal=? AND tipe="pulang"',
      [userId, today]);
    if (clockOut) return res.status(400).json({ success: false, message: 'Anda sudah clock-out hari ini.' });

    // 3. Validasi jam pulang
    const jamMulai = parseInt(s.jam_pulang_mulai?.replace(':', '') || '1400');
    const jamAkhir = parseInt(s.jam_pulang_akhir?.replace(':', '') || '2300');
    const jamNow = parseInt(wib.time.replace(/:/g, '').slice(0, 4));
    if (jamNow < jamMulai || jamNow > jamAkhir) {
      return res.status(400).json({
        success: false,
        message: `Clock-out hanya bisa jam ${s.jam_pulang_mulai}-${s.jam_pulang_akhir}. Sekarang ${wib.time.slice(0, 5)} WIB.`
      });
    }

    // 4. Validasi foto
    if (s.foto_wajib === '1' && !req.file) {
      return res.status(400).json({ success: false, message: 'Foto selfie wajib.' });
    }

    // 5. GPS & jarak
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    const accuracy = parseFloat(req.body.accuracy) || 0;
    let jarak = null;
    let valid = 1;

    if (s.gps_wajib === '1') {
      if (!lat || !lng) return res.status(400).json({ success: false, message: 'Lokasi GPS wajib diaktifkan.' });
      const maxAccuracy = parseInt(s.accuracy_max || '100');
      if (accuracy > maxAccuracy) {
        return res.status(400).json({
          success: false,
          message: `Akurasi GPS terlalu rendah (${Math.round(accuracy)}m).`
        });
      }
    }

    if (lat && lng && cabangId) {
      const [[cab]] = await db.query('SELECT lat, lng, nama FROM cabang WHERE id=?', [cabangId]);
      if (cab?.lat && cab?.lng) {
        jarak = Math.round(haversineM(lat, lng, parseFloat(cab.lat), parseFloat(cab.lng)));
        const radiusMax = parseInt(s.radius_meter || '200');
        if (jarak > radiusMax) {
          valid = 0;
          return res.status(400).json({
            success: false,
            message: `Lokasi terlalu jauh dari ${cab.nama} (${jarak}m, batas ${radiusMax}m).`
          });
        }
      }
    }

    // 6. Simpan foto
    let fotoUrl = null;
    if (req.file) {
      const filename = `pulang_${userId}_${today}_${Date.now()}.webp`;
      const destPath = path.join(UPLOAD_DIR, filename);
      await sharp(req.file.buffer)
        .resize(480, 480, { fit: 'cover', position: 'centre' })
        .webp({ quality: 70 })
        .toFile(destPath);
      fotoUrl = 'selfie/' + filename;
    }

    // 7. Insert
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    await db.query(
      `INSERT INTO absensi_log (user_id, cabang_id, tanggal, tipe, foto_url, lat, lng, accuracy, jarak_meter, waktu, valid, ip_address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, cabangId, today, 'pulang', fotoUrl, lat || null, lng || null, accuracy || null, jarak, wib.time, valid, ip]
    );

    // 8. Sinkron ke absensi_hari_ini
    await db.query(
      `UPDATE absensi_hari_ini SET clock_out=?, status='pulang' WHERE user_id=? AND tanggal=?`,
      [wib.time, userId, today]
    );

    res.json({
      success: true,
      message: `Clock-out berhasil! ${wib.time.slice(0, 5)} WIB`,
      data: { waktu: wib.time, jarak, valid }
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'Anda sudah clock-out hari ini.' });
    console.error('clock-out error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════
// GET /api/absensi/status — status hari ini
// ══════════════════════════════════════════
router.get('/status', auth(), async (req, res) => {
  try {
    const today = wibNow().date;
    const userId = req.user.id;

    const [logs] = await db.query(
      'SELECT tipe, waktu, foto_url, jarak_meter, valid FROM absensi_log WHERE user_id=? AND tanggal=? ORDER BY tipe',
      [userId, today]);

    const masuk  = logs.find(l => l.tipe === 'masuk');
    const pulang = logs.find(l => l.tipe === 'pulang');

    // Cek izin hari ini
    const [[izin]] = await db.query(
      `SELECT tipe, status FROM absensi_izin WHERE user_id=? AND ?>=dari_tanggal AND ?<=sampai_tanggal AND status='approved'`,
      [userId, today, today]);

    let status = 'belum';
    if (izin) status = izin.tipe;
    else if (pulang) status = 'pulang';
    else if (masuk) status = 'hadir';

    // Info cabang user
    const [[user]] = await db.query(
      'SELECT u.cabang_id, c.nama as nama_cabang, c.lat, c.lng FROM users u LEFT JOIN cabang c ON c.id=u.cabang_id WHERE u.id=?',
      [userId]);

    res.json({
      success: true,
      data: {
        status,
        clock_in: masuk ? { waktu: masuk.waktu, foto: masuk.foto_url, jarak: masuk.jarak_meter } : null,
        clock_out: pulang ? { waktu: pulang.waktu, foto: pulang.foto_url, jarak: pulang.jarak_meter } : null,
        izin: izin || null,
        cabang: user ? { id: user.cabang_id, nama: user.nama_cabang, lat: user.lat, lng: user.lng } : null,
        tanggal: today
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═════���════════════════════════════════════
// GET /api/absensi/riwayat?bulan=YYYY-MM
// ══════════════════════════════════════════
router.get('/riwayat', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || wibNow().date.slice(0, 7);
    const userId = req.query.user_id || req.user.id;

    // Hanya owner/manajer boleh lihat riwayat user lain
    if (parseInt(userId) !== req.user.id && !['owner', 'manajer', 'head_operational', 'admin_pusat', 'spv_area'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak.' });
    }

    const [logs] = await db.query(
      `SELECT tanggal, tipe, waktu, foto_url, jarak_meter, valid, catatan
       FROM absensi_log WHERE user_id=? AND DATE_FORMAT(tanggal,'%Y-%m')=?
       ORDER BY tanggal, tipe`,
      [userId, bulan]);

    // Group by tanggal
    const harian = {};
    logs.forEach(l => {
      const tgl = l.tanggal instanceof Date ? l.tanggal.toISOString().slice(0, 10) : String(l.tanggal);
      if (!harian[tgl]) harian[tgl] = { tanggal: tgl, masuk: null, pulang: null };
      harian[tgl][l.tipe === 'masuk' ? 'masuk' : 'pulang'] = {
        waktu: l.waktu, foto: l.foto_url, jarak: l.jarak_meter, valid: l.valid
      };
    });

    // Izin bulan ini
    const [izinList] = await db.query(
      `SELECT * FROM absensi_izin WHERE user_id=? AND DATE_FORMAT(dari_tanggal,'%Y-%m')=? AND status='approved'`,
      [userId, bulan]);

    const data = Object.values(harian).sort((a, b) => b.tanggal.localeCompare(a.tanggal));
    const hadir = data.filter(d => d.masuk).length;
    const tidakHadir = new Date().getDate() - hadir; // rough estimate

    res.json({
      success: true,
      data,
      izin: izinList,
      summary: { hadir, total_hari: data.length, bulan }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
