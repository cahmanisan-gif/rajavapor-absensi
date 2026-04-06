const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

const ADMIN_ROLES = ['owner', 'admin_pusat', 'head_operational'];

// GET /api/admin/settings
router.get('/settings', auth(ADMIN_ROLES), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM absensi_setting ORDER BY key_name');
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/admin/settings
router.patch('/settings', auth(ADMIN_ROLES), async (req, res) => {
  try {
    for (const [key, val] of Object.entries(req.body)) {
      await db.query('UPDATE absensi_setting SET value=? WHERE key_name=?', [val, key]);
    }
    res.json({ success: true, message: 'Setting disimpan.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/admin/dashboard — overview hari ini
router.get('/dashboard', auth(ADMIN_ROLES), async (req, res) => {
  try {
    const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

    const [
      [totalStaff], [sudahMasuk], [sudahPulang], [izinHariIni], [belumMasuk]
    ] = await Promise.all([
      db.query("SELECT COUNT(*) as n FROM users WHERE aktif=1 AND role IN ('kasir','kasir_sales','vaporista','kepala_cabang')"),
      db.query("SELECT COUNT(DISTINCT user_id) as n FROM absensi_log WHERE tanggal=? AND tipe='masuk'", [today]),
      db.query("SELECT COUNT(DISTINCT user_id) as n FROM absensi_log WHERE tanggal=? AND tipe='pulang'", [today]),
      db.query("SELECT COUNT(*) as n FROM absensi_izin WHERE status='approved' AND ?>=dari_tanggal AND ?<=sampai_tanggal", [today, today]),
      db.query(`SELECT COUNT(*) as n FROM users u
        WHERE u.aktif=1 AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')
          AND u.id NOT IN (SELECT user_id FROM absensi_log WHERE tanggal=? AND tipe='masuk')
          AND u.id NOT IN (SELECT user_id FROM absensi_izin WHERE status='approved' AND ?>=dari_tanggal AND ?<=sampai_tanggal)`,
        [today, today, today]),
    ]);

    // Per cabang breakdown
    const [perCabang] = await db.query(`
      SELECT c.id, c.kode, c.nama,
        (SELECT COUNT(*) FROM users u2 WHERE u2.cabang_id=c.id AND u2.aktif=1 AND u2.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')) as total,
        (SELECT COUNT(DISTINCT l.user_id) FROM absensi_log l WHERE l.cabang_id=c.id AND l.tanggal=? AND l.tipe='masuk') as hadir
      FROM cabang c WHERE c.aktif=1 ORDER BY c.kode`, [today]);

    // Izin pending
    const [[izinPending]] = await db.query("SELECT COUNT(*) as n FROM absensi_izin WHERE status='pending'");

    res.json({
      success: true,
      data: {
        tanggal: today,
        total_staff: totalStaff[0].n,
        sudah_masuk: sudahMasuk[0].n,
        sudah_pulang: sudahPulang[0].n,
        izin: izinHariIni[0].n,
        belum_masuk: belumMasuk[0].n,
        izin_pending: izinPending.n,
        per_cabang: perCabang
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/admin/override — manual override absensi (owner only)
router.post('/override', auth(['owner']), async (req, res) => {
  try {
    const { user_id, tanggal, tipe, waktu, catatan } = req.body;
    if (!user_id || !tanggal || !tipe || !waktu) {
      return res.status(400).json({ success: false, message: 'user_id, tanggal, tipe, waktu wajib.' });
    }

    const [[user]] = await db.query('SELECT cabang_id FROM users WHERE id=?', [user_id]);
    const cabangId = user?.cabang_id || null;

    await db.query(
      `INSERT INTO absensi_log (user_id, cabang_id, tanggal, tipe, waktu, valid, catatan)
       VALUES (?,?,?,?,?,1,?)
       ON DUPLICATE KEY UPDATE waktu=VALUES(waktu), catatan=VALUES(catatan)`,
      [user_id, cabangId, tanggal, tipe, waktu, `[OVERRIDE oleh ${req.user.username || req.user.id}] ${catatan || ''}`]);

    // Sinkron ke absensi_hari_ini
    if (tipe === 'masuk') {
      await db.query(
        `INSERT INTO absensi_hari_ini (user_id, personnel_id, tanggal, clock_in, status)
         VALUES (?, (SELECT personnel_id FROM users WHERE id=?), ?, ?, 'hadir')
         ON DUPLICATE KEY UPDATE clock_in=VALUES(clock_in), status='hadir'`,
        [user_id, user_id, tanggal, waktu]);
    } else {
      await db.query(
        `UPDATE absensi_hari_ini SET clock_out=?, status='pulang' WHERE user_id=? AND tanggal=?`,
        [waktu, user_id, tanggal]);
    }

    res.json({ success: true, message: `Override ${tipe} berhasil untuk ${tanggal}.` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/admin/users — list staff untuk dropdown
router.get('/users', auth(ADMIN_ROLES), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT u.id, u.nama_lengkap, u.role, u.cabang_id, c.nama as nama_cabang, c.kode
      FROM users u LEFT JOIN cabang c ON c.id=u.cabang_id
      WHERE u.aktif=1 AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')
      ORDER BY c.kode, u.nama_lengkap`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/admin/cabang — list cabang aktif
router.get('/cabang', auth(), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, kode, nama, lat, lng FROM cabang WHERE aktif=1 ORDER BY kode');
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
