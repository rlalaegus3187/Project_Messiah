export const players = new Map();       // characterId -> { id, x, y, dir, anim, map, dialogue }
export const maps = new Map();          // mapName -> Set(characterId)
export const activeSockets = new Map(); // characterId -> socket.id
export const objectState = new Map();   // objectId -> state(null,open,etc))

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function serializeObjectState() {
  return {
    objects: [...objectState.entries()].map(([id, state]) => ({ id, state })),
  };
}


export function ensureRoom(mapName) {
    if (!maps.has(mapName)) maps.set(mapName, new Set());
    if (!objectState.has(mapName)) objectState.set(mapName, new Map());
}

export function getCharacterBySocket(socket) {
    for (const [characterId, socketId] of activeSockets.entries()) {
        if (socketId === socket.id) return characterId;
    }
    return null;
}

export function ensureObjectState(objectId, state, durationMs = 0) {
    if (!objectId) return null;

    // 오브젝트가 없으면 초기 생성
    if (!objectState.has(objectId)) {
        objectState.set(objectId, null);
    }

    // state 인자가 있으면 새 값으로 업데이트
    if (arguments.length >= 2) {
        const prev = objectState.get(objectId);
        objectState.set(objectId, state ?? null);

        // 일정 시간 후 복귀
        if (durationMs && durationMs > 0) {
            setTimeout(() => {
                // 중간에 상태가 바뀌었으면 복귀 안 함
                const cur = objectState.get(objectId);
                if (cur === state) {
                    objectState.set(objectId, prev ?? null);
                }
            }, durationMs);
        }
    }

    return objectState.get(objectId);
}

/**
 * 현재 오브젝트 상태를 부작용 없이 조회 (생성하지 않음)
 */
export function peekObjectState(objectId) {
    return objectState.has(objectId) ? objectState.get(objectId) : null;
}
