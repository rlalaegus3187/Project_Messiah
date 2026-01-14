// server/logic/boss.js
import { inBounds, passable as _passable } from "./grid.js";
import { getTauntTargetId } from "../status.js"; // ✅ 도발 확인용

/* ---------------- Multi-boss helpers ---------------- */
export function getBosses(raid) {
    if (!raid || !(raid.bosses instanceof Map)) {
        return [];
    }
    const bosses = Array.from(raid.bosses.values());

    return bosses;
}

// get single boss by id or first boss as fallback
export function getBossById(raid, bossId) {
    const bosses = getBosses(raid);
    if (!bosses.length) {
        return null;
    }

    if (bossId != null) {
        const found = bosses.find(b => String(b.uid) === String(bossId)) || null;
        return found;
    }

    return bosses[0];
}

/* ---------------- Boss utilities ---------------- */

// return tiles occupied by boss
export function bossTiles(raid, bossId = null) {
    const b = getBossById(raid, bossId);
    if (!b) return [];
    const w = Math.max(1, b.size?.w || 1);
    const h = Math.max(1, b.size?.h || 1);
    const tiles = [];
    for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
            tiles.push({ x: b.x + dx, y: b.y + dy });
    return tiles;
}

// check if tile is inside boss area
export function tileIsInBoss(raid, t, bossId = null) {
    if (bossId != null) return bossTiles(raid, bossId).some(bt => bt.x === t.x && bt.y === t.y);
    for (const b of getBosses(raid)) {
        const w = Math.max(1, b.size?.w || 1);
        const h = Math.max(1, b.size?.h || 1);
        for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++)
                if (b.x + dx === t.x && b.y + dy === t.y) return true;
    }
    return false;
}

// check if boss can be placed at pos (no collision)
export function canPlaceBoss(raid, pos, bossId = null) {
    if (!raid || !pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
        return false;
    }

    const b = getBossById(raid, bossId);

    if (!b) {
        return false;
    }

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
        if (!inBounds(raid.map, x, y)) {
            return false;
        }
        if (!_passable(raid.map, x, y)) {
            return false;
        }
    }

    // 2) players collision
    for (const p of raid.players.values()) {
        if (!p) continue;
        if (targetTiles.has(`${p.x},${p.y}`)) {
            return false;
        }
    }

    // 3) other bosses collision
    for (const other of getBosses(raid)) {
        if (!other) continue;
        if (bossId != null && String(other.id) === String(bossId)) continue;

        const ow = Math.max(1, other.size?.w || 1);
        const oh = Math.max(1, other.size?.h || 1);

        for (let dy = 0; dy < oh; dy++) {
            for (let dx = 0; dx < ow; dx++) {
                const occKey = `${other.x + dx},${other.y + dy}`;
                if (targetTiles.has(occKey)) {
                    return false;
                }
            }
        }
    }

    return true;
}

// move boss and emit
export function bossMove(io, raid, path, boss) {
    const b = boss;
    const to = path[path.length - 1];

    if (!b || !canPlaceBoss(raid, to, b.uid)) return;
    b.x = to.x;
    b.y = to.y;

    io.to(raid.raidId).emit('boss:move', { boss: b, to });
}

/* ---------------- Pathfinding ---------------- */

// BFS pathfinding for boss
// export function bfsPathForBoss(raid, start, goal, maxSteps = 50, bossId) {
//     const key = t => `${t.x},${t.y}`;

//     if (start.x === goal.x && start.y === goal.y) {
//         return [start];
//     }

//     const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
//     const q = [start];
//     let qi = 0; // queue index (O(1) pop)
//     const prev = new Map([[key(start), null]]);
//     let steps = 0;

//     while (qi < q.length && steps <= maxSteps) {
//         const levelSize = q.length - qi; // 현재 레벨(깊이)의 노드 수

//         for (let i = 0; i < levelSize; i++) {
//             const cur = q[qi++];

//             if (cur.x === goal.x && cur.y === goal.y) {
//                 const path = [];
//                 for (let t = cur; t; t = prev.get(key(t))) path.push(t);
//                 path.reverse();
//                 return path;
//             }

//             for (const [dx, dy] of dirs) {
//                 const nx = cur.x + dx, ny = cur.y + dy;
//                 const nk = key({ x: nx, y: ny });
//                 if (prev.has(nk)) continue;
//                 prev.set(nk, cur);
//                 q.push({ x: nx, y: ny });
//             }
//         }
//         steps++;
//     }

//     return [];
// }

// Helper: Manhattan distance
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * BFS that respects canPlaceBoss() for walkability.
 * - If goal is unreachable, returns path to the reachable node closest to goal.
 * - Returns path truncated to maxSteps (start..stepN).
 */
export function bfsPathForBoss(raid, start, goal, maxSteps = 50, bossUid) {
    const key = (t) => `${t.x},${t.y}`;

    // Same tile: no movement
    if (start.x === goal.x && start.y === goal.y) return [start];

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const q = [start];
    let qi = 0;

    // visited + predecessor map for path reconstruction
    const prev = new Map([[key(start), null]]);

    // Track best reachable node (fallback) by distance to goal
    let bestNode = start;
    let bestDist = manhattan(start, goal);

    const enqueue = (nx, ny, from) => {
        const node = { x: nx, y: ny };
        const k = key(node);
        if (prev.has(k)) return;

        // Only step onto tiles where the boss can actually stand
        if (!canPlaceBoss(raid, node, bossUid)) return;

        prev.set(k, from);
        q.push(node);

        // Update fallback candidate
        const d = manhattan(node, goal);
        if (d < bestDist) {
            bestDist = d;
            bestNode = node;
        }
    };

    // Standard BFS with walkability check
    while (qi < q.length) {
        const cur = q[qi++];

        // Reached goal (and guaranteed placeable due to enqueue filter)
        if (cur.x === goal.x && cur.y === goal.y) {
            const path = [];
            for (let t = cur; t; t = prev.get(key(t))) path.push(t);
            path.reverse();
            return (path.length - 1 > maxSteps) ? path.slice(0, maxSteps + 1) : path;
        }

        for (const [dx, dy] of dirs) enqueue(cur.x + dx, cur.y + dy, cur);
    }

    // Goal unreachable → fallback to best reachable node (closest to goal)
    if (bestNode) {
        const path = [];
        for (let t = bestNode; t; t = prev.get(key(t))) path.push(t);
        path.reverse();
        return (path.length - 1 > maxSteps) ? path.slice(0, maxSteps + 1) : path;
    }

    // Nothing reachable (shouldn't happen if start is valid)
    return [];
}


/* ---------------- Taunt-aware targeting ---------------- */

// 보스의 어떤 타일에서든 타깃까지의 최소 맨해튼 거리
function minManhattanFromBoss(boss, target) {
    const w = Math.max(1, boss.size?.w || 1);
    const h = Math.max(1, boss.size?.h || 1);
    let best = Number.POSITIVE_INFINITY;
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            const d = Math.abs((boss.x + dx) - target.x) + Math.abs((boss.y + dy) - target.y);
            if (d < best) best = d;
        }
    }
    return best;
}

// 스킬 사거리 안에 있는지(기본: 맨해튼 거리 <= range)
export function isTargetInSkillRange(raid, boss, target, skill) {
    if (!boss || !target || !skill) return false;
    const range = Number(skill.rangeTiles ?? skill.range ?? 1);
    const dist = minManhattanFromBoss(boss, target);
    return dist <= Math.max(0, range);
}

// 도발 고려하여 최종 타깃 결정 (사거리 안일 때만 도발자 우선)
function iterPlayers(raid) {
    const p = raid?.players;
    if (!p) return [];
    if (p instanceof Map) return Array.from(p.values());
    if (Array.isArray(p)) return p;
    return Object.values(p); // 키-값 객체 대응
}

function isAlivePlayer(p) {
    return p && !p.dead && Number(p.hp) > 0;
}

export function findTarget(raid, b) {
    const alive = iterPlayers(raid).filter(isAlivePlayer);
    if (alive.length === 0) return null;

    const taunt = b?.statuses?.find(ss => ss?.id === "taunt");
    if (taunt) {
        const taunterId =
            taunt.meta?.id ?? taunt.meta ?? taunt.taunterId ?? taunt.sourceId;
        const taunter = alive.find(p => String(p.id) === String(taunterId));

        if (taunter) {
            return { id: taunter.id, x: taunter.x, y: taunter.y, name: taunter.name };
        }
    }

    const t = alive[Math.floor(Math.random() * alive.length)];
    return { id: t.id, x: t.x, y: t.y, name: t.name, target:t };
}
