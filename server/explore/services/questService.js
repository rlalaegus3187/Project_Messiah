import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../utils/validators.js';
import { insertInventoryItems, removeInventoryItemsAtomic } from './inventoryService.js';
import { addKeywords, removeKeywords } from './keywordService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUESTS_PATH = path.resolve(__dirname, '../data/quests.json');

const TBL = {
    quest: process.env.DB_TABLE_QUEST,
    inventory: process.env.DB_TABLE_INVENTORY,
};

const END_MARK = 'end';
const SINGLE_MARK = 'single';

// ─────────────────── JSON 로딩 캐시 ───────────────────
const cache = { mtime: 0, data: null };
async function loadQuests() {
    const st = await fs.stat(QUESTS_PATH).catch(() => null);
    const mt = st ? st.mtimeMs : 0;
    if (cache.data && cache.mtime === mt) return cache.data;
    cache.data = JSON.parse(await fs.readFile(QUESTS_PATH, 'utf8'));
    cache.mtime = mt;
    return cache.data;
}

async function getQuestDef(questId) {
    const data = await loadQuests();
    const q = data.quests?.[questId];
    if (!q) throw new Error(`QUEST_NOT_FOUND: ${questId}`);
    return q;
}

function parseDoneSubs(txt) {
    if (!txt) return [];
    try { return JSON.parse(txt); } catch { return []; }
}
function now() { return new Date(); }

function computeFirstSubId(q) {
    const subs = q?.subquests || {};
    const all = Object.keys(subs);
    if (!all.length) return null;

    const pointed = new Set();
    for (const sid of all) {
        const n = subs[sid]?.next;
        if (Array.isArray(n)) {
            for (const t of n) if (t) pointed.add(String(t));
        } else if (typeof n === 'string' && n) {
            pointed.add(n);
        }
    }
    return all.find(id => !pointed.has(id)) ?? all[0] ?? null;
}

// ─────────────── DB helpers ───────────────
async function getActiveRowsForChar(conn, chId) {
    const [rows] = await conn.query(
        `SELECT idx, ch_id, quest_id, cur_sub_id, completed_subs, updated_at
       FROM \`${TBL.quest}\`
      WHERE ch_id=? AND cur_sub_id<>?`,
        [chId, END_MARK]
    );
    return rows;
}

async function insertNewQuestRow(conn, chId, questId, curSubId, doneSubs = []) {
    await conn.query(
        `INSERT INTO \`${TBL.quest}\`
       (ch_id, quest_id, cur_sub_id, completed_subs, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
        [chId, questId, curSubId, JSON.stringify(doneSubs), now()]
    );
}

async function setRowToEnd(conn, idx, doneSubs) {
    await conn.query(
        `UPDATE \`${TBL.quest}\`
        SET cur_sub_id=?, completed_subs=?, updated_at=?
      WHERE idx=? LIMIT 1`,
        [END_MARK, JSON.stringify(doneSubs), now(), idx]
    );
}

async function setRowToNext(conn, idx, nextSubId, doneSubs) {
    await conn.query(
        `UPDATE \`${TBL.quest}\`
        SET cur_sub_id=?, completed_subs=?, updated_at=?
      WHERE idx=? LIMIT 1`,
        [nextSubId, JSON.stringify(doneSubs), now(), idx]
    );
}

// ─────────────── 상태/보상 helpers ───────────────
async function getItemCount(conn, chId, itId) {
    const [r] = await conn.query(
        `SELECT item_stack FROM \`${TBL.inventory}\` WHERE ch_id=? AND it_id=? LIMIT 1`,
        [chId, itId]
    );
    return Number(r?.[0]?.item_stack ?? 0);
}

function _asArray(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

function _normItems(arrLike) {
    const raw = _asArray(arrLike);
    return raw.map(x => {
        if (typeof x === 'number' || typeof x === 'string') {
            return { item_id: Number(x), count: 1 };
        }
        return {
            // 🔧 핵심: item_id 로 읽기
            item_id: Number(x.item_id),
            count: Number(x.count ?? 1),
        };
    })
        .filter(x => Number.isFinite(x.item_id) && x.item_id > 0 && Number.isFinite(x.count) && x.count > 0);
}

export async function grantRewards(chId, rewards) {
    const effects = [];
    let okAll = true;

    // ITEM ADD
    const addItems = _normItems(rewards?.item_add);
    if (addItems.length) {
        const r = await insertInventoryItems(chId, addItems);
        effects.push({ type: 'item_add', ok: r.ok, items: r.items });
        okAll &&= !!r.ok;
    }

    // ITEM REMOVE
    const removeItems = _normItems(rewards?.item_remove);
    if (removeItems.length) {
        const r = await removeInventoryItemsAtomic(chId, removeItems);
        effects.push({ type: 'item_remove', ok: r.ok, items: r.items, errors: r.errors });
        okAll &&= !!r.ok;
    }

    // KEYWORD ADD
    const kwAdd = _asArray(rewards?.keyword_add).map(String).filter(Boolean);
    if (kwAdd.length) {
        const r = await addKeywords(chId, kwAdd);
        effects.push({ type: 'keyword_add', ok: r.ok, added: r.added, skipped: r.skipped });
        okAll &&= !!r.ok;
    }

    // KEYWORD REMOVE
    const kwRemove = _asArray(rewards?.keyword_remove).map(String).filter(Boolean);
    if (kwRemove.length) {
        const r = await removeKeywords(chId, kwRemove);
        effects.push({ type: 'keyword_remove', ok: r.ok, removed: r.removed, missing: r.missing });
        okAll &&= !!r.ok;
    }

    return { ok: okAll, effects };
}

export async function ensureQuestStarted(chId, questId) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const q = await getQuestDef(questId);

        await conn.beginTransaction();

        const curSub = q.subquests
            ? (computeFirstSubId(q) ?? SINGLE_MARK)
            : (q.type ? SINGLE_MARK : SINGLE_MARK);

        await insertNewQuestRow(conn, chId, questId, curSub, []);
        await conn.commit();

        return { ok: true, cur_sub_id: curSub };
    } catch (e) {
        try { await conn.rollback(); } catch { }
        return { ok: false, error: e?.message || String(e) };
    } finally {
        conn.release();
    }
}

/**
 * talk 이벤트로만 진행/완료
 * - collect는 준비조건(인벤토리 보유)으로만 사용
 * - 완료 트리거는 항상 talk.obj_id
 * - 보상: sub.rewards, q.complete.rewards
 */
export async function processQuestEvents(chId, { kind, objId } = {}) {
    if (kind !== 'talk') return { ok: true, changed: [] };

    const pool = await getPool();
    const conn = await pool.getConnection();
    const changed = [];

    try {
        const data = await loadQuests();
        await conn.beginTransaction();

        const rows = await getActiveRowsForChar(conn, chId);

        for (const row of rows) {
            const idx = row.idx;
            const questId = row.quest_id;
            const curSubId = row.cur_sub_id; // 'single' | sub id | ...
            const doneSubs = parseDoneSubs(row.completed_subs);
            const q = data.quests?.[questId];
            if (!q) continue;

            // ── 단일형 퀘스트(서브퀘 없음)
            if (!q.subquests && q.type) {
                if (!q.talk?.obj_id || q.talk.obj_id !== objId) continue;

                if (q.type === 'collect') {
                    const itId = Number(q.collect?.it_id || 0);
                    const need = Number(q.collect?.count || 1);
                    if (!(itId > 0)) continue;
                    const have = await getItemCount(conn, chId, itId);
                    if (have < need) continue;
                }

                const gr = await grantRewards(chId, q.rewards);
                if (!gr.ok) { await conn.rollback(); return { ok: false, error: 'REWARD_FAILED' }; }

                await setRowToEnd(conn, idx, doneSubs);
                changed.push({ idx, questId, cur_sub_id: END_MARK, effects: gr.effects });
                continue;
            }

            // ── 체인형(서브퀘 존재)
            if (!curSubId || curSubId === END_MARK) continue;

            const sub = q.subquests?.[curSubId];
            if (!sub) continue;

            if (!sub.talk?.obj_id || sub.talk.obj_id !== objId) continue;

            if (sub.type === 'collect') {
                const itId = Number(sub.collect?.it_id || 0);
                const need = Number(sub.collect?.count || 1);
                if (!(itId > 0)) continue;
                const have = await getItemCount(conn, chId, itId);
                if (have < need) continue;
            }

            if (sub.rewards) {
                const gr = await grantRewards(chId, sub.rewards);
                if (!gr.ok) { await conn.rollback(); return { ok: false, error: 'SUB_REWARD_FAILED' }; }
            }

            const nextId = sub.next ?? null;
            const newDone = doneSubs.concat(curSubId);

            if (nextId) {
                await setRowToNext(conn, idx, nextId, newDone);
                changed.push({ idx, questId, cur_sub_id: nextId, completed_subs: newDone });
            } else {
                if (q.complete?.rewards) {
                    const fr = await grantRewards(chId, q.complete.rewards);
                    if (!fr.ok) { await conn.rollback(); return { ok: false, error: 'FINAL_REWARD_FAILED' }; }
                    changed.push({ idx, questId, final_effects: fr.effects });
                }
                await setRowToEnd(conn, idx, newDone);
                changed.push({ idx, questId, cur_sub_id: END_MARK, completed_subs: newDone });
            }
        }

        await conn.commit();
        return { ok: true, changed };
    } catch (e) {
        try { await conn.rollback(); } catch { }
        return { ok: false, error: e?.message || String(e) };
    } finally {
        conn.release();
    }
}

// ─────────────────── 퀘스트 시작/등록 유틸 ───────────────────

/** quests.json 에서 특정 퀘스트 정의 가져오기 */
function _getQuestDef(all, questId) {
    const q = all?.[questId];
    if (!q || typeof q !== 'object') throw new Error(`Quest def not found: ${questId}`);
    return q;
}

/** 첫 서브퀘 ID 추론: (모든 subquests) - (누군가의 next로 지목된 것), skip 제외 */
function _getFirstSubId(qdef) {
    const subs = qdef?.subquests || {};
    const all = Object.keys(subs);
    if (all.length === 0) return null;

    const pointed = new Set();
    for (const sid of all) {
        const n = subs[sid]?.next;
        if (Array.isArray(n)) {
            for (const t of n) if (t) pointed.add(String(t));
        } else if (typeof n === "string" && n) {
            pointed.add(n);
        }
    }

    // next로 가리켜지지 않은 후보 중 skip이 아닌 것
    const first = all.find(
        (id) => !pointed.has(id) && !subs[id]?.skip
    );

    // 없으면 skip이더라도 0번째 반환 (fallback)
    return first ?? all.find((id) => !subs[id]?.skip) ?? all[0] ?? null;
}


function _extractQuestMeta(qdef, firstSubId) {
    const quest_name = qdef?.name ?? '';
    const quest_desc = qdef?.summary ?? '';
    const sdef = qdef?.subquests?.[firstSubId] ?? {};
    const cur_sub_name = sdef?.title ?? '';
    const cur_sub_desc = sdef?.summary ?? '';
    return { quest_name, quest_desc, cur_sub_name, cur_sub_desc };
}

export async function startQuestIfNotActive(chId, questId) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const cid = Number(chId);
        if (!Number.isFinite(cid)) return { ok: false, reason: 'BAD_CH_ID' };
        const qid = String(questId || '').trim();
        if (!qid) return { ok: false, reason: 'BAD_QUEST_ID' };

        // 1) 퀘 정의 로드 + 첫 서브퀘/메타 파싱
        const all = await loadQuests();
        const qdef = _getQuestDef(all, qid);
        const firstSubId = _getFirstSubId(qdef);
        if (!firstSubId) return { ok: false, reason: 'NO_SUBQUESTS' };
        const meta = _extractQuestMeta(qdef, firstSubId);

        // 2) 이미 active 인지 확인
        const [dupRows] = await conn.query(
            `SELECT idx, ch_id, quest_id, cur_sub_id, status
         FROM ${TBL.quest}
        WHERE ch_id = ? AND quest_id = ? AND status = 'active'
        LIMIT 1`,
            [cid, qid]
        );
        if (Array.isArray(dupRows) && dupRows.length > 0) {
            // 중복 시작 금지: 기존 행 그대로 리턴
            const row = dupRows[0];
            return {
                ok: true,
                inserted: false,
                curSubId: row.cur_sub_id,
                meta,
                row,
            };
        }

        // 3) INSERT … SELECT … WHERE NOT EXISTS 로 원자적 보호
        // completed_subs 는 '[]' (TEXT/JSON 문자열)으로 초기화
        const now = new Date();
        const [result] = await conn.query(
            `
      INSERT INTO ${TBL.quest}
        (ch_id, quest_id, cur_sub_id, status, completed_subs, updated_at,
         quest_name, quest_desc, cur_sub_name, cur_sub_desc)
      SELECT ?, ?, ?, 'active', '[]', ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM ${TBL.quest}
         WHERE ch_id = ? AND quest_id = ? AND status = 'active'
      )
      `,
            [
                cid, qid, firstSubId, now,
                meta.quest_name, meta.quest_desc, meta.cur_sub_name, meta.cur_sub_desc,
                cid, qid,
            ]
        );

        const inserted = result?.affectedRows > 0;

        // 방금 만든/혹은 기존 active 행을 읽어 반환(정합성용)
        const [rows] = await conn.query(
            `SELECT idx, ch_id, quest_id, cur_sub_id, status, completed_subs,
              updated_at, quest_name, quest_desc, cur_sub_name, cur_sub_desc
         FROM ${TBL.quest}
        WHERE ch_id = ? AND quest_id = ? AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1`,
            [cid, qid]
        );

        const row = Array.isArray(rows) ? rows[0] : null;

        return { ok: true, inserted, curSubId: firstSubId, meta, row };
    } catch (err) {
        console.error('[startQuestIfNotActive] failed:', err);
        return { ok: false, reason: 'DB_ERROR', error: String(err?.message || err) };
    } finally {
        conn.release();
    }
}

/** 다음 서브퀘 ID 계산: 명시 target 우선, 없으면 현재 sub의 next */
function _computeNextSubId(qdef, curSubId, explicitNext) {
    if (explicitNext) return explicitNext;
    const s = qdef?.subquests?.[curSubId];
    if (!s) return null;
    const n = s.next;
    if (Array.isArray(n)) return n[0] ?? null;
    if (typeof n === 'string' && n) return n;
    return null;
}

/** 진행 중인 퀘스트를 다음 서브퀘로 전진 (없으면 완료 처리) */
export async function advanceQuestSubIfActive(chId, questId, opts = {}) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const cid = Number(chId);
        const qid = String(questId || '').trim();
        if (!Number.isFinite(cid) || !qid) return { ok: false, reason: 'BAD_ARG' };

        const row = await _getActiveRow(conn, cid, qid);
        if (!row) return { ok: false, reason: 'NOT_ACTIVE' };

        const all = await loadQuests();
        const qdef = _getQuestDef(all, qid);

        const completed = parseDoneSubs(row.completed_subs);
        const cur = row.cur_sub_id || null;
        const next = _computeNextSubId(qdef, cur, opts?.nextSubId);

        // 현재 서브퀘를 완료 목록에 추가(중복 방지)
        if (cur && !completed.includes(cur)) completed.push(cur);

        if (!next) {
            // 더 갈 데가 없으면 완료
            const done = await completeQuestIfActive(cid, qid, { pushLast: false, completed });
            return { ...done, advanced: false, reachedEnd: true };
        }

        const meta = _getSubMeta(qdef, next);
        const now = new Date();

        const [res] = await conn.query(
            `UPDATE ${TBL.quest}
          SET cur_sub_id = ?, cur_sub_name = ?, cur_sub_desc = ?,
              completed_subs = ?, updated_at = ?
        WHERE ch_id = ? AND quest_id = ? AND status = 'active'`,
            [
                next, meta.cur_sub_name, meta.cur_sub_desc,
                JSON.stringify(completed), now,
                cid, qid,
            ]
        );

        return {
            ok: true,
            advanced: res?.affectedRows > 0,
            reachedEnd: false,
            curSubId: next,
            meta,
            completedSubs: completed,
        };
    } catch (err) {
        console.error('[advanceQuestSubIfActive] failed:', err);
        return { ok: false, reason: 'DB_ERROR', error: String(err?.message || err) };
    } finally {
        conn.release();
    }
}

/** 진행 중인 퀘스트를 완료로 마감 */
export async function completeQuestIfActive(chId, questId, opts = {}) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const cid = Number(chId);
        const qid = String(questId || '').trim();
        if (!Number.isFinite(cid) || !qid) return { ok: false, reason: 'BAD_ARG' };

        const row = await _getActiveRow(conn, cid, qid);
        if (!row) return { ok: false, reason: 'NOT_ACTIVE' };

        const completed = Array.isArray(opts?.completed)
            ? opts.completed.slice()
            : parseDoneSubs(row.completed_subs);

        // 마지막 진행 중이던 sub를 목록에 추가할지 옵션으로 제어
        if (opts.pushLast !== false && row.cur_sub_id && !completed.includes(row.cur_sub_id)) {
            completed.push(row.cur_sub_id);
        }

        const now = new Date();
        const [res] = await conn.query(
            `UPDATE ${TBL.quest}
          SET status = 'completed',
              cur_sub_id = NULL,
              cur_sub_name = NULL,
              cur_sub_desc = NULL,
              completed_subs = ?,
              updated_at = ?
        WHERE ch_id = ? AND quest_id = ? AND status = 'active'`,
            [JSON.stringify(completed), now, cid, qid]
        );

        return {
            ok: true,
            completed: res?.affectedRows > 0,
            completedSubs: completed,
        };
    } catch (err) {
        console.error('[completeQuestIfActive] failed:', err);
        return { ok: false, reason: 'DB_ERROR', error: String(err?.message || err) };
    } finally {
        conn.release();
    }
}
// ─────────────── 스냅샷 API (클라이언트 전송용) ───────────────
export async function getActiveQuests(chId) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const cid = Number(chId);
        if (!Number.isFinite(cid)) return [];

        const [rows] = await conn.query(
            `SELECT quest_id, cur_sub_id
               FROM \`${TBL.quest}\`
              WHERE ch_id = ?
                AND status <> 'completed'
              ORDER BY updated_at DESC`,
            [cid]
        );
        return Array.isArray(rows) ? rows : [];
    } finally {
        conn.release();
    }
}

export async function updatePlayerQuestSnapshot(p) {
    const chId = p?.id;
    const nowTs = Date.now();
    try {
        const rows = await getActiveQuests(chId);
        const list = (rows || []).map(r => ({ questId: r.quest_id, curSubId: r.cur_sub_id }));
        p.quests = { ok: true, list, updatedAt: nowTs };
        return p.quests;
    } catch (err) {
        console.error('[updatePlayerQuestSnapshot] failed:', err);
        p.quests = { ok: false, list: [], updatedAt: nowTs, error: 'QUEST_SNAPSHOT_FAILED' };
        return p.quests;
    }
}

// ─────────────── Quest trigger from interaction ───────────────

/** questId 기준, 현재 진행중인 해당 퀘스트 행 1개 */
async function _getActiveRowByQuest(conn, chId, questId) {
    const [rows] = await conn.query(
        `SELECT idx, ch_id, quest_id, cur_sub_id, completed_subs, updated_at
       FROM \`${TBL.quest}\`
      WHERE ch_id=? AND quest_id=? AND cur_sub_id<>?
      LIMIT 1`,
        [chId, questId, END_MARK]
    );
    return rows?.[0] || null;
}

/** next 가 string/array/undefined 모두 들어올 수 있으므로 정규화 */
function _normalizeNextId(next) {
    if (!next) return null;
    if (typeof next === 'string' && next.trim()) return next.trim();
    if (Array.isArray(next)) return next.length ? String(next[0]) : null;
    return null;
}

/**
 * 진행 중인 퀘스트 목록(p.quests.list)을 바탕으로,
 * - 이번 상호작용 objectId 와 sub.obj_id 가 일치하고
 * - sub.require 를 충족하면
 *   → 보상 정산(grantRewards) + 다음 서브 이동(setRowToNext) 또는 완료(setRowToEnd)
 *   → 열어줄 dialogue_id 반환
 *
 * 사용법: const hit = await checkIfQuestCanComplete(p, objectId)
 * 반환: { ok, handled, dialogueId?, questId?, error? }
 */
export async function checkIfQuestCanComplete(p, objectId) {
    try {
        if (!p?.quests?.list?.length || !objectId) {
            return { ok: true, handled: false };
        }

        const data = await loadQuests();
        const pool = await getPool();
        const conn = await pool.getConnection();

        try {
            for (const ent of p.quests.list) {
                const questId = ent.questId;
                const curSubId = ent.curSubId;
                const qdef = data?.[questId];
                if (!qdef) continue;

                const sub = qdef.subquests?.[curSubId];
                if (!sub) continue;

                // 1) 오브젝트 일치 확인
                if (!sub.obj_id || sub.obj_id != objectId) continue;

                // 2) require 확인 (현재는 패스)
                let requireOK = true;
                if (!requireOK) continue;

                await conn.beginTransaction();

                // 3) Sub 보상 지급
                if (sub.rewards) {
                    const gr = await grantRewards(p.id, sub.rewards);
                    if (!gr.ok) {
                        await conn.rollback();
                        return { ok: false, handled: false, error: 'SUB_REWARD_FAILED' };
                    }
                }

                // 4) 다음 단계 처리
                const nextId = _normalizeNextId(sub.next);
                const doneSubs = parseDoneSubs(ent.completed_subs) || [];
                if (!doneSubs.includes(curSubId)) doneSubs.push(curSubId);

                let dialogueId = sub.dialogue_id || qdef.dialogue_id || null;

                if (nextId) {
                    const nextQuest = qdef.subquests?.[nextId];

                    const [res] = await conn.query(
                        `UPDATE aa_quest
                    SET cur_sub_id = ?,
                        cur_sub_name = ?,
                        cur_sub_desc = ?,
                                completed_subs=?
                    WHERE ch_id = ? AND quest_id = ?`,
                        [nextId, nextQuest.title, nextQuest.summary, JSON.stringify(doneSubs), p.id, questId]
                    );

                    await conn.commit();
                    // dialogueId = nextQuest.dialogue_id;
                    return { ok: true, handled: true, dialogueId, questId };
                } else {
                    // 더 이상 진행할 sub 없음 → 퀘스트 끝 (최종 보상 없음)
                    await finishQuest(conn, p, questId, doneSubs);
                    await conn.commit();

                    return { ok: true, handled: true, dialogueId, questId };
                }
            }
            return { ok: true, handled: false };
        } catch (err) {
            try { await conn.rollback(); } catch { }
            console.error('[QuestCheck] error in transaction:', err);
            return { ok: false, handled: false, error: String(err?.message || err) };
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('[checkIfQuestCanComplete] failed:', e);
        return { ok: false, handled: false, error: String(e?.message || e) };
    }
}

async function finishQuest(conn, player, questId, doneSubs) {
    await conn.query(
        `UPDATE \`${TBL.quest}\`
         SET status='completed',
             completed_subs=?,
             updated_at=NOW()
         WHERE quest_id=? AND ch_id=? 
         LIMIT 1`,
        [JSON.stringify(doneSubs), questId, player.id]
    );
}
