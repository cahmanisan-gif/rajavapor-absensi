const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

const MANAGEMENT = ['owner', 'manajer', 'head_operational', 'admin_pusat', 'spv_area', 'manajer_area'];

// GET /api/rekap/bulanan?bulan=YYYY-MM&cabang_id=
router.get('/bulanan', auth(MANAGEMENT), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
    const [y, m] = bulan.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    let cabangWhere = '';
    const params = [bulan];
    if (req.query.cabang_id) {
      cabangWhere = 'AND u.cabang_id=?';
      params.push(parseInt(req.query.cabang_id));
    }

    // Semua karyawan toko aktif
    const [users] = await db.query(`
      SELECT u.id, u.nama_lengkap, u.role, u.cabang_id, c.nama as nama_cabang, c.kode
      FROM users u LEFT JOIN cabang c ON c.id=u.cabang_id
      WHERE u.aktif=1 AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang') ${cabangWhere}
      ORDER BY c.kode, u.nama_lengkap`, params.slice(1));

    if (!users.length) return res.json({ success: true, data: [], bulan });

    const userIds = users.map(u => u.id);
    const ph = userIds.map(() => '?').join(',');

    // Absensi log bulan ini
    const [logs] = await db.query(`
      SELECT user_id, tanggal, tipe, waktu, valid
      FROM absensi_log
      WHERE user_id IN (${ph}) AND DATE_FORMAT(tanggal,'%Y-%m')=?
      ORDER BY tanggal, tipe`, [...userIds, bulan]);

    // Group per user
    const logMap = {};
    logs.forEach(l => {
      const uid = l.user_id;
      if (!logMap[uid]) logMap[uid] = {};
      const tgl = l.tanggal instanceof Date ? l.tanggal.toISOString().slice(0, 10) : String(l.tanggal);
      if (!logMap[uid][tgl]) logMap[uid][tgl] = {};
      logMap[uid][tgl][l.tipe] = l.waktu;
    });

    // Izin approved bulan ini
    const [izinList] = await db.query(`
      SELECT user_id, tipe, dari_tanggal, sampai_tanggal, jumlah_hari
      FROM absensi_izin
      WHERE user_id IN (${ph}) AND status='approved'
        AND (DATE_FORMAT(dari_tanggal,'%Y-%m')=? OR DATE_FORMAT(sampai_tanggal,'%Y-%m')=?)`,
      [...userIds, bulan, bulan]);

    const izinMap = {};
    izinList.forEach(iz => {
      if (!izinMap[iz.user_id]) izinMap[iz.user_id] = { izin: 0, sakit: 0, cuti: 0 };
      izinMap[iz.user_id][iz.tipe] += iz.jumlah_hari;
    });

    // Hitung hari kerja (exclude Minggu)
    let hariKerja = 0;
    const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(y, m - 1, d);
      const tgl = `${bulan}-${String(d).padStart(2, '0')}`;
      if (tgl > today) break;
      if (dt.getDay() !== 0) hariKerja++; // skip Minggu
    }

    const data = users.map(u => {
      const userLog = logMap[u.id] || {};
      const hadir = Object.keys(userLog).filter(tgl => userLog[tgl].masuk).length;
      const telat = 0; // TODO: hitung berdasarkan jam masuk vs setting
      const iz = izinMap[u.id] || { izin: 0, sakit: 0, cuti: 0 };
      const alpha = Math.max(0, hariKerja - hadir - iz.izin - iz.sakit - iz.cuti);

      return {
        user_id: u.id,
        nama: u.nama_lengkap,
        role: u.role,
        cabang_id: u.cabang_id,
        nama_cabang: u.nama_cabang,
        kode_cabang: u.kode,
        hadir,
        telat,
        izin: iz.izin,
        sakit: iz.sakit,
        cuti: iz.cuti,
        alpha,
        hari_kerja: hariKerja
      };
    });

    const summary = {
      total_karyawan: data.length,
      rata_hadir: data.length ? Math.round(data.reduce((s, d) => s + d.hadir, 0) / data.length * 10) / 10 : 0,
      total_alpha: data.reduce((s, d) => s + d.alpha, 0),
      hari_kerja: hariKerja
    };

    res.json({ success: true, data, summary, bulan });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/rekap/harian?tanggal=YYYY-MM-DD&cabang_id=
router.get('/harian', auth(MANAGEMENT), async (req, res) => {
  try {
    const tanggal = req.query.tanggal || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

    let cabangWhere = '';
    const params = [];
    if (req.query.cabang_id) {
      cabangWhere = 'AND u.cabang_id=?';
      params.push(parseInt(req.query.cabang_id));
    }

    const [users] = await db.query(`
      SELECT u.id, u.nama_lengkap, u.role, u.cabang_id, c.nama as nama_cabang, c.kode
      FROM users u LEFT JOIN cabang c ON c.id=u.cabang_id
      WHERE u.aktif=1 AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang') ${cabangWhere}
      ORDER BY c.kode, u.nama_lengkap`, params);

    const userIds = users.map(u => u.id);
    if (!userIds.length) return res.json({ success: true, data: [], tanggal });

    const ph = userIds.map(() => '?').join(',');
    const [logs] = await db.query(`
      SELECT user_id, tipe, waktu, foto_url, jarak_meter, valid
      FROM absensi_log WHERE user_id IN (${ph}) AND tanggal=?
      ORDER BY tipe`, [...userIds, tanggal]);

    const logMap = {};
    logs.forEach(l => {
      if (!logMap[l.user_id]) logMap[l.user_id] = {};
      logMap[l.user_id][l.tipe] = l;
    });

    // Izin hari ini
    const [izinList] = await db.query(`
      SELECT user_id, tipe FROM absensi_izin
      WHERE user_id IN (${ph}) AND ?>=dari_tanggal AND ?<=sampai_tanggal AND status='approved'`,
      [...userIds, tanggal, tanggal]);
    const izinMap = {};
    izinList.forEach(iz => { izinMap[iz.user_id] = iz.tipe; });

    const data = users.map(u => {
      const log = logMap[u.id] || {};
      let status = 'alpha';
      if (izinMap[u.id]) status = izinMap[u.id];
      else if (log.pulang) status = 'pulang';
      else if (log.masuk) status = 'hadir';

      return {
        user_id: u.id,
        nama: u.nama_lengkap,
        role: u.role,
        cabang_id: u.cabang_id,
        nama_cabang: u.nama_cabang,
        status,
        masuk: log.masuk ? { waktu: log.masuk.waktu, foto: log.masuk.foto_url, jarak: log.masuk.jarak_meter } : null,
        pulang: log.pulang ? { waktu: log.pulang.waktu, foto: log.pulang.foto_url, jarak: log.pulang.jarak_meter } : null,
      };
    });

    const hadir  = data.filter(d => ['hadir', 'pulang'].includes(d.status)).length;
    const alpha  = data.filter(d => d.status === 'alpha').length;

    res.json({ success: true, data, summary: { total: data.length, hadir, alpha }, tanggal });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/rekap/cabang?bulan=YYYY-MM — summary per cabang
router.get('/cabang', auth(MANAGEMENT), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);

    const [rows] = await db.query(`
      SELECT c.id, c.kode, c.nama,
             COUNT(DISTINCT l.user_id) as total_karyawan,
             COUNT(DISTINCT CONCAT(l.user_id, '_', l.tanggal)) as total_hadir_hari,
             COUNT(DISTINCT l.tanggal) as hari_ada_absensi
      FROM cabang c
      LEFT JOIN absensi_log l ON l.cabang_id=c.id AND l.tipe='masuk' AND DATE_FORMAT(l.tanggal,'%Y-%m')=?
      WHERE c.aktif=1
      GROUP BY c.id, c.kode, c.nama
      ORDER BY c.kode`, [bulan]);

    res.json({ success: true, data: rows, bulan });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
