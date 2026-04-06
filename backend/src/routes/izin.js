const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const UPLOAD_DIR = path.join(process.env.UPLOAD_PATH || '/var/www/rajavapor-absensi/uploads', 'izin');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `izin_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/izin — list izin (user lihat milik sendiri, management lihat semua)
router.get('/', auth(), async (req, res) => {
  try {
    const isManagement = ['owner', 'manajer', 'head_operational', 'admin_pusat', 'spv_area'].includes(req.user.role);
    let where = '1=1';
    const params = [];

    if (!isManagement) { where += ' AND i.user_id=?'; params.push(req.user.id); }
    if (req.query.status) { where += ' AND i.status=?'; params.push(req.query.status); }
    if (req.query.bulan) { where += " AND DATE_FORMAT(i.dari_tanggal,'%Y-%m')=?"; params.push(req.query.bulan); }
    if (req.query.cabang_id) { where += ' AND i.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }

    const [rows] = await db.query(`
      SELECT i.*, u.nama_lengkap, c.nama as nama_cabang,
             ua.nama_lengkap as nama_approver
      FROM absensi_izin i
      LEFT JOIN users u ON u.id=i.user_id
      LEFT JOIN cabang c ON c.id=i.cabang_id
      LEFT JOIN users ua ON ua.id=i.approved_by
      WHERE ${where} ORDER BY i.created_at DESC LIMIT 200`, params);

    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/izin — ajukan izin/sakit/cuti
router.post('/', auth(), upload.single('bukti'), async (req, res) => {
  try {
    const { tipe, dari_tanggal, sampai_tanggal, alasan } = req.body;
    if (!tipe || !dari_tanggal || !sampai_tanggal) {
      return res.status(400).json({ success: false, message: 'Tipe, dari_tanggal, sampai_tanggal wajib.' });
    }

    const d1 = new Date(dari_tanggal);
    const d2 = new Date(sampai_tanggal);
    const jumlahHari = Math.max(1, Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);

    const buktiUrl = req.file ? 'izin/' + req.file.filename : null;

    await db.query(
      `INSERT INTO absensi_izin (user_id, cabang_id, tipe, dari_tanggal, sampai_tanggal, jumlah_hari, alasan, bukti_url)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.id, req.user.cabang_id || null, tipe, dari_tanggal, sampai_tanggal, jumlahHari, alasan || '', buktiUrl]);

    res.json({ success: true, message: `Pengajuan ${tipe} berhasil dikirim (${jumlahHari} hari). Menunggu approval.` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/izin/:id/approve
router.patch('/:id/approve', auth(['owner', 'manajer', 'head_operational', 'admin_pusat', 'spv_area']), async (req, res) => {
  try {
    const { catatan_review } = req.body;
    await db.query(
      `UPDATE absensi_izin SET status='approved', approved_by=?, catatan_review=? WHERE id=? AND status='pending'`,
      [req.user.id, catatan_review || null, req.params.id]);

    // Sinkron ke absensi_hari_ini untuk setiap hari izin
    const [[izin]] = await db.query('SELECT * FROM absensi_izin WHERE id=?', [req.params.id]);
    if (izin) {
      const d1 = new Date(izin.dari_tanggal);
      const d2 = new Date(izin.sampai_tanggal);
      for (let dt = new Date(d1); dt <= d2; dt.setDate(dt.getDate() + 1)) {
        const tgl = dt.toISOString().slice(0, 10);
        await db.query(
          `INSERT INTO absensi_hari_ini (user_id, personnel_id, tanggal, status)
           VALUES (?, (SELECT personnel_id FROM users WHERE id=?), ?, ?)
           ON DUPLICATE KEY UPDATE status=VALUES(status)`,
          [izin.user_id, izin.user_id, tgl, izin.tipe === 'sakit' ? 'tidak_hadir' : 'tidak_hadir']);
      }
    }

    res.json({ success: true, message: 'Izin disetujui.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/izin/:id/reject
router.patch('/:id/reject', auth(['owner', 'manajer', 'head_operational', 'admin_pusat', 'spv_area']), async (req, res) => {
  try {
    const { catatan_review } = req.body;
    await db.query(
      `UPDATE absensi_izin SET status='rejected', approved_by=?, catatan_review=? WHERE id=? AND status='pending'`,
      [req.user.id, catatan_review || null, req.params.id]);
    res.json({ success: true, message: 'Izin ditolak.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/izin/:id — hapus pengajuan (hanya pending & milik sendiri)
router.delete('/:id', auth(), async (req, res) => {
  try {
    const [[iz]] = await db.query('SELECT user_id, status FROM absensi_izin WHERE id=?', [req.params.id]);
    if (!iz) return res.status(404).json({ success: false, message: 'Tidak ditemukan.' });
    if (iz.status !== 'pending') return res.status(400).json({ success: false, message: 'Hanya pengajuan pending yang bisa dihapus.' });
    if (iz.user_id !== req.user.id && req.user.role !== 'owner')
      return res.status(403).json({ success: false, message: 'Bukan pengajuan Anda.' });
    await db.query('DELETE FROM absensi_izin WHERE id=?', [req.params.id]);
    res.json({ success: true, message: 'Pengajuan dihapus.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
