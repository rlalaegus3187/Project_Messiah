import { createServer } from "https";
import { readFileSync } from "fs";
import { Server } from "socket.io";

import { createApp } from "./web/app.js";
import { installSocketHandlers } from "./net/socketHandlers.js";
import { startTick } from "./tick.js";
import { HTTPS_KEY, HTTPS_CERT } from "./config/constants.js";

const app = createApp();

const httpsServer = createServer({
  key: readFileSync(HTTPS_KEY),
  cert: readFileSync(HTTPS_CERT),
}, app);

const io = new Server(httpsServer, {
  cors: { origin: "https://scenario-messiah.com" },
  allowEIO3: true,
});

installSocketHandlers(io);
startTick(io);

const PORT = process.env.PORT || 5000;
httpsServer.listen(PORT, () => console.log(`[raid-grid] https://localhost:${PORT}`));
