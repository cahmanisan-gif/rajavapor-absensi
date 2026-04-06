const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

const MANAGEMENT = ['owner', 'manajer', 'head_operational', 'admin_pusat', 'spv_area', 'manajer_area'];

// Helper: get settings
async function getSettings() {
  const [rows] = await db.query('SELECT key_name, value FROM absensi_setting');
  const s = {};
  rows.forEach(r => { s[r.key_name] = r.value; });
  return s;
}

// Helper: parse time to total minutes
function timeToMinutes(t) {
  if (!t) return 0;
  const str = typeof t === 'string' ? t : String(t);
  const parts = str.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// Helper: WIB today
function wibToday() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}

// Helper: classify lateness
function classifyLateness(waktuMinutes, shift, settings) {
  const batasTepat = shift === 1
    ? timeToMinutes(settings.shift1_batas_tepat_waktu || '09:00')
    : timeToMinutes(settings.shift2_batas_tepat_waktu || '15:00');
  const batasToleransi = shift === 1
    ? timeToMinutes(settings.shift1_batas_toleransi || '09:15')
    : timeToMinutes(settings.shift2_batas_toleransi || '15:15');

  if (waktuMinutes <= batasTepat) {
    return { status: 'tepat_waktu', menit_telat: 0 };
  } else if (waktuMinutes <= batasToleransi) {
    return { status: 'toleransi', menit_telat: waktuMinutes - batasTepat };
  } else {
    return { status: 'telat', menit_telat: waktuMinutes - batasTepat };
  }
}

// ══════════════════════════════════════════
// GET /api/keterlambatan?bulan=YYYY-MM&cabang_id=
// Laporan keterlambatan bulanan
// Management: semua data. Staff: hanya diri sendiri.
// ══════════════════════════════════════════
router.get('/', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
    const s = await getSettings();
    const isManagement = MANAGEMENT.includes(req.user.role);

    let cabangWhere = '';
    const params = [];

    if (!isManagement) {
      // Staff only sees own data
      cabangWhere = 'AND u.id=?';
      params.push(req.user.id);
    } else if (req.query.cabang_id) {
      cabangWhere = 'AND u.cabang_id=?';
      params.push(parseInt(req.query.cabang_id));
    }

    // Get employees
    const [users] = await db.query(`
      SELECT u.id, u.nama_lengkap, u.role, u.cabang_id, c.nama as nama_cabang, c.kode
      FROM users u LEFT JOIN cabang c ON c.id=u.cabang_id
      WHERE u.aktif=1 AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang') ${cabangWhere}
      ORDER BY c.kode, u.nama_lengkap`, params);

    if (!users.length) return res.json({ success: true, data: [], summary: {}, bulan });

    const userIds = users.map(u => u.id);
    const ph = userIds.map(() => '?').join(',');

    // Fetch all clock-in records for the month
    const [logs] = await db.query(`
      SELECT user_id, tanggal, waktu
      FROM absensi_log
      WHERE user_id IN (${ph}) AND DATE_FORMAT(tanggal,'%Y-%m')=? AND tipe='masuk'
      ORDER BY user_id, tanggal`, [...userIds, bulan]);

    // Classify each clock-in
    const userDataMap = {};
    users.forEach(u => {
      userDataMap[u.id] = {
        user_id: u.id,
        nama: u.nama_lengkap,
        role: u.role,
        cabang_id: u.cabang_id,
        nama_cabang: u.nama_cabang,
        kode_cabang: u.kode,
        total_hadir: 0,
        tepat_waktu_count: 0,
        toleransi_count: 0,
        telat_count: 0,
        total_menit_telat: 0,
        detail: []
      };
    });

    logs.forEach(l => {
      const uid = l.user_id;
      const tgl = l.tanggal instanceof Date ? l.tanggal.toISOString().slice(0, 10) : String(l.tanggal);
      const waktuMin = timeToMinutes(l.waktu);

      // Detect shift: clock_in < 12:00 = shift 1, else shift 2
      const shift = waktuMin < 720 ? 1 : 2;
      const { status, menit_telat } = classifyLateness(waktuMin, shift, s);

      const ud = userDataMap[uid];
      if (!ud) return;

      ud.total_hadir++;
      if (status === 'tepat_waktu') ud.tepat_waktu_count++;
      else if (status === 'toleransi') ud.toleransi_count++;
      else {
        ud.telat_count++;
        ud.total_menit_telat += menit_telat;
      }

      ud.detail.push({
        tanggal: tgl,
        waktu: String(l.waktu),
        shift,
        status,
        menit_telat
      });
    });

    const data = Object.values(userDataMap).filter(d => d.total_hadir > 0);

    // Summary
    const totalStaff = data.length;
    const totalTelat = data.reduce((sum, d) => sum + d.telat_count, 0);
    const totalMenitTelat = data.reduce((sum, d) => sum + d.total_menit_telat, 0);
    const avgKeterlambatan = totalTelat > 0 ? Math.round(totalMenitTelat / totalTelat) : 0;

    // Worst offenders top 5
    const worstOffenders = [...data]
      .sort((a, b) => b.telat_count - a.telat_count || b.total_menit_telat - a.total_menit_telat)
      .slice(0, 5)
      .filter(d => d.telat_count > 0)
      .map(d => ({
        nama: d.nama,
        cabang: d.nama_cabang,
        telat_count: d.telat_count,
        total_menit_telat: d.total_menit_telat
      }));

    res.json({
      success: true,
      data,
      summary: {
        total_staff: totalStaff,
        total_telat,
        total_menit_telat: totalMenitTelat,
        avg_keterlambatan_menit: avgKeterlambatan,
        worst_offenders: worstOffenders
      },
      bulan,
      setting: {
        shift1_batas_tepat_waktu: s.shift1_batas_tepat_waktu || '09:00',
        shift1_batas_toleransi: s.shift1_batas_toleransi || '09:15',
        shift2_batas_tepat_waktu: s.shift2_batas_tepat_waktu || '15:00',
        shift2_batas_toleransi: s.shift2_batas_toleransi || '15:15'
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
// GET /api/keterlambatan/hari-ini
// Quick view: siapa telat, siapa tepat waktu hari ini
// Management: semua. Staff: diri sendiri.
// ══════════════════════════════════════════
router.get('/hari-ini', auth(), async (req, res) => {
  try {
    const today = wibToday();
    const s = await getSettings();
    const isManagement = MANAGEMENT.includes(req.user.role);

    let whereExtra = '';
    const params = [today];
    if (!isManagement) {
      whereExtra = 'AND l.user_id=?';
      params.push(req.user.id);
    } else if (req.query.cabang_id) {
      whereExtra = 'AND u.cabang_id=?';
      params.push(parseInt(req.query.cabang_id));
    }

    const [logs] = await db.query(`
      SELECT l.user_id, l.waktu, l.cabang_id,
             u.nama_lengkap, u.role, c.nama as nama_cabang, c.kode
      FROM absensi_log l
      JOIN users u ON u.id=l.user_id
      LEFT JOIN cabang c ON c.id=l.cabang_id
      WHERE l.tanggal=? AND l.tipe='masuk' AND u.aktif=1 ${whereExtra}
      ORDER BY l.waktu`, params);

    const result = logs.map(l => {
      const waktuMin = timeToMinutes(l.waktu);
      const shift = waktuMin < 720 ? 1 : 2;
      const { status, menit_telat } = classifyLateness(waktuMin, shift, s);

      return {
        user_id: l.user_id,
        nama: l.nama_lengkap,
        role: l.role,
        cabang: l.nama_cabang,
        kode_cabang: l.kode,
        waktu: String(l.waktu),
        shift,
        status,
        menit_telat
      };
    });

    const tepat   = result.filter(r => r.status === 'tepat_waktu');
    const toleransi = result.filter(r => r.status === 'toleransi');
    const telat   = result.filter(r => r.status === 'telat');

    res.json({
      success: true,
      data: result,
      summary: {
        total: result.length,
        tepat_waktu: tepat.length,
        toleransi: toleransi.length,
        telat: telat.length
      },
      tanggal: today
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
