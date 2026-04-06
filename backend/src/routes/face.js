const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');
require('dotenv').config();

const UPLOAD_DIR = path.join(process.env.UPLOAD_PATH || '/var/www/rajavapor-absensi/uploads', 'face');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.memoryStorage();
const upload  = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ══════════════════════════════════════════
// GET /api/face/employees?cabang_id=X
// Daftar karyawan + foto wajah untuk face matching di APK
// ══════════════════════════════════════════
router.get('/employees', async (req, res) => {
  try {
    const cabangId = parseInt(req.query.cabang_id);
    if (!cabangId) return res.status(400).json({ success: false, message: 'cabang_id wajib.' });

    const [users] = await db.query(`
      SELECT u.id, u.nama_lengkap, u.username, u.role, u.cabang_id, u.personnel_id,
             c.nama as nama_cabang, c.kode as kode_cabang,
             fp.foto_url
      FROM users u
      LEFT JOIN cabang c ON c.id = u.cabang_id
      LEFT JOIN face_photo fp ON fp.user_id = u.id AND fp.is_primary = 1
      WHERE u.aktif = 1 AND u.cabang_id = ?
        AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')
      ORDER BY u.nama_lengkap`, [cabangId]);

    res.json({
      success: true,
      data: users.map(u => ({
        id: u.id,
        nama_lengkap: u.nama_lengkap,
        username: u.username,
        role: u.role,
        cabang_id: u.cabang_id,
        nama_cabang: u.nama_cabang,
        personnel_id: u.personnel_id,
        foto_url: u.foto_url ? '/uploads/' + u.foto_url : null
      }))
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
// POST /api/face/verify
// Verifikasi wajah → issue JWT token
// Body: multipart — foto (selfie), user_id
// APK melakukan face matching lokal, lalu kirim hasil ke sini
// ══════════════════════════════════════════
router.post('/verify', upload.single('foto'), async (req, res) => {
  try {
    const userId = parseInt(req.body.user_id);
    const confidence = parseFloat(req.body.confidence) || 0;

    if (!userId) return res.status(400).json({ success: false, message: 'user_id wajib.' });

    // Ambil data user
    const [[user]] = await db.query(`
      SELECT u.id, u.username, u.nama_lengkap, u.role, u.cabang_id, u.personnel_id,
             c.nama as nama_cabang
      FROM users u
      LEFT JOIN cabang c ON c.id = u.cabang_id
      WHERE u.id = ? AND u.aktif = 1`, [userId]);

    if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan atau tidak aktif.' });

    // Minimum confidence threshold (configurable)
    const MIN_CONFIDENCE = 0.6;
    if (confidence > 0 && confidence < MIN_CONFIDENCE) {
      return res.status(401).json({
        success: false,
        message: `Wajah tidak cocok (confidence: ${(confidence * 100).toFixed(0)}%). Coba lagi.`,
        confidence
      });
    }

    // Simpan foto verifikasi sebagai log (compress to WebP)
    let fotoUrl = null;
    if (req.file) {
      const filename = `verify_${userId}_${Date.now()}.webp`;
      const destPath = path.join(UPLOAD_DIR, filename);
      await sharp(req.file.buffer)
        .resize(240, 240, { fit: 'cover', position: 'centre' })
        .webp({ quality: 60 })
        .toFile(destPath);
      fotoUrl = 'face/' + filename;
    }

    // Generate JWT token (sama format dengan main API login)
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        cabang_id: user.cabang_id,
        personnel_id: user.personnel_id || null
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      message: `Login berhasil: ${user.nama_lengkap}`,
      token,
      user: {
        id: user.id,
        username: user.username,
        nama_lengkap: user.nama_lengkap,
        role: user.role,
        cabang_id: user.cabang_id,
        nama_cabang: user.nama_cabang,
        personnel_id: user.personnel_id || null
      },
      confidence
    });
  } catch (e) {
    console.error('face verify error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════
// POST /api/face/register — upload/update foto wajah karyawan
// Auth required (owner/admin or self)
// ══════════════════════════════════════════
router.post('/register', auth(), upload.single('foto'), async (req, res) => {
  try {
    const targetUserId = parseInt(req.body.user_id) || req.user.id;

    // Hanya owner/admin bisa register wajah orang lain
    if (targetUserId !== req.user.id && !['owner', 'admin_pusat', 'head_operational', 'manajer'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Tidak diizinkan.' });
    }

    if (!req.file) return res.status(400).json({ success: false, message: 'Foto wajib diupload.' });

    // Compress & save
    const filename = `face_${targetUserId}_${Date.now()}.webp`;
    const destPath = path.join(UPLOAD_DIR, filename);
    await sharp(req.file.buffer)
      .resize(480, 480, { fit: 'cover', position: 'centre' })
      .webp({ quality: 80 })
      .toFile(destPath);
    const fotoUrl = 'face/' + filename;

    // Hapus foto lama
    const [[old]] = await db.query('SELECT foto_url FROM face_photo WHERE user_id=? AND is_primary=1', [targetUserId]);
    if (old?.foto_url) {
      const oldPath = path.join(process.env.UPLOAD_PATH || '/var/www/rajavapor-absensi/uploads', old.foto_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    // Upsert
    await db.query(`INSERT INTO face_photo (user_id, foto_url, is_primary)
      VALUES (?, ?, 1)
      ON DUPLICATE KEY UPDATE foto_url=VALUES(foto_url)`, [targetUserId, fotoUrl]);

    const [[user]] = await db.query('SELECT nama_lengkap FROM users WHERE id=?', [targetUserId]);

    res.json({
      success: true,
      message: `Foto wajah ${user?.nama_lengkap || ''} berhasil disimpan.`,
      foto_url: '/uploads/' + fotoUrl
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
// POST /api/face/register-bulk — bulk upload foto wajah
// Auth: owner/admin
// Body JSON: { users: [{ user_id, foto_base64 }] }
// ══════════════════════════════════════════
router.post('/register-bulk', auth(['owner', 'admin_pusat', 'head_operational', 'manajer']), async (req, res) => {
  try {
    const { users } = req.body;
    if (!Array.isArray(users) || !users.length) {
      return res.status(400).json({ success: false, message: 'Array users wajib diisi.' });
    }

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const item of users) {
      try {
        const userId = parseInt(item.user_id);
        if (!userId || !item.foto_base64) {
          failedCount++;
          errors.push({ user_id: item.user_id, error: 'user_id atau foto_base64 kosong' });
          continue;
        }

        // Decode base64 — strip data URI prefix if present
        let b64 = item.foto_base64;
        if (b64.includes(',')) b64 = b64.split(',')[1];
        const buffer = Buffer.from(b64, 'base64');

        // Compress & save as WebP 480x480
        const filename = `face_${userId}_${Date.now()}.webp`;
        const destPath = path.join(UPLOAD_DIR, filename);
        await sharp(buffer)
          .resize(480, 480, { fit: 'cover', position: 'centre' })
          .webp({ quality: 80 })
          .toFile(destPath);
        const fotoUrl = 'face/' + filename;

        // Hapus foto lama
        const [[old]] = await db.query('SELECT foto_url FROM face_photo WHERE user_id=? AND is_primary=1', [userId]);
        if (old?.foto_url) {
          const oldPath = path.join(process.env.UPLOAD_PATH || '/var/www/rajavapor-absensi/uploads', old.foto_url);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        // Upsert face_photo
        await db.query(`INSERT INTO face_photo (user_id, foto_url, is_primary)
          VALUES (?, ?, 1)
          ON DUPLICATE KEY UPDATE foto_url=VALUES(foto_url)`, [userId, fotoUrl]);

        successCount++;
      } catch (itemErr) {
        failedCount++;
        errors.push({ user_id: item.user_id, error: itemErr.message });
      }
    }

    res.json({
      success: true,
      message: `Bulk register selesai: ${successCount} berhasil, ${failedCount} gagal.`,
      data: { success: successCount, failed: failedCount, errors: errors.length ? errors : undefined }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
// GET /api/face/status?cabang_id=X — status foto wajah per user di cabang
// ══════════════════════════════════════════
router.get('/status', async (req, res) => {
  try {
    const cabangId = parseInt(req.query.cabang_id);
    if (!cabangId) return res.status(400).json({ success: false, message: 'cabang_id wajib.' });

    const [rows] = await db.query(`
      SELECT u.id as user_id, u.nama_lengkap, u.username, u.role,
             CASE WHEN fp.foto_url IS NOT NULL THEN 1 ELSE 0 END as has_photo,
             fp.foto_url
      FROM users u
      LEFT JOIN face_photo fp ON fp.user_id = u.id AND fp.is_primary = 1
      WHERE u.aktif = 1 AND u.cabang_id = ?
        AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')
      ORDER BY u.nama_lengkap`, [cabangId]);

    const total = rows.length;
    const withPhoto = rows.filter(r => r.has_photo).length;
    const withoutPhoto = total - withPhoto;

    res.json({
      success: true,
      data: rows.map(r => ({
        user_id: r.user_id,
        nama_lengkap: r.nama_lengkap,
        username: r.username,
        role: r.role,
        has_photo: !!r.has_photo,
        foto_url: r.foto_url ? '/uploads/' + r.foto_url : null
      })),
      summary: { total, with_photo: withPhoto, without_photo: withoutPhoto }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
// GET /api/face/cabang — daftar cabang aktif (untuk pilih cabang di APK)
// ══════════════════════════════════════════
router.get('/cabang', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, kode, nama FROM cabang WHERE aktif=1 ORDER BY kode');
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
