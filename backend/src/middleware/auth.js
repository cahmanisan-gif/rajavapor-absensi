const jwt = require('jsonwebtoken');
require('dotenv').config();

module.exports = (roles = []) => {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ success: false, message: 'Token tidak ada.' });

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ success: false, message: 'Akses ditolak.' });
      }
      next();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Token tidak valid.' });
    }
  };
};
