import { setTileOverride } from "./tile.js";
import { doDamagePlayers } from "./combat.js";
import { allTiles, tilesInCircle } from "./grid.js";
import { bossMove, bfsPathForBoss, findTarget } from "./boss.js";
import { loadBossById } from "../data/loader.js";
import { randomUUID } from "crypto";
import * as Status from "../status.js";

/*
  Boss action execution layer.
  - windup(telegraph) -> resolve(damage/status/move) 순서로 처리
  - 결과는 서버에서 확정하고 룸(raidId)에 브로드캐스트
*/

export function scheduleWindup(io, raid, bossType, teleTiles, windupMs = 500, origin = null) {
  // telegraph: 플레이어에게 장판/예고를 먼저 보여주고, n ms 뒤 판정을 수행
  if (teleTiles) {
    io.to(raid.raidId).emit("boss:windup", { tele: teleTiles, windup: windupMs, bossType });
  }

  if (bossType === "main" && origin?.say) {
    io.to(raid.raidId).emit("boss:announce", { text: origin.say, bossId: origin.bossId ?? null });
  }

  return new Promise((res) => setTimeout(res, Math.max(0, Number(windupMs) || 0)));
}

function makeOrigin(boss, action) {
  return {
    by: "boss",
    action: action?.type ?? "",
    say: action?.say || action?.text || "",
    label: action?.name || "",
    bossName: boss?.name || "",
    bossId: boss?.uid ?? null,
  };
}

/* ---------------- Action implementations ---------------- */

async function act_attackCircleSelf(io, raid, action, boss) {
  const tiles = tilesInCircle(raid.map, { x: boss.x, y: boss.y }, action.radius || 1);
  const origin = makeOrigin(boss, action);

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);
  doDamagePlayers(io, raid, tiles, action.dmg || 0, origin);

  io.to(raid.raidId).emit("boss:attack", { bossId: boss.uid, tiles, origin });
}

async function act_attackCircleTarget(io, raid, action, boss) {
  const center = findTarget(raid, boss);
  if (!center) return;

  const tiles = tilesInCircle(raid.map, center, action.radius || 1);
  const origin = makeOrigin(boss, action);

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);
  doDamagePlayers(io, raid, tiles, action.dmg || 0, origin);

  io.to(raid.raidId).emit("boss:attack", { bossId: boss.uid, tiles, origin });
}

async function act_attackLineRow(io, raid, action, boss) {
  const y = boss.y;
  const tiles = [];
  const len = action.length || 4;

  for (let dx = -len; dx <= len; dx++) {
    const x = boss.x + dx;
    if (x >= 0 && x < raid.map.n) tiles.push({ x, y });
  }

  const origin = makeOrigin(boss, action);

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);
  doDamagePlayers(io, raid, tiles, action.dmg || 0, origin);

  io.to(raid.raidId).emit("boss:attack", { bossId: boss.uid, tiles, origin });
}

async function act_moveTowardNearest(io, raid, action, boss) {
  const origin = makeOrigin(boss, action);

  await scheduleWindup(io, raid, boss.type, null, action?.windupMs ?? 0, origin);

  const center = findTarget(raid, boss);
  if (!center) return;

  const bossPos = { x: boss.x, y: boss.y };
  const path = bfsPathForBoss(
    raid,
    bossPos,
    { x: center.x, y: center.y },
    action.maxSteps || 1,
    boss.uid
  );

  if (!path || path.length <= 1) return;
  bossMove(io, raid, path, boss);
}

async function act_globalAoE(io, raid, action, boss) {
  const tiles = allTiles(raid);
  const origin = makeOrigin(boss, action);

  await scheduleWindup(io, raid, boss.type, tiles, action?.windupMs ?? 0, origin);
  doDamagePlayers(io, raid, tiles, action.dmg || 0, origin);

  io.to(raid.raidId).emit("boss:attack", { bossId: boss.uid, tiles, origin });
}

function genUid() {
  try {
    return randomUUID();
  } catch {
    return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export async function act_summonMinions(io, raid, action, boss) {
  if (!raid?.bosses || !Array.isArray(action?.minions)) return;

  const origin = makeOrigin(boss, action);
  await scheduleWindup(io, raid, boss.type, null, action?.windupMs ?? 0, origin);

  for (const min of action.minions) {
    if (!min?.id || !min?.spawn) continue;

    let bossDef = null;
    try {
      bossDef = typeof loadBossById === "function" ? loadBossById(min.id) || null : null;
    } catch (e) {
      console.warn("[act_summonMinions] loadBossById failed:", e);
    }

    const baseName = min.name ?? bossDef?.name ?? min.id;
    const baseSize = min.size ?? bossDef?.size ?? { w: 1, h: 1 };

    const baseHp = Number.isFinite(min?.hp)
      ? Number(min.hp)
      : Number(bossDef?.hp) || Number(bossDef?.def?.hp) || 1;

    const inst = {
      uid: genUid(),
      id: min.id,
      name: baseName,
      type: min.type || "sub",
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
      statuses: Array.isArray(min.statuses) ? min.statuses.map((s) => ({ ...s })) : [],
    };

    raid.bosses.set(inst.uid, inst);
  }
}

export async function act_tileEffect(io, raid, action, boss) {
  if (!raid || !action?.tile) return;

  const origin = makeOrigin(boss, action);
  await scheduleWindup(io, raid, boss?.type, null, action?.windupMs ?? 0, origin);

  const { x, y } = action.tile;

  const effects = [
    {
      dmg: action.dmg ?? 0,
      applyStatus: Array.isArray(action.applyStatus) ? action.applyStatus : [],
      text: action.say || action.text || "",
      origin,
    },
  ];

  setTileOverride(raid, x, y, effects);

  const overridesArr = Array.from(raid.tileOverrides, ([key, v]) => {
    const firstStatusId = v?.effects?.[0]?.applyStatus?.[0]?.id ?? null;
    return { key, x: v.x, y: v.y, id: firstStatusId };
  });

  io.to(raid.raidId).emit("tile:Overrides", {
    raidId: raid.raidId,
    overrides: overridesArr,
  });
}

export async function act_applyStatus(io, raid, action, boss) {
  if (!boss) return false;

  const applyStatus = Array.isArray(action?.applyStatus) ? action.applyStatus : [];
  if (applyStatus.length === 0) return false;

  const origin = makeOrigin(boss, action);

  const windupMs = Number(action?.windupMs ?? 0);
  if (windupMs > 0) {
    await scheduleWindup(io, raid, boss.type, null, windupMs, origin);
  }

  const targetKind = applyStatus[0]?.target;
  const target = resolveTarget(raid, boss, targetKind);
  if (!target) return false;

  for (const st of applyStatus) {
    const spec = {
      id: st.id,
      stacks: st.stacks || 1,
      durationMs: st.durationMs ?? 3000,
      magnitude: st.magnitude ?? 1,
      src: action?.name,
      meta: boss.name ?? "boss",
    };

    Status.add(target, spec);
  }

  io.to(raid.raidId).emit("boss:applyStatus", {
    boss: boss.name,
    target: target.name,
    statuses: applyStatus.map((s) => s.id),
  });

  return true;
}

function resolveTarget(raid, boss, targetKind) {
  switch (targetKind) {
    case "player": {
      const t = findTarget(raid, boss);
      if (!t) return null;
      return raid?.players?.get(t.id) || null;
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
  applyStatus: act_applyStatus,
};

/* ---------------- dispatcher ---------------- */

export async function runAction(io, raid, action, boss) {
  if (!action || !boss) return;
  const fn = ACTION_IMPL[action.type];
  if (!fn) return;

  // 액션 구현은 windup -> 판정 순서를 가지므로 비동기 실행을 보장
  await fn(io, raid, action, boss);
}
