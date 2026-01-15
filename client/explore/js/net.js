import {
	handleInteractionStart,
	handleInteractionUpdate,
	handleInteractionEnd,
	handleInteractionFail,
	setChoiceEmitter
} from './dialogue.js';

export class Net {
	constructor() {
		this.socket = io("https://scenario-messiah.com:8080/explore");
		this.me = null;
		this.others = new Map();
		this.handlers = new Map();
		this.currentMap = 'lobby';
		this.roomState = { switches: {}, gathered: [] };
		this.objectState = new Map(); // id -> state

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

	connect() {
		setChoiceEmitter((nodeId, idx) => this.choose(nodeId, idx));

		this.socket.on('player:exist', () => {
			alert('이미 다른 곳에서 접속중입니다.');
		});

		this.socket.on('player:init', (mapName, spawn) => {
			this.join(mapName, spawn);
		});

		this.socket.on('map:init', (payload) => {
			window.questInfo = payload.me.quests.views;

			this.me = payload.me;
			this.others = new Map((payload.others || []).map(p => [p.id, p]));

			const incomingVersion = payload.version || (payload.maps && payload.maps.version) || 0;
			if (!this._mapsVersion || incomingVersion >= this._mapsVersion) {
				this._mapsVersion = incomingVersion;
				this.maps = payload.maps;
			}

			this.applySerializedState(payload.objectState);

			this._call('map:init', payload);
		});

		this.socket.on('player:join', (p) => {
			if (p.id !== this.me?.id) {
				this.others.set(p.id, p);
				this._call('player:join', p);
			}
		});

		this.socket.on('player:leave', ({ characterId }) => {
			this.others.delete(Number(characterId));
			this._call('player:leave', characterId);
		});

		this.socket.on('player:move', (p) => {
			if (p.id !== this.me?.id) {
				const prev = this.others.get(p.id);
				const moved = !prev || prev.x !== p.x || prev.y !== p.y;
				const updated = { ...(prev || {}), ...p };
				if (moved) updated.lastMoveAt = performance.now();
				this.others.set(p.id, updated);
				this._call('player:move', updated);
			}
		});

		// 기존 오브젝트 이벤트(있으면 사용)
		this.socket.on('object:interact', (evt) => this._call('object:interact', evt));
		this.socket.on('object:update', (evt) => this._call('object:update', evt));

		this.socket.on('interaction:start', handleInteractionStart);
		this.socket.on('interaction:update', handleInteractionUpdate);
		this.socket.on('interaction:end', handleInteractionEnd);
		this.socket.on('interaction:fail', handleInteractionFail);

		this.socket.on('new_map', () => {
			window.location.reload();
		});

		this.socket.on('switch:changed', ({ id, state }) => {
			this.updateSwitch(id, state);
		});
	}

	applySerializedState(payload) {
		const arr = Array.isArray(payload?.objects) ? payload.objects : [];

		// id/state 로 매핑된 전역 objectState 생성
		this.objectState = new Map(
			arr.map(({ id, state }) => [String(id), state])
		);
	}

	updateSwitch(id, nextState) {
		if (id == null) return;

		const key = String(id);
		const prev = this.objectState.get(key);

		const merged =
			prev && typeof prev === 'object' && nextState && typeof nextState === 'object'
				? { ...prev, ...nextState }
				: nextState;

		this.objectState.set(key, merged);
	}

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

		this._initResetBtn();
	}

	_initResetBtn() {
		const btn = document.getElementById('resetBtn');

		const onClick = (e) => {
			e.preventDefault();
			btn.disabled = true;
			this.socket.emit('map:respawn', { characterId: window.characterId });
			setTimeout(() => { btn.disabled = false; }, 800);
		};

		btn.addEventListener('click', onClick);
	}

	join(mapName, spawn) {
		this.currentMap = mapName;
		this.emit('map:join', { characterId: window.characterId, mapName, spawn });
	}

	switchMap(targetMap, spawn) {
		this.currentMap = targetMap;
		this.emit('map:switch', { targetMap, spawn }); 
	}

	move(x, y, dir) {
		if (window.isTempChar) return;

		this.pending = { x: x, y: y, dir };
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

