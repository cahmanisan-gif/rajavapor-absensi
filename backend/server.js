require('dotenv').config({ path: __dirname + '/.env' });
const app  = require('./src/app');
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log('Absensi Raja Vapor berjalan di port ' + PORT);
});
