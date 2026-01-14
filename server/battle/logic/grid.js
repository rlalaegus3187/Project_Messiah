export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// 맵 범위 체크
export function inBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.n && y < map.n;
}

// 이동 가능 타일 여부 (map.passable 구현에 위임)
export function passable(map, x, y) {
  return map.passable(x, y);
}

// 원형 범위(유클리드 거리) 내 타일 리스트 반환
export function tilesInCircle(map, center, radius) {
  const res = [];
  for (let y = center.y - radius; y <= center.y + radius; y++) {
    for (let x = center.x - radius; x <= center.x + radius; x++) {
      if (!inBounds(map, x, y)) continue;
      const dx = x - center.x,
        dy = y - center.y;
      if (dx * dx + dy * dy <= radius * radius) res.push({ x, y });
    }
  }
  return res;
}

// 맵 전체 타일 리스트 (map.n을 표준으로 사용)
export function allTiles(map) {
  const n = map?.n ?? 0;
  const res = [];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) res.push({ x, y });
  }
  return res;
}

// BFS 경로 탐색 (passable 타일만 이동)
// - q.shift() 대신 인덱스를 사용해 성능 저하를 방지
export function bfsPath(map, start, goal, maxSteps = 50) {
  const key = (t) => `${t.x},${t.y}`;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const q = [start];
  let qi = 0;

  const prev = new Map([[key(start), null]]);
  let expanded = 0;

  while (qi < q.length) {
    const cur = q[qi++];

    if (cur.x === goal.x && cur.y === goal.y) break;
    if (expanded++ > maxSteps * 50) break; // 안전장치(무한 확장 방지)

    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx,
        ny = cur.y + dy;
      if (!inBounds(map, nx, ny)) continue;
      if (!passable(map, nx, ny)) continue;

      const nk = key({ x: nx, y: ny });
      if (prev.has(nk)) continue;

      const next = { x: nx, y: ny };
      prev.set(nk, cur);
      q.push(next);
    }
  }

  // goal에 도달 못했으면 실패
  if (!prev.has(key(goal))) return [];

  // 역추적해서 path 구성
  const path = [];
  let cur = goal;
  while (cur) {
    path.push(cur);
    cur = prev.get(key(cur));
  }
  path.reverse();

  // 최대 스텝 제한 (start 포함이므로 +1)
  return path.length - 1 > maxSteps ? path.slice(0, maxSteps + 1) : path;
}
