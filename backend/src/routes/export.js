const express  = require('express');
const router   = express.Router();
const db       = require('../config/database');
const auth     = require('../middleware/auth');
const XLSX     = require('xlsx');
const PDFDocument = require('pdfkit');

const MANAGEMENT = ['owner', 'manajer', 'head_operational', 'admin_pusat', 'spv_area', 'manajer_area'];

// Helper: time string to minutes
function timeToMinutes(t) {
  if (!t) return 0;
  const str = typeof t === 'string' ? t : String(t);
  const parts = str.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// Helper: fetch full rekap data for a month + optional cabang
async function fetchRekapData(bulan, cabangId) {
  const [y, m] = bulan.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();

  // Settings for lembur
  const [settingRows] = await db.query('SELECT key_name, value FROM absensi_setting');
  const s = {};
  settingRows.forEach(r => { s[r.key_name] = r.value; });

  const shift1NormalPulang = timeToMinutes(s.shift1_jam_normal_pulang || '17:00');
  const shift2NormalPulang = timeToMinutes(s.shift2_jam_normal_pulang || '22:00');
  const lemburMinimum     = parseInt(s.lembur_minimum_menit || '60');

  let cabangWhere = '';
  const params = [];
  if (cabangId) {
    cabangWhere = 'AND u.cabang_id=?';
    params.push(parseInt(cabangId));
  }

  // Get employees
  const [users] = await db.query(`
    SELECT u.id, u.nama_lengkap, u.role, u.cabang_id, c.nama as nama_cabang, c.kode
    FROM users u LEFT JOIN cabang c ON c.id=u.cabang_id
    WHERE u.aktif=1 AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang') ${cabangWhere}
    ORDER BY c.kode, u.nama_lengkap`, params);

  if (!users.length) return { users: [], rekap: [], detail: [], bulan, hariKerja: 0 };

  const userIds = users.map(u => u.id);
  const ph = userIds.map(() => '?').join(',');

  // Attendance logs
  const [logs] = await db.query(`
    SELECT user_id, tanggal, tipe, waktu, jarak_meter, valid
    FROM absensi_log
    WHERE user_id IN (${ph}) AND DATE_FORMAT(tanggal,'%Y-%m')=?
    ORDER BY tanggal, user_id, tipe`, [...userIds, bulan]);

  // Group logs
  const logMap = {};
  logs.forEach(l => {
    const uid = l.user_id;
    const tgl = l.tanggal instanceof Date ? l.tanggal.toISOString().slice(0, 10) : String(l.tanggal);
    if (!logMap[uid]) logMap[uid] = {};
    if (!logMap[uid][tgl]) logMap[uid][tgl] = {};
    logMap[uid][tgl][l.tipe] = l;
  });

  // Izin
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

  // Working days (exclude Sunday)
  let hariKerja = 0;
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(y, m - 1, d);
    const tgl = `${bulan}-${String(d).padStart(2, '0')}`;
    if (tgl > today) break;
    if (dt.getDay() !== 0) hariKerja++;
  }

  // Build rekap per user
  const rekap = users.map(u => {
    const userLog = logMap[u.id] || {};
    const hadir = Object.keys(userLog).filter(tgl => userLog[tgl].masuk).length;
    const iz = izinMap[u.id] || { izin: 0, sakit: 0, cuti: 0 };
    const alpha = Math.max(0, hariKerja - hadir - iz.izin - iz.sakit - iz.cuti);

    // Lembur calculation
    let lemburHari = 0;
    Object.keys(userLog).forEach(tgl => {
      const day = userLog[tgl];
      if (!day.masuk || !day.pulang) return;
      const clockInMin  = timeToMinutes(day.masuk.waktu);
      const clockOutMin = timeToMinutes(day.pulang.waktu);
      const shift = clockInMin < 720 ? 1 : 2;
      const normalPulang = shift === 1 ? shift1NormalPulang : shift2NormalPulang;
      if ((clockOutMin - normalPulang) >= lemburMinimum) lemburHari++;
    });

    return {
      nama: u.nama_lengkap,
      cabang: u.nama_cabang || '-',
      kode_cabang: u.kode || '-',
      role: u.role,
      hadir,
      izin: iz.izin,
      sakit: iz.sakit,
      cuti: iz.cuti,
      alpha,
      lembur_hari: lemburHari,
      hari_kerja: hariKerja
    };
  });

  // Build detail harian
  const detail = [];
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u; });

  logs.forEach(l => {
    if (l.tipe !== 'masuk') return; // one row per day, start from masuk
    const uid = l.user_id;
    const tgl = l.tanggal instanceof Date ? l.tanggal.toISOString().slice(0, 10) : String(l.tanggal);
    const u = userMap[uid];
    const dayLog = logMap[uid]?.[tgl] || {};

    let status = 'hadir';
    // Check izin for this user on this day
    const userIzin = izinList.find(iz =>
      iz.user_id === uid &&
      tgl >= (iz.dari_tanggal instanceof Date ? iz.dari_tanggal.toISOString().slice(0, 10) : String(iz.dari_tanggal)) &&
      tgl <= (iz.sampai_tanggal instanceof Date ? iz.sampai_tanggal.toISOString().slice(0, 10) : String(iz.sampai_tanggal))
    );
    if (userIzin) status = userIzin.tipe;
    else if (dayLog.pulang) status = 'hadir+pulang';

    detail.push({
      tanggal: tgl,
      nama: u ? u.nama_lengkap : '-',
      cabang: u ? (u.nama_cabang || '-') : '-',
      clock_in: dayLog.masuk ? String(dayLog.masuk.waktu) : '-',
      clock_out: dayLog.pulang ? String(dayLog.pulang.waktu) : '-',
      status,
      jarak: dayLog.masuk ? (dayLog.masuk.jarak_meter != null ? dayLog.masuk.jarak_meter + 'm' : '-') : '-'
    });
  });

  detail.sort((a, b) => a.tanggal.localeCompare(b.tanggal) || a.nama.localeCompare(b.nama));

  return { users, rekap, detail, bulan, hariKerja };
}

// ══════════════════════════════════════════
// GET /api/export/rekap-excel?bulan=YYYY-MM&cabang_id=
// ══════════════════════════════════════════
router.get('/rekap-excel', auth(MANAGEMENT), async (req, res) => {
  try {
    const bulan    = req.query.bulan || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
    const cabangId = req.query.cabang_id || null;

    const { rekap, detail, hariKerja } = await fetchRekapData(bulan, cabangId);

    // Sheet 1: Rekap per karyawan
    const sheet1Data = [
      ['Rekap Absensi Raja Vapor', '', '', '', '', '', '', '', '', ''],
      ['Periode: ' + bulan, '', 'Hari Kerja: ' + hariKerja],
      [],
      ['No', 'Nama', 'Cabang', 'Role', 'Hadir', 'Izin', 'Sakit', 'Cuti', 'Alpha', 'Lembur (hari)']
    ];
    rekap.forEach((r, i) => {
      sheet1Data.push([i + 1, r.nama, r.cabang, r.role, r.hadir, r.izin, r.sakit, r.cuti, r.alpha, r.lembur_hari]);
    });

    // Sheet 2: Detail harian
    const sheet2Data = [
      ['Detail Absensi Harian — ' + bulan],
      [],
      ['No', 'Tanggal', 'Nama', 'Cabang', 'Clock In', 'Clock Out', 'Status', 'Jarak']
    ];
    detail.forEach((d, i) => {
      sheet2Data.push([i + 1, d.tanggal, d.nama, d.cabang, d.clock_in, d.clock_out, d.status, d.jarak]);
    });

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
    const ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);

    // Set column widths
    ws1['!cols'] = [{ wch: 4 }, { wch: 25 }, { wch: 20 }, { wch: 16 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 12 }];
    ws2['!cols'] = [{ wch: 4 }, { wch: 12 }, { wch: 25 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 8 }];

    XLSX.utils.book_append_sheet(wb, ws1, 'Rekap');
    XLSX.utils.book_append_sheet(wb, ws2, 'Detail');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = `rekap_absensi_${bulan}${cabangId ? '_cab' + cabangId : ''}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
// GET /api/export/rekap-pdf?bulan=YYYY-MM&cabang_id=
// ══════════════════════════════════════════
router.get('/rekap-pdf', auth(MANAGEMENT), async (req, res) => {
  try {
    const bulan    = req.query.bulan || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
    const cabangId = req.query.cabang_id || null;

    const { rekap, hariKerja } = await fetchRekapData(bulan, cabangId);

    const filename = `rekap_absensi_${bulan}${cabangId ? '_cab' + cabangId : ''}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/pdf');

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    doc.pipe(res);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').text('Raja Vapor - Rekap Absensi', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').text(`Periode: ${bulan}   |   Hari Kerja: ${hariKerja}`, { align: 'center' });
    doc.moveDown(1);

    // Table header
    const cols = [
      { label: 'No', width: 30 },
      { label: 'Nama', width: 140 },
      { label: 'Cabang', width: 120 },
      { label: 'Role', width: 90 },
      { label: 'Hadir', width: 45 },
      { label: 'Izin', width: 40 },
      { label: 'Sakit', width: 45 },
      { label: 'Cuti', width: 40 },
      { label: 'Alpha', width: 45 },
      { label: 'Lembur', width: 50 }
    ];

    const tableLeft = 40;
    let y = doc.y;
    const rowHeight = 20;

    // Draw header row
    doc.font('Helvetica-Bold').fontSize(9);
    let x = tableLeft;
    cols.forEach(col => {
      doc.rect(x, y, col.width, rowHeight).stroke();
      doc.text(col.label, x + 3, y + 5, { width: col.width - 6, align: 'center' });
      x += col.width;
    });
    y += rowHeight;

    // Draw data rows
    doc.font('Helvetica').fontSize(8);
    rekap.forEach((r, i) => {
      // Check page overflow
      if (y + rowHeight > doc.page.height - 40) {
        doc.addPage({ layout: 'landscape' });
        y = 40;
      }

      const rowData = [i + 1, r.nama, r.cabang, r.role, r.hadir, r.izin, r.sakit, r.cuti, r.alpha, r.lembur_hari];
      x = tableLeft;
      cols.forEach((col, ci) => {
        doc.rect(x, y, col.width, rowHeight).stroke();
        const align = ci <= 3 ? 'left' : 'center';
        doc.text(String(rowData[ci]), x + 3, y + 6, { width: col.width - 6, align });
        x += col.width;
      });
      y += rowHeight;
    });

    // Footer
    doc.moveDown(1);
    const now = new Date(Date.now() + 7 * 3600000);
    doc.fontSize(8).text(`Dicetak: ${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)} WIB`, tableLeft);

    doc.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
});

module.exports = router;
