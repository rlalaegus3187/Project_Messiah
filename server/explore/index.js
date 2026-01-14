import {
  players, maps, activeSockets, objectState,
  ensureRoom, serializeObjectState, getCharacterBySocket, clamp
} from './state/worldState.js';

import { getMaps } from './services/dataCache.js';
import { validateObjectState } from './utils/mapUtils.js';
import { startInteractionForObject, handleChoice } from './services/interactionService.js';
import { updatePlayerQuestSnapshot } from './services/questService.js';

export default (io) => {
  const exploreNS = io.of('/explore');

  exploreNS.on('connection', (socket) => {

    // 초기 연결: 캐릭터/맵 동기화
    socket.on('explore:init', async ({ characterId, mapName }) => {
      if (!characterId) return;

      // 이전 소켓 강제 종료
      const prevSocketId = activeSockets.get(characterId);
      if (prevSocketId && prevSocketId !== socket.id) {
        const prevSocket = exploreNS.sockets.get(prevSocketId) || io.sockets.sockets.get(prevSocketId);
        if (prevSocket) {
          prevSocket.emit("player:exist");
          prevSocket.disconnect(true);
        }
      }
      activeSockets.set(characterId, socket.id);

      const { data: MAPS_DATA, version: MAPS_VER } = await getMaps();

      const p = players.get(characterId);
      const m = p?.map;

      // 서버가 가진 플레이어 상태가 없거나, 요청한 맵과 다르면 클라에 스폰 지시만 내려줌
      if (!p || m !== String(mapName)) {
        function findMapDef(data, name) {
          if (!data) return null;

          if (data && typeof data === 'object' && !Array.isArray(data) && data[name]) return data[name];

          const mapsObj = data.maps ?? null;
          if (mapsObj) {
            if (Array.isArray(mapsObj)) {
              return mapsObj.find(d => d?.id === name || d?.name === name || d?.mapName === name) ?? null;
            }
            if (typeof mapsObj === 'object' && mapsObj[name]) return mapsObj[name];
          }

          if (Array.isArray(data)) {
            return data.find(d => d?.id === name || d?.name === name || d?.mapName === name) ?? null;
          }

          return null;
        }

        const def = findMapDef(MAPS_DATA, String(mapName));

        // 스폰 좌표(없으면 기본값)
        const spawn = (() => {
          const s = def?.spawn;
          const x = Number(s?.x);
          const y = Number(s?.y);
          const dir = typeof s?.dir === 'string' ? s.dir : 'down';
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { x: 64, y: 64, dir: 'down' };
          }
          return { x, y, dir };
        })();

        socket.emit('player:init', String(mapName), spawn);
        return;
      }

      p.connected = true;

      ensureRoom(m);
      maps.get(m).add(characterId);
      socket.join(m);

      const roomPlayers = [...maps.get(m)].map(id => players.get(id)).filter(Boolean);

      // 퀘스트 스냅샷 최신화(클라에 me로 내려감)
      await updatePlayerQuestSnapshot(p);

      socket.emit('map:init', {
        me: p,
        others: roomPlayers.filter(pp => pp.id !== characterId),
        objectState: serializeObjectState(),
        maps: {
          version: MAPS_VER,
          current: (typeof MAPS_DATA === 'object' && MAPS_DATA !== null) ? (MAPS_DATA[m] ?? null) : null,
        },
      });

      exploreNS.to(m).emit('player:join', p);
    });

    // 클라 로딩 완료/입력 가능 상태 알림
    socket.on('explore:connected', async ({ characterId }) => {
      const p = players.get(characterId);
      if (!p) return;
      p.connected = true;
    });

    // 캐릭터 상태 생성/초기화
    socket.on('map:join', async ({ characterId, mapName, spawn }) => {
      const m = String(mapName || 'lobby');
      ensureRoom(m);

      // 기존 방에서 제거
      for (const [r, set] of maps.entries()) {
        if (set.has(characterId)) { set.delete(characterId); socket.leave(r); }
      }
      maps.get(m).add(characterId);
      socket.join(m);

      // 맵 데이터 로드
      const { data: MAPS_DATA, version: MAPS_VER } = await getMaps();
      const mapDef = (typeof MAPS_DATA === 'object' && MAPS_DATA !== null) ? MAPS_DATA[m] : null;

      // 스폰 결정
      const fallback = { x: 200, y: 200 };
      const base = (Number.isFinite(spawn?.x) && Number.isFinite(spawn?.y))
        ? spawn
        : (Number.isFinite(mapDef?.spawn?.x) && Number.isFinite(mapDef?.spawn?.y))
          ? mapDef.spawn
          : fallback;

      // 맵 경계 클램프
      const width = Number.isFinite(mapDef?.w) ? mapDef.w : 1024;
      const height = Number.isFinite(mapDef?.h) ? mapDef.h : 768;
      const px = clamp(Math.round(base.x), 0, width - 1);
      const py = clamp(Math.round(base.y), 0, height - 1);

      // 플레이어 상태 생성
      const p = {
        id: characterId,
        x: px,
        y: py,
        dir: 'down',
        anim: 0,
        map: m,
        dialogue: null,
        interaction: false,
        quests: { ok: false, list: [], views: [], updatedAt: 0 },
        connected: true
      };
      players.set(characterId, p);

      // emit 전에 퀘스트 최신화
      await updatePlayerQuestSnapshot(p);

      const roomPlayers = [...maps.get(m)].map(id => players.get(id)).filter(Boolean);

      socket.emit('map:init', {
        me: p,
        others: roomPlayers.filter(pp => pp.id !== characterId),
        objectState: serializeObjectState(objectState.get(m)),
        maps: { version: MAPS_VER, current: mapDef ?? null },
      });

      exploreNS.to(m).emit('player:join', p);
    });

    // 같은 방에서 스폰 위치로 리셋
    socket.on('map:respawn', async ({ characterId }) => {
      const p = players.get(characterId);
      if (!p) return;

      // 리스폰 도중 입력 막기
      p.connected = false;

      const { data: MAPS_DATA } = await getMaps();
      const mapDef = MAPS_DATA?.[p.map];
      if (!mapDef) return;

      const fallbackSpawn = { x: 200, y: 200, dir: 'down' };
      const base = (mapDef.spawn && typeof mapDef.spawn === 'object') ? mapDef.spawn : fallbackSpawn;

      const width = Number.isFinite(mapDef?.w) ? Number(mapDef.w) : 1024;
      const height = Number.isFinite(mapDef?.h) ? Number(mapDef.h) : 768;

      const bx = Number.isFinite(base.x) ? Math.round(base.x) : fallbackSpawn.x;
      const by = Number.isFinite(base.y) ? Math.round(base.y) : fallbackSpawn.y;
      const bdir = (typeof base.dir === 'string' && base.dir) ? base.dir : fallbackSpawn.dir;

      p.x = clamp(bx, 0, Math.max(0, width - 1));
      p.y = clamp(by, 0, Math.max(0, height - 1));
      p.dir = bdir;

      const roomPlayers = [...maps.get(p.map)].map(id => players.get(id)).filter(Boolean);

      socket.emit('new_map');

      // 리스폰 완료 → 이동 허용
      p.connected = true;

      exploreNS.to(p.map).volatile.emit('player:move', {
        id: p.id,
        x: p.x,
        y: p.y,
        dir: p.dir,
        map: p.map,
      });
    });

    // 이동(최소 검증만)
    socket.on('player:move', (data = {}) => {
      const characterId = getCharacterBySocket(socket);
      if (!characterId) return;

      const p = players.get(characterId);
      if (!p) return;

      // 대화/상호작용 중이거나, 아직 연결 확정이 아니면 이동 금지
      if (p.interaction || !p.connected) return;

      const dirList = ["down", "down-right", "right", "up-right", "up", "up-left", "left", "down-left"];
      const dir = (dirList.includes(data.dir) ? data.dir : p.dir);

      p.x = data.x;
      p.y = data.y;
      p.dir = dir;

      exploreNS.to(p.map).volatile.emit('player:move', {
        id: characterId,
        x: p.x,
        y: p.y,
        dir: p.dir,
        map: p.map,
      });
    });

    // 오브젝트 상태 변경(문/상자/스위치 등)
    socket.on('object:state', async ({ objectId, state }) => {
      const characterId = getCharacterBySocket(socket);
      if (!characterId) return;

      const p = players.get(characterId);
      if (!p) return;

      if (typeof objectId !== 'string' || typeof state !== 'string') {
        socket.emit('object:fail', { ok: false, id: objectId, error: 'BAD_PAYLOAD' });
        return;
      }

      ensureRoom(p.map);

      // 서버 데이터 기준으로 가능한 상태 전환인지 검증
      const v = await validateObjectState(p.map, objectId, state);
      if (!v.ok) {
        socket.emit('object:fail', { ok: false, id: objectId, error: v.code, allowed: v.allowed });
        return;
      }

      const omap = objectState.get(p.map);
      const prev = omap.get(objectId) ?? null;
      if (prev === state) return;

      omap.set(objectId, state);

      exploreNS.to(p.map).emit('map:update', { id: objectId, state, by: characterId, prev });
      socket.emit('object:update', { ok: true, id: objectId, state });
    });

    // 맵 전환
    socket.on('map:switch', async ({ targetMap, spawn }) => {
      const characterId = getCharacterBySocket(socket);
      if (!characterId) return;

      const p = players.get(characterId);
      if (!p) return;

      p.connected = false;

      const from = p.map;
      const to = String(targetMap || 'town');
      ensureRoom(to);

      if (maps.has(from)) {
        maps.get(from).delete(characterId);
        socket.leave(from);
        exploreNS.to(from).emit('player:leave', { characterId });
      }

      maps.get(to).add(characterId);
      socket.join(to);

      p.map = to;
      p.x = spawn?.x ?? 200;
      p.y = spawn?.y ?? 200;

      // 전환 직후 퀘스트 최신화
      await updatePlayerQuestSnapshot(p);

      exploreNS.to(to).emit('player:join', p);

      const roomPlayers = [...maps.get(to)].map(id => players.get(id)).filter(Boolean);
      const { data: MAPS_DATA, version: MAPS_VER } = await getMaps();

      socket.emit('map:init', {
        me: p,
        others: roomPlayers.filter(pp => pp.id !== characterId),
        objectState: serializeObjectState(objectState.get(to)),
        maps: {
          version: MAPS_VER,
          current: (typeof MAPS_DATA === 'object' && MAPS_DATA !== null) ? (MAPS_DATA[to] ?? null) : null,
        },
      });

      p.connected = true;
    });

    // 인터랙션 시작
    socket.on('player:interaction', async ({ objectId }) => {
      const characterId = getCharacterBySocket(socket);
      if (!characterId) return;

      const p = players.get(characterId);
      if (!p) return;

      p.interaction = true;

      if (typeof objectId !== 'string' || !objectId) {
        socket.emit('interaction:fail', { ok: false, error: 'BAD_PAYLOAD' });
        p.interaction = false;
        return;
      }

      await startInteractionForObject(socket, p, { objectId });
    });

    // 대사/선택지 진행
    socket.on('interaction:choose', async ({ nodeId, choice }) => {
      const characterId = getCharacterBySocket(socket);
      if (!characterId) return;

      const p = players.get(characterId);
      if (!p) return;

      await handleChoice(socket, p, { nodeId, choice });
    });

    // 연결 종료
    socket.on('disconnect', () => {
      const characterId = getCharacterBySocket(socket);
      if (!characterId) return;

      const p = players.get(characterId);
      if (!p) return;

      p.connected = false;

      if (p.map && maps.has(p.map)) {
        maps.get(p.map).delete(characterId);
        exploreNS.to(p.map).emit('player:leave', { characterId });
      }

      activeSockets.delete(characterId);
    });
  });
};
