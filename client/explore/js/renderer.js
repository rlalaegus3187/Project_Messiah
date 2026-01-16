import { loadImage } from '../data/maps.js';

export class Renderer {
	constructor(canvas, net, world) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.net = net;
		this.world = world;
		this.camera = { x: 0, y: 0 };
		this.images = new Map();
		this.sprites = new Map();
		this.showCollision = false; // 디버그 오버레이 토글 (main.js에서 F2 등으로 바꿔도 됨)

		this.MOVE_GRACE = 60; // ms

		// 기본 고정 해상도
		this.baseWidth = 960;
		this.baseHeight = 540;
		this.setFixedResolution(this.baseWidth, this.baseHeight);

		// 리사이즈 이벤트
		window.addEventListener("resize", () => this.resize());
		this.resize();
	}

	async preload(maps) {
		const keyOf = v => String(v);

		async function tryLoadImage(src) {
			try {
				return await loadImage(src);
			} catch {
				return null;
			}
		}

		// 배경/전경
		this.images.set(maps.bg, await loadImage(maps.bg));
		this.images.set(maps.fg, await loadImage(maps.fg));
		if (maps.onswitch) {
			for (const rule of maps.onswitch) {
				if (rule.bg) {
					if (!this.images.has(rule.bg)) {
						this.images.set(rule.bg, await loadImage(rule.bg));
					}
				}

				if (rule.fg) {
					if (!this.images.has(rule.fg)) {
						this.images.set(rule.fg, await loadImage(rule.fg));
					}
				}
			}
		}

		// 기본 시트
		const DEFAULT_SHEET = '/explore/assets/new_player_sheet.png';
		const defaultImg = await loadImage(DEFAULT_SHEET);

		// 내 캐릭터
		const myPath = window.isTempChar
			? DEFAULT_SHEET
			: `/explore/assets/player/character${window.characterId}.png`;
		const myImg = (await tryLoadImage(myPath)) || defaultImg;
		this.sprites.set('player', myImg);

		// 다른 캐릭터들
		const charMap = new Map();
		this.sprites.set('characters', charMap);

		for (const c of Object.values(window.chList || {})) {
			const id = String(c.ch_id);
			const sheetPath = `/explore/assets/player/character${id}.png`;
			const img = (await tryLoadImage(sheetPath)) || defaultImg;
			charMap.set(id, img);
		}

		// 오브젝트 시트
		this.sprites.set('objects', await loadImage('/explore/assets/object_sheet.png'));
	}

	// 해상도 고정 함수
	setFixedResolution(width, height) {
		this.baseWidth = width;
		this.baseHeight = height;
		this.canvas.width = width;
		this.canvas.height = height;
	}

	// 실제 브라우저 크기에 맞게 스케일 조정
	resize() {
		const scaleX = window.innerWidth / this.baseWidth;
		const scaleY = window.innerHeight / this.baseHeight;
		const scale = Math.min(scaleX, scaleY);

		this.canvas.style.width = `${this.baseWidth * scale}px`;
		this.canvas.style.height = `${this.baseHeight * scale}px`;
	}

	_computeEffectiveObject(obj, switchMap, keywordList) {
		if (!obj) return obj;

		const mergePatch = (base, rule) => ({
			...base,
			...(rule?.sx != null ? { sx: rule.sx } : null),
			...(rule?.sy != null ? { sy: rule.sy } : null),
			...(rule?.collide != null ? { collide: rule.collide } : null),
			...(rule?.bbox ? { bbox: { ...(base.bbox || {}), ...rule.bbox } } : null),
		});

		const toKeywordSet = (list) => {
			if (!list) return new Set();
			const extract = (v) => {
				if (typeof v === "string") return v;
				if (v && typeof v === "object") {
					return v.keyword ?? v.kw_name ?? v.name ?? v.key ?? null;
				}
				return null;
			};
			const set = new Set();
			for (const it of Array.isArray(list) ? list : []) {
				const k = extract(it);
				if (k) set.add(String(k));
			}
			return set;
		};

		const toArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));

		// 모든 switch들이 요구 상태를 만족하는지 검사
		const switchesAllMatch = (rule) => {
			const sids = toArray(rule?.switch_id);
			if (sids.length === 0) return false;

			let statuses = toArray(rule?.status);
			if (statuses.length === 1 && sids.length > 1) {
				statuses = Array(sids.length).fill(statuses[0]);
			}
			if (statuses.length !== sids.length) return false;
			if (!(switchMap instanceof Map)) return false;

			for (let i = 0; i < sids.length; i++) {
				const sid = sids[i];
				const required = statuses[i];
				if (!switchMap.has(sid) || switchMap.get(sid) !== required) return false;
			}
			return true;
		};

		const kwSet = toKeywordSet(keywordList);

		let out = obj;

		// 1) 스위치 기반 룰 (첫 매칭만 적용)
		if (Array.isArray(obj.onswitch)) {
			for (const rule of obj.onswitch) {
				if (!rule) continue;
				if (switchesAllMatch(rule)) {
					out = mergePatch(out, rule);
					break;
				}
			}
		}

		// 2) 키워드 기반 룰 (첫 매칭만 적용)
		if (Array.isArray(obj.onKeyword) && kwSet.size > 0) {
			for (const rule of obj.onKeyword) {
				if (!rule) continue;

				const rKeys = [];
				if (typeof rule.keyword === "string") rKeys.push(rule.keyword);
				if (Array.isArray(rule.keywords)) {
					for (const k of rule.keywords) if (typeof k === "string") rKeys.push(k);
				}
				if (rKeys.length === 0) continue;

				let matched = false;
				for (const k of rKeys) {
					if (kwSet.has(k)) {
						matched = true;
						break;
					}
				}
				if (!matched) continue;

				out = mergePatch(out, rule);
				break;
			}
		}

		return out;
	}

	_computeEffectiveMap(map, switchMap, keywordList) {
		if (!map) return { bg: null, fg: null };

		let bg = map.bg ?? null;
		let fg = map.fg ?? null;

		const rules = Array.isArray(map.onswitch) ? map.onswitch : null;
		if (!rules) return { bg, fg };

		const toArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));

		for (const rule of rules) {
			const sids = toArray(rule?.switch_id);
			if (sids.length === 0) continue;

			let statuses = toArray(rule?.status);
			if (statuses.length === 1 && sids.length > 1) {
				statuses = Array(sids.length).fill(statuses[0]);
			}

			if (statuses.length !== sids.length) continue;

			let allMatch = true;
			for (let i = 0; i < sids.length; i++) {
				const sid = sids[i];
				const required = statuses[i];
				if (!switchMap.has(sid) || switchMap.get(sid) !== required) {
					allMatch = false;
					break;
				}
			}

			if (allMatch) {
				if (rule.bg != null) bg = rule.bg;
				if (rule.fg != null) fg = rule.fg;
				break;
			}
		}

		return { bg, fg };
	}

	draw(now) {
		const { ctx, canvas } = this;
		const map = this.world.map;
		const me = this.net.me;
		if (!map || !me) return;

		const switchMap = this.net.objectState || {};
		const keywordList = window.keywords || {};

		// 카메라
		{
			this.camera.x = Math.max(0, Math.min(map.w - canvas.width, me.x - canvas.width / 2));
			this.camera.y = Math.max(0, Math.min(map.h - canvas.height, me.y - canvas.height / 2));

			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}

		// 배경
		const { bg, fg } = this._computeEffectiveMap(map, switchMap, keywordList);
		{
			const bgImage = this.images.get(bg);
			ctx.drawImage(bgImage, this.camera.x, this.camera.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
		}

		// ── 공통: 방향 → 시트 행 인덱스(0~7)
		const DIR_TO_INDEX = {
			"up": 0,
			"up-right": 1,
			"right": 2,
			"down-right": 3,
			"down": 4,
			"down-left": 5,
			"left": 6,
			"up-left": 7,
		};

		// 내 플레이어
		{
			const isMoving = (typeof me.moving === 'boolean') ? me.moving : false;

			const playerSheet = this.sprites.get('player');
			// 움직일 때만 0~2 애니메이션, 멈추면 frame=0 고정
			const frame = isMoving ? Math.floor((now / 250) % 4) : 0;
			const dirIndex = DIR_TO_INDEX[me.dir] ?? 0;
			this.drawSprite(playerSheet, frame, dirIndex, me.x, me.y);
		}

		// 다른 플레이어 그리기
		{
			for (const p of (this.net?.others instanceof Map
				? this.net.others.values()
				: Object.values(this.net?.others || {}))) {

				const last = p.lastMoveAt ?? -Infinity;
				const stillMoving = (now - last) < this.MOVE_GRACE;
				if (p.moving !== stillMoving) {
					p.moving = stillMoving;
					this.net?.others?.set?.(p.id, p);
				}

				const f = stillMoving ? Math.floor((now / 250) % 4) : 0;
				const di = DIR_TO_INDEX[p.dir] ?? 0;

				const charSheets = this.sprites.get('characters');
				const sheet = charSheets?.get(String(p.id)) || this.sprites.get('player');

				this.drawSprite(sheet, f, di, p.x, p.y);
			}
		}

		// 오브젝트
		{
			const objSheet = this.sprites.get('objects');

			for (const obj of map.objects) {
				const eff = this._computeEffectiveObject(obj, switchMap, keywordList);
				const { sx, sy, sw, sh } = this.getObjSpriteRect(eff);
				this.drawSpriteObject(objSheet, sx, sy, sw, sh, eff.x, eff.y);
			}
		}

		// 디버그: 충돌 오버레이 (오브젝트 위, 전경 아래)
		if (this.showCollision) this.drawCollisionOverlay();

		// 전경
		{
			const fgImage = this.images.get(fg);
			ctx.drawImage(fgImage, this.camera.x, this.camera.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
		}

		// ── 상호작용 힌트(E)
		{
			const me = this.net?.me;
			if (me) {
				const target = this.world.findNearestInteractable(me.x, me.y);
				if (target) this.drawKeyHint(target);
			}
		}
	}

	getObjSpriteRect(obj) {
		// 시트 내 시작 좌표
		const sx = obj.sx ?? 0;
		const sy = obj.sy ?? 0;

		// 잘라올 가로/세로 크기: sprite.w/h → frameW/H → bbox.w/h → 32 기본
		const sw = obj.sprite?.w ?? obj.frameW ?? obj.bbox?.w ?? 32;
		const sh = obj.sprite?.h ?? obj.frameH ?? obj.bbox?.h ?? 32;

		return { sx, sy, sw, sh };
	}

	drawCollisionOverlay() {
		const col = this.world.collision;
		if (!col || !col.data) return;

		const { data, width, tileSize } = col;
		const isSolid = (v) => {
			if (col.solid && typeof col.solid.has === 'function') return col.solid.has(v);
			if (Array.isArray(col.solid)) return col.solid.includes(v);
			return v === 9;
		};

		const height = Math.ceil(data.length / width);
		const { ctx } = this;

		// 화면에 보이는 타일 범위만 루프
		const x0 = Math.max(0, Math.floor(this.camera.x / tileSize));
		const y0 = Math.max(0, Math.floor(this.camera.y / tileSize));
		const x1 = Math.min(width - 1, Math.floor((this.camera.x + this.canvas.width) / tileSize));
		const y1 = Math.min(height - 1, Math.floor((this.camera.y + this.canvas.height) / tileSize));

		ctx.save();
		for (let ty = y0; ty <= y1; ty++) {
			for (let tx = x0; tx <= x1; tx++) {
				const idx = ty * width + tx;
				const v = data[idx] ?? 0;
				if (!isSolid(v)) continue;
				const px = Math.round(tx * tileSize - this.camera.x);
				const py = Math.round(ty * tileSize - this.camera.y);
				ctx.fillStyle = 'rgba(255, 0, 0, 0.22)'; // 타일 충돌: 빨강
				ctx.fillRect(px, py, tileSize, tileSize);
				ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
				ctx.strokeRect(px + 0.5, py + 0.5, tileSize, tileSize);
			}
		}
		ctx.restore();

		// 오브젝트 충돌 박스: 파랑
		const objs = Array.isArray(this.world.map?.objects) ? this.world.map.objects : [];
		const gathered = new Set(this.net.roomState?.gathered || []);
		ctx.save();
		for (const o of objs) {
			if (!o?.collide) continue;
			if (o.type === 'gather' && gathered.has(o.id)) continue;

			const w = o.bbox?.w ?? 28;
			const h = o.bbox?.h ?? 20;
			const ox = o.bbox?.ox ?? 0;
			const oy = o.bbox?.oy ?? 0;

			// 잠긴 문이지만 스위치 ON이면 충돌/표시 제외
			if (o.type === 'door_locked' && o.needSwitch) {
				const on = !!this.net?.roomState?.switches?.[o.needSwitch];
				if (on) continue;
			}

			const rx = Math.round((o.x + ox) - w / 2 - this.camera.x);
			const ry = Math.round((o.y + oy) - h / 2 - this.camera.y);

			ctx.fillStyle = 'rgba(0, 128, 255, 0.22)';
			ctx.fillRect(rx, ry, w, h);
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
			ctx.strokeRect(rx + 0.5, ry + 0.5, w, h);
		}
		ctx.restore();

		// 간단한 범례
		const pad = 6;
		const w = 190, h = 44;
		const x = 10, y = this.canvas.height - h - 10;
		ctx.save();
		ctx.fillStyle = 'rgba(10, 12, 14, 0.65)';
		ctx.fillRect(x, y, w, h);
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
		ctx.strokeRect(x + 0.5, y + 0.5, w, h);
		ctx.fillStyle = '#e6eef7';
		ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
		ctx.fillText('RED = Tile collision', x + pad, y + 18);
		ctx.fillText('BLUE = Object collision', x + pad, y + 34);
		ctx.restore();
	}

	// drawSprite: (열=방향, 행=프레임)
	drawSprite(sheet, frame, dirCol, x, y) {
		const { ctx } = this;
		const sw = 32, sh = 32;
		const sx = dirCol * sw;   // 가로(열) = 방향
		const sy = frame * sh;    // 세로(행) = 프레임

		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(
			sheet, sx, sy, sw, sh,
			Math.round(x - this.camera.x - sw / 2),
			Math.round(y - this.camera.y - sh / 2),
			sw, sh
		);
	}

	drawSpriteObject(sheet, sx, sy, sw, sh, x, y) {
		const { ctx } = this;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(
			sheet, sx, sy, sw, sh,
			Math.round(x - this.camera.x - sw / 2),
			Math.round(y - this.camera.y - sh / 2),
			sw, sh
		);
	}

	drawKeyHint(obj) {
		const ctx = this.ctx;

		// 오브젝트 위쪽 약간 띄워서 표시(필요시 hintOffsetY로 보정)
		const x = Math.round(obj.x - this.camera.x);
		const y = Math.round(obj.y - this.camera.y - 24 + (obj.hintOffsetY || 0));
		const w = 18, h = 18, r = 4;

		ctx.save();
		ctx.globalAlpha = 0.95;

		// 배경(반투명 캡슐)
		ctx.fillStyle = "rgba(0,0,0,0.5)";
		ctx.strokeStyle = "rgba(255,255,255,0.9)";
		ctx.lineWidth = 2;

		ctx.beginPath();
		ctx.moveTo(x - w / 2 + r, y - h / 2);
		ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r);
		ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r);
		ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r);
		ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();

		// 텍스트
		ctx.fillStyle = "#fff";
		ctx.font = "bold 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(obj.hintText || "E", x, y);

		ctx.restore();
	}
}
