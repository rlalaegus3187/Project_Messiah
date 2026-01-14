import { readFileSync, statSync } from "fs";
import path from "path";
import { SKILL_DATA_PATH, MAPS_DIR, BOSSES_DIR } from "../config/constants.js";

const CACHE = new Map(); // filePath -> { mtime, data }

function loadJSON(file, fallback = {}) {
    try {
        const { mtimeMs } = statSync(file); // 파일 수정시각
        const cached = CACHE.get(file);

        if (cached && cached.mtime === mtimeMs) {
            return cached.data; // 캐시 그대로 사용
        }

        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        CACHE.set(file, { mtime: mtimeMs, data: parsed });
        return parsed;
    } catch (e) {
        console.error("[loadJSON]", file, e.message);
        return fallback;
    }
}

/** ----- skills ----- */
let SKILL_ARRAY = [];
let SKILLS = {};

export function loadSkills() {
    const parsed = loadJSON(SKILL_DATA_PATH, { skills: [] });
    const arr = parsed.skills || [];
    const map = Object.fromEntries(arr.map(s => [s.id, s]));
    SKILL_ARRAY = arr;
    SKILLS = map;
}

export function getSkills() {
    loadSkills();
    return { array: SKILL_ARRAY, map: SKILLS };
}

/** ----- maps ----- */
export function loadMapByName(name = "town") {
    const file = path.join(MAPS_DIR, `${name}.json`);
    const m = loadJSON(file, null);
    if (!m) return null;
    m.passable = (x, y) => {
        if (x < 0 || y < 0 || x >= m.n || y >= m.n) return false;
        const code = m.tiles[y][x];
        const info = m.legend[String(code)] || { passable: true };
        return !!info.passable;
    };
    return m;
}

/** ----- bosses ----- */
export function loadBossById(id) {
    const file = path.join(BOSSES_DIR, `${id}.json`);
    return loadJSON(file, { id, phases: [], timelineOnce: [] });
}
