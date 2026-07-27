const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./bot.db');
db.all("SELECT action_type, message, timestamp FROM bot_logs WHERE action_type LIKE '%error%' OR message LIKE '%Bitget TPSL ERROR%' ORDER BY id DESC LIMIT 10", (err, rows) => {
  if (err) console.error(err);
  console.log(rows);
});
