module.exports = {
  apps: [{
    name: 'rajavapor-absensi',
    script: './server.js',
    cwd: '/var/www/rajavapor-absensi/backend',
    instances: 2,
    exec_mode: 'cluster',
    max_memory_restart: '256M',
    listen_timeout: 5000,
    kill_timeout: 3000,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1000,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
