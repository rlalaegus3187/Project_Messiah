import express from "express";
import { createServer } from "https";
import { readFileSync } from "fs";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/explore', express.static(path.join(__dirname, '../../avocado/explore')));
app.use('/battle', express.static(path.join(__dirname, '../../avocado/battle')));
app.use('/chat', express.static(path.join(__dirname, '../../avocado/chat')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../avocado/explore', 'index.html'));
});

const PORT = process.env.PORT_CHAT;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH;
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH;

const httpsServer = createHttpsServer(
  {
    key: readFileSync(HTTPS_KEY_PATH),
    cert: readFileSync(HTTPS_CERT_PATH),
  },
  app
);


const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  allowEIO3: true,
});

let pool;
async function getPool() {
    if (!pool) {
        pool = await mysql.createPool({
            host: process.env.MYSQL_HOST,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASS,
            database: process.env.MYSQL_DB,
            timezone: "+09:00",
            waitForConnections: true,
            connectionLimit: 10,
        });
    }
    return pool;
}

// DB 헬퍼
async function insertMessage(chId, roomId, text) {
    const p = await getPool();
    await p.query(
        "INSERT INTO aa_chat (ch_id, room_id, chat) VALUES (?, ?, ?)",
        [chId ?? 0, roomId, String(text).slice(0, 2000)]
    );
}

async function fetchHistory(roomId, limit = 50) {
    const p = await getPool();
    const [rows] = await p.query(
        "SELECT ch_id, chat FROM aa_chat WHERE room_id = ? ORDER BY idx DESC LIMIT ?",
        [roomId, limit]
    );
    return rows.map(r => ({ userId: r.ch_id, text: r.chat })).reverse();
}

// 소켓
io.on("connection", (socket) => {
    socket.on("room:join", async ({ chId, roomId }) => {
        try {
            if (!roomId) return;
            // userId = chId
            socket.data.userId = chId ?? `u_${socket.id.slice(0, 6)}`;
            socket.join(roomId);

            const history = await fetchHistory(roomId, 50);
            socket.emit("room:history", history);
        } catch (e) {
            console.error("room:join error", e);
            socket.emit("room:error", { message: "방 참가 중 오류" });
        }
    });

    socket.on("chat:send", async ({ chId, roomId, text }) => {
        try {
            if (!roomId || !text) return;
            const userId = chId ?? socket.data.userId ?? `u_${socket.id.slice(0, 6)}`;
            const clean = String(text).slice(0, 2000);

            await insertMessage(Number.isFinite(+userId) ? +userId : 0, roomId, clean);
            io.to(roomId).emit("chat:message", { userId, text: clean });
        } catch (e) {
            console.error("chat:send error", e);
            socket.emit("room:error", { message: "메시지 전송 중 오류" });
        }
    });
});


httpsServer.listen(PORT, () => {
  console.log(`[Project_Messiah] https server listening on port ${PORT}`);
});
