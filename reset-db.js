const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'data', 'farmer_system.sqlite');
for (const suffix of ['', '-wal', '-shm']) {
  const target = file + suffix;
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
console.log('SQLite database reset. Start the server to recreate it from data/db.json.');
