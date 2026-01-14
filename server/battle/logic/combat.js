import * as Status from "../status.js";
import { tilesInCircle } from "./grid.js";

/*
 전투 판정 로직
 - 서버 권한(server-authoritative) 기반 데미지 / 힐 처리
 - 상태이상(shield, reflect 등)에 따른 수치 보정
 - 판정 결과만 클라이언트에 브로드캐스트
*/

// raid 내에서 보스 객체를 안전하게 가져오는 헬퍼
function getBossFromRaid(raid, bossId = null) {
  if (!raid) return null;

  // bossId가 주어진 경우: uid 우선
  if (bossId != null) {
    if (raid.bosses instanceof Map) {
      return (
        raid.bosses.get(bossId) ||
        raid.bosses.get(String(bossId)) ||
        Array.from(raid.bosses.values()).find(
          (b) => String(b.uid) === String(bossId) || String(b.id) === String(bossId)
        ) ||
        null
      );
    }

    if (Array.isArray(raid.bosses)) {
      return (
        raid.bosses.find((b) => String(b.uid) === String(bossId)) ||
        raid.bosses.find((b) => String(b.id) === String(bossId)) ||
        null
      );
    }

    if (raid.bosses && typeof raid.bosses === "object") {
      const vals = Object.values(raid.bosses);
      return (
        vals.find((b) => String(b.uid) === String(bossId)) ||
        vals.find((b) => String(b.id) === String(bossId)) ||
        null
      );
    }

    return null;
  }

  // bossId가 없으면 첫 번째 보스 반환
  if (raid.bosses instanceof Map) {
    const it = raid.bosses.values().next();
    return it.done ? null : it.value;
  }
  if (Array.isArray(raid.bosses) && raid.bosses.length) return raid.bosses[0];
  if (raid.bosses && typeof raid.bosses === "object") {
    const vals = Object.values(raid.bosses);
    return vals.length ? vals[0] : null;
  }
  return null;
}

/* ---------------- 플레이어 / 보스 탐색 ---------------- */

export function computeNearestPlayer(raid, from) {
  let best = null;
  let bestD = Infinity;

  for (const p of raid.players.values()) {
    if (!p || p.dead || p.hp <= 0) continue;

    const d = Math.abs(from.x - p.x) + Math.abs(from.y - p.y);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/* ---------------- 플레이어 HP / 상태이상 판정 ---------------- */

export function applyDamageToPlayer(io, raid, p, rawDmg, origin = null, ignoreDef = false) {
  if (!p || p.dead || p.hp <= 0) return { before: 0, after: 0, dmg: 0, origin };

  // 상태이상 기반 수치 계산
  const mods = Status.computeModifiers(p);

  // 방어측 피해 배율만 적용
  let dmg = Math.max(1, Math.floor(Number(rawDmg || 0) * (mods.dmgTakenMul ?? 1)));

  // 실드(shield) 상태이상 우선 소모
  if ((mods.flatShield || 0) > 0 && Array.isArray(p.statuses)) {
    let absorbed = Math.min(mods.flatShield, dmg);
    dmg -= absorbed;

    for (const s of p.statuses) {
      if (s.id !== "shield" || absorbed <= 0) continue;

      const per = s.magnitude || 1;
      const canAbsorb = per * (s.stacks || 1);
      const take = Math.min(absorbed, canAbsorb);

      const usedStacks = Math.ceil(take / Math.max(1, per));
      s.stacks = Math.max(0, (s.stacks || 1) - usedStacks);
      absorbed -= take;
    }

    // 스택이 소진된 실드 제거
    p.statuses = p.statuses.filter((s) => !(s.id === "shield" && s.stacks <= 0));
  }

  // 방어력 차감
  if (!ignoreDef) {
    const def = Math.max(0, Number(p.def || 0));
    dmg = Math.max(1, dmg - def);
  }

  dmg = Math.min(999, dmg);

  const before = Number(p.hp || 0);
  p.hp = Math.max(0, before - dmg);

  if (p.hp <= 0) {
    p.dead = true;
    p.ap = 0;
    announcePlayerDeath(io, raid.raidId, p.name);
  }

  return { before, after: p.hp, dmg: before - p.hp, origin };
}

export function applyHealToPlayer(p, amount) {
  if (!p || p.dead) return { before: 0, after: 0, healed: 0 };

  const maxHp = p.max_hp ?? 100;
  const before = Number(p.hp || 0);
  p.hp = Math.min(maxHp, before + Math.floor(Number(amount || 0)));

  return { before, after: p.hp, healed: p.hp - before };
}

/* ---------------- 보스 피해 판정 ---------------- */

export function applyDamageToBoss(io, raid, rawDmg, bossId = null, player) {
  const b = getBossFromRaid(raid, bossId);
  if (!b || b.dead || b.hp <= 0) return { before: 0, after: 0, dmg: 0 };

  const modsPlayer = Status.computeModifiers(player);
  const modsBoss = Status.computeModifiers(b);

  let dmg = Math.max(
    0,
    Math.floor(Number(rawDmg || 0) * (modsBoss.dmgTakenMul ?? 1) * (modsPlayer.dmgDealtMul ?? 1))
  );

  // 반사(reflect) 상태이상 처리
  if (Array.isArray(b.statuses) && b.statuses.some((s) => s.id === "reflect")) {
    const res = applyDamageToPlayer(io, raid, player, dmg, null, false);
    if (res.dmg > 0) {
      io.to(raid.raidId).emit("players:damaged", {
        hits: [{
          id: player.id,
          hp: res.after,
          dmg: res.dmg,
          by: b.name,
          action: "reflect",
          label: "반사",
        }],
        origin: null,
      });
    }
    return { before: b.hp, after: b.hp, dmg: 0 };
  }

  // 보스 방어력 차감
  const def = Math.max(0, Number(b.def || 0));
  dmg = Math.max(1, dmg - def);
  dmg = Math.min(999, dmg);

  const before = Number(b.hp || 0);
  b.hp = Math.max(0, before - dmg);

  if (b.hp <= 0) {
    b.dead = true;
    announceBossDeath(io, raid.raidId, b.name);
  }

  return { before, after: b.hp, dmg: before - b.hp };
}

/* ---------------- 브로드캐스트 헬퍼 ---------------- */

export function announcePlayerDeath(io, raidId, playerName) {
  io.to(raidId).emit("player:death", {
    message: `아군 ${playerName} 이/가 행동불능이 되었습니다.`,
  });
}

export function announceBossDeath(io, raidId, bossName) {
  io.to(raidId).emit("boss:death", {
    message: `적 ${bossName} 이/가 쓰러졌습니다.`,
  });
}

export function doDamagePlayers(io, raid, tiles, dmg, origin = null) {
  const hits = [];
  let bossOutMul = 1;

  // 보스 공격일 경우 보스의 공격 배율 적용
  if (origin?.by === "boss") {
    const b = getBossFromRaid(raid, origin.bossId ?? null);
    if (b) bossOutMul = Status.computeModifiers(b).dmgDealtMul ?? 1;
  }

  const finalBossDmg = Math.floor(Number(dmg || 0) * bossOutMul);

  for (const p of raid.players.values()) {
    if (!p || p.dead || p.hp <= 0) continue;

    for (const t of tiles) {
      if (p.x === t.x && p.y === t.y) {
        const res = applyDamageToPlayer(io, raid, p, finalBossDmg, origin, false);
        if (res.dmg > 0) {
          hits.push({
            id: p.id,
            hp: res.after,
            dmg: res.dmg,
            by: origin?.bossName || "",
            action: origin?.action || "",
            label: origin?.label || "",
          });
        }
        break;
      }
    }
  }

  if (hits.length) io.to(raid.raidId).emit("players:damaged", { hits, origin });
}

export function labelFromAction(p) {
  return typeof p?.say === "string" && p.say.trim().length
    ? p.say.replace(/[!！]+$/, "")
    : p?.type || "공격";
}

export { tilesInCircle };
