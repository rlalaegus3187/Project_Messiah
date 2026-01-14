import { getMaps } from '../services/dataCache.js';

export function findObjectDef(mapDef, objectId) {
    if (!mapDef) return null;
    const dict = mapDef.objectsById || mapDef.objectMap || mapDef.objects_map;
    if (dict && typeof dict === 'object') return dict[objectId] || null;
    const arr = mapDef.objects;
    if (Array.isArray(arr)) return arr.find(o => String(o?.id) === String(objectId)) || null;
    return null;
}

export async function findObjectDefInMap(mapName, objectId) {
    const { data: MAPS_DATA } = await getMaps();
    const mapDef = (typeof MAPS_DATA === 'object' && MAPS_DATA !== null) ? MAPS_DATA[mapName] : null;
    if (!mapDef) return null;
    return findObjectDef(mapDef, objectId);
}

// object:state 변경 시 상태 유효성 체크
export async function validateObjectState(mapName, objectId, nextState) {
    const { data: MAPS_DATA } = await getMaps();
    const mapDef = (typeof MAPS_DATA === 'object' && MAPS_DATA !== null) ? MAPS_DATA[mapName] : null;
    if (!mapDef) return { ok: false, code: 'MAP_NOT_FOUND' };

    const objDef = findObjectDef(mapDef, objectId);
    if (!objDef) return { ok: false, code: 'OBJECT_NOT_FOUND' };

    const allowed = objDef.states;
    if (!Array.isArray(allowed) || allowed.length === 0) return { ok: false, code: 'STATES_NOT_DEFINED' };
    if (!allowed.map(String).includes(String(nextState))) return { ok: false, code: 'STATE_NOT_ALLOWED', allowed };

    return { ok: true, objDef, allowed };
}
