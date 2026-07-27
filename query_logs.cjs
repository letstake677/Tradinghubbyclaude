const Database = require('better-sqlite3');
const db = new Database('./bot.db');
const rows = db.prepare("SELECT action_type, message, timestamp FROM bot_logs WHERE action_type LIKE '%error%' OR message LIKE '%BITGET TPSL ERROR%' ORDER BY id DESC LIMIT 10").all();
console.log(rows);
