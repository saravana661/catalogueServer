const sql = require("mssql");
require("dotenv").config();

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    requestTimeout: 60000,
    connectionTimeout: 30000,
    pool: {
        max: 10,
        min: 1,
        idleTimeoutMillis: 30000
    },
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

let pool;

async function getConnection() {
    try {
        if (!pool) {
            pool = await sql.connect(config);
            console.log("✅ SQL Connected");
        }
        return pool;
    } catch (err) {
        console.log("❌ DB Connection Failed:", err);
        throw err; // important
    }
}

module.exports = { sql, getConnection };