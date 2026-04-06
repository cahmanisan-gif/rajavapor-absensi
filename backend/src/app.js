const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');
const app     = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://poinraja.com').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const compression = require('compression');
app.use(compression({ threshold: 512 }));

// Static uploads
const UPLOAD_PATH = process.env.UPLOAD_PATH || '/var/www/rajavapor-absensi/uploads';
if (!fs.existsSync(UPLOAD_PATH)) fs.mkdirSync(UPLOAD_PATH, { recursive: true });
app.use('/uploads', express.static(UPLOAD_PATH, { maxAge: '7d' }));

// Serve frontend
app.use(express.static(path.join(__dirname, '../../frontend')));

// API routes
app.use('/api/absensi',  require('./routes/absensi'));
app.use('/api/rekap',    require('./routes/rekap'));
app.use('/api/izin',     require('./routes/izin'));
app.use('/api/admin',    require('./routes/admin'));

app.get('/api/ping', (req, res) => res.json({ success: true, message: 'Absensi Raja Vapor aktif!' }));

module.exports = app;
