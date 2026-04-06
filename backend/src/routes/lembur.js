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

// Helper: parse time "HH:MM:SS" or "HH:MM" to total minutes
function timeToMinutes(t) {
  if (!t) return 0;
  const str = typeof t === 'string' ? t : String(t);
  const parts = str.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// ══════════════════════════════════════════
// GET /api/lembur/hitung?bulan=YYYY-MM&cabang_id=
// Auto-calculate lembur from absensi_log
// ══════════════════════════════════════════
router.get('/hitung', auth(MANAGEMENT), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
    const s = await getSettings();

    const shift1NormalPulang = timeToMinutes(s.shift1_jam_normal_pulang || '17:00');
    const shift2NormalPulang = timeToMinutes(s.shift2_jam_normal_pulang || '22:00');
    const lemburMinimum     = parseInt(s.lembur_minimum_menit || '60');

    let cabangWhere = '';
    const params = [];
    if (req.query.cabang_id) {
      cabangWhere = 'AND u.cabang_id=?';
      params.push(parseInt(req.query.cabang_id));
    }

    // Get all active shop employees
    const [users] = await db.query(`
      SELECT u.id, u.nama_lengkap, u.role, u.cabang_id, c.nama as nama_cabang, c.kode
      FROM users u LEFT JOIN cabang c ON c.id=u.cabang_id
      WHERE u.aktif=1 AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang') ${cabangWhere}
      ORDER BY c.kode, u.nama_lengkap`, params);

    if (!users.length) return res.json({ success: true, data: [], bulan });

    const userIds = users.map(u => u.id);
    const ph = userIds.map(() => '?').join(',');

    // Fetch all clock-in and clock-out for the month
    const [logs] = await db.query(`
      SELECT user_id, tanggal, tipe, waktu
      FROM absensi_log
      WHERE user_id IN (${ph}) AND DATE_FORMAT(tanggal,'%Y-%m')=?
      ORDER BY user_id, tanggal, tipe`, [...userIds, bulan]);

    // Group logs per user per day
    const logMap = {};
    logs.forEach(l => {
      const uid = l.user_id;
      const tgl = l.tanggal instanceof Date ? l.tanggal.toISOString().slice(0, 10) : String(l.tanggal);
      if (!logMap[uid]) logMap[uid] = {};
      if (!logMap[uid][tgl]) logMap[uid][tgl] = {};
      logMap[uid][tgl][l.tipe] = l.waktu;
    });

    const data = users.map(u => {
      const userLog = logMap[u.id] || {};
      const detail = [];
      let totalHariLembur = 0;
      let totalMenitLembur = 0;

      Object.keys(userLog).sort().forEach(tgl => {
        const day = userLog[tgl];
        if (!day.masuk || !day.pulang) return; // need both clock-in and clock-out

        const clockInMin  = timeToMinutes(day.masuk);
        const clockOutMin = timeToMinutes(day.pulang);

        // Detect shift: clock_in < 12:00 (720 min) = shift 1, else shift 2
        const shift = clockInMin < 720 ? 1 : 2;
        const normalPulang = shift === 1 ? shift1NormalPulang : shift2NormalPulang;

        // Calculate overtime
        const overtime = clockOutMin - normalPulang;
        if (overtime >= lemburMinimum) {
          totalHariLembur++;
          totalMenitLembur += overtime;
          detail.push({
            tanggal: tgl,
            clock_in: String(day.masuk),
            clock_out: String(day.pulang),
            shift,
            menit_lembur: overtime
          });
        }
      });

      return {
        user_id: u.id,
        nama: u.nama_lengkap,
        role: u.role,
        cabang_id: u.cabang_id,
        nama_cabang: u.nama_cabang,
        kode_cabang: u.kode,
        total_hari_lembur: totalHariLembur,
        total_menit_lembur: totalMenitLembur,
        detail
      };
    });

    // Only return users who have overtime
    const filtered = data.filter(d => d.total_hari_lembur > 0);

    res.json({
      success: true,
      data: filtered,
      bulan,
      setting: {
        shift1_normal_pulang: s.shift1_jam_normal_pulang || '17:00',
        shift2_normal_pulang: s.shift2_jam_normal_pulang || '22:00',
        lembur_minimum_menit: lemburMinimum
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
// GET /api/lembur/summary?bulan=YYYY-MM
// Summary: total karyawan lembur, total jam, per cabang
// ══════════════════════════════════════════
router.get('/summary', auth(MANAGEMENT), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
    const s = await getSettings();

    const shift1NormalPulang = timeToMinutes(s.shift1_jam_normal_pulang || '17:00');
    const shift2NormalPulang = timeToMinutes(s.shift2_jam_normal_pulang || '22:00');
    const lemburMinimum     = parseInt(s.lembur_minimum_menit || '60');

    // Get all clock-in/out pairs for the month
    const [logs] = await db.query(`
      SELECT l.user_id, l.cabang_id, l.tanggal, l.tipe, l.waktu,
             u.nama_lengkap, c.nama as nama_cabang, c.kode
      FROM absensi_log l
      JOIN users u ON u.id=l.user_id
      LEFT JOIN cabang c ON c.id=l.cabang_id
      WHERE DATE_FORMAT(l.tanggal,'%Y-%m')=?
        AND u.aktif=1
        AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')
      ORDER BY l.user_id, l.tanggal, l.tipe`, [bulan]);

    // Group per user per day
    const logMap = {};
    logs.forEach(l => {
      const uid = l.user_id;
      const tgl = l.tanggal instanceof Date ? l.tanggal.toISOString().slice(0, 10) : String(l.tanggal);
      if (!logMap[uid]) logMap[uid] = { cabang_id: l.cabang_id, nama_cabang: l.nama_cabang, kode: l.kode, nama: l.nama_lengkap, days: {} };
      if (!logMap[uid].days[tgl]) logMap[uid].days[tgl] = {};
      logMap[uid].days[tgl][l.tipe] = l.waktu;
    });

    let totalKaryawanLembur = 0;
    let totalMenitLembur = 0;
    const perCabang = {};

    Object.keys(logMap).forEach(uid => {
      const user = logMap[uid];
      let userLembur = 0;

      Object.keys(user.days).forEach(tgl => {
        const day = user.days[tgl];
        if (!day.masuk || !day.pulang) return;

        const clockInMin  = timeToMinutes(day.masuk);
        const clockOutMin = timeToMinutes(day.pulang);
        const shift = clockInMin < 720 ? 1 : 2;
        const normalPulang = shift === 1 ? shift1NormalPulang : shift2NormalPulang;
        const overtime = clockOutMin - normalPulang;

        if (overtime >= lemburMinimum) {
          userLembur += overtime;
        }
      });

      if (userLembur > 0) {
        totalKaryawanLembur++;
        totalMenitLembur += userLembur;

        const cabKey = user.cabang_id || 0;
        if (!perCabang[cabKey]) {
          perCabang[cabKey] = { cabang_id: user.cabang_id, nama_cabang: user.nama_cabang, kode: user.kode, karyawan: 0, total_menit: 0 };
        }
        perCabang[cabKey].karyawan++;
        perCabang[cabKey].total_menit += userLembur;
      }
    });

    const cabangList = Object.values(perCabang).sort((a, b) => (a.kode || '').localeCompare(b.kode || ''));
    cabangList.forEach(c => { c.total_jam = Math.round(c.total_menit / 60 * 10) / 10; });

    res.json({
      success: true,
      data: {
        total_karyawan_lembur: totalKaryawanLembur,
        total_menit_lembur: totalMenitLembur,
        total_jam_lembur: Math.round(totalMenitLembur / 60 * 10) / 10,
        per_cabang: cabangList
      },
      bulan
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
