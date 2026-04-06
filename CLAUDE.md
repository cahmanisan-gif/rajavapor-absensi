# Raja Vapor - Sistem Absensi Mandiri

## Stack
- Backend: Node.js + Express, port 3001, PM2 (rajavapor-absensi)
- Frontend: /var/www/rajavapor-absensi/frontend/index.html (single file PWA)
- Database: MySQL 8.0, db: rajavapor (shared dengan portal utama)
- Domain: https://poinraja.com (sub-path atau subdomain)

## Struktur
- Backend routes: backend/src/routes/ (absensi, rekap, izin, admin)
- Frontend: frontend/index.html
- Uploads: /var/www/rajavapor-absensi/uploads/selfie/, uploads/izin/

## Key Commands
- Restart: pm2 restart rajavapor-absensi
- Logs: pm2 logs rajavapor-absensi --lines 20 --nostream
- DB: mysql -u root -ppasswordkamu rajavapor

## Integrasi
- JWT Secret sama dengan portal utama
- Tabel users & cabang shared
- Sinkron ke absensi_hari_ini (untuk payroll & gate transaksi POS)
- Tabel baru: absensi_log, absensi_izin, absensi_setting
