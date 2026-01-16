import { loadCollision, isBlocked as _isBlocked } from './collision.js';

export class World {
    constructor(net) {
        this.net = net;
        this.playerRadius = 14; // 상호작용/충돌 계산에 사용하는 플레이어 반경
        this.mapName = 'lobby';
        this.map = null;
        this.collision = null;

        if (this.net && typeof this.net._call === 'function') {
            this.net._call('on', 'map:init', async (payload) => {
                await this.setMap(payload.maps);
            });
        } else if (this.net?.on) {
            this.net.on('map:init', async (payload) => {
                await this.setMap(payload.maps);
            });
        }
        this.socket = io("https://scenario-messiah.com:8080/explore");
    }

    async setMap(maps) {
        const m = maps?.current ? maps.current : maps;
        if (!m) return;

        // 이름이 없으면 'server'로
        this.mapName = m.name || 'lobby';
        this.map = m;

        await this._loadCollisionForCurrent();

        this.socket.emit('explore:connected', { characterId: window.characterId });
        this.net?._call?.('map:ready', { map: this.mapName });
    }

    async loadMap(name) {
        const candidate =
            (this.net?.maps && (this.net.maps[name] || this.net.maps.current)) ||
            this.map;
        if (!candidate) return;
        await this.setMap(candidate);
    }

    async _loadCollisionForCurrent() {
        if (!this.map) { this.collision = null; return; }
        this.collision = await loadCollision(this.map);
    }

    // 상호작용 가능 여부
    _isInteractable(obj, gathered, roomState) {
        if (!obj) return false;
        // 이미 획득한 채집물은 제외
        if (obj.type === 'gather' && gathered.has(obj.id)) return false;
        // 잠긴 문인데 필요한 스위치가 이미 켜졌으면 제외(열렸다고 간주)
        if (obj.type === 'door_locked' && obj.needSwitch) {
            const on = !!roomState?.switches?.[obj.needSwitch];
            if (on) return false;
        }
        // 명시 플래그가 있으면 우선
        if (Object.prototype.hasOwnProperty.call(obj, 'interact')) return !!obj.interact;
        // 기본 타입 셋
        const INTERACTABLE = new Set(['npc', 'sign', 'switch', 'door', 'door_locked', 'gather', 'item_add', 'item_remove', 'keyword_add', 'keyword_remove', 'quest']);
        return INTERACTABLE.has(obj.type);
    }

    _objCenterAndRadius(obj) {
        const w = obj.bbox?.w ?? 28;
        const h = obj.bbox?.h ?? 28;
        const ox = obj.bbox?.ox ?? 0;
        const oy = obj.bbox?.oy ?? 0;
        const cx = obj.x + ox / 2;
        const cy = obj.y + oy / 2;
        // 플레이어 충돌 반경
        const playerR = this.playerRadius ?? 14;
        const margin = 8; // 여유
        const needed = Math.max(w, h) / 2 + playerR + margin;
        // 명시 interactDist/talkDist가 있으면 우선, 없으면 크기 기반 자동계산
        const r = obj.interactDist ?? obj.talkDist ?? needed;
        return { cx, cy, r };
    }

    // 플레이어 좌표(px, py) 기준, 반경 내 최근접 상호작용 대상 찾기
    findNearestInteractable(px, py) {
        const objs = this.map?.objects || [];
        const gathered = new Set(this.net?.roomState?.gathered || []);
        const rs = this.net?.roomState;

        let best = null, bestD2 = Infinity;
        for (const o of objs) {
            if (!this._isInteractable(o, gathered, rs)) continue;
            const { cx, cy, r } = this._objCenterAndRadius(o);
            const dx = px - cx, dy = py - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 <= r * r && d2 < bestD2) { best = o; bestD2 = d2; }
        }
        return best;
    }

    // 기존 타일 충돌 (4코너)
    _blockedByTiles(x, y, r = 12) {
        if (!this.collision) return false;
        if (window.ignoreColliosion) return false;
        const t = this.collision;
        const c = (px, py) => _isBlocked(t, px, py);
        return c(x - r, y - r) || c(x + r, y - r) || c(x - r, y + r) || c(x + r, y + r);
    }

    // 오브젝트 충돌 (AABB 교차)
    _blockedByObjects(x, y, r = 14) {
        const objs = this.map?.objects || [];
        const gathered = new Set(this.net?.roomState?.gathered || []);

        // 플레이어 박스
        const pl = x - r, pr = x + r, pt = y - r, pb = y + r;

        for (const o of objs) {
            if (!o?.collide) continue;                    // collide가 true인 것만
            if (o.type === 'gather' && gathered.has(o.id)) continue; // 이미 주운 채집물은 충돌 제외

            const w = o.bbox?.w ?? 28;
            const h = o.bbox?.h ?? 20;
            const ox = o.bbox?.ox ?? 0;
            const oy = o.bbox?.oy ?? 0;

            const ol = (o.x + ox) - w / 2;
            const orr = (o.x + ox) + w / 2;
            const ot = (o.y + oy) - h / 2;
            const ob = (o.y + oy) + h / 2;

            const separated =
                pr < ol || pl > orr || pb < ot || pt > ob;

            if (!separated) {
                // 잠긴 문 같은 조건부 충돌 제어를 하고 싶다면 여기서 처리
                if (o.type === 'door_locked' && o.needSwitch) {
                    const on = !!this.net?.roomState?.switches?.[o.needSwitch];
                    if (on) continue; // 스위치 ON이면 더 이상 막지 않음
                }
                return true; // 충돌!
            }
        }
        return false;
    }

    // 외부에서 쓰는 충돌 함수: 타일 or 오브젝트
    blockedRect(x, y, r = 14) {
        return this._blockedByTiles(x, y, r) || this._blockedByObjects(x, y, r);
    }

    // (선택) 반경 상호작용 — 네가 기존에 이미 구현했다면 그대로 두면 됨
    tryInteract(player, _radiusIgnored = null) {
        // 힌트(E)와 같은 후보/같은 거리 기준으로 찾는다
        const target = this.findNearestInteractable(player.x, player.y);
        if (!target) return null;

        // 동일한 중심/반경 계산(_objCenterAndRadius)로 최종 근접 여부 확인
        const { cx, cy, r } = this._objCenterAndRadius(target);
        const dx = player.x - cx, dy = player.y - cy;
        if (dx * dx + dy * dy <= r * r) {
            return target; // 상호작용 범위 안
        }
        return null;     // 힌트는 떴지만 실제론 살짝 벗어난 경우
    }
}