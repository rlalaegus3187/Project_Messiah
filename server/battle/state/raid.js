import { MAX_AP } from "../config/constants.js";
import { loadMapByName, loadBossById, getSkills } from "../data/loader.js";
import { query } from "../../../db/db.js";
import { randomUUID } from "crypto";

const G = globalThis;

// 서버 프로세스 내에서 레이드 상태를 유지 (PM2 재시작 시에는 초기화됨)
G.__RAID_STATE__ ??= new Map();       // raidId -> RaidState
G.__RAID_COOLDOWNS__ ??= new Map();   // raidId -> Map<playerId, { [skillId]: cooldown }>
export const stateByRaid = G.__RAID_STATE__;
export const cooldownsByRaid = G.__RAID_COOLDOWNS__;

const keyify = (id) => String(id);

function genUid() {
  try {
    return randomUUID();
  } catch {
    return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/* ---------------- 레이드 생성 ---------------- */

export async function newRaid(teamId) {
  const teamRows = await query(
    "SELECT id, dungeon_id, name FROM aa_battle_team WHERE id = ?",
    [teamId]
  );
  const team = Array.isArray(teamRows) ? teamRows[0] : teamRows?.[0];
  if (!team) throw new Error(`Team not found: ${teamId}`);

  // 맵 로드 
  const mapName = team.dungeon_id || "town";
  const map = loadMapByName(mapName) || loadMapByName("town");
  if (!map) throw new Error(`Map not found: ${mapName}`);

  let bossesInfo = [];
  if (Array.isArray(map.boss)) bossesInfo = map.boss;
  else if (map.boss) bossesInfo = [map.boss];
  else bossesInfo = [{ id: "golem", spawn: { x: 1, y: 1 }, hp: 400 }];

  const bosses = new Map();
  for (const bInfo of bossesInfo) {
    const bossDef = loadBossById(bInfo.id) || {};
    const baseName = bossDef.name || bInfo.id;

    const hp = toNum(bInfo.hp, toNum(bossDef.hp, 1));

    const boss = {
      uid: genUid(),
      id: bInfo.id,
      name: baseName,
      type: bInfo.type || "main",
      x: bInfo.spawn?.x ?? 1,
      y: bInfo.spawn?.y ?? 1,
      hp,
      maxHp: hp,

      bossDef,
      def: bossDef.def || 0,

      clock: 0,
      phaseName: null,
      randomTimer: 0,
      onceDone: new Set(),

      size: bInfo.size || bossDef.size || { w: 1, h: 1 },
      statuses: [],
    };

    bosses.set(boss.uid, boss);
  }

  const memRows = await query(
    "SELECT ch_id FROM aa_battle_team_member WHERE team_id = ?",
    [teamId]
  );
  const chIds = (memRows || []).map((r) => Number(r.ch_id)).filter(Boolean);

  let charRows = [];
  if (chIds.length) {
    const placeholders = chIds.map(() => "?").join(",");
    charRows = await query(
      `SELECT ch_id, ch_name, hp, atk, def, skill_1, skill_2, skill_3, skill_4, skill_5
       FROM aa_battle_character WHERE ch_id IN (${placeholders})`,
      chIds
    );
  }

  const raidId = `battle:${teamId}`;
  const raid = {
    raidId,
    teamId: team.id,
    teamName: team.name,

    map,
    over: false,

    players: new Map(),
    bosses,

    lastTick: Date.now(),

    tileOverrides: new Map(), // key: "x,y" -> { x, y, original, effects }
    tileEffects: new Map(),   // key: "x,y" -> [ { dmg, applyStatus, origin, ... } ]
  };

  const { SKILLS } = getSkillData();

  for (const row of charRows) {
    const pid = Number(row.ch_id);
    const name = String(row.ch_name || `ch_${pid}`);
    const pos = randSpawnOnMap(map);

    const rawSkillIds = [row.skill_1, row.skill_2, row.skill_3, row.skill_4, row.skill_5]
      .map((s) => (s == null ? null : String(s).trim()))
      .filter(Boolean);

    const skills = rawSkillIds.map((id) => SKILLS[id]).filter(Boolean);

    raid.players.set(pid, {
      id: pid,
      name,
      x: pos.x,
      y: pos.y,

      hp: toNum(row.hp, 100),
      max_hp: toNum(row.hp, 100),

      atk: toNum(row.atk, 0),
      def: toNum(row.def, 0),

      ap: Math.floor(MAX_AP / 2),
      dead: false,

      statuses: [],
      skills,
    });
  }

  stateByRaid.set(raidId, raid);
  cooldownsByRaid.set(keyify(raidId), new Map());

  return raidId;
}

/* ---------------- 조회/유틸 ---------------- */

export function ensureRaid(raidId) {
  return stateByRaid.get(raidId) || null;
}

export function getBossByUid(raid, bossUid) {
  if (!raid) return null;
  return raid.bosses?.get?.(bossUid) || null;
}

// 레거시: 테스트용 초기 상태
export function initialPlayerState(playerId, name) {
  const pos = { x: 2, y: 2 };
  return {
    id: playerId,
    name,
    x: pos.x,
    y: pos.y,
    hp: 100,
    ap: Math.floor(MAX_AP / 2),
    dead: false,
    statuses: [],
  };
}

export function getSkillData() {
  const { array, map } = getSkills();
  return { SKILL_ARRAY: array, SKILLS: map };
}

/* ---------------- 내부 유틸 ---------------- */

function randSpawnOnMap(map, tries = 30) {
  const n = map?.n ?? 0;
  for (let i = 0; i < tries; i++) {
    const x = Math.floor(Math.random() * Math.max(1, n));
    const y = Math.floor(Math.random() * Math.max(1, n));
    if (map?.passable?.(x, y)) return { x, y };
  }

  return { x: 2, y: 2 };
}

function toNum(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
