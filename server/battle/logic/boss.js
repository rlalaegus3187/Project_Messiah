import { inBounds, passable as _passable } from "./grid.js";

/*
 Boss utilities:
 - multi-boss 지원 (raid.bosses: Map)
 - collision-aware placement + BFS pathfinding
 - taunt(도발) 기반 타깃 선택
*/

export function getBosses(raid) {
  if (!raid || !(raid.bosses instanceof Map)) return [];
  return Array.from(raid.bosses.values());
}

export function getBossById(raid, bossId) {
  const bosses = getBosses(raid);
  if (bosses.length === 0) return null;

  if (bossId != null) {
    return bosses.find((b) => String(b.uid) === String(bossId)) || null;
  }
  return bosses[0];
}

/* ---------------- Boss occupancy / collision ---------------- */

export function bossTiles(raid, bossId = null) {
  const b = getBossById(raid, bossId);
  if (!b) return [];

  const w = Math.max(1, b.size?.w || 1);
  const h = Math.max(1, b.size?.h || 1);

  const tiles = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      tiles.push({ x: b.x + dx, y: b.y + dy });
    }
  }
  return tiles;
}

export function tileIsInBoss(raid, t, bossId = null) {
  if (!t) return false;

  if (bossId != null) {
    return bossTiles(raid, bossId).some((bt) => bt.x === t.x && bt.y === t.y);
  }

  for (const b of getBosses(raid)) {
    const w = Math.max(1, b.size?.w || 1);
    const h = Math.max(1, b.size?.h || 1);

    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (b.x + dx === t.x && b.y + dy === t.y) return true;
      }
    }
  }
  return false;
}

export function canPlaceBoss(raid, pos, bossUid = null) {
  if (!raid || !pos || typeof pos.x !== "number" || typeof pos.y !== "number") return false;

  const b = getBossById(raid, bossUid);
  if (!b) return false;

  const w = Math.max(1, b.size?.w || 1);
  const h = Math.max(1, b.size?.h || 1);

  const targetTiles = new Set();
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      targetTiles.add(`${pos.x + dx},${pos.y + dy}`);
    }
  }

  // 1) bounds & passable
  for (const key of targetTiles) {
    const [x, y] = key.split(",").map(Number);
    if (!inBounds(raid.map, x, y)) return false;
    if (!_passable(raid.map, x, y)) return false;
  }

  // 2) player collision
  for (const p of raid.players.values()) {
    if (!p) continue;
    if (targetTiles.has(`${p.x},${p.y}`)) return false;
  }

  // 3) other bosses collision
  for (const other of getBosses(raid)) {
    if (!other) continue;
    if (bossUid != null && String(other.uid) === String(bossUid)) continue;

    const ow = Math.max(1, other.size?.w || 1);
    const oh = Math.max(1, other.size?.h || 1);

    for (let dy = 0; dy < oh; dy++) {
      for (let dx = 0; dx < ow; dx++) {
        const occKey = `${other.x + dx},${other.y + dy}`;
        if (targetTiles.has(occKey)) return false;
      }
    }
  }

  return true;
}

export function bossMove(io, raid, path, boss) {
  const to = path?.[path.length - 1];
  if (!boss || !to) return;

  if (!canPlaceBoss(raid, to, boss.uid)) return;

  boss.x = to.x;
  boss.y = to.y;

  // 필요한 최소 정보만 브로드캐스트 (payload 절약)
  io.to(raid.raidId).emit("boss:move", { bossId: boss.uid, to });
}

/* ---------------- Pathfinding ---------------- */

const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function bfsPathForBoss(raid, start, goal, maxSteps = 50, bossUid) {
  const key = (t) => `${t.x},${t.y}`;

  if (start.x === goal.x && start.y === goal.y) return [start];

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const q = [start];
  let qi = 0;
  const prev = new Map([[key(start), null]]);

  let bestNode = start;
  let bestDist = manhattan(start, goal);

  const enqueue = (nx, ny, from) => {
    const node = { x: nx, y: ny };
    const k = key(node);
    if (prev.has(k)) return;

    if (!canPlaceBoss(raid, node, bossUid)) return;

    prev.set(k, from);
    q.push(node);

    const d = manhattan(node, goal);
    if (d < bestDist) {
      bestDist = d;
      bestNode = node;
    }
  };

  while (qi < q.length) {
    const cur = q[qi++];

    if (cur.x === goal.x && cur.y === goal.y) {
      const path = [];
      for (let t = cur; t; t = prev.get(key(t))) path.push(t);
      path.reverse();
      return path.length - 1 > maxSteps ? path.slice(0, maxSteps + 1) : path;
    }

    for (const [dx, dy] of dirs) enqueue(cur.x + dx, cur.y + dy, cur);
  }

  // fallback: goal unreachable
  const path = [];
  for (let t = bestNode; t; t = prev.get(key(t))) path.push(t);
  path.reverse();
  return path.length - 1 > maxSteps ? path.slice(0, maxSteps + 1) : path;
}

/* ---------------- Taunt-aware targeting ---------------- */

function iterPlayers(raid) {
  const p = raid?.players;
  if (!p) return [];
  if (p instanceof Map) return Array.from(p.values());
  if (Array.isArray(p)) return p;
  return Object.values(p);
}

function isAlivePlayer(p) {
  return p && !p.dead && Number(p.hp) > 0;
}

function minManhattanFromBoss(boss, target) {
  const w = Math.max(1, boss.size?.w || 1);
  const h = Math.max(1, boss.size?.h || 1);

  let best = Number.POSITIVE_INFINITY;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const d = Math.abs(boss.x + dx - target.x) + Math.abs(boss.y + dy - target.y);
      if (d < best) best = d;
    }
  }
  return best;
}

export function isTargetInSkillRange(_raid, boss, target, skill) {
  if (!boss || !target || !skill) return false;
  const range = Number(skill.rangeTiles ?? skill.range ?? 1);
  return minManhattanFromBoss(boss, target) <= Math.max(0, range);
}

export function findTarget(raid, boss) {
  const alive = iterPlayers(raid).filter(isAlivePlayer);
  if (alive.length === 0) return null;

  // 도발(taunt)이 있으면 해당 타깃 우선
  const taunt = boss?.statuses?.find((s) => s?.id === "taunt");
  if (taunt) {
    const taunterId = taunt.meta?.id ?? taunt.meta ?? taunt.taunterId ?? taunt.sourceId;
    const taunter = alive.find((p) => String(p.id) === String(taunterId));
    if (taunter) return { id: taunter.id, x: taunter.x, y: taunter.y, name: taunter.name };
  }

  // 없으면 랜덤 타깃
  const t = alive[Math.floor(Math.random() * alive.length)];
  return { id: t.id, x: t.x, y: t.y, name: t.name };
}
