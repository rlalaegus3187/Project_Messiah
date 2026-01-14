// server/logic/actions.js
import { tileKey, setTileOverride, getEffectiveTile } from "./tile.js";
import { computeNearestPlayer, doDamagePlayers, labelFromAction } from "./combat.js";
import { allTiles, tilesInCircle } from "./grid.js";
import { bossMove, bfsPathForBoss, findTarget } from "./boss.js";
import { loadBossById } from "../data/loader.js";
import { randomUUID } from "crypto"; // ⬅️ 추가
import * as Status from "../status.js";

/* ---------------- internal helpers ---------------- */

// 스킬 사거리 판정에 사용할 "skill-like" 객체 구성
function skillLikeFromAction(action) {
  const rangeTiles =
    action?.rangeTiles ?? action?.range ?? action?.maxRange ?? action?.castRange ?? 1;
  return { rangeTiles: Number(rangeTiles) };
}

export function scheduleWindup(io, raid, bossType, tele, windupMs = 500, origin = null) {
  if (tele) {
    io.to(raid.raidId).emit('boss:windup', { tele, windup: windupMs, bossType });
  }

  if (bossType === "main" && origin?.say) {
    io.to(raid.raidId).emit('boss:announce', { text: origin.say, bossId: origin.bossId ?? null });
  }

  return new Promise(res => setTimeout(res, Math.max(0, windupMs || 0)));
}

/* ---------------- Action implementations (boss 필수) ---------------- */
async function act_attackCircleSelf(io, raid, action, boss) {
  const b = boss;
  if (!b) return;

  const tiles = tilesInCircle(raid.map, { x: b.x, y: b.y }, action.radius || 1);

  const origin = {
    by: "boss",
    action: action.type,
    say: action.say || action.text || "",
    label: action.name || "",
    bossName: boss.name || "",
    bossId: boss.uid,
  };

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);
  doDamagePlayers(io, raid, tiles, action.dmg || 0, origin);
  io.to(raid.raidId).emit("boss:attack", { bossId: b.uid, tiles, origin });
}

async function act_attackCircleTarget(io, raid, action, boss) {
  const b = boss;
  if (!b) return;

  const center = findTarget(raid, b);
  const tiles = tilesInCircle(raid.map, center, action.radius || 1);

  const origin = {
    by: "boss",
    action: action.type,
    say: action.say || action.text || "",
    label: action.name || "",
    bossName: boss.name || "",
    bossId: boss.uid,
  };

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);
  doDamagePlayers(io, raid, tiles, action.dmg || 0, origin);

  io.to(raid.raidId).emit("boss:attack", { bossId: b.uid, tiles, origin });
}

async function act_attackLineRow(io, raid, action, boss) {
  const b = boss;
  if (!b) return;
  const y = b.y;
  const tiles = [];
  const len = action.length || 4;

  for (let dx = -len; dx <= len; dx++) {
    const x = b.x + dx;
    if (x >= 0 && x < raid.map.n) tiles.push({ x, y });
  }

  const origin = {
    by: "boss",
    action: action.type,
    say: action.say || action.text || "",
    label: action.name || "",
    bossName: boss.name || "",
    bossId: boss.uid,
  };

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);

  doDamagePlayers(io, raid, tiles, action.dmg || 0, origin);
  io.to(raid.raidId).emit("boss:attack", { bossId: b.uid, tiles, origin });
}

async function act_moveTowardNearest(io, raid, action, boss) {
  const b = boss;
  if (!b) return;

  const origin = {
    by: "boss",
    action: action.type,
    say: action.say || action.text || "",
    label: action.name || "",
    bossName: boss.name || "",
    bossId: boss.uid,
  };

  await scheduleWindup(io, raid, boss.type, null, action?.windupMs ?? 0, origin);

  const bossPos = { x: b.x, y: b.y };
  const center = findTarget(raid, b);
  if (!center) return;
  const path = bfsPathForBoss(raid, bossPos, { x: center.x, y: center.y }, action.maxSteps || 1, b.uid);
  if (!path || path.length <= 1) return;
  bossMove(io, raid, path, b);
}

async function act_globalAoE(io, raid, action, boss) {
  const b = boss;
  if (!b) return;

  const tiles = allTiles(raid);

  const origin = {
    by: "boss",
    action: action.type,
    say: action.say || action.text || "",
    label: action.name || "",
    bossName: boss.name || "",
    bossId: boss.uid,
  };

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);
  doDamagePlayers(io, raid, tiles, action.dmg, origin);

  io.to(raid.raidId).emit("boss:attack", { bossId: b.uid, tiles, origin });
}

function genUid() {
  try { return randomUUID(); } catch {
    return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export async function act_summonMinions(io, raid, action, boss) {
  if (!raid?.bosses || !Array.isArray(action?.minions)) return;

  const origin = {
    by: "boss",
    action: action.type,
    say: action.say || action.text || "",
    label: action.name || "",
    bossName: boss.name || "",
    bossId: boss.uid,
  };

  await scheduleWindup(io, raid, boss.type, null, action?.windupMs ?? 0, origin);

  for (const min of action.minions) {
    if (!min?.id || !min?.spawn) continue;

    // bossDef 로드 (있으면 사용, 없으면 null)
    let bossDef = null;
    try {
      if (typeof loadBossById === 'function') {
        bossDef = loadBossById(min.id) || null;
      }
    } catch (e) {
      console.warn('[act_summonMinions] loadBossById failed:', e);
    }

    // 스탯/이름/사이즈 등 우선순위:
    // 입력(min) → bossDef → 기본값
    const baseName = min.name ?? bossDef?.name ?? min.id;
    const baseSize = min.size ?? bossDef?.size ?? { w: 1, h: 1 };

    const baseHp = Number.isFinite(min?.hp)
      ? Number(min.hp)
      : (Number(bossDef?.hp) || Number(bossDef?.def?.hp) || 1);

    const inst = {
      uid: genUid(),
      id: min.id,
      name: baseName,
      type: min.type || 'sub',
      x: min.spawn.x,
      y: min.spawn.y,
      hp: baseHp,
      maxHp: baseHp,
      bossDef,
      def: bossDef?.def ?? null,
      clock: 0,
      phaseName: null,
      randomTimer: 0,
      onceDone: new Set(),
      size: baseSize,
      statuses: Array.isArray(min.statuses) ? min.statuses.map(s => ({ ...s })) : [],
    };

    raid.bosses.set(inst.uid, inst);
  }
}

export async function act_tileEffect(io, raid, action, boss) {
  if (!raid || !action?.tile) return;

  const origin = {
    by: "boss",
    action: action.type,
    say: action.say || action.text || "",
    label: action.name || "",
    bossName: boss?.name || "",
    bossId: boss?.uid,
  };

  await scheduleWindup(io, raid, boss?.type, null, action?.windupMs ?? 0, origin);

  const { x, y } = action.tile;
  const effects = [{
    dmg: action.dmg ?? 0,
    applyStatus: Array.isArray(action.applyStatus) ? action.applyStatus : [],
    text: action.say || action.text || "",
    origin,
  }];

  setTileOverride(raid, x, y, effects);

  const overridesArr = Array.from(raid.tileOverrides, ([key, v]) => ({
    key,
    x: v.x,
    y: v.y,
    id: v.effects[0].applyStatus[0].id
  }));

  io.to(raid.raidId).emit("tile:Overrides", {
    raidId: raid.raidId,
    overrides: overridesArr,
  });
}

export async function act_applyStatus(io, raid, action, boss) {
  const b = boss;
  if (!b) return false;

  const origin = {
    by: "boss",
    action: action?.type ?? "",
    say: action?.say || action?.text || "",
    label: action?.name || "",
    bossName: b.name || "",
    bossId: b.uid,
  };

  const windupMs = Number(action?.windupMs ?? 0);
  if (windupMs > 0 && typeof scheduleWindup === "function") {
    await scheduleWindup(io, raid, b.type, null, windupMs, origin);
  }

  const effects = Array.isArray(action?.applyStatus)
    ? action.applyStatus[0]
    : [];

  const target = resolveTarget(raid, b, action?.applyStatus[0].target);
  if (!target) {
    return false;
  }

  for (const st of action.applyStatus) {
    const spec = {
      id: st.id,
      stacks: st.stacks || 1,
      durationMs: st.durationMs ?? 3000,
      magnitude: st.magnitude ?? 1,
      src: action?.name,
      meta: b.name ?? 'tile',
    };

    Status.add(target, spec);

    io.to(raid.raidId).emit("boss:applyStatus", { boss: b.name, target: target.name, status: st.id });
  }
}

function resolveTarget(raid, boss, targetKind) {
  switch (targetKind) {
    case "player": {
      let target = findTarget(raid, boss);
      if (!target) return null;
      const p = raid?.players?.get(target.id);
      if (!p) return null;

      return p;
    }
    case "self":
      return boss;
    default:
      return null;
  }
}

/* ---------------- Action registry ---------------- */
const ACTION_IMPL = {
  attackCircleSelf: act_attackCircleSelf,
  attackCircleTarget: act_attackCircleTarget,
  attackLineRow: act_attackLineRow,
  moveTowardNearest: act_moveTowardNearest,
  globalAoE: act_globalAoE,
  summonMinions: act_summonMinions,
  tileEffect: act_tileEffect,
  applyStatus: act_applyStatus
};

/* ---------------- runAction (boss 필수) ---------------- */
export async function runAction(io, raid, a, boss) {
  if (!a || !ACTION_IMPL[a.type]) return;
  if (!boss) return; // 필수

  ACTION_IMPL[a.type](io, raid, a, boss);
}

