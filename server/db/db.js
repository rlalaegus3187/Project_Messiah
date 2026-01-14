import mysql from 'mysql2/promise';

let pool = null;

export async function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.MYSQL_HOST,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASS,
            database: process.env.MYSQL_DB,
            timezone: '+09:00',           // Asia/Seoul
            waitForConnections: true,
            connectionLimit: 10,
        });
    }
    return pool;
}

// 단순 쿼리용 헬퍼
export async function query(sql, params = []) {
    const p = await getPool();
    const [rows] = await p.query(sql, params);
    return rows;
}
