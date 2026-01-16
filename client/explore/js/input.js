// input.js
import {
	isDlgOpen, closeDialogue,
	nextChoice, prevChoice, activateCurrent, activateByNumber,
	showHint,
} from './dialogue.js';

export class Input {
	constructor({ renderer }) {
		this.renderer = renderer;
		this.keys = new Set();
		this.lastE = 0;
		this.allow = false;

		addEventListener('keydown', (e) => {
			if (!this.allow || window.isTyping) return;

			const k = e.key;
			const kl = k.toLowerCase();

			// ESC → 대화창 닫기
			if (k === 'Escape' && isDlgOpen()) {
				e.preventDefault();
				closeDialogue();
				return;
			}

			// 대화창 열려 있을 때
			if (isDlgOpen()) {
				if (k === 'ArrowDown' || k === 'Tab' || kl === 's') {
					e.preventDefault();
					nextChoice();
					return;
				}

				if (k === 'ArrowUp' || kl === 'w') {
					e.preventDefault();
					prevChoice();
					return;
				}

				if (k === 'Enter') {
					e.preventDefault();
					activateCurrent();
					return;
				}

				if (k >= '1' && k <= '9') {
					e.preventDefault();
					activateByNumber(parseInt(k, 10));
					return;
				}
			}

			// F2 → 충돌박스 토글
			if (k === 'F2' && window.isAdmin) {
				this.renderer.showCollision = !this.renderer.showCollision;
				showHint(
					`Collision overlay: ${this.renderer.showCollision ? 'ON' : 'OFF'}`
				);
			}

			// F2 → 충돌박스 토글
			if (k === 'F4' && window.isAdmin) {
				window.ignoreColliosion = !window.ignoreColliosion;
			}
		});

		addEventListener('keydown', (e) => {
			if (!this.allow || window.isTyping) return;
			this.keys.add(e.key.toLowerCase());
		});
		addEventListener('keyup', (e) => {
			if (!this.allow) return;
			this.keys.delete(e.key.toLowerCase());
		});
	}

	get dir() {
		if (!this.allow) return { x: 0, y: 0 }; // 🚫 차단
		const d = { x: 0, y: 0 };
		if (this.keys.has('w') || this.keys.has('arrowup')) d.y -= 1;
		if (this.keys.has('s') || this.keys.has('arrowdown')) d.y += 1;
		if (this.keys.has('a') || this.keys.has('arrowleft')) d.x -= 1;
		if (this.keys.has('d') || this.keys.has('arrowright')) d.x += 1;
		return d;
	}

	consumeInteract() {
		if (!this.allow) return false; // 🚫 차단
		const now = performance.now();
		if (this.keys.has('e') && now - this.lastE > 250) {
			this.lastE = now;
			return true;
		}
		return false;
	}
}
