import { createServer as createHttpsServer } from "https";
import { readFileSync } from "fs";
import { Server } from "socket.io";

import { createApp } from "./web/app.js";
import { installSocketHandlers } from "./net/socketHandlers.js";
import { startTick } from "./tick.js";

/*
 Entry point for realtime game server.
 - socket.io 기반 실시간 통신
 - 서버 권한(server-authoritative) 구조 유지
*/

const app = createApp();

const PORT = process.env.PORT_BATTLE;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH;
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH;

if (!HTTPS_KEY_PATH || !HTTPS_CERT_PATH) {
  throw new Error("HTTPS key/cert path is not defined in environment variables.");
}

const server = createHttpsServer(
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

installSocketHandlers(io);
startTick(io);

server.listen(PORT, () => {
  console.log(`[Project_Messiah] https server listening on port ${PORT}`);
});
