import {
	handleInteractionStart,
	handleInteractionUpdate,
	handleInteractionEnd,
	handleInteractionFail,
	setChoiceEmitter
} from './dialogue.js';

export class Net {
	constructor() {
		this.me = null;
		this.others = new Map();
		this.handlers = new Map();
		this.currentMap = 'lobby';
		this.roomState = { switches: {}, gathered: [] };

		this.MIN_INTERVAL = 50;
		this.lastSentAt = 0;
		this.pending = null;
		this.timer = null;
		this.lastMoveAt = new Map(); // id -> timestamp(ms)

		// 대화/인터랙션 진행 상황(옵션)
		this.currentDialogue = null;
	}

	on(event, fn) { this.handlers.set(event, fn); }
	emit(event, data) { this.socket.emit(event, data); }

	init() {
		if (window.isTempChar) {
			this.currentMap = "temp_lobby";
			this.me = {
				id: '1',
				x: 200,
				y: 200, // ← 오타 수정
				dir: 'down',
				anim: 0,
				map: 'temp_lobby'
			};
			return;
		}
		this.emit('explore:init', { characterId: window.characterId, mapName: window.currentMap });
	}

	join(mapName, spawn) {
		this.currentMap = mapName;
		this.emit('map:join', { characterId: window.characterId, mapName });
	}

	switchMap(targetMap, spawn) {
		this.currentMap = targetMap;
		this.emit('map:switch', { targetMap, spawn }); // ✅ 서버 이벤트명과 일치
	}

	move(x, y, dir) {
		if (window.isTempChar) return;

		this.pending = { x: Math.round(x), y: Math.round(y), dir };

		const now = performance.now();
		const wait = this.MIN_INTERVAL - (now - this.lastSentAt);

		if (wait <= 0) {
			this._flush();
		} else if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				this._flush();
			}, wait);
		}
	}

	_flush() {
		if (!this.pending) return;
		this.emit('player:move', this.pending);
		this.lastSentAt = performance.now();
		this.pending = null;
	}

	flushNow() {
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		this._flush();
	}

	switchObjectState(objectId, state) {
		this.emit('object:state', { objectId, state });
	}

	// ===== 상호작용 시작 (클라→서버) =====
	interact(target) {
		if (window.isTempChar) return;

		const objectId = target?.id;
		if (!objectId) { console.warn('interact: invalid objectId', target); return; }

		console.log("interact(target", objectId);

		this.emit('player:interaction', { objectId: String(objectId) });
	}

	// ===== 선택 전송 =====
	choose(nodeId, choice) {
		if (window.isTempChar) return;
		if (!nodeId) return;
		this.emit('interaction:choose', { nodeId: String(nodeId), choice });
	}

	_call(key, arg) {
		const fn = this.handlers.get(key);
		if (fn) fn(arg);
	}
}
