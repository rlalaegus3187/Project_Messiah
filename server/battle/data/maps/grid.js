// server/logic/grid.js
export function manhattan(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
export function inBounds(map, x, y) { return x >= 0 && y >= 0 && x < map.n && y < map.n; }
export function passable(map, x, y) { return map.passable(x, y); }

export function tilesInCircle(map, center, radius) {
    const res = [];
    for (let y = center.y - radius; y <= center.y + radius; y++) {
        for (let x = center.x - radius; x <= center.x + radius; x++) {
            if (!inBounds(map, x, y)) continue;
            const dx = x - center.x, dy = y - center.y;
            if (dx * dx + dy * dy <= radius * radius) res.push({ x, y });
        }
    }
    return res;
}

export function allTiles(map) {
    const res = [];
    const W = map?.map.n ?? map?.width ?? 0;
    const H = map?.map.n ?? map?.height ?? 0;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            res.push({ x, y });
        }
    }
    return res;
}

export function bfsPath(map, start, goal, maxSteps = 50) {
    const q = [start];
    const key = t => `${t.x},${t.y}`;
    const prev = new Map();
    prev.set(key(start), null);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    while (q.length) {
        const cur = q.shift();
        if (cur.x === goal.x && cur.y === goal.y) break;
        for (const [dx, dy] of dirs) {
            const nx = cur.x + dx, ny = cur.y + dy;
            const k = key({ x: nx, y: ny });
            if (prev.has(k)) continue;
            if (!passable(map, nx, ny)) continue;
            prev.set(k, cur);
            q.push({ x: nx, y: ny });
        }
        if (prev.size > (maxSteps + 1) * 8) break;
    }

    const path = [];
    let cur = goal;
    if (!prev.has(key(cur))) return [];
    while (cur) { path.push(cur); cur = prev.get(key(cur)); }
    path.reverse();
    return path;
}
