// server/logic/combat.js
import * as Status from "../status.js";
import { tilesInCircle } from "./grid.js";

/**
 * 멀티보스 대응 헬퍼: raid, bossId -> boss 객체 반환
 * - bossId가 주어지면 uid 우선으로 탐색
 *   * Map(uid→boss): .get(uid)
 *   * Array/Object: b.uid === bossId → 없으면 b.id === bossId (하위호환)
 * - bossId 없으면 첫 보스 반환
 */
function getBossFromRaid(raid, bossId = null) {
    if (!raid) return null;

    // bossId 명시: uid 우선
    if (bossId != null) {
        // Map(uid → boss)
        if (raid.bosses instanceof Map) {
            // 키가 숫자/문자 혼용될 수 있으니 두 번 조회
            const byExact = raid.bosses.get(bossId);
            if (byExact) return byExact;
            const byStr = raid.bosses.get(String(bossId));
            if (byStr) return byStr;
            // 혹시 모를 잘못된 키 타입에 대비해 values에서 uid/id 비교
            for (const b of raid.bosses.values()) {
                if (String(b.uid) === String(bossId)) return b;
                if (String(b.id) === String(bossId)) return b;
            }
            return null;
        }

        // Array
        if (Array.isArray(raid.bosses)) {
            let found = raid.bosses.find(b => String(b.uid) === String(bossId));
            if (found) return found;
            found = raid.bosses.find(b => String(b.id) === String(bossId)); // 하위호환 (종류 id)
            if (found) return found;
            return null;
        }

        // Plain object
        if (raid.bosses && typeof raid.bosses === "object") {
            const vals = Object.values(raid.bosses);
            let found = vals.find(b => String(b.uid) === String(bossId));
            if (found) return found;
            found = vals.find(b => String(b.id) === String(bossId)); // 하위호환
            if (found) return found;
            return null;
        }

        return null;
    }

    // bossId 미지정: 첫 보스
    if (raid.bosses instanceof Map) {
        const it = raid.bosses.values().next();
        if (!it.done) return it.value;
    }
    if (Array.isArray(raid.bosses) && raid.bosses.length) return raid.bosses[0];
    if (raid.bosses && typeof raid.bosses === "object") {
        const vals = Object.values(raid.bosses);
        if (vals.length) return vals[0];
    }
    return null;
}

/* ----------------- players/boss utilities ----------------- */

export function computeNearestPlayer(raid, from) {
    let best = null;
    let bestD = 1e9;

    for (const p of raid.players.values()) {
        if (!p) continue;

        if (p.dead || p.hp <= 0) continue;

        const d = Math.abs(from.x - p.x) + Math.abs(from.y - p.y);
        if (d < bestD) {
            best = p;
            bestD = d;
        }
    }

    return best;
}

// ---- entity hp/shields ----
export function applyDamageToPlayer(io, raid, p, rawDmg, origin = null, ignoreDef = false) {
    if (p.hp == 0 || p.dead == true) return { before: 0, after: 0, dmg: 0, origin };

    const mods = Status.computeModifiers(p);

    // 1) 수비측 피해 배율만 적용
    let dmg = Math.max(1, Math.floor(Number(rawDmg || 0) * (mods.dmgTakenMul ?? 1)));

    // 2) 실드 우선 소모
    if ((mods.flatShield || 0) > 0 && Array.isArray(p.statuses)) {
        let absorbed = Math.min(mods.flatShield, dmg);
        dmg -= absorbed;

        for (const s of p.statuses) {
            if (s.id === 'shield' && absorbed > 0) {
                const per = s.magnitude || 1;
                const take = Math.min(absorbed, per * (s.stacks || 1));
                const usedStacks = Math.ceil(take / Math.max(1, per));
                s.stacks = Math.max(0, (s.stacks || 1) - usedStacks);
                absorbed -= take;
            }
        }
        p.statuses = p.statuses.filter(s => !(s.id === 'shield' && s.stacks <= 0));
    }

    // 3) 방어력 차감(최소 0)
    if (ignoreDef != true) {
        const def = Math.max(0, Number(p.def || 0));
        dmg = Math.max(1, dmg - def);
    }

    dmg = Math.min(999,dmg);

    // 4) HP 반영
    const before = p.hp || 0;
    p.hp = Math.max(0, before - dmg);
    if (p.hp <= 0) {
        p.dead = true;
        p.ap = 0;
        announcePlayerDeath(io, raid.raidId, p.name);
    }

    return { before, after: p.hp, dmg: before - p.hp, origin };
}

export function applyHealToPlayer(p, amount) {
    if (p.dead == true) return { before: 0, after: 0, healed: 0 };

    const maxHp = p.max_hp ?? 100; // 캐릭터에 max_hp 있으면 그걸 사용
    const before = p.hp || 0;
    p.hp = Math.min(maxHp, before + Math.floor(amount));
    return { before, after: p.hp, healed: p.hp - before };
}

/**
 * applyDamageToBoss
 * - bossId는 기본적으로 "uid" 로 간주 (하위호환: 배열/객체에서 id 매칭도 지원)
 * - bossId 미지정 시 첫 보스
 */
export function applyDamageToBoss(io, raid, rawDmg, bossId = null, player) {
    const b = getBossFromRaid(raid, bossId);
    if (!b) return { before: 0, after: 0, dmg: 0 };

    if (b.dead == true || b.hp == 0) return { before: 0, after: 0, dmg: 0 };
    const modsPlayer = Status.computeModifiers(player);
    const mods = Status.computeModifiers(b);
    let dmg = Math.max(0, Math.floor(Number(rawDmg || 0) * (mods.dmgTakenMul ?? 1) * (modsPlayer.dmgDealtMul ?? 1)));

    // 1) 반사 상태이상 확인
    if (Array.isArray(b.statuses)) {
        const hits = [];

        for (const s of b.statuses) {
            if (s.id === 'reflect') {
                const res = applyDamageToPlayer(io, raid, player, dmg, null, false);
                if (res.dmg > 0) hits.push({
                    id: player.id, hp: res.after, dmg: res.dmg,
                    by: b.name,
                    action: "reflect",
                    lable: "반사"
                });

                if (hits.length) io.to(raid.raidId).emit('players:damaged', { hits, origin: null });
                return;
            }
        }
    }

    // 2) 방어력 차감 (최소 0)
    const def = Math.max(1, Number(b.def || 0));
    dmg = Math.max(1, dmg - def);

//999데미지 제약 
    dmg = Math.min(999, dmg);

    // 3) HP 반영
    const before = b.hp || 0;
    b.hp = Math.max(0, before - dmg);
    if (b.hp <= 0) {
        b.dead = true;
        announceBossDeath(io, raid.raidId, b.name);
    }
    return { before, after: b.hp, dmg: before - b.hp };
}

// ---- broadcast helpers ----
export function emitAnnounce(io, raidId, text) {
    if (text) io.to(raidId).emit('boss:announce', { text });
}

export function announcePlayerDeath(io, raidId, playerName) {
    io.to(raidId).emit('player:death', {
        message: `아군 ${playerName} 이/가 행동불능이 되었습니다.`
    });
}

export function announceBossDeath(io, raidId, bossName) {
    console.log(raidId, bossName);
    io.to(raidId).emit('boss:death', {
        message: `적 ${bossName} 이/가 쓰러졌습니다.`
    });
}

/**
 * doDamagePlayers
 * - origin.bossId(=uid 권장)가 있으면 해당 보스의 dmgDealtMul 적용
 * - 없으면 첫 보스 dmgDealtMul 적용
 */
export function doDamagePlayers(io, raid, tiles, dmg, origin = null) {
    const hits = [];
    let bossOutMul = 1;

    if (origin && origin.by === 'boss' && origin.bossId != null) {
        const b = getBossFromRaid(raid, origin.bossId);
        if (b) bossOutMul = Status.computeModifiers(b).dmgDealtMul ?? 1;
    } else {
        const firstB = getBossFromRaid(raid, null);
        if (firstB) bossOutMul = Status.computeModifiers(firstB).dmgDealtMul ?? 1;
    }

    const finalBossDmg = Math.floor((dmg || 0) * bossOutMul);

    for (const p of raid.players.values()) {
        for (const t of tiles) {
            if (p.x === t.x && p.y === t.y) {
                const res = applyDamageToPlayer(io, raid, p, finalBossDmg, origin, false);
                if (res.dmg > 0) hits.push({
                    id: p.id, hp: res.after, dmg: res.dmg,
                    by: origin.bossName || "",
                    action: origin.action || "",
                    lable: origin.label || ""
                });
                break;
            }
        }
    }

    if (hits.length) io.to(raid.raidId).emit('players:damaged', { hits, origin });
}

export function labelFromAction(p) {
    return (p && typeof p.say === 'string' && p.say.trim().length)
        ? p.say.replace(/[!！]+$/, '')
        : (p?.type || '공격');
}

export { tilesInCircle };
