import express from "express";
import { createServer } from "https";
import { readFileSync } from "fs";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import exploreNS from "./namespaces/explore/explore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/explore', express.static(path.join(__dirname, '../../avocado/explore')));
app.use('/battle', express.static(path.join(__dirname, '../../avocado/battle')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../avocado/explore', 'index.html'));
});

const PORT = process.env.PORT_EXPLORE;
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH;
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

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

exploreNS(io);

httpsServer.listen(PORT, () => {
  console.log(`[Project_Messiah] https server listening on port ${PORT}`);
});

export { io };
