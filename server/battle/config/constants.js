import path, { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TICK_HZ = 15;
export const AP_REGEN_PER_SEC = 1.0;
export const MAX_AP = 10;
export const DEFAULT_RAID_ID = "raid-town";

// data paths
export const SKILL_DATA_PATH = path.resolve(__dirname, '../data/skills/skills.json');
export const MAPS_DIR = path.resolve(__dirname, "../data/maps");
export const BOSSES_DIR = path.resolve(__dirname, "../data/bosses");

// static roots
export const EXPLORE_STATIC = path.resolve(__dirname, "../../avocado/explore");
export const BATTLE_STATIC  = path.resolve(__dirname, "../../avocado/battle");
export const EXPLORE_INDEX_HTML = path.join(EXPLORE_STATIC, "index.html");
