// grid.js
import { socket } from "./net.js";

const TILE = 48;

export class GridRenderer {
  constructor(app) {
    this.app = app;
    this.tileSize = TILE;
    this.n = 16;

    this.app.stage.removeChildren();
    this.app.stage.sortableChildren = true;

    this.layers = {
      bg: new PIXI.Container(),
      image: new PIXI.Container(),
      grid: new PIXI.Container(),
      overrides: new PIXI.Container(),
      telegraph: new PIXI.Container(),
      entities: new PIXI.Container(),
      hover: new PIXI.Container(),
      effects: new PIXI.Container(),
      ui: new PIXI.Container(),
      hit: new PIXI.Container(),
    };

    this.layers.telegraphRange = new PIXI.Container();
    this.layers.telegraphWarn = new PIXI.Container();
    this.layers.telegraphAim = new PIXI.Container();

    this.layers.telegraph.addChild(this.layers.telegraphRange);
    this.layers.telegraph.addChild(this.layers.telegraphWarn);
    this.layers.telegraph.addChild(this.layers.telegraphAim);

    for (const c of [this.layers.telegraphRange, this.layers.telegraphWarn]) {
      c.eventMode = "none";
      c.interactive = false;
      c.interactiveChildren = false;
    }

    let zi = 0;
    for (const key of ["bg", "image", "grid", "overrides", "telegraph", "entities", "hover", "effects", "ui", "hit"]) {
      this.layers[key].zIndex = zi++;
      this.app.stage.addChild(this.layers[key]);
    }

    for (const key of ["bg", "image", "grid", "overrides", "telegraph", "entities", "hover", "effects", "ui"]) {
      const c = this.layers[key];
      c.eventMode = "none";
      c.interactive = false;
      c.interactiveChildren = false;
    }

    this._buildHitLayer();

    this.players = new Map();
    this.playerDisp = new Map();

    this.bosses = new Map();
    this.bossDisp = new Map();
    this.boss = null;
    this.bossSpriteFirstUid = null;

    this.skill = null;
    this.caster = null;
    this._floating = new Set();

    this.mapSprite = null;
    this.effectSheet = PIXI.Texture.from("assets/effect.png").baseTexture;
    this.statusSheet = PIXI.Texture.from("assets/status_icons.png").baseTexture;

    this._statusIndex = {
      burn: 0, poison: 1, bleed: 2, regen: 3, taunt: 4,
      adrenaline: 5, empower: 6, vuln: 7, fortify: 8,
      haste: 9, reflect: 10
    };

    this._buildMapSprite();

    this.app.ticker.add(this._tick);

    socket.on('player:healed', ({ healed }) => {
      if (!Array.isArray(healed)) return;
      for (const h of healed) {
        const p = this.players.get(h.id);
        if (!p) continue;
        this.spawnFloatingDamageAtTile({ x: p.x, y: p.y }, `+${h.amount}`, { heal: true });
        p.hp = h.hp;
        this._ensurePlayerDisp(p);
      }
    });

    socket.on('player:healed:tick', ({ healed }) => {
      if (!Array.isArray(healed)) return;
      for (const h of healed) {
        const p = this.players.get(h.id);
        if (!p) continue;
        this.spawnFloatingDamageAtTile({ x: p.x, y: p.y }, `+${h.amount}`, { heal: true });
        p.hp = h.hp;
        this._ensurePlayerDisp(p);
      }
    });

    socket.on('boss:damaged', (payload) => {
      // payload: { dmg|damage|amount|value, crit, bossId(uid), hp, maxHp? }
      const raw = payload.amount ?? payload.damage ?? payload.dmg ?? payload.value ?? 0;
      const val = Math.max(0, Number(raw) | 0);
      const crit = !!payload.crit;
      const bossUid = payload.bossId ?? null;

      this.spawnFloatingDamageAtBoss(`-${val}`, { crit }, bossUid);

      // HP 동기화
      if (bossUid && payload.hp != null) {
        const b = this.bosses.get(bossUid);
        if (b) {
          b.hp = payload.hp;
          if (payload.maxHp != null) b.maxHp = payload.maxHp;
          const disp = this.bossDisp.get(bossUid);
          if (disp) this._updateHPBar(disp._hpBar, b.hp, b.maxHp || 100);
        }
      } else if (!bossUid && payload.hp != null) {
        // 하위호환: 단일 보스 가정
        const first = this._firstBoss();
        if (first) {
          first.hp = payload.hp;
          const disp = this.bossDisp.get(first.uid);
          if (disp) this._updateHPBar(disp._hpBar, first.hp, first.maxHp || 100);
        }
      }
    });

    socket.on('boss:damaged:tick', (payload) => {
      const raw = payload.amount ?? payload.damage ?? payload.dmg ?? payload.value ?? 0;
      const val = Math.max(0, Number(raw) | 0);
      const crit = !!payload.crit;
      const bossUid = payload.bossId ?? null;

      this.spawnFloatingDamageAtBoss(`-${val}`, { crit }, bossUid);

      // HP 동기화
      if (bossUid && payload.hp != null) {
        const b = this.bosses.get(bossUid);
        if (b) {
          b.hp = payload.hp;
          if (payload.maxHp != null) b.maxHp = payload.maxHp;
          const disp = this.bossDisp.get(bossUid);
          if (disp) this._updateHPBar(disp._hpBar, b.hp, b.maxHp || 100);
        }
      } else if (!bossUid && payload.hp != null) {
        // 하위호환: 단일 보스 가정
        const first = this._firstBoss();
        if (first) {
          first.hp = payload.hp;
          const disp = this.bossDisp.get(first.uid);
          if (disp) this._updateHPBar(disp._hpBar, first.hp, first.maxHp || 100);
        }
      }
    });

    this._attackFx = {
      default: { src: 'https://scenario-messiah.com/battle/assets/effect/hit_simple.png', fw: 64, fh: 64, cols: 4, rows: 4, speed: 0.5, loop: false, anchor: 0.5, blend: PIXI.BLEND_MODES.ADD, yOffset: 0 },
      slash: { src: 'https://scenario-messiah.com/battle/assets/effect/slash.png', fw: 64, fh: 64, cols: 8, rows: 2, speed: 0.8, loop: false, anchor: 0.5, blend: PIXI.BLEND_MODES.NORMAL, yOffset: 0 },
      boom: { src: 'https://scenario-messiah.com/battle/assets/effect/hit.png', fw: 64, fh: 64, cols: 8, rows: 8, speed: 0.5, loop: false, anchor: 0.5, blend: PIXI.BLEND_MODES.ADD, yOffset: 0 },
      heal: { src: 'https://scenario-messiah.com/battle/assets/effect/heal.png', fw: 64, fh: 64, cols: 8, rows: 4, speed: 0.5, loop: false, anchor: 0.5, blend: PIXI.BLEND_MODES.ADD, yOffset: 0 }
    };

    this._skillFxMap = new Map([
      ['slash', 'slash'],
      ['fireball', 'boom'],
      ['heal', 'heal'],
    ]);
  }

  applyDamageBatch(hits) {
    if (!Array.isArray(hits)) return;
    for (const d of hits) {
      const p = this.players?.get?.(d.id);
      if (!p) continue;

      const val = (typeof d.dmg === 'number')
        ? Math.max(0, Math.trunc(d.dmg))
        : null;

      const show = (val != null) ? `-${val}` : (typeof d.hp === 'number')
        ? `-${Math.max(0, Math.trunc((p.hp | 0) - d.hp))}`
        : '-0';
      this.spawnFloatingDamageAtTile({ x: p.x, y: p.y }, show, { crit: !!d.crit });

      if (typeof d.hp === 'number') {
        p.hp = Math.max(0, d.hp);
      } else if (val != null) {
        p.hp = Math.max(0, (p.hp | 0) - val);
      }

      this._ensurePlayerDisp(p);
    }
  }

  setOnTileHover(fn) { this.onTileHover = fn; }
  clearHover() { this.layers.hover.removeChildren(); }

  showHoverTarget(tile, { valid = true, color } = {}) {
    const g = new PIXI.Graphics();
    const col = (typeof color === 'number') ? color : (valid ? 0x44ff88 : 0xff5566);
    const alpha = 0.9;
    const s = this.tileSize;

    const player = [...this.players.values()].find(p => p.x === tile.x && p.y === tile.y);

    const inBoss = (() => {
      for (const b of this.bosses.values()) {
        const w = Math.max(1, b.size?.w || 1);
        const h = Math.max(1, b.size?.h || 1);
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) {
            if (b.x + dx === tile.x && b.y + dy === tile.y) return b;
          }
        }
      }
      return null;
    })();

    this.layers.hover.removeChildren();

    if (inBoss) {
      const b = inBoss;
      const w = Math.max(1, b.size?.w || 1);
      const h = Math.max(1, b.size?.h || 1);
      g.lineStyle(3, col, alpha);
      g.drawRoundedRect(b.x * s, b.y * s, w * s, h * s, 6);
    } else if (player) {
      g.lineStyle(3, col, alpha);
      g.drawRoundedRect(tile.x * s, tile.y * s, s, s, 6);
    } else {
      g.lineStyle(2, col, 0.7);
      const pad = 4;
      const x = tile.x * s, y = tile.y * s;
      const w = s, h = s, seg = 10;
      g.moveTo(x + pad, y); g.lineTo(x + pad + seg, y);
      g.moveTo(x, y + pad); g.lineTo(x, y + pad + seg);
      g.moveTo(x + w - pad, y); g.lineTo(x + w - pad - seg, y);
      g.moveTo(x + w, y + pad); g.lineTo(x + w, y + pad + seg);
      g.moveTo(x + pad, y + h); g.lineTo(x + pad + seg, y + h);
      g.moveTo(x, y + h - pad); g.lineTo(x, y + h - pad - seg);
      g.moveTo(x + w - pad, y + h); g.lineTo(x + w - pad - seg, y + h);
      g.moveTo(x + w, y + h - pad); g.lineTo(x + w, y + h - pad - seg);
    }

    g.eventMode = "none";
    this.layers.hover.addChild(g);
  }

  renderStatusIcons(disp, statuses) {
    if (!disp) return;
    if (!disp._statusLayer) {
      const cont = new PIXI.Container();
      cont.zIndex = (disp.zIndex || 10) + 1;
      disp.addChild(cont);
      disp._statusLayer = cont;
    }
    const layer = disp._statusLayer;
    layer.removeChildren();
    if (!Array.isArray(statuses) || statuses.length === 0) return;

    const size = 12, pad = 2, maxIcons = 6;
    const shown = statuses.slice(0, maxIcons);
    const totalWidth = (shown.length - 1) * (size + pad);
    const baseX = -totalWidth / 2;
    const baseY = -32;

    for (let i = 0; i < shown.length; i++) {
      const s = shown[i];
      const idx = this._statusIndex[s.id] ?? 0;
      const tex = new PIXI.Texture(this.statusSheet, new PIXI.Rectangle(idx * 20, 0, 20, 20));
      const spr = new PIXI.Sprite(tex);
      spr.width = size; spr.height = size;
      spr.anchor.set(0.5, 1);
      spr.x = baseX + i * (size + pad);
      spr.y = baseY;
      layer.addChild(spr);

      const stacks = s.stacks ?? 1;
      if (stacks > 1) {
        const txt = new PIXI.Text(String(stacks), {
          fontSize: 8, fill: 0xffffff, stroke: 0x000000, strokeThickness: 2
        });

        txt.anchor.set(0.5, 1);
        txt.x = spr.x + size / 2 - 4;
        txt.y = baseY;
        layer.addChild(txt);
      }
    }
  }

  _buildMapSprite() {
    const spr = new PIXI.Sprite(PIXI.Texture.EMPTY);
    spr.eventMode = "none";
    spr.interactive = false;
    spr.interactiveChildren = false;

    this.layers.image.removeChildren();
    this.layers.image.addChild(spr);
    this.mapSprite = spr;
  }

  _buildHitLayer() {
    const g = new PIXI.Graphics();
    g.cursor = "pointer";
    g.eventMode = "static";
    g.interactive = true;

    g.on("pointerdown", (e) => {
      if (!this.onTileClick) return;
      const local = e.data.getLocalPosition(this.app.stage);
      const tx = Math.floor(local.x / this.tileSize);
      const ty = Math.floor(local.y / this.tileSize);
      if (tx < 0 || ty < 0 || tx >= this.n || ty >= this.n) return;
      this.onTileClick({ x: tx, y: ty });
    });

    g.on("pointermove", (e) => {
      if (!this.onTileHover) return;
      const local = e.data.getLocalPosition(this.app.stage);
      const tx = Math.floor(local.x / this.tileSize);
      const ty = Math.floor(local.y / this.tileSize);
      if (tx < 0 || ty < 0 || tx >= this.n || ty >= this.n) { this.clearHover(); return; }
      this.onTileHover({ x: tx, y: ty });
    });
    g.on("pointerout", () => { this.clearHover(); if (this.clearAim) this.clearAim(); });

    this.layers.hit.addChild(g);
    this.hitGraphic = g;
    this._redrawHitLayer();
  }

  _redrawHitLayer() {
    const w = this.n * this.tileSize;
    const h = this.n * this.tileSize;
    this.hitGraphic.clear();
    this.hitGraphic.beginFill(0x000000, 0.0001);
    this.hitGraphic.drawRect(0, 0, w, h);
    this.hitGraphic.endFill();
  }

  _framesFromGrid(src, fw, fh, cols, rows) {
    let base;
    if (src instanceof PIXI.BaseTexture) base = src;
    else if (src instanceof PIXI.Texture) base = src.baseTexture;
    else base = PIXI.Texture.from(src).baseTexture;

    const arr = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        arr.push(new PIXI.Texture(base, new PIXI.Rectangle(x * fw, y * fh, fw, fh)));
      }
    }
    return arr;
  }

  _makeAnimFrames(src, fw, fh, frameCount = 1, rowIndex = 0, startCol = 0) {
    const baseTexture =
      src instanceof PIXI.BaseTexture ? src :
        (src instanceof PIXI.Texture ? src.baseTexture : PIXI.Texture.from(src).baseTexture);

    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const rect = new PIXI.Rectangle((startCol + i) * fw, rowIndex * fh, fw, fh);
      frames.push(new PIXI.Texture(baseTexture, rect));
    }
    return frames;
  }

  _firstBoss() {
    if (this.bosses.size === 0) return null;

    if (this.boss && this.bosses.get(this.boss.uid) === this.boss) return this.boss;

    const it = this.bosses.values().next();
    if (it.done) return null;
    const b = it.value;

    this.boss = b;
    this.bossSpriteFirstUid = b.uid;
    return b;
  }

  setOnTileClick(fn) { this.onTileClick = fn; }

  tileToScreen(t) { return { x: t.x * this.tileSize, y: t.y * this.tileSize }; }
  centerOfTile(t) { const p = this.tileToScreen(t); return { x: p.x + this.tileSize / 2, y: p.y + this.tileSize / 2 }; }

  _resizeToMap() {
    const w = this.n * this.tileSize;
    const h = this.n * this.tileSize;
    this.app.renderer.resize(w, h);
    if (this.mapSprite) { this.mapSprite.width = w; this.mapSprite.height = h; }
    this._redrawHitLayer();
  }

  _drawGrid() {
    const g = new PIXI.Graphics();
    const s = this.tileSize, n = this.n;
    g.clear();

    // 그리드 선
    const color = this.map?.assets?.grid || 0xffffff;
    g.lineStyle(1, color, 0.3);
    for (let x = 0; x <= n; x++) { g.moveTo(x * s, 0); g.lineTo(x * s, n * s); }
    for (let y = 0; y <= n; y++) { g.moveTo(0, y * s); g.lineTo(n * s, y * s); }

    if (this.tiles) {
      g.beginFill(0xffffff, 0.3);
      this.tiles.forEach((row, y) => {
        row.forEach((val, x) => {
          if (val === 1) {
            g.drawRect(x * s, y * s, s, s);
          }
        });
      });
      g.endFill();
    }

    this.layers.grid.removeChildren();
    g.eventMode = "none";
    this.layers.grid.addChild(g);
  }

  setOverrides(arr) {
    this._overrides = Array.isArray(arr) ? arr : [];
    this._drawOverrides();
  }

  _drawOverrides() {
    const s = this.tileSize;
    const g = new PIXI.Graphics();
    g.clear();

    for (const o of this._overrides) {
      switch (o.id) {
        case "bleed":
        case "burn":
        case "poison":
        case "vuln":
          g.beginFill(0xff0000, 0.35); // 빨강
          break;

        case "heal":
        case "regen":
          g.beginFill(0x00ff00, 0.35); // 초록
          break;

        case "fortify":
          g.beginFill(0x3399ff, 0.35); // 파랑
          break;

        case "empower":
        case "adrenaline":
          g.beginFill(0xffff00, 0.35); // 노랑
          break;

        case "haste":
          g.beginFill(0xaa66ff, 0.35); // 보라
          break;

        default:
          g.beginFill(0x888888, 0.2); // 회색
          break;
      }

      const x = o.x, y = o.y;
      g.drawRect(x * s, y * s, s, s);
    }

    g.endFill();

    this.layers.overrides.removeChildren();
    g.eventMode = "none";
    this.layers.overrides.addChild(g);
  }

  setMap(map) {
    this.map = map;
    if (map && map.n) this.n = map.n;
    if (map && map.tiles) this.tiles = map.tiles;

    this._resizeToMap();
    this._drawGrid();
  }

  setTelegraph(skill, caster) { this.skill = skill; this.caster = caster; this.drawRange(); }
  setSkillContext(skill, caster) { this.setTelegraph(skill, caster); }
  clearTelegraph() { this.layers.telegraphRange.removeChildren(); }

  drawRange() {
    const c = this.layers.telegraphRange;
    c.removeChildren();
    if (!this.map || !this.skill || !this.caster) return;

    const s = this.tileSize, n = this.map.n;
    const R = this.skill.range ?? 1;
    const g = new PIXI.Graphics();
    g.beginFill(0x66ff99, 0.15);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = this.caster.x + dx, y = this.caster.y + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (Math.abs(dx) + Math.abs(dy) <= R) g.drawRect(x * s, y * s, s, s);
      }
    }
    g.endFill();
    g.eventMode = "none";
    c.addChild(g);
  }

  _ensurePlayerDisp(p) {
    let disp = this.playerDisp.get(p.id);
    if (!disp) {
      const url = `../explore/assets/player/character${p.id}.png`;
      const fw = 32, fh = 32, cols = 8, rows = 4;
      const frames = this._framesFromGrid(url, fw, fh, cols, rows);

      const anim = new PIXI.AnimatedSprite(frames);
      anim.anchor.set(0.5);
      anim.gotoAndStop(4);

      const hpBar = this._makeHPBar(40, 4, 0x20b2aa);
      hpBar.y = 32;
      anim.addChild(hpBar);
      anim._hpBar = hpBar;

      anim.eventMode = "none";
      anim.interactive = false;
      anim.interactiveChildren = false;
      this.layers.entities.addChild(anim);
      this.playerDisp.set(p.id, anim);
      disp = anim;

      if (p.id == window.characterId) {
        const outline = new PIXI.filters.OutlineFilter(2, 0x99ff99);
        disp.filters = [outline];
      }
    }

    if (p.hp <= 0) {
      disp.tint = 0x000000;
    } else {
      disp.tint = 0xFFFFFF;
    }

    const c = this.centerOfTile(p);
    disp.x = c.x;
    disp.y = c.y;
    this.renderStatusIcons(disp, p.statuses);
    this._updateHPBar(disp._hpBar, p.hp, p.maxHp || 100);
  }

  upsertPlayer(p) {
    this.players.set(p.id, p);
    this._ensurePlayerDisp(p);
  }

  upsertBoss(b) {
    if (!b) return;
    if (Array.isArray(b)) { b.forEach(bb => this.upsertBoss(bb)); return; }

    const uid = b.uid ?? b.id;
    const speciesId = String(b.id || 'unknown');

    this.bosses ||= new Map();
    this.bossDisp ||= new Map();

    this.bosses.set(uid, b);

    if (!this.boss) { this.boss = b; this.bossSpriteFirstUid = uid; }

    let anim = this.bossDisp.get(uid);
    if (!anim) {
      const url = `https://scenario-messiah.com/battle/assets/boss/${speciesId}.png`;
      const frames = this._makeAnimFrames(url, 64, 64, 1);
      anim = new PIXI.AnimatedSprite(frames);
      anim.animationSpeed = 0.1; anim.play(); anim.anchor.set(0.5);
      const hpBar = this._makeHPBar(52, 6, 0xff4444); hpBar.y = 40;
      anim.addChild(hpBar); anim._hpBar = hpBar;
      anim.eventMode = "none";
      anim.interactive = false;
      anim.interactiveChildren = false;
      this.layers.entities.addChild(anim);
      this.bossDisp.set(uid, anim);
    }

    if (b.hp <= 0) {
      anim.tint = 0x000000;
    } else {
      anim.tint = 0xFFFFFF;
    }

    const c = this.centerOfTile(b);
    anim.x = c.x; anim.y = c.y;
    this.renderStatusIcons(anim, b.statuses);
    this._updateHPBar(anim._hpBar, b.hp, b.maxHp ?? 100);
  }

  spawnFloatingTextScreen(x, y, text, color = 0xffd966, opts = {}) {
    const label = new PIXI.Text(String(text), {
      fontFamily: "monospace", fontSize: 18, fill: color, stroke: 0x000000, strokeThickness: 3
    });
    const jx = (opts.jitterX ?? ((Math.random() * 12) - 6));
    const jy = (opts.jitterY ?? ((Math.random() * 8) - 4));
    label.x = x + jx;
    label.y = y + jy;
    label.alpha = 1.0;
    label.zIndex = 10;
    label.eventMode = "none";

    const life = opts.life || 900;
    const vy = opts.vy || -0.06;
    const fade = opts.fade || 0.015;
    const obj = { label, life, vy, fade };
    this.layers.ui.addChild(label);
    this._floating.add(obj);
  }

  spawnFloatingDamageAtTile(tile, amount, { crit = false, heal = false } = {}) {
    const c = this.centerOfTile(tile);
    const color = heal ? 0x9cff8a : (crit ? 0xff4757 : 0xffd166);
    const jitter = crit ? 12 : 6;
    this.spawnFloatingTextScreen(c.x, c.y - 10, amount, color, {
      jitterX: (Math.random() * jitter) - jitter / 2,
      jitterY: (Math.random() * jitter) - jitter / 2,
      life: crit ? 1100 : 900,
      vy: crit ? -0.08 : -0.06,
      fade: crit ? 0.020 : 0.015,
    });
  }

  spawnFloatingDamageAtBoss(amount, { crit = false } = {}, bossId = null) {
    let b = null;
    if (bossId) b = this.bosses.get(bossId);
    if (!b) b = this._firstBoss();
    if (!b) return;
    this.spawnFloatingDamageAtTile({ x: b.x, y: b.y }, amount, { crit });
  }

  _tick = (delta) => {
    const rm = [];
    for (const obj of this._floating) {
      obj.label.y += obj.vy * (delta * 16.6);
      obj.label.alpha -= obj.fade * delta;
      obj.life -= (delta * 16.6);
      if (obj.life <= 0 || obj.label.alpha <= 0) rm.push(obj);
    }
    for (const o of rm) {
      this._floating.delete(o);
      if (o.label.parent) o.label.parent.removeChild(o.label);
      o.label.destroy();
    }
  }

  _shakeTarget(display, power = 4, duration = 120) {
    if (!display) return;
    const ox = display.x, oy = display.y;
    let t = 0;
    const ticker = (dt) => {
      t += dt * 16.6;
      const p = Math.max(0, 1 - t / duration);
      const amp = power * p;
      display.x = ox + (Math.random() * 2 - 1) * amp;
      display.y = oy + (Math.random() * 2 - 1) * amp;
      if (t >= duration) {
        display.x = ox; display.y = oy;
        this.app.ticker.remove(ticker);
      }
    };
    this.app.ticker.add(ticker);
  }

  shakeBoss(bossId = null) {
    const uid = bossId ?? this.bossSpriteFirstUid;
    const disp = this.bossDisp.get(uid);
    this._shakeTarget(disp, 6, 160);
  }

  shakePlayer(id) { this._shakeTarget(this.playerDisp.get(id), 5, 140); }

  spawnEffectAtTile(tile) {
    const base = this.effectSheet;
    const frames = [];
    const fw = 64, fh = 64, count = 8;
    for (let i = 0; i < count; i++) {
      frames.push(new PIXI.Texture(base, new PIXI.Rectangle(i * fw, 0, fw, fh)));
    }
    const anim = new PIXI.AnimatedSprite(frames);
    const c = this.centerOfTile(tile);
    anim.x = c.x; anim.y = c.y;
    anim.anchor.set(0.5);
    anim.loop = false;
    anim.animationSpeed = 0.4;
    anim.eventMode = "none";
    anim.onComplete = () => { if (anim.parent) anim.parent.removeChild(anim); anim.destroy(); };
    this.layers.effects.addChild(anim);
    anim.play();
  }

  _nearestAlivePlayer(from, maxRange) {
    let best = null, bestD = Infinity;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const d = Math.abs(p.x - from.x) + Math.abs(p.y - from.y);
      if (d < bestD && (maxRange == null || d <= maxRange)) {
        best = p; bestD = d;
      }
    }
    return best;
  }

  _axisToward(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'down' : 'up';
  }

  /* hp bar */
  _makeHPBar(width, height, color = 0xff4444) {
    const cont = new PIXI.Container();

    const bg = new PIXI.Graphics();
    bg.lineStyle(1, 0xffffff, 0.6);
    bg.beginFill(0x000000, 0.4);
    bg.drawRoundedRect(0, 0, width, height, height / 2);
    bg.endFill();

    const fg = new PIXI.Graphics();
    fg.beginFill(color);
    fg.drawRoundedRect(0, 0, width, height, height / 2);
    fg.endFill();

    cont.addChild(bg);
    cont.addChild(fg);

    cont._bg = bg;
    cont._fg = fg;
    cont._width = width;
    cont._height = height;
    cont._color = color;

    cont.x = -width / 2;
    cont.y = 32;

    return cont;
  }

  _updateHPBar(bar, hp, maxHp) {
    if (!bar || !bar._fg) return;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    bar._fg.clear();
    bar._fg.beginFill(bar._color);
    bar._fg.drawRoundedRect(0, 0, bar._width * ratio, bar._height, bar._height / 2);
    bar._fg.endFill();
  }

  spawnAttackEffectAtTile(tile, fxIdOrCfg = 'default') {
    const cfg = (typeof fxIdOrCfg === 'string')
      ? (this._attackFx[fxIdOrCfg] || this._attackFx.default)
      : (fxIdOrCfg || this._attackFx.default);

    const frames = this._framesFromGrid(cfg.src, cfg.fw, cfg.fh, cfg.cols, cfg.rows);

    const anim = new PIXI.AnimatedSprite(frames);
    const c = this.centerOfTile(tile);

    anim.x = c.x;
    anim.y = c.y + (cfg.yOffset || 0);
    anim.anchor.set(cfg.anchor ?? 0.5);
    anim.loop = !!cfg.loop;
    anim.animationSpeed = cfg.speed ?? 0.4;
    anim.eventMode = "none";
    if (cfg.blend != null) anim.blendMode = cfg.blend;

    anim.onComplete = () => {
      if (anim.parent) anim.parent.removeChild(anim);
      anim.destroy();
    };

    this.layers.effects.addChild(anim);
    anim.play();
  }

  spawnAttackEffectOnTiles(tiles, fxIdOrCfg = 'default') {
    if (!Array.isArray(tiles)) return;
    for (const t of tiles) this.spawnAttackEffectAtTile(t, fxIdOrCfg);
  }

  mapSkillEffect(skillId, fxIdOrCfg) { this._skillFxMap.set(String(skillId), fxIdOrCfg); }

  spawnSkillEffect(skillId, tile) {
    const map = this._skillFxMap;
    const fx = map.get(String(skillId)) ?? 'default';
    this.spawnAttackEffectAtTile(tile, fx);
  }

  _buildTelegraphPattern(tele) {
    if (!tele || !tele.type) return null;
    const life = Math.max(300, (tele.windupMs | 0));

    const pickBoss = () => {
      if (tele.bossId) return this.bosses.get(tele.bossId) || null;
      return this._firstBoss();
    };

    if (tele.type === 'attackCircleSelf') {
      const boss = pickBoss() || { x: 0, y: 0 };
      return {
        shape: 'circle',
        center: { x: boss.x, y: boss.y },
        radius: (tele.radius | 0) || 1,
        durationMs: life,
      };
    }

    if (tele.type === 'attackCircleTarget') {
      const boss = pickBoss() || { x: 0, y: 0 };
      const target = this._nearestAlivePlayer(boss, tele.range);
      if (!target) return null;
      return {
        shape: 'circle',
        center: { x: target.x, y: target.y },
        radius: (tele.radius | 0) || 1,
        durationMs: life,
      };
    }

    if (tele.type === 'attackLineRow') {
      const boss = pickBoss() || { x: 0, y: 0 };
      const target = this._nearestAlivePlayer(boss, null);
      if (!target) return null;
      const dir = this._axisToward(boss, target);
      return {
        shape: 'rectLine',
        origin: { x: boss.x, y: boss.y },
        dir,
        length: (tele.length | 0) || 5,
        width: (tele.width | 0) || 1,
        durationMs: life,
      };
    }

    return null;
  }

  _tilesInCircle(center, radius) {
    const n = this.map?.n ?? this.n;
    const inBounds = (x, y) => (x >= 0 && y >= 0 && x < n && y < n);

    const res = [];
    const R = (radius | 0);
    const cx = (center.x | 0);
    const cy = (center.y | 0);
    const r2 = R * R;

    for (let y = cy - R; y <= cy + R; y++) {
      for (let x = cx - R; x <= cx + R; x++) {
        if (!inBounds(x, y)) continue;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) res.push({ x, y });
      }
    }
    return res;
  }

  _tilesInRectLine(origin, dir, length, width = 1) {
    const n = this.map?.n ?? this.n;
    const L = Math.max(1, Number(length) | 0);
    const W = Math.max(1, Number(width) | 0);
    const ox = Number(origin.x);
    const oy = Number(origin.y);

    const half = Math.floor((W - 1) / 2);
    const tiles = [];

    if (dir === "left" || dir === "right") {
      const y0 = Math.max(0, oy - half);
      const y1 = Math.min(n - 1, oy + half + ((W % 2) ? 0 : 1));
      const step = (dir === "right") ? +1 : -1;
      let x = ox + step;
      for (let k = 0; k < L; k++, x += step) {
        if (x < 0 || x >= n) break;
        for (let y = y0; y <= y1; y++) tiles.push({ x, y });
      }
    } else {
      const x0 = Math.max(0, ox - half);
      const x1 = Math.min(n - 1, ox + half + ((W % 2) ? 0 : 1));
      const step = (dir === "down") ? +1 : -1;
      let y = oy + step;
      for (let k = 0; k < L; k++, y += step) {
        if (y < 0 || y >= n) break;
        for (let x = x0; x <= x1; x++) tiles.push({ x, y });
      }
    }
    return tiles;
  }

  _drawTelegraphTiles(tiles, { durationMs = 800, fill = 0xff0000, alpha = 0.28, outline = 0xff5555 } = {}) {
    if (!tiles?.length) return;
    const s = this.tileSize;
    const g = new PIXI.Graphics();
    g.beginFill(fill, alpha);
    g.lineStyle(1, outline, 0.7);
    for (const t of tiles) g.drawRect(t.x * s, t.y * s, s, s);
    g.endFill();
    g.eventMode = "none";
    g.zIndex = 1;
    g.blendMode = PIXI.BLEND_MODES.ADD;

    this.layers.telegraphWarn.addChild(g);
    setTimeout(() => { if (g.parent) g.parent.removeChild(g); g.destroy(); }, durationMs);
  }

  _drawTelegraphCircle({ center, radius = 1, durationMs = 800 }) {
    if (!this.map || !center) return;
    const tiles = this._tilesInCircle(center, radius);
    this._drawTelegraphTiles(tiles, { durationMs });
  }

  _drawTelegraphRectLine({ origin, dir, length, width, durationMs = 800 }) {
    if (!this.map || !origin || !dir) return;
    const tiles = this._tilesInRectLine(origin, dir, length, width);
    this._drawTelegraphTiles(tiles, { durationMs });
  }

  _drawPreviewTiles(tiles, { fill = 0x3846dc, alpha = 0.22, outline = 0x3846dc } = {}) {
    if (!tiles?.length) return;
    const s = this.tileSize;
    const g = new PIXI.Graphics();
    g.beginFill(fill, alpha);
    g.lineStyle(1, outline, 0.6);
    for (const t of tiles) g.drawRect(t.x * s, t.y * s, s, s);
    g.endFill();
    g.eventMode = "none";
    g.zIndex = 2;
    this.layers.telegraphAim.addChild(g);
  }

  _tilesInSquare(center, r) {
    const n = this.map?.n ?? this.n;
    const res = [], cx = center.x | 0, cy = center.y | 0;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x >= 0 && y >= 0 && x < n && y < n) res.push({ x, y });
      }
    }
    return res;
  }

  _tilesInDiamond(center, r) {
    const n = this.map?.n ?? this.n;
    const res = [], cx = center.x | 0, cy = center.y | 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (Math.abs(dx) + Math.abs(dy) <= r) res.push({ x, y });
      }
    }
    return res;
  }

  showSkillPreviewAt(tile) {
    this.clearAim();
    if (!this.map || !this.skill) return;

    const shape = this.skill.aoeShape || this.skill.shape || 'diamond';
    const radius = (this.skill.aoeRadius ?? this.skill.radius ?? 1) | 0;
    const width = (this.skill.aoeWidth ?? this.skill.width ?? 1) | 0;
    const length = (this.skill.aoeLength ?? this.skill.length ?? 1) | 0;

    let tiles = null;
    switch (shape) {
      case 'circle': tiles = this._tilesInCircle(tile, Math.max(0, radius)); break;
      case 'square': tiles = this._tilesInSquare(tile, Math.max(0, radius)); break;
      case 'line': {
        const caster = (this.caster && typeof this.caster.x === 'number') ? this.caster : tile;
        const dir = this._axisToward(caster, tile);
        tiles = this._tilesInRectLine(tile, dir, Math.max(1, length), Math.max(1, width));
        break;
      }
      case 'diamond': tiles = this._tilesInDiamond(tile, Math.max(0, radius)); break;
      case 'single':
      default: tiles = [{ x: tile.x | 0, y: tile.y | 0 }]; break;
    }

    this._drawPreviewTiles(tiles, { fill: 0x3846dc, alpha: 0.22, outline: 0x3846dc });
  }

  showTelegraphFromHint(tele) {
    const pat = this._buildTelegraphPattern(tele);
    if (!pat) return;
    if (pat.shape === 'circle') return this._drawTelegraphCircle(pat);
    if (pat.shape === 'rectLine') return this._drawTelegraphRectLine(pat);
  }

  clearAim() { this.layers.telegraphAim.removeChildren(); }

  showTele(tele, windupMs = 800, bossType = 'sub') {
    const tiles = Array.isArray(tele) ? tele : (tele?.tiles || []);
    if (!tiles.length) return;

    function getTeleStyleByBossType(bossType) {
      if (bossType === 'main') {
        return {
          fill: 0xff0000,
          outline: 0xff5555,
          alpha: 0.28
        };
      }
      return {
        fill: 0xff0000,
        outline: 0xff5555,
        alpha: 0.28
      };
    }

    const style = getTeleStyleByBossType(bossType);

    this._drawTelegraphTiles(tiles, {
      durationMs: windupMs,
      fill: style.fill,
      alpha: style.alpha,
      outline: style.outline
    });
  }
}
