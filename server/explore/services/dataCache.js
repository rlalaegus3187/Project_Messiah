import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPS_PATH = path.resolve(__dirname, "../data/maps.json");
const DIALOGUES_PATH = path.resolve(__dirname, "../data/dialogues.json");

const cache = {
    maps: { mtime: 0, data: null },
    dialogues: { mtime: 0, data: null },
};

async function readJSON(p) {
    const txt = await fs.readFile(p, 'utf8');
    return JSON.parse(txt);
}

async function loadIfStale(kind, filePath) {
    const st = await fs.stat(filePath);
    const mtime = st.mtimeMs;
    if (cache[kind].data && cache[kind].mtime === mtime) return cache[kind].data;
    const json = await readJSON(filePath);
    cache[kind].data = json;
    cache[kind].mtime = mtime;
    return json;
}

export async function getMaps() {
    const json = await loadIfStale('maps', MAPS_PATH);
    const data = json?.MAPS ?? json;
    return { data, version: cache.maps.mtime };
}

export async function getDialogues() {
    const json = await loadIfStale('dialogues', DIALOGUES_PATH);
    const data = json?.DIALOGUES ?? json;
    return { data, version: cache.dialogues.mtime };
}
