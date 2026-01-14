import * as Status from "./status.js";
import { stateByRaid, cooldownsByRaid, ensureRaid } from "./state/raid.js"; 
import { AP_REGEN_PER_SEC, MAX_AP, TICK_HZ } from "./config/constants.js";
import { applyDamageToPlayer, applyHealToPlayer } from "./logic/combat.js";
import { runAction } from "./logic/actions.js";
import { query } from "../../db/db.js";

const CLEANUP_AFTER_MS = 15000;
const cleanupTimers = new Map();

/* ---------------- 보스 액션 실행 제어 ---------------- */

// 액션을 구분하기 위한 키 생성(정의 파일 구조가 달라도 최대한 안정적으로)
function actionKey(act) {
  return String(
    act?.key || act?.id || act?.name || act?.action || act?.type ||
    JSON.stringify({ type: act?.type, action: act?.action, name: act?.name, id: act?.id })
  );
}

// 같은 액션이 같은 "초"에 중복 실행되지 않도록 제한 (패턴 중복 방지)
function shouldRunOncePerSecond(boss, key) {
  boss._execSec ??= new Map();
  const sec = Math.floor(boss.clock || 0);
  const last = boss._execSec.get(key);
  if (last === sec) return false;
  boss._execSec.set(key, sec);
  return true;
}

async function maybeRunAction(io, raid, act, boss) {
  const key = actionKey(act);
  if (!shouldRunOncePerSecond(boss, key)) return;
  await runAction(io, raid, act, boss);
}

/* ---------------- 초기화 ---------------- */

function initBossesIfNeeded(raid) {
  if (!raid?.bosses?.size) return;

  for (const b of raid.bosses.values()) {
    b.clock ??= 0;
    b.phaseName ??= "";
    b.onceDone ??= new Set();
    b._execSec ??= new Map();
    b._phaseShifted ??= new Set();
    b.statuses ??= [];

    // 보스 정의(def) 기반으로 초기 페이즈/랜덤 타이머 준비
    if (b.def) {
      const firstPhase = Array.isArray(b.def.phases) ? b.def.phases[0] : null;
      if (firstPhase && !b.phaseName) b.phaseName = firstPhase.name;
      b.randomTimer ??= firstPhase?.randomEverySec ?? 3.0;
    }
  }
}

/* ---------------- 플레이어 틱 ---------------- */

function tickPlayers(io, raidId, raid, dt) {
  for (const p of raid.players.values()) {
    p.statuses ??= [];

    // 상태이상(DOT/HOT 등) 처리
    Status.tickEntity(p, dt * 1000, {
      onDot: (ent, amount, kind) => {
        const res = applyDamageToPlayer(
          io,
          raid,
          p,
          amount,
          { by: "dot", action: kind, label: kind },
          true // DOT는 방어무시/고정데미지
        );

        if (res?.dmg > 0) {
          io.to(raidId).emit("player:damaged:tick", {
            dmg: res.dmg,
            by: kind,
            name: p.name,
            id: ent.id,
          });
        }
      },
      onHot: (ent, amount, kind) => {
        const res = applyHealToPlayer(ent, amount);

        if (res?.healed > 0) {
          io.to(raidId).emit("player:healed:tick", {
            healed: [{ id: ent.id, hp: res.after, amount: res.healed, to: p.name }],
            by: kind,
            periodic: true,
          });
        }
      },
    });

    // AP 재생성(상태이상/버프에 따라 배율 적용)
    if (!p.dead) {
      const mods = Status.computeModifiers(p);
      p.ap = Math.min(MAX_AP, (p.ap || 0) + (AP_REGEN_PER_SEC * (mods.apRegenMul ?? 1)) * dt);
    } else {
      p.ap = 0;
    }
  }
}

/* ---------------- 쿨다운 틱 ---------------- */

function updateCooldowns(io, raidId, dt) {
  // cooldownsByRaid: Map<raidId, Map<playerId, Map<skillId, remainSec> | object>>
  const cdMap = cooldownsByRaid.get(String(raidId));
  if (!cdMap) return;

  for (const [pid, cds] of cdMap.entries()) {
    // 개인 채널로만 쿨다운 전송(브로드캐스트 방지)
    const personalRoom = `p:${String(pid)}`;

    if (cds instanceof Map) {
      for (const [skillId, remain] of cds.entries()) {
        cds.set(skillId, Math.max(0, (remain || 0) - dt));
      }

      const rounded = Object.fromEntries(
        Array.from(cds.entries()).map(([k, v]) => [k, Math.round(v * 100) / 100])
      );

      io.to(personalRoom).emit("cd:update", { cd: rounded });
    } else if (cds && typeof cds === "object") {
      // 레거시 하위호환(plain object)
      for (const k of Object.keys(cds)) cds[k] = Math.max(0, (cds[k] || 0) - dt);

      const rounded = Object.fromEntries(
        Object.entries(cds).map(([k, v]) => [k, Math.round(v * 100) / 100])
      );

      io.to(personalRoom).emit("cd:update", { cd: rounded });
    }
  }
}

/* ---------------- 승패 판정 ---------------- */

async function checkDefeatAndMaybeFinish(io, raidId, raid) {
  if (raid.players.size <= 0) return false;

  const allDead = Array.from(raid.players.values()).every((p) => p.dead || p.hp <= 0);
  const allDown = Array.from(raid.bosses.values()).every((b) => (b?.hp || 0) <= 0);

  if (allDown && !raid.over) {
    await finishRaid(io, raidId, { result: "victory", reason: "all-down" });
    io.to(raidId).emit("boss:announce", { text: "보스 처치!" });
    return true;
  }

  if (allDead && !raid.over) {
    await finishRaid(io, raidId, { result: "defeat", reason: "all-dead" });
    return true;
  }

  return false;
}

/* ---------------- 보스 상태이상 틱 ---------------- */

async function tickBossStatuses(io, raidId, raid, dt) {
  if (!raid?.bosses?.size) return false;

  for (const b of raid.bosses.values()) {
    if (raid.over) return true;
    if (!b || b.dead || b.hp <= 0) continue;

    b.statuses ??= [];

    let finishPromise = null;

    Status.tickEntity(b, dt * 1000, {
      onDot: (ent, amount, kind) => {
        if (amount <= 0) return;

        // 보스 DOT는 직접 hp 감소(보스 데미지 브로드캐스트)
        ent.hp = Math.max(0, (ent.hp ?? 0) - Math.floor(amount));

        io.to(raidId).emit("boss:damaged:tick", {
          dmg: amount,
          hp: b.hp,
          maxHp: b.maxHp,
          by: kind,
          crit: false,
          bossId: b.uid,
          name: b.name,
        });

        const allDown = Array.from(raid.bosses.values()).every((bb) => (bb?.hp ?? 1) <= 0);
        if (allDown && !raid.over && !finishPromise) {
          // 콜백 내부에서는 await 금지 → 바깥에서 대기
          finishPromise = finishRaid(io, raidId, { result: "victory", reason: "boss-dead" });
        }
      },
      onHot: (ent, amount) => {
        const maxHp = ent.maxHp ?? ent.hp ?? 0;
        ent.hp = Math.min(maxHp, (ent.hp ?? 0) + Math.floor(amount));
      },
    });

    if (finishPromise) {
      await finishPromise;
      return true;
    }
    if (raid.over) return true;
  }

  return !!raid.over;
}

/* ---------------- 보스 AI (페이즈/타임라인/랜덤) ---------------- */

function ensureArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

async function stepBossAI(io, raidId, raid, dt) {
  if (!raid?.bosses?.size || raid.over) return;

  for (const b of raid.bosses.values()) {
    if (!b || raid.over) continue;
    if (b.dead || b.hp <= 0) continue;

    const def = b.bossDef;
    if (!def) continue;

    b.clock = (b.clock ?? 0) + dt;
    b.onceDone ??= new Set();
    b._phaseShifted ??= new Set();

    const maxHp = Math.max(1, Number(b.maxHp || 0));
    const hpPct = Math.max(0, Math.min(100, b.hp <= 0 ? 0 : (b.hp / maxHp) * 100));

    // 현재 HP%에 해당하는 페이즈 선택
    const nextPhase =
      def.phases?.find((ph) => hpPct >= ph.rangeHpPct[0] && hpPct <= ph.rangeHpPct[1]) ??
      def.phases?.[0] ??
      null;

    // 페이즈 변경 시: onPhaseShift 액션은 페이즈당 1회만 실행
    if (nextPhase && b.phaseName !== nextPhase.name) {
      b.phaseName = nextPhase.name;

      const every = Math.max(0.1, Number(nextPhase.randomEverySec || 3.0));
      b.randomTimer = Math.random() * every;

      const phaseKey = String(nextPhase.name);
      if (!b._phaseShifted.has(phaseKey)) {
        b._phaseShifted.add(phaseKey);

        for (const act of ensureArray(nextPhase.onPhaseShift)) {
          try {
            await maybeRunAction(io, raid, act, b);
          } catch (e) {
            console.error("[stepBossAI] onPhaseShift error:", e);
          }
          if (raid.over || b.hp <= 0) return;
        }
      }
    }

    // 타임라인 액션(1회성)
    if (def.timelineOnce?.length) {
      for (let i = 0; i < def.timelineOnce.length; i++) {
        if (b.onceDone.has(i)) continue;

        const act = def.timelineOnce[i];
        if (b.clock >= (act.t || 0)) {
          b.onceDone.add(i);
          try {
            await maybeRunAction(io, raid, act, b);
          } catch (e) {
            console.error("[stepBossAI] timelineOnce error:", e);
          }
          if (raid.over || b.hp <= 0) return;
        }
      }
    }

    // 랜덤 액션(페이즈별)
    if (nextPhase?.randomActions?.length) {
      const every = Math.max(0.1, Number(nextPhase.randomEverySec || 3.0));
      b.randomTimer = (b.randomTimer ?? 0) - dt;

      // tick 누락 보정: 누적된 만큼 실행
      while (b.randomTimer <= 0 && !raid.over && b.hp > 0) {
        const pool = nextPhase.randomActions;
        const sum = pool.reduce((acc, it) => acc + (it.weight || 1), 0);

        if (sum > 0) {
          let r = Math.random() * sum;
          let choice = pool[pool.length - 1];
          for (const it of pool) {
            r -= it.weight || 1;
            if (r <= 0) {
              choice = it;
              break;
            }
          }

          try {
            if (choice) await maybeRunAction(io, raid, choice, b);
          } catch (e) {
            console.error("[stepBossAI] randomAction error:", e);
          }

          if (raid.over || b.hp <= 0) return;
        }

        b.randomTimer += every;
      }
    }
  }
}

/* ---------------- 상태 브로드캐스트 ---------------- */

function broadcastState(io, raidId, raid, now) {
  io.to(raidId).emit("state", {
    t: now,
    players: Array.from(raid.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      hp: p.hp,
      maxHp: p.max_hp,
      ap: Number((p.ap || 0).toFixed(2)),
      dead: !!p.dead,
      statuses: Status.serialize(p),
    })),
    bosses: raid.bosses instanceof Map
      ? Array.from(raid.bosses.values()).map((b) => ({
          uid: b.uid,
          id: b.id,
          x: b.x,
          y: b.y,
          hp: b.hp,
          maxHp: b.maxHp,
          phase: b.phaseName,
          statuses: Status.serialize(b),
          size: b.size || { w: 1, h: 1 },
        }))
      : [],
    mobs: raid.mobs,
    over: !!raid.over,
  });
}

/* ---------------- 라이프사이클 ---------------- */

export async function activateRaid(raidId) {
  const raid = ensureRaid(raidId);
  if (!raid) return;

  raid.started = true;
  raid.over = false;
  raid.lastTick = Date.now();

  initBossesIfNeeded(raid);
}

export async function finishRaid(io, raidId, { result = "aborted", reason = "normal" } = {}) {
  const raid = ensureRaid(raidId);
  if (!raid || raid.over) return;

  raid.over = true;

  // 종료 시점 스냅샷을 먼저 브로드캐스트(클라 UI 안정화)
  const players = Array.from(raid.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    hp: p.hp,
    ap: Number((p.ap || 0).toFixed(2)),
    dead: !!p.dead,
    statuses: Status.serialize(p),
  }));

  const bosses = Array.from(raid.bosses?.values?.() || []).map((b) => ({
    uid: b.uid,
    id: b.id,
    x: b.x,
    y: b.y,
    hp: b.hp,
    maxHp: b.maxHp,
    phase: b.phaseName,
    statuses: Status.serialize(b),
    size: b.size || { w: 1, h: 1 },
  }));

  io.to(raidId).emit("state", { t: Date.now(), players, bosses, mobs: raid.mobs, over: true });

  let grantsForBroadcast = [];

  try {
    // 운영 기록
    await query(
      `INSERT INTO aa_battle_result (team_id, result, reason) VALUES (?, ?, ?)`,
      [Number(raid.teamId || 0), String(result), String(reason || "normal").slice(0, 255)]
    );

    await query(`UPDATE aa_battle_team SET status = "DONE" WHERE id = ?`, [Number(raid.teamId || 0)]);

    // 보상 지급(승리 시)
    grantsForBroadcast = await reward(io, raidId, raid, { result }) || [];
  } catch (e) {
    console.error("[finishRaid] DB error:", e);
    grantsForBroadcast = [];
  }

  // 결과/보상 캐싱
  raid.result = result;
  raid.reason = reason;
  raid.rewards = {
    at: Date.now(),
    dungeonId: typeof raid?.map === "string" ? raid.map : (raid?.map?.id || raid?.dungeonId || "unknown"),
    byPlayer: groupRewardsByPlayer(grantsForBroadcast),
    list: grantsForBroadcast,
  };

  io.to(raidId).emit("raid:over", { result, reason, reward: grantsForBroadcast });

  raid.started = false;

  // 일정 시간 동안만 메모리에 유지 후 정리(관전/요약 UI 대비)
  if (!cleanupTimers.has(raidId)) {
    const ms = Math.max(CLEANUP_AFTER_MS, 5 * 60 * 1000);
    cleanupTimers.set(
      raidId,
      setTimeout(() => {
        stateByRaid.delete(raidId);
        cleanupTimers.delete(raidId);
      }, ms)
    );
  }
}

function groupRewardsByPlayer(list = []) {
  const m = new Map();
  for (const g of list) {
    const arr = m.get(g.playerId) || [];
    arr.push({ type: g.type, rewardId: g.rewardId, count: g.count });
    m.set(g.playerId, arr);
  }
  return Object.fromEntries([...m.entries()].map(([k, v]) => [String(k), v]));
}

function nv(v) {
  return (v ?? "") + "";
}

/* ---------------- 보상 로직 ---------------- */

async function reward(io, raidId, raid, { result }) {
  if (result !== "victory") return [];

  const dungeonId =
    typeof raid?.map === "string" ? raid.map : raid?.map?.id || raid?.dungeonId || "unknown";

  // 던전 보상 테이블 로딩
  let rewards = [];
  try {
    const rows = await query(
      `SELECT dungeon_id, type, reward_id, count, chance
         FROM aa_battle_reward
        WHERE dungeon_id = ?`,
      [String(dungeonId)]
    );
    rewards = Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
  if (!rewards.length) return [];

  const players = Array.from(raid.players?.values?.() || []);
  if (!players.length) return [];

  // 허가권 보유자만 지급 대상(운영 정책)
  const eligible = [];
  const gotAnyReward = new Map();

  for (const p of players) {
    try {
      const chRows = await query(`SELECT ch_id, ch_name FROM avo_character WHERE ch_id = ?`, [String(p.id)]);
      const ch = chRows?.[0];
      if (!ch) continue;

      const permitRows = await query(
        `SELECT inv.in_id, inv.item_stack
           FROM avo_inventory AS inv
           JOIN avo_item AS it ON it.it_id = inv.it_id
          WHERE inv.ch_id = ? AND it.it_type = ?`,
        [ch.ch_id, "토벌 허가권"]
      );
      if (!Array.isArray(permitRows) || permitRows.length === 0) continue;

      let ticketSlot = null;
      for (const row of permitRows) {
        if (Number(row.item_stack || 0) >= 1) {
          ticketSlot = { in_id: row.in_id, curStack: row.item_stack };
          break;
        }
      }
      if (!ticketSlot) continue;

      eligible.push({ p, ch, ticket: ticketSlot });
    } catch {
      // 한 플레이어 실패가 전체 보상 실패로 이어지지 않게 방어
    }
  }

  if (!eligible.length) return [];

  const grantsForBroadcast = [];

  for (const r of rewards) {
    const type = String(r.type || "").toUpperCase();
    const rewardId = r.reward_id;
    const qtyNum = Math.max(1, Number(r.count || 1));

    const chance = Math.max(0, Math.min(100, Number(r.chance || 0)));
    if (Math.random() * 100 >= chance) continue;

    if (type === "ITEM") {
      const itId = String(rewardId);

      // 아이템 정의 조회
      const itemRows = await query(
        `SELECT it_id, it_name, it_img, it_1, it_2, it_3, it_4, it_5
           FROM avo_item
          WHERE it_id = ?`,
        [itId]
      );
      const item = itemRows?.[0];
      if (!item) continue;

      // 허가권 보유자 전원에게 지급
      for (const { p, ch } of eligible) {
        try {
          const invRows = await query(
            `SELECT in_id, item_stack
               FROM avo_inventory
              WHERE ch_id = ? AND it_id = ?
              ORDER BY in_id ASC`,
            [nv(ch.ch_id), nv(item.it_id)]
          );

          if (Array.isArray(invRows) && invRows.length > 0) {
            const keep = invRows[0];
            const extras = invRows.slice(1);
            const extraSum = extras.reduce((s, rr) => s + Number(rr.item_stack || 0), 0);

            await query(
              `UPDATE avo_inventory
                  SET item_stack = ?,
                      it_name    = ?,
                      ch_name    = ?
                WHERE in_id = ?`,
              [Number(keep.item_stack || 0) + qtyNum + extraSum, nv(item.it_name), nv(ch.ch_name), keep.in_id]
            );

            if (extras.length > 0) {
              const ids = extras.map((rr) => rr.in_id);
              const ph = ids.map(() => "?").join(",");
              await query(`DELETE FROM avo_inventory WHERE in_id IN (${ph})`, ids);
            }
          } else {
            await query(
              `INSERT INTO avo_inventory
                  (it_id, it_name, item_stack, it_rel,
                   ch_id, ch_name,
                   se_ch_id, se_ch_name,
                   re_ch_id, re_ch_name,
                   in_sdatetime, in_edatetime, in_memo, in_use,
                   in_1, in_2, in_3, in_4, in_5)
               VALUES
                  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL, ?, ?, ?, ?, ?, ?, ?)`,
              [
                nv(item.it_id),
                nv(item.it_name),
                qtyNum,
                nv("OWN"),

                nv(ch.ch_id),
                nv(ch.ch_name),

                nv(""),
                nv("battle"),

                nv(ch.ch_id),
                nv(ch.ch_name),

                nv("battle_reward"),
                nv("0"),

                nv(item.it_1),
                nv(item.it_2),
                nv(item.it_3),
                nv(item.it_4),
                nv(item.it_5),
              ]
            );
          }

          gotAnyReward.set(String(ch.ch_id), true);

          grantsForBroadcast.push({
            playerId: p.id,
            type: "ITEM",
            rewardId: item.it_name,
            img: item.it_img,
            count: qtyNum,
          });
        } catch (e) {
          console.error("[reward] ITEM grant error:", { itId, ch_id: ch.ch_id }, e);
        }
      }
    } else if (type === "KEYWORD") {
      for (const { p, ch } of eligible) {
        try {
          await query(`INSERT IGNORE INTO aa_keyword (ch_id, keyword) VALUES (?, ?)`, [
            Number(p.id),
            String(rewardId),
          ]);
          gotAnyReward.set(String(ch.ch_id), true);
        } catch {
          // 무시(중복/일시 오류)
        }
      }
    }
  }

  // 허가권 차감: 보상을 하나라도 받은 사람만 차감
  for (const { ch, ticket } of eligible) {
    const chIdStr = String(ch.ch_id);
    if (!gotAnyReward.get(chIdStr)) continue;

    try {
      if (Number(ticket.curStack || 0) > 1) {
        await query(`UPDATE avo_inventory SET item_stack = item_stack - 1 WHERE in_id = ?`, [ticket.in_id]);
      } else {
        await query(`DELETE FROM avo_inventory WHERE in_id = ?`, [ticket.in_id]);
      }
    } catch (e) {
      console.error(`[reward] 허가권 차감 실패 ch_id=${ch.ch_id}, in_id=${ticket.in_id}`, e);
    }
  }

  return grantsForBroadcast;
}

/* ---------------- 메인 틱 루프 ---------------- */

export function startTick(io) {
  setInterval(async () => {
    const now = Date.now();

    for (const [raidId, raid] of stateByRaid.entries()) {
      if (!raid?.started || raid.over) continue;

      const dt = (now - raid.lastTick) / 1000;
      raid.lastTick = now;

      tickPlayers(io, raidId, raid, dt);
      updateCooldowns(io, raidId, dt);

      if (await checkDefeatAndMaybeFinish(io, raidId, raid)) continue;
      if (await tickBossStatuses(io, raidId, raid, dt)) continue;
      if (raid.over) continue;

      await stepBossAI(io, raidId, raid, dt);
      if (!raid.over) broadcastState(io, raidId, raid, now);
    }
  }, 1000 / TICK_HZ);
}
