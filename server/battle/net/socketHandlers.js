import * as Status from "../status.js";
import { newRaid, ensureRaid, cooldownsByRaid, getSkillData } from "../state/raid.js";
import { activateRaid, finishRaid } from "../tick.js";
import { manhattan, passable } from "../logic/grid.js";
import { applyDamageToPlayer, applyDamageToBoss } from "../logic/combat.js";
import { getTileEffects, clearTileOverride } from "../logic/tile.js";

const keyify = (id) => String(id);

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function joinPlayerChannel(socket, playerId) {
  if (playerId == null) return;
  socket.join(`p:${keyify(playerId)}`);
}

function toRoomId(room) {
  return `battle:${room}`;
}

function serializeBoss(b) {
  return {
    uid: b.uid,
    id: b.id,
    name: b.name,
    x: b.x,
    y: b.y,
    hp: b.hp,
    maxHp: b.maxHp,
    phase: b.phaseName,
    statuses: Status.serialize(b),
    size: b.size || { w: 1, h: 1 },
  };
}

function serializeOverrides(raid) {
  if (!raid?.tileOverrides) return [];
  return Array.from(raid.tileOverrides, ([key, v]) => ({
    key,
    x: v?.x,
    y: v?.y,
    id: v?.effects?.[0]?.applyStatus?.[0]?.id ?? null,
  }));
}

export function installSocketHandlers(io) {
  io.on("connection", (socket) => {
    let currentRaid = null;
    let playerId = null;

    /* ---------------- 팀 관련(중복 제거) ---------------- */

    function joinTeamRoom(room, chId, emitUpdate = null) {
      const roomId = toRoomId(room);
      currentRaid = roomId;
      playerId = chId;

      socket.join(roomId);
      joinPlayerChannel(socket, playerId);

      if (emitUpdate) io.in(roomId).emit("team:update", emitUpdate);
    }

    socket.on("team:login", ({ room, chId } = {}) => joinTeamRoom(room, chId));
    socket.on("team:create", ({ room, chId } = {}) => joinTeamRoom(room, chId));
    socket.on("team:join", ({ room, chId } = {}) => joinTeamRoom(room, chId, "member:join"));

    socket.on("team:leave", ({ room, chId } = {}) => {
      const roomId = toRoomId(room);

      currentRaid = null;
      playerId = chId;

      socket.leave(roomId);
      socket.leave(`p:${keyify(playerId)}`);

      io.in(roomId).emit("team:update", "member:leave");
    });

    socket.on("team:toggle", ({ room, chId } = {}) => {
      joinTeamRoom(room, chId);
      io.in(currentRaid).emit("team:update", "member:ready");
    });

    /* ---------------- 배틀 시작/종료 ---------------- */

    socket.on("battle:start", async ({ team_id }) => {
      try {
        if (!team_id) return;

        const raidIdRaw = await newRaid(team_id);
        const raidId = keyify(raidIdRaw).trim();

        const raid = ensureRaid(raidId);
        if (!raid) return;

        activateRaid(raidId);
        io.to(raidId).emit("battle:started", { raidId });
      } catch (e) {
        console.error("[battle:start] error", e);
      }
    });

    socket.on("battle:finish", ({ team_id, result = "victory", reason = "force_end" } = {}) => {
      const raidId = toRoomId(team_id);
      try {
        finishRaid(io, keyify(raidId), { result, reason });
      } catch (e) {
        console.error("[battle:finish] error", e);
      }
    });

    /* ---------------- 레이드 참가 ---------------- */

    socket.on("joinRaid", ({ raidId, chId, isView = false } = {}) => {
      const roomId = toRoomId(raidId);
      currentRaid = roomId;
      playerId = chId;

      const raid = ensureRaid(roomId);
      if (!raid) {
        socket.emit("raid:over", {
          result: "aborted",
          reason: "RAID_NOT_FOUND",
          message: "배틀이 존재하지 않습니다.",
        });
        return;
      }

      // 끝난 레이드면 요약만 전송
      if (raid.over) {
        const playersArray = Array.from(raid.players?.values?.() || []);
        const bossesArray =
          raid.bosses instanceof Map ? Array.from(raid.bosses.values()).map(serializeBoss) : [];

        const mapObj = typeof raid.map === "object" ? raid.map : { id: raid.map, name: raid.map };

        socket.emit("raid:summary", {
          over: true,
          result: raid.result || "aborted",
          reason: raid.reason || "normal",
          endedAt: raid.rewards?.at || raid.endedAt || Date.now(),
          rewards: raid.rewards || { list: [], byPlayer: {}, dungeonId: raid.map?.id || raid.map || "unknown" },
          state: {
            players: playersArray,
            bosses: bossesArray,
            map: {
              id: mapObj.id,
              name: mapObj.name,
              tileSize: mapObj.tileSize,
              n: mapObj.n,
              legend: mapObj.legend,
              tiles: mapObj.tiles,
              assets: mapObj.assets,
            },
          },
        });
        return;
      }

      // 관전자가 아니면 플레이어 존재 필수
      const p = raid.players?.get?.(playerId);
      if (!isView && !p) {
        socket.emit("raid:error", { code: "PLAYER_NOT_FOUND", message: "캐릭터가 없습니다." });
        return;
      }

      socket.join(currentRaid);
      joinPlayerChannel(socket, playerId);
      socket.data.isView = !!isView;

      const raidKey = keyify(currentRaid);
      if (!socket.data.isView && playerId != null) {
        let cdMap = cooldownsByRaid.get(raidKey);
        if (!cdMap) {
          cdMap = new Map();
          cooldownsByRaid.set(raidKey, cdMap);
        }
        if (!cdMap.has(playerId)) cdMap.set(playerId, {});
      }

      const { SKILL_ARRAY } = getSkillData();
      const mapObj = typeof raid.map === "object" ? raid.map : { id: raid.map, name: raid.map };

      const playersArray = Array.from(raid.players.values());
      const bossesArray =
        raid.bosses instanceof Map ? Array.from(raid.bosses.values()).map(serializeBoss) : [];

      socket.emit("joined", {
        isView: !!isView,
        id: playerId ?? null,
        raidId: roomId,
        players: playersArray,
        map: {
          id: mapObj.id,
          name: mapObj.name,
          tileSize: mapObj.tileSize,
          n: mapObj.n,
          legend: mapObj.legend,
          tiles: mapObj.tiles,
          assets: mapObj.assets,
        },
        overrides: serializeOverrides(raid),
        you: p || null,
        skills: p?.skills ?? null,
        bosses: bossesArray,
        skillList: SKILL_ARRAY,
      });
    });

    /* ---------------- 타일 점유/이동 ---------------- */

    function tileIsOccupied(raid, tile) {
      // 보스 점유
      if (raid?.bosses instanceof Map) {
        for (const b of raid.bosses.values()) {
          const w = Math.max(1, b.size?.w || 1);
          const h = Math.max(1, b.size?.h || 1);
          if (tile.x >= b.x && tile.x < b.x + w && tile.y >= b.y && tile.y < b.y + h) return true;
        }
      }
      // 플레이어 점유
      if (raid?.players instanceof Map) {
        for (const p of raid.players.values()) {
          if (p && tile.x === p.x && tile.y === p.y) return true;
        }
      }
      return false;
    }

    socket.on("input:move", ({ to }) => {
      const raid = ensureRaid(currentRaid);
      const p = raid?.players?.get(playerId);
      if (!raid || !p || !to) return;
      if (raid.over) return;
      if (p.dead || p.hp <= 0) return;
      if (Status.has(p, "stun")) return;

      // 타일 게임은 1칸 이동을 서버에서 검증
      if (manhattan(p, to) !== 1) return;
      if (p.ap < 1) return;
      if (!passable(raid.map, to.x, to.y)) return;
      if (tileIsOccupied(raid, to)) return;

      p.x = to.x;
      p.y = to.y;
      p.ap -= 1;

      io.to(currentRaid).emit("moved", { id: playerId, x: p.x, y: p.y, ap: p.ap });

      // 함정/장판 같은 타일 효과 판정
      const effects = getTileEffects(raid, p.x, p.y);
      if (!Array.isArray(effects) || effects.length === 0) return;

      const trapSkill = { id: "trap", name: "함정" };

      for (const eff of effects) {
        const dealtDmg = Number(eff?.dmg || 0);

        if (dealtDmg > 0) {
          const origin = { by: eff?.origin?.bossId ?? "tile", action: trapSkill.id, label: trapSkill.name };
          const res = applyDamageToPlayer(io, raid, p, dealtDmg, origin, true);

          if (res?.dmg > 0) {
            io.to(currentRaid).emit("players:damaged", {
              hits: [{
                id: p.id,
                hp: res.after,
                dmg: res.dmg,
                by: "tile",
                action: trapSkill.id,
                label: trapSkill.name,
              }],
              origin,
            });
          }
        }

        if (Array.isArray(eff?.applyStatus)) {
          for (const st of eff.applyStatus) {
            const spec = {
              id: st.id,
              stacks: st.stacks || 1,
              durationMs: st.durationMs ?? 3000,
              magnitude: st.magnitude ?? 1,
              src: "trap",
              meta: eff?.origin?.bossId ?? "tile",
            };

            Status.add(p, spec);
            io.to(currentRaid).emit("status:apply", {
              raidId: currentRaid,
              targetId: p.id,
              status: { id: spec.id, durationMs: spec.durationMs, magnitude: spec.magnitude, source: spec.src },
            });
          }
        }
      }

      // 트랩은 1회성이라면 밟은 즉시 제거
      clearTileOverride(raid, p.x, p.y);

      io.to(currentRaid).emit("tile:Overrides", {
        raidId: raid.raidId,
        overrides: serializeOverrides(raid),
      });
    });

    /* ---------------- 스킬 사용 ---------------- */

    socket.on("action:skill", ({ skillId, target }) => {
      const raid = ensureRaid(currentRaid);
      const p = raid?.players?.get?.(playerId);
      if (!raid || !p || !skillId || !target) return;
      if (raid.over || p.dead || Status.has(p, "stun")) return;

      const { SKILLS } = getSkillData();
      const skill = SKILLS[skillId];
      if (!skill) return;

      const raidKey = keyify(currentRaid);
      const cdMap = cooldownsByRaid.get(raidKey);
      const myCD = cdMap?.get(playerId) || {};

      if ((myCD[skillId] || 0) > 0) return;
      if ((p.ap | 0) < skill.apCost) return;

      // 이동/텔레포트 스킬
      if (skill.shape === "move" || skill.shape === "teleport") {
        if (manhattan(p, target) > skill.range) return;
        if (!passable(raid.map, target.x, target.y)) return;
        if (tileIsOccupied(raid, target)) return;

        p.ap -= skill.apCost;
        p.x = target.x;
        p.y = target.y;

        myCD[skillId] = skill.cooldown;
        cdMap.set(playerId, myCD);

        io.to(currentRaid).emit("skill:move", { id: playerId, to: { x: p.x, y: p.y }, ap: p.ap, skillId });
        socket.emit("cd:update", { cd: myCD });
        return;
      }

      // 공격/힐 스킬 사거리 검증
      if (manhattan(p, target) > (skill.range ?? 1)) return;

      p.ap -= skill.apCost;
      myCD[skillId] = skill.cooldown;
      cdMap.set(playerId, myCD);

      // 데미지 계산(예시: RNG 기반)
      let dealtDmg = 0;
      if (skillId === "adrenaline") {
        dealtDmg = 40;
      } else if (skillId === "empower") {
        dealtDmg = 0;
      } else {
        const outMul = Status.computeModifiers(p).dmgDealtMul || 1;
        let rolls = skill.dmg || 0;
        let randDmg = 0;
        while (rolls--) randDmg += rand(1, p.atk);
        dealtDmg = Math.max(1, Math.ceil(randDmg * outMul));
      }

      // 범위 타일 계산
      const affectedTiles = [];
      if (skill.shape === "single") {
        affectedTiles.push({ x: target.x, y: target.y });
      } else if (skill.shape === "circle") {
        const r = skill.radius ?? 1;
        for (let y = target.y - r; y <= target.y + r; y++) {
          for (let x = target.x - r; x <= target.x + r; x++) {
            if ((x - target.x) ** 2 + (y - target.y) ** 2 <= r * r) affectedTiles.push({ x, y });
          }
        }
      }

      // 힐
      if (skill.heal > 0) {
        const healed = [];
        for (const other of raid.players.values()) {
          if (!other || other.dead || other.hp <= 0) continue;
          if (!affectedTiles.some((t) => t.x === other.x && t.y === other.y)) continue;

          const before = other.hp || 0;
          other.hp = Math.min(other.max_hp, before + skill.heal);
          healed.push({ id: other.id, to: other.name, hp: other.hp, amount: other.hp - before });
        }

        if (healed.length) {
          io.to(currentRaid).emit("player:healed", {
            healed,
            by: p.name,
            label: skill.name || skill.id,
          });
        }
      }

      // 플레이어 데미지
      const hits = [];
      for (const other of raid.players.values()) {
        if (!other || other.dead || other.hp <= 0) continue;
        if (!affectedTiles.some((t) => t.x === other.x && t.y === other.y)) continue;
        if (dealtDmg <= 0) continue;

        const ignoreDef = skillId === "adrenaline";
        const res = applyDamageToPlayer(io, raid, other, dealtDmg, { by: playerId, action: skill.id, label: skill.name }, ignoreDef);

        if (res?.dmg > 0) {
          hits.push({
            id: other.id,
            hp: res.after,
            dmg: res.dmg,
            by: p.name,
            action: skill.id,
            label: skill.name,
          });
        }
      }
      if (hits.length) io.to(currentRaid).emit("players:damaged", { hits });

      // 보스 데미지
      if (skillId !== "adrenaline" && raid.bosses instanceof Map) {
        for (const b of raid.bosses.values()) {
          const w = b.size?.w || 1,
            h = b.size?.h || 1;
          const hitBoss = affectedTiles.some((t) => t.x >= b.x && t.x < b.x + w && t.y >= b.y && t.y < b.y + h);
          if (!hitBoss) continue;

          const res = applyDamageToBoss(io, raid, dealtDmg, b.uid, p);
          if (res?.dmg > 0) {
            io.to(currentRaid).emit("boss:damaged", {
              dmg: res.dmg,
              hp: b.hp,
              maxHp: b.maxHp,
              by: p.name,
              action: skill.name || skill.id,
              crit: Math.random() < 0.2,
              bossId: b.uid,
              name: b.name,
            });
          }
        }
      }

      // 상태 적용
      if (Array.isArray(skill.applyStatus)) {
        for (const eff of skill.applyStatus) {
          const spec = {
            id: eff.id,
            stacks: eff.stacks || 1,
            durationMs: eff.durationMs || 3000,
            magnitude: eff.magnitude || 1,
            src: "skill",
            meta: playerId,
          };

          if (eff.target === "self") {
            Status.add(p, spec);
          } else if (eff.target === "ally") {
            for (const other of raid.players.values()) {
              if (affectedTiles.some((t) => t.x === other.x && t.y === other.y)) Status.add(other, spec);
            }
          } else if ((eff.target === "enemy" || eff.target === "boss") && raid.bosses instanceof Map) {
            for (const b of raid.bosses.values()) {
              const w = b.size?.w || 1,
                h = b.size?.h || 1;
              const hitBoss = affectedTiles.some((t) => t.x >= b.x && t.x < b.x + w && t.y >= b.y && t.y < b.y + h);
              if (hitBoss) Status.add(b, spec);
            }
          }
        }
      }

      io.to(currentRaid).emit("skill:cast", {
        caster: playerId,
        casterName: p.name,
        skillId,
        skillName: skill.name,
        target,
        affectedTiles,
        ap: p.ap,
      });

      socket.emit("cd:update", { cd: myCD });
    });

    /* ---------------- 연결 종료 ---------------- */

    socket.on("disconnect", () => {
      if (!currentRaid || playerId == null) return;

      const raid = ensureRaid(currentRaid);
      if (!raid) return;

      // 진행 중 레이드에서도 이탈 처리
      if (raid.players?.has?.(playerId)) {
        raid.players.delete(playerId);
      }

      // 아무도 없으면 레이드 종료
      if (raid.started && raid.players.size === 0 && !raid.over) {
        finishRaid(io, currentRaid, { result: "aborted", reason: "empty" });
      }
    });
  });
}
