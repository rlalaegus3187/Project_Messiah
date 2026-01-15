
import { socket, joinRaid } from './net.js';
import { HUD } from '../hud.js';
import { GridRenderer } from './grid.js';
import { SkillUI } from './skills.js';

const app = new PIXI.Application({
  resizeTo: window,
  antialias: true,
  backgroundAlpha: 0,
});

document.getElementById('game').appendChild(app.view);

const hud = new HUD();
const grid = new GridRenderer(app);
const ui = new SkillUI();

let you = null;
let skills = [];
let raidOver = false;

const STATUS_KO = {
  burn: '화상',
  poison: '중독',
  bleed: '출혈',
  regen: '재생',
  stun: '기절',
  slow: '감속',
  shield: '보호막',
  vuln: '취약',
  fortify: '강화',
  haste: '가속',
};

let bossMap = new Map();


function refreshTelegraph() {
  if (!you) return;
  const s = skills.find(x => x.id === ui.selected) || null;
  grid.setSkillContext(s, you);
}

function updateHUD() {
  hud.updateYou(you);
  const alive = !!you && you.hp > 0 && !raidOver;
  ui.updateAP(alive ? (you?.ap || 0) : 0);
  ui.updateAlive(alive);
  refreshTelegraph();
}

function displayName(idOrObj) {
  if (!idOrObj) return '';
  const id = typeof idOrObj === 'string' ? idOrObj : (idOrObj.id || idOrObj.label || idOrObj.action || '');
  const name = (typeof idOrObj === 'object' && idOrObj.name) ? String(idOrObj.name) : null;
  return name || STATUS_KO[id] || String(id);
}

grid.setOnTileClick((tile) => {
  if (!you || !grid.map) return;
  if (raidOver || (you.hp <= 0)) return;
  if (ui.selected) {
    const skillId = ui.selected;
    const skill = skills.find(s => s.id === skillId);

    socket.emit('action:skill', { skillId: ui.selected, target: tile });

    if (skill?.cooldown) {
      ui.setCooldowns({ [skillId]: skill.cooldown });
    }

    ui.clearSelection();
    grid.clearHover();
  } else {
    socket.emit('input:move', { to: tile });
  }
});

ui.onSelect = (_skill) => {
  refreshTelegraph();
  if (!_skill && grid.clearAim) grid.clearAim();
};

grid.setOnTileHover((tile) => {
  if (!you || !grid.map) { grid.clearHover(); return; }
  const s = skills.find(x => x.id === ui.selected);
  if (!s) { grid.clearHover(); return; }
  const dist = Math.abs(you.x - tile.x) + Math.abs(you.y - tile.y);
  const R = s.range ?? 1;
  const inRange = dist <= R;
  grid.showHoverTarget(tile, { valid: inRange });

  grid.setSkillContext(s, you);
  if (inRange && grid.showSkillPreviewAt) {
    grid.showSkillPreviewAt(tile);
  } else if (grid.clearAim) {
    grid.clearAim();
  }
});

function normalizeHits(hits) {
  if (!Array.isArray(hits)) return [];
  const out = [];
  for (const h of hits) {
    const id = h.id ?? h.targetId ?? h.playerId;
    const hp = (typeof h.hp === 'number') ? h.hp : null;
    const dmg = (typeof h.dmg === 'number') ? Math.max(0, Math.trunc(h.dmg)) : null;
    out.push({ id, hp, dmg, crit: !!(h.crit || h.isCrit) });
  }
  return out;
}

function normalizeRewards(reward) {
  if (!reward) return [];
  if (Array.isArray(reward)) return reward;
  if (Array.isArray(reward.list)) return reward.list;
  return [];
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildRewardHTML(rewardList) {
  if (!Array.isArray(rewardList) || rewardList.length === 0) {
    return `<div>보상 : 없음</div>`;
  }

  const filtered = rewardList.filter(r => {
    return !r.playerId || r.playerId === you.id;
  });

  if (filtered.length === 0) {
    return `<div>내 보상 : 없음</div>`;
  }

  const agg = new Map();
  for (const r of filtered) {
    const key = `${r.type}:${r.rewardId}:${r.name || ""}:${r.img || ""}`;
    const prev = agg.get(key) || {
      type: r.type,
      rewardId: r.rewardId,
      count: 0,
      name: r.name,
      img: r.img
    };
    prev.count += Number(r.count || 1);
    if (r.name && !prev.name) prev.name = r.name;
    if (r.img && !prev.img) prev.img = r.img;
    agg.set(key, prev);
  }

  const items = [];
  for (const { type, rewardId, count, name, img } of agg.values()) {
    const title = name
      ? `[ <strong>${esc(name)}</strong> ]`
      : `[${esc(rewardId)}]`;

    const imgHTML = img
      ? `<img src="${esc(img)}" alt="${esc(name || rewardId)}" class="reward-thumb">`
      : "";

    items.push(`
      <li class="reward-item">
        ${imgHTML}
        <div class="reward-text">
          <div class="line1">${title} x <b>${esc(count)}</b></div>
        </div>
      </li>
    `);
  }

  return `
    <ul class="reward-list">
      ${items.join("\n")}
    </ul>
  `;
}

function renderResultPanel({ result, reason, reward, payload }) {
  const box = document.getElementById('result');
  if (!box) return;

  const titleEl = document.getElementById('result-title');
  const rewardEl = document.getElementById('result-reward');
  const okBtn = document.getElementById('result-ok');

  const title = (result === 'defeat') ? '전투 패배' : '전투 승리';

  titleEl.textContent = `${title}`;
  rewardEl.innerHTML = buildRewardHTML(normalizeRewards(reward));

  box.hidden = false;

  okBtn?.addEventListener('click', async () => {
    okBtn.disabled = true;

    try {
      const res = await fetch("https://scenario-messiah.com/battle/ajax/finish_battle.php", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json().catch(() => ({}));
      if (json?.ok === false) throw new Error(json?.message || "요청 실패");
    } catch (e) {
      console.error(e);
      const rewardEl2 = document.getElementById('result-reward');
      if (rewardEl2) {
        rewardEl2.innerHTML += `<div style="color:red;">${e.message || "요청 처리 중 오류가 발생했습니다."}</div>`;
      }
      okBtn.disabled = false;
      return;
    }

    box.hidden = true;
    window.location.href = "https://scenario-messiah.com";
  }, { once: true });

  box.classList.remove('hidden');

}

socket.on('boss:announce', ({ text, bossId }) => {
  hud.announce(text);
});

socket.on('boss:windup', ({ tele, windup, bossType }) => {
  grid.showTele(tele, windup, bossType);
});

socket.on('joined', ({ id, raidId, overrides, players, map, you: youMe, skills: skillList, bosses }) => {
  you = youMe;
  skills = skillList || [];

  grid.setMap(map);
  ui.build(skills);

  if (players) {
    for (const p of players) {
      hud.upsertPlayer(p);
      grid.upsertPlayer(p);
    }
  }

  if (bosses) {
    bossMap = new Map(bosses.map(boss => [boss.uid, boss]));
    grid.upsertBoss(bosses);
  }

  grid.setOverrides(overrides);

  updateHUD();
});

socket.on('tile:Overrides', ({ raidId, overrides }) => {
  grid.setOverrides(overrides);
});

socket.on('state', ({ players, bosses, mobs, over }) => {
  if (players) {
    for (const p of players) {
      grid.upsertPlayer(p);
      hud.updatePlayer(p);
      if (you && p.id === you.id) {
        you = { ...you, x: p.x, y: p.y, hp: p.hp, ap: p.ap, dead: p.dead };
      }
    }
  }

  if (bosses) {
    bossMap = new Map(bosses.map(boss => [boss.uid, boss]));
    grid.upsertBoss(bosses);
  }

  raidOver = !!over;
  if (raidOver) { hud.announce(over === 'defeat' ? '전투 패배' : '전투 종료'); }
  updateHUD();
});

socket.on('skill:cast', ({ caster, target, affectedTiles, hits, ap, skillId, skillName }) => {
  if (target) grid.spawnSkillEffect(skillId, target);
  if (Array.isArray(affectedTiles) && affectedTiles.length) {
    const fx = grid._skillFxMap.get(String(skillId)) || 'default';
    grid.spawnAttackEffectOnTiles(affectedTiles, fx);
  }
  if (you && caster === you.id && ui && ui.clearSelection) ui.clearSelection();
});

socket.on('players:damaged', ({ hits, origin }) => {
  if (!you || !Array.isArray(hits)) return;

  const getName = (id) => {
    const name = window?.chList?.[id]?.ch_name;
    if (id === you.id) return name || '나';
    return name || `플레이어#${id}`;
  };

  for (const h of hits) {
    const id = h.id;
    if (id == null) continue;

    let prevHp;
    if (id === you.id) {
      prevHp = you.hp ?? 0;
    } else {
      const p = grid?.players?.get?.(id);
      prevHp = (p && typeof p.hp === 'number') ? p.hp : undefined;
    }

    let dmg;
    if (typeof h.dmg === 'number') {
      dmg = Math.max(0, Math.trunc(h.dmg));
    } else if (typeof h.hp === 'number' && typeof prevHp === 'number') {
      dmg = Math.max(0, Math.trunc(prevHp - h.hp));
    } else {
      dmg = 0;
    }

    const name = getName(id);
    const bossName = (h.by) || "적";
    const actionName = (h.lable) || "공격";

    if (h.action == "reflect") {
      hud.log(`[${bossName}]이/가 ${dmg} 피해를 튕겨냈습니다.`, 'player');
    } else {
      hud.log(`[${name}]이/가 [${bossName}]의 ${actionName}(으)로 ${dmg} 피해를 받았습니다.`, 'player');
    }

    if (id === you.id) {
      grid?.shakePlayer?.(you.id);
      if (typeof h.hp === 'number') you.hp = h.hp;
      if ((prevHp ?? 0) > 0 && (you.hp ?? 0) <= 0) {
        hud.announce(`[${name}]이/가 쓰러졌습니다.`);
      }
      updateHUD?.();
    } else {
      if (typeof prevHp === 'number' && typeof h.hp === 'number' && prevHp > 0 && h.hp <= 0) {
        hud.announce(`[${name}]이/가 쓰러졌습니다.`);
      }
    }
  }

  if (grid && typeof grid.applyDamageBatch === 'function') {
    grid.applyDamageBatch(normalizeHits(hits));
  }
});

socket.on('player:damaged:tick', ({ dmg, by, name, id }) => {
  const byKo = by ? displayName(by) : null;
  hud.log(`[${name}]이/가 ${byKo}(으)로 ${dmg}의 피해를 입었습니다.`, 'playertick');
  grid.shakePlayer(id);
});

socket.on('player:healed', ({ healed, by, lable }) => {
  for (const h of healed) {
    hud.log(`[${h.to}]이/가 [${by}]의 ${lable}(으)로 ${healed[0]?.amount ?? 0}의 피해를 회복했습니다.`, 'heal');
  }
});

socket.on('player:healed:tick', ({ healed, by }) => {
  const byKo = by ? displayName(by) : null;
  hud.log(`[${healed[0].to}]이/가 ${byKo}(으)로 ${healed[0].amount}의 피해를 회복했습니다.`, 'healtick');
});

socket.on("boss:applyStatus", ({ boss, target, status }) => {
  let message;
  if (status == "reflect") {
    message = "특수한 장막을 두릅니다";
  } else {
    message = `${status ? displayName(status) : null}을/를 겁니다`;
  }

  hud.log(`[${boss}]이/가 [${target}]에게 ${message}.`, 'bossstatus');
});

socket.on('boss:hits', ({ hits, origin }) => {
  if (!you || !hits) return;
  const mine = hits.find(h => h.id === you.id);
  const dmg = (typeof mine.dmg === 'number') ? mine.dmg : Math.max(0, (you.hp || 0) - mine.hp);
  grid.shakePlayer(you.id);
});

socket.on('boss:damaged', ({
  dmg,
  hp,
  maxHp,
  by,
  action,
  crit,
  bossId,
  name
}) => {
  const byKo = by ? displayName(by) : null;
  hud.log(`[${by}]가 [${name}]에게 ${action}(으)로 ${dmg}의 피해를 입혔습니다.`, 'boss');
  grid.shakeBoss(bossId);
});

socket.on('boss:damaged:tick', ({ dmg, hp, by, crit, bossId, name }) => {
  const byKo = by ? displayName(by) : null;
  hud.log(`[${name}]이/가 ${byKo}(으)로 ${dmg}의 피해를 입었습니다.`, 'bosstick');
  grid.shakeBoss(bossId);
});

socket.on('boss:move', ({ boss, to }) => {
  grid.upsertBoss(boss);
});

socket.on('player:death', ({ message }) => {
  grid.playerDead(message);
});

socket.on('boss:death', ({ message }) => {
  grid.bossDead(message);
});

socket.on('cd:update', ({ cd }) => {
  if (ui && cd) {
    ui.setCooldowns(cd);
  }
});

socket.on('raid:over', (payloadFromServer) => {
  const {
    result = 'aborted',
    reason = '',
    reward = [],
    payload // 서버가 준 finish용 payload
  } = payloadFromServer || {};

  raidOver = true;
  hud.announce(result === 'defeat' ? '전투 패배' : '전투 종료');
  updateHUD();

  renderResultPanel({ result, reason, reward, payload });
});

socket.on('raid:summary', (payloadFromServer) => {
  const {
    result = 'aborted',
    reason = '',
    rewards = [],
    payload
  } = payloadFromServer || {};

  raidOver = true;
  hud.announce(result === 'defeat' ? '전투 패배' : '전투 종료');
  updateHUD();

  renderResultPanel({ result, reason, rewards, payload });
});

joinRaid({ raidId: window.raidId, chId: window.characterId, isView: window.isViewer });