export class HUD {
  constructor() {
    this.nameEl = document.getElementById('youName');
    this.hpEl = document.getElementById('youHP');
    this.apEl = document.getElementById('youAP');
    this.annEl = document.getElementById('announce');
    this.logEl = document.getElementById('log');
    this.characterEl = document.getElementById('battle_ch_list');

    this.maxLines = 120;
    this.annTimer = null;
  }

  updateYou(you) {
    if (this.nameEl) this.nameEl.textContent = you?.name ?? '-';
    if (this.hpEl) this.hpEl.textContent = Math.floor(you?.hp ?? 0);
    if (this.apEl) this.apEl.textContent = (you?.ap ?? 0).toFixed(1);
  }

  // 상단 어나운스 배너
  announce(text, ms = 1800) {
    if (!this.annEl) return;
    this.annEl.textContent = String(text || '');
    this.annEl.classList.add('show');
    if (this.annTimer) clearTimeout(this.annTimer);
    this.annTimer = setTimeout(() => {
      this.annEl.classList.remove('show');
    }, Math.max(600, ms | 0));
  }

  // 전투 로그
  log(text, type = 'info') {
    if (!this.logEl) return;
    const line = document.createElement('div');
    line.className = 'line ' + (type || 'info');
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    line.innerHTML = `<span class="t">${hh}:${mm}:${ss}</span>${text}`;

    const nearBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 20;
    this.logEl.appendChild(line);

    while (this.logEl.children.length > this.maxLines) {
      this.logEl.removeChild(this.logEl.firstChild);
    }

    if (nearBottom) {
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  upsertPlayer(p) {
    if (!this.characterEl || !p || p.id == null) return;

    const ch = window.chList?.[p.id] || {};
    const name = ch.ch_name || `#${p.id}`;
    const thumb = ch.ch_thumb || "";

    const hp = Math.max(0, Number(p.hp ?? 0));
    const maxHp = Math.max(
      1,
      Number(
        p.max_hp !== undefined ? p.max_hp
          : ch.hp_max !== undefined ? ch.hp_max
            : hp
      )
    );
    const atk = Math.max(0, Number(p.atk ?? 0));
    const def = Math.max(0, Number(p.def ?? 0));

    const dead = !!p.dead || hp <= 0;

    if (!this._playerNodes) this._playerNodes = new Map();

    let card = this._playerNodes.get(p.id);
    if (!card) {
      card = document.createElement("div");
      card.className = "char-card";
      card.dataset.id = String(p.id);
      card.innerHTML = `
      <div class="char-thumb-wrap">
        <img class="char-thumb" src="${thumb}" alt="${name}">
      </div>
      <div class="char-meta">
        <div class="char-name">${name}</div>
        <div class="char-hp">
          <i>HP</i> <div class="hp-current-val">${hp}</div><div class="hp-max-val">/${maxHp}</div>
        </div>
        <div class="char-atk">
          <i>ATK</i><div class="atk-val">${atk}</div>
        </div>
        <div class="char-def">
          <i>DEF</i><div class="def-val">${def}</div>
        </div>
      </div>
    `;
      this.characterEl.appendChild(card);
      this._playerNodes.set(p.id, card);
    }

    card.classList.toggle("is-dead", dead);
  }

  updatePlayer(p) {
    if (!this._playerNodes || !p || p.id == null) return;

    const card = this._playerNodes.get(p.id);
    if (!card) return; // 카드가 없으면 스킵

    const hp = Math.max(0, Number(p.hp ?? 0));
    const maxHp = Math.max(
      1,
      Number(
        p.max_hp !== undefined ? p.max_hp
          : (window.chList?.[p.id]?.hp_max ?? hp)
      )
    );
    const hpPct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
    const dead = !!p.dead || hp <= 0;

    // 값 갱신
    const val = card.querySelector(".hp-current-val");
    if (val) val.textContent = `${hp}`;

    const fill = card.querySelector(".hp-fill");
    if (fill) fill.style.width = `${hpPct}%`;

    // 죽음 상태 반영
    card.classList.toggle("is-dead", dead);
  }
}