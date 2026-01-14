// server/explore/services/interactionService.js
// Patched to support per-choice/per-node outcome override (e.g., {effect:{type:'door', ...}})

import { ensureRoom, maps, players, serializeObjectState, ensureObjectState } from '../state/worldState.js';
import { updateCharacterLocationDB } from '../services/characterService.js';
import { findObjectDefInMap } from '../utils/mapUtils.js';
import {
    getDialogueNode, normalizeNodeForClient, resolveChoiceIndex,
    gateNode, loadDialogues
} from '../utils/dialogueUtils.js';
import { checkRequires, checkLimits, logInteractionSuccessDB } from '../utils/validators.js';
import {
    insertInventoryItems,
    removeInventoryItemsAtomic
} from './inventoryService.js';
import { addKeywords, removeKeywords } from './keywordService.js';

import {
    startQuestIfNotActive,
    advanceQuestSubIfActive,
    completeQuestIfActive,
} from './questService.js';
import { updatePlayerQuestSnapshot, checkIfQuestCanComplete } from './questService.js'; // 이미 있다면 유지
import { io } from "../../../io.js"

/* ───────── 공통 유틸 ───────── */
/** 상호작용 성공 로그 */
export async function logInteractionSuccess(player, { objectId }) {
    try {
        const chId = Number(player?.id);
        const obj = objectId || player?._lastInteraction?.objectId;
        const { ok } = await logInteractionSuccessDB(chId, obj);
        return ok;
    } catch (e) {
        console.error('[interaction] logInteractionSuccess error:', e);
        return false;
    }
}

function pickOutcomeFrom(choice, node) {
    const eff = choice?.effect || choice?.outcome || node?.effect || node?.outcome || null;
    if (!eff) return null;

    if (eff.type === 'door' || eff.door) {
        const d = eff.door || eff;
        return {
            type: 'door',
            target: String(d.target || '').trim(),
            targetSpawn: d.targetSpawn || d.spawn || d.target_spawn || {}
        };
    }
    return eff;
}

function aggregateItems(arr) {
    if (!arr) return [];
    const list = Array.isArray(arr) ? arr : [arr];

    const map = new Map();
    for (const it of list) {
        const id = Number(it?.item_id);
        const cnt = Math.max(1, Number(it?.count ?? 1) || 0);

        if (!Number.isFinite(id) || id <= 0 || cnt <= 0) {
            console.warn('[aggregateItems] skipped invalid item:', it);
            continue;
        }

        map.set(id, (map.get(id) || 0) + cnt);
    }

    const result = Array.from(map, ([item_id, count]) => ({ item_id, count }));
    return result;
}

async function applyInteractionOutcome(socket, player, objDef, {
    dialogueId,
    nodeId,
    node,
    context = {},
    overrideOutcome = null,
}) {
    const type = overrideOutcome?.type || objDef?.type || 'npc';
    let result = { ok: true, applied: type, detail: 'no_op' };

    try {
        switch (type) {
            case 'npc': {
                result.detail = 'talk_only';
                break;
            }

            case 'item_add': {
                const src = overrideOutcome ?? objDef?.item ?? [];
                const arr = Array.isArray(src)
                    ? src
                    : (src.item_add || src.item_remove || src.item || [src]);
                const items = aggregateItems(arr);
                if (items.length === 0) { result = { ok: false, applied: type, error: 'NO_ITEMS' }; break; }

                const { ok, items: done, errors } =
                    await insertInventoryItems(Number(player.id), items);

                if (!ok) result = { ok: false, applied: type, error: errors?.join(',') || 'ADD_FAILED' };
                else { result.detail = 'item_added'; result.items = done; }
                break;
            }

            case 'item_remove': {
                const src = overrideOutcome ?? objDef?.item ?? [];
                const arr = Array.isArray(src)
                    ? src
                    : (src.item_add || src.item_remove || src.item || [src]);
                const items = aggregateItems(arr);
                if (items.length === 0) { result = { ok: false, applied: type, error: 'NO_ITEMS' }; break; }

                const { ok, items: done, errors } =
                    await removeInventoryItemsAtomic(Number(player.id), items);

                if (!ok) result = { ok: false, applied: type, error: errors?.join(',') || 'NOT_ENOUGH_ITEMS' };
                else { result.detail = 'item_removed'; result.items = done; }
                break;
            }

            case 'switch': {
                const payload = overrideOutcome?.switch ?? objDef?.switch ?? overrideOutcome;
                const entries = Array.isArray(payload) ? payload : [payload];
                const changed = [];

                for (const entry of entries) {
                    if (!entry) continue;

                    let id, state, durationMs = 0;

                    if (Array.isArray(entry)) {
                        const [idRaw, stateRaw, durRaw] = entry;
                        id = String(idRaw);
                        state = stateRaw ?? null;
                        const n = Number(durRaw);
                        durationMs = Number.isFinite(n) ? n : 0;
                    } else if (typeof entry === 'object') {
                        id = String(entry.id ?? '').trim();
                        state = entry.state ?? null;
                        if (entry.durationMs != null) {
                            const n = Number(entry.durationMs);
                            durationMs = Number.isFinite(n) ? n : 0;
                        } else if (entry.durationSec != null || entry.duration_s != null) {
                            const sec = Number(entry.durationSec ?? entry.duration_s);
                            durationMs = Number.isFinite(sec) ? Math.max(0, sec * 1000) : 0;
                        }
                    } else if (typeof entry === 'string') {
                        id = entry.trim();
                        state = true;
                        durationMs = 0;
                    }

                    if (!id) continue;

                    const current = ensureObjectState(id, state, durationMs);
                    io.of('/explore').emit('switch:changed', { id, state: current });
                    changed.push({ id, newState: state ?? null, durationMs, current });
                }

                result.detail = 'state_switched';
                result.switches = changed;
                break;
            }

            case 'keyword_add': {
                const srcBase = overrideOutcome?.keyword || objDef?.keyword || overrideOutcome?.keyword_add || '';
                const src = Array.isArray(srcBase) ? srcBase : [srcBase];
                const ks = src.filter(k => typeof k === 'string' && k.trim().length > 0);
                if (ks.length === 0) { result = { ok: false, applied: type, error: 'NO_KEYWORDS' }; break; }

                const { ok, added, skipped, error } = await addKeywords(Number(player.id), ks);
                if (!ok) result = { ok: false, applied: type, error: error || 'KW_ADD_FAILED' };
                else {
                    result.detail = 'keyword_added';
                    result.added = added;
                    result.skipped = skipped;
                }
                break;
            }

            case 'keyword_remove': {
                const srcBase = overrideOutcome?.keyword ?? objDef.keyword;
                const src = Array.isArray(srcBase) ? srcBase : [srcBase];
                const ks = src.filter(k => typeof k === 'string' && k.trim().length > 0);
                if (ks.length === 0) { result = { ok: false, applied: type, error: 'NO_KEYWORDS' }; break; }

                const { ok, removed, missing, error } = await removeKeywords(Number(player.id), ks);
                if (!ok) result = { ok: false, applied: type, error: error || 'KW_REMOVE_FAILED' };
                else {
                    result.detail = 'keyword_removed';
                    result.removed = removed;
                    result.missing = missing;
                }
                break;
            }

            case 'quest': {
                const qid = String((overrideOutcome?.quest_id ?? overrideOutcome?.questId ?? objDef.quest_id ?? objDef.questId ?? overrideOutcome?.quest) ?? '').trim();
                if (!qid) { result = { ok: false, applied: type, error: 'NO_QUEST_ID' }; break; }

                const action = String(overrideOutcome?.action ?? objDef.action ?? 'start').toLowerCase();

                if (action === 'advance') {
                    const nextSubId = overrideOutcome?.next_sub_id ?? overrideOutcome?.nextSubId ?? objDef.next_sub_id ?? objDef.nextSubId ?? null;
                    const adv = await advanceQuestSubIfActive(Number(player.id), qid, { nextSubId });
                    if (!adv.ok) { result = { ok: false, applied: type, error: adv.reason || adv.error || 'ADV_FAILED' }; break; }

                    result.detail = adv.reachedEnd ? 'quest_reached_end' : 'quest_advanced';
                    result.quest = {
                        questId: qid,
                        curSubId: adv.curSubId ?? null,
                        completedSubs: adv.completedSubs,
                        meta: adv.meta ?? null,
                    };
                } else {
                    const started = await startQuestIfNotActive(Number(player.id), qid);
                    if (!started.ok) { result = { ok: false, applied: type, error: started.reason || 'START_FAILED' }; break; }

                    result.detail = started.inserted ? 'quest_started' : 'quest_already_active';
                    result.quest = {
                        questId: qid,
                        curSubId: started.row?.cur_sub_id ?? started.curSubId ?? null,
                        meta: started.meta,
                    };
                }

                await updatePlayerQuestSnapshot(player);
                break;
            }

            case 'quest_complete': {
                const qid = String((overrideOutcome?.quest_id ?? overrideOutcome?.questId ?? objDef.quest_id ?? objDef.questId) ?? '').trim();
                if (!qid) { result = { ok: false, applied: type, error: 'NO_QUEST_ID' }; break; }

                const done = await completeQuestIfActive(Number(player.id), qid);
                if (!done.ok) { result = { ok: false, applied: type, error: done.reason || 'COMPLETE_FAILED' }; break; }

                result.detail = done.completed ? 'quest_completed' : 'quest_complete_noop';
                result.quest = { questId: qid, completedSubs: done.completedSubs };

                await updatePlayerQuestSnapshot(player);
                break;
            }

            case 'door': {
                const charId = Number(player.id);

                function pickFirst(arr) {
                    for (const v of arr) {
                        const n = normalizeOne(v);
                        if (n) return n;
                    }
                    return null;
                }

                function normalizeOne(payload) {
                    if (!payload) return null;

                    if (payload.door !== undefined) {
                        const d = payload.door;
                        if (Array.isArray(d)) return pickFirst(d);
                        return normalizeOne(d);
                    }

                    if (typeof payload === 'string') {
                        const t = String(payload || '').trim();
                        return t ? { target: t } : null;
                    }

                    if (Array.isArray(payload)) {
                        return pickFirst(payload);
                    }

                    if (typeof payload === 'object') {
                        const t = String(payload.target || '').trim();
                        if (t) {
                            return {
                                target: t,
                                targetSpawn: payload.targetSpawn ?? payload.spawn ?? null,
                            };
                        }
                        return null;
                    }

                    return null;
                }

                const doorDef = overrideOutcome || overrideOutcome?.door;
                if (!doorDef) {
                    result = { ok: false, applied: type, error: 'NO_TARGET_MAP' };
                    break;
                }

                const nextMap = String(doorDef.target || doorDef.door.target || '').trim();
                if (!nextMap) {
                    result = { ok: false, applied: type, error: 'NO_TARGET_MAP' };
                    break;
                }

                const spawnLike = doorDef.targetSpawn || doorDef.door.targetSpawn || {};

                const nx = Number.isFinite(Number(spawnLike.x)) ? Number(spawnLike.x) : 200;
                const ny = Number.isFinite(Number(spawnLike.y)) ? Number(spawnLike.y) : 200;
                const ndir = spawnLike.dir || 'down';

                const dbOk = await updateCharacterLocationDB(charId, { map: nextMap });
                if (!dbOk?.ok) {
                    result = { ok: false, applied: type, error: dbOk?.error || 'DB_UPDATE_FAILED' };
                    break;
                }

                const prevMap = player.map;
                if (prevMap && maps.has(prevMap)) {
                    maps.get(prevMap).delete(charId);
                    socket.leave(prevMap);
                    io.of('/explore').to(prevMap).emit('player:leave', { characterId: charId });
                }

                ensureRoom(nextMap);

                const updated = {
                    ...player,
                    map: nextMap,
                    x: nx,
                    y: ny,
                    dir: ndir,
                    anim: 0,
                    dialogue: null,
                    interaction: false,
                    connected: false
                };

                players.set(charId, updated);

                result.detail = 'character_moved';
                result.moved = { map: nextMap, x: nx, y: ny, dir: ndir };

                socket.emit('new_map', nextMap);

                break;
            }

            default:
                result.detail = 'no_op';
                break;
        }
    } catch (err) {
        console.error('[interaction] applyInteractionOutcome error:', err);
        result = { ok: false, applied: type, error: err };
    }

    if (result.ok) {
        const objectId = objDef?.id ?? context?.objectId ?? player?._lastInteraction?.objectId;
        await logInteractionSuccess(player, { objectId });
    }

    return result;
}

async function endWithOutcome(socket, player, objDef, { dialogueId, nodeId, node, endNode, overrideOutcome = null }) {
    await applyInteractionOutcome(socket, player, objDef, {
        dialogueId, nodeId, node, context: { objectId: player?._lastInteraction?.objectId }, overrideOutcome
    });
    interactionEnd(socket, player, { dialogueId, endNode });
}

export function sendInteractionUpdate(socket, player, { dialogueId, nodeId, node }) {
    const payload = normalizeNodeForClient(node);
    socket.emit('interaction:update', {
        ok: true,
        dialogue: { id: dialogueId, nodeId, node: payload },
    });

    player.interaction = false;
}

export function interactionEnd(socket, player, { dialogueId, endNode }) {
    player.dialogue = null;

    if (endNode) {
        socket.emit('interaction:end', {
            ok: true,
            dialogue: { id: dialogueId, nodeId: 'end', node: normalizeNodeForClient(endNode) },
        });
    } else {
        socket.emit('interaction:end', { ok: true, dialogue: { id: dialogueId, nodeId: 'end' } });
    }

    player.interaction = false;
}

function sendFallbackOrFail(socket, DIALOGUES, dialogueId, phase /* 'start' | 'update' */) {
    const fb = getDialogueNode(DIALOGUES, dialogueId, 'fallback');
    if (fb.ok) {
        const payload = normalizeNodeForClient(fb.node);
        const evt = phase === 'start' ? 'interaction:start' : 'interaction:update';
        socket.emit(evt, {
            ok: true,
            dialogue: { id: dialogueId, nodeId: 'fallback', node: payload },
        });
        return true;
    }

    socket.emit('interaction:fail', { ok: false, error: 'FALLBACK_NOT_FOUND', dialogueId });
    return false;
}

export async function startInteractionForObject(socket, p, { objectId }) {
    // 0) 퀘스트 완료 트리거 우선 처리
    const qres = await checkIfQuestCanComplete(p, objectId);
    if (qres?.ok && qres.handled) {
        // 퀘스트 완료/진척에 성공했고, 열어줄 dialogueId 가 정의되어 있으면 퀘스트 대화로 진입
        const questDialogueId = qres.dialogueId;
        if (questDialogueId) {
            try {
                const DIALOGUES = await loadDialogues();
                await updatePlayerQuestSnapshot(p);

                let entry = getDialogueNode(DIALOGUES, questDialogueId, 'start');
                if (!entry.ok) {
                    entry = getDialogueNode(DIALOGUES, questDialogueId, 'fallback');
                }

                if (entry.ok) {
                    p.dialogue = questDialogueId;
                    p._lastInteraction = { objectId, objectType: 'quest', dialogueId: questDialogueId };

                    socket.emit('interaction:start', {
                        ok: true,
                        objectId,
                        object: { id: objectId, type: 'quest' },
                        me: { id: p.id, map: p.map },
                        dialogue: { id: questDialogueId, nodeId: "start", node: normalizeNodeForClient(entry.node) },
                        meta: { kind: 'quest-complete', questId: qres.questId },
                    });

                    p.interaction = false;
                    return;
                } else {
                    console.log('interaction:toast', { ok: true, text: '퀘스트가 완료되었습니다.' });
                    return;
                }
            } catch (e) {
                console.log('interaction:toast', { ok: true, text: '퀘스트 보상 지급 및 진행이 반영되었습니다.' });
                return;
            }
        } else {
            console.log('interaction:toast', { ok: true, text: '퀘스트가 완료되었습니다.' });
            return;
        }
    }

    // 1) 오브젝트 확인 (퀘스트 트리거로 처리되지 않은 경우만 일반 흐름)
    const objDef = await findObjectDefInMap(p.map, objectId);
    if (!objDef) {
        socket.emit('interaction:fail', { ok: false, error: 'OBJECT_NOT_FOUND', objectId });
        return;
    }

    // 2) door : 대화 없이 즉시 결과 적용
    if (objDef.type === 'door') {
        const objReqOk = await checkRequires(objDef.requires, { player: p, objectId, nodeId: 'interaction' });
        const objLimOk = await checkLimits(objDef.limit, { player: p, objectId, nodeId: 'interaction' });
        if (!objReqOk || !objLimOk) {
            socket.emit('interaction:fail', { ok: false, error: 'GATE_BLOCKED', objectId });
            return;
        }
        const outcome = {
            type: 'door',
            target: String(objDef.target || '').trim(),
            targetSpawn: objDef.spawn || objDef.targetSpawn || { x: 200, y: 200, dir: 'down' },
        };
        await applyInteractionOutcome(socket, p, objDef, {
            dialogueId: objDef.dialogue || objDef.id || 'door',
            nodeId: 'door',
            node: null,
            context: { objectId },
            overrideOutcome: outcome,
        });
        
        interactionEnd(socket, p, { dialogueId: objDef.dialogue || objDef.id || 'door', endNode: null });
        return;
    }

    // 3) 다이얼로그 로드
    const DIALOGUES = await loadDialogues();
    const dialogueId = objDef.dialogue || objDef.id; // fallback id

    // 4) 오브젝트 레벨 게이트(실패해도 fallback)
    const objReqOk = await checkRequires(objDef.requires, { player: p, objectId, nodeId: 'interaction' });
    const objLimOk = await checkLimits(objDef.limit, { player: p, objectId, nodeId: 'interaction' });

    // 5) 엔트리 결정
    const entryId = (objReqOk && objLimOk) ? 'start' : 'fallback';
    const entry = getDialogueNode(DIALOGUES, dialogueId, entryId);
    if (!entry.ok) {
        if (entryId !== 'fallback') {
            if (sendFallbackOrFail(socket, DIALOGUES, dialogueId, 'start')) {
                p.dialogue = dialogueId;
                p.interaction = false;
            }
            return;
        }
        socket.emit('interaction:fail', { ok: false, error: entry.code, dialogueId, nodeId: entryId });
        return;
    }

    // 6) 노드 레벨 게이트
    const gated = await gateNode({
        DIALOGUES, dialogueId, nodeId: entryId, nodes: entry.nodes, node: entry.node, player: p, objectId
    });
    if (!gated.ok) {
        if (sendFallbackOrFail(socket, DIALOGUES, dialogueId, 'start')) {
            p.dialogue = dialogueId;
            p.interaction = false;
        }
        return;
    }

    // 7) 세션에 현재 대화/오브젝트 표식 저장
    p.dialogue = dialogueId;
    p._lastInteraction = { objectId, objectType: objDef.type, dialogueId };

    // 8) 시작 알림
    socket.emit('interaction:start', {
        ok: true,
        objectId,
        object: objDef,
        me: { id: p.id, map: p.map },
        dialogue: { id: dialogueId, nodeId: gated.nodeId, node: normalizeNodeForClient(gated.node) },
    });

    if (gated.nodeId == 'fallback' || gated.nodeId == 'onfail') {
        //effect/effects 적용
        const rawEffects = (gated?.effect || gated?.node?.effect) ?? null;

        if (rawEffects) {
            const effects = normalizeEffectEntries(rawEffects);

            for (const { effType, val } of effects) {
                const objDef = { type: effType };
                await applyInteractionOutcome(socket, p, objDef, {
                    dialogueId,
                    nodeId: dialogueId,
                    node: gated.node,
                    context: { objectId: p?._lastInteraction?.objectId ?? null },
                    overrideOutcome: { [effType]: val },
                });
            }
        }
        p.interaction = false;
    }
}

function normalizeEffectEntries(rawEffects) {
    if (!rawEffects) return [];

    const entries = [];

    const pushOne = (type, value) => {
        if (value == null) return;

        //door 전용 처리
        if (type === 'door') {
            if (typeof value === 'string') {
                entries.push({ effType: 'door', val: { target: value } });
            } else if (Array.isArray(value)) {
                for (const v of value) pushOne('door', v);
            } else if (typeof value === 'object') {
                entries.push({ effType: 'door', val: value });
            }
            return;
        }

        //switch 전용 처리
        if (type === 'switch') {
            const toMs = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : 0;
            };

            const normSwitch = (v) => {
                if (!v) return null;

                // 문자열: "id" -> { id, state: true }
                if (typeof v === 'string') return { id: v.trim(), state: true, durationMs: 0 };

                // 배열(튜플) 판별: ["id","state","25000"] 같은 형태
                if (Array.isArray(v)) {
                    // 단일 튜플인지(= 2~4 원소, 앞 1~2개는 원시형, 3번째는 duration일 수 있음) 먼저 확인
                    const looksLikeTuple =
                        v.length >= 2 && v.length <= 4 &&
                        (typeof v[0] === 'string' || typeof v[0] === 'number') &&
                        (typeof v[1] === 'string' || v[1] == null) &&
                        (v.length === 2 || typeof v[2] === 'string' || typeof v[2] === 'number' || v[2] == null);

                    if (looksLikeTuple) {
                        const [idRaw, stateRaw, durRaw] = v;
                        const id = String(idRaw);
                        const state = stateRaw ?? null;
                        const durationMs = toMs(durRaw);
                        return { id, state, durationMs };
                    }

                    const out = [];
                    for (const each of v) {
                        const parsed = normSwitch(each);
                        if (parsed) out.push(parsed);
                    }
                    return out.length ? out : null;
                }

                if (typeof v === 'object') {
                    const id = String(v.id ?? '').trim();
                    if (!id) return null;
                    let durationMs = 0;
                    if (v.durationMs != null) durationMs = toMs(v.durationMs);
                    else if (v.durationSec != null || v.duration_s != null) {
                        const sec = Number(v.durationSec ?? v.duration_s);
                        if (Number.isFinite(sec)) durationMs = Math.max(0, sec * 1000);
                    }
                    return { id, state: v.state ?? null, durationMs };
                }

                return null;
            };

            const pushParsed = (parsed) => {
                if (!parsed) return;
                if (Array.isArray(parsed)) {
                    for (const p of parsed) entries.push({ effType: 'switch', val: p });
                } else {
                    entries.push({ effType: 'switch', val: parsed });
                }
            };

            pushParsed(normSwitch(value));
            return;
        }

        // ---- 그 외 타입 ----
        if (Array.isArray(value)) {
            for (const v of value) entries.push({ effType: type, val: v });
        } else {
            entries.push({ effType: type, val: value });
        }
    };

    if (Array.isArray(rawEffects)) {
        for (const eff of rawEffects) {
            if (!eff || typeof eff !== 'object') continue;
            for (const [effType, values] of Object.entries(eff)) {
                pushOne(effType, values);
            }
        }
        return entries;
    }

    if (typeof rawEffects === 'object') {
        for (const [effType, values] of Object.entries(rawEffects)) {
            pushOne(effType, values);
        }
        return entries;
    }

    return entries;
}

export async function handleChoice(socket, p, { nodeId, choice }) {
    const dialogueId = p.dialogue;

    if (!dialogueId || typeof dialogueId !== 'string') {
        socket.emit('interaction:fail', { ok: false, error: 'DIALOGUE_NOT_ACTIVE' });
        return;
    }
    if (typeof nodeId !== 'string' || !nodeId) {
        socket.emit('interaction:fail', { ok: false, error: 'BAD_PAYLOAD' });
        return;
    }

    const DIALOGUES = await loadDialogues();
    const cur = getDialogueNode(DIALOGUES, dialogueId, nodeId);
    if (!cur.ok) {
        socket.emit('interaction:fail', { ok: false, error: cur.code, dialogueId, nodeId });
        return;
    }

    const curNorm = normalizeNodeForClient(cur.node);
    const idx = resolveChoiceIndex(curNorm.choices, choice);
    if (idx < 0) {
        socket.emit('interaction:fail', { ok: false, error: 'INVALID_CHOICE', dialogueId, nodeId });
        return;
    }

    const chosen = curNorm.choices[idx];
    const nextId = chosen?.next;
    if (typeof nextId !== 'string' || !nextId) {
        socket.emit('interaction:fail', { ok: false, error: 'BAD_NEXT', dialogueId, nodeId });
        return;
    }

    // 다음 노드 로드
    const next = getDialogueNode(DIALOGUES, dialogueId, nextId);
    if (!next.ok) {
        if (sendFallbackOrFail(socket, DIALOGUES, dialogueId, 'update')) return;
        socket.emit('interaction:fail', { ok: false, error: next.code, dialogueId, nodeId: nextId });
        p.interaction = false;
        return;
    }

    const objectId = p._lastInteraction?.objectId ?? null;
    const gated = await gateNode({
        DIALOGUES, dialogueId, nodeId: nextId, nodes: next.nodes, node: next.node, player: p, objectId
    });
    if (!gated.ok) {
        if (sendFallbackOrFail(socket, DIALOGUES, dialogueId, 'update')) return;
        socket.emit('interaction:fail', { ok: false, error: gated.code, dialogueId });
        p.interaction = false;
        return;
    }

    // ── (1) effect/effects 적용 ────────────────────────────────────────────────
    const rawEffects = (chosen?.effect || gated?.node?.effect) ?? null;

    if (rawEffects) {
        const effects = normalizeEffectEntries(rawEffects);

        for (const { effType, val } of effects) {
            const objDef = { type: effType };
            await applyInteractionOutcome(socket, p, objDef, {
                dialogueId,
                nodeId,
                node: cur.node,
                context: { objectId: p?._lastInteraction?.objectId ?? null },
                overrideOutcome: { [effType]: val },
            });
        }
    }

    sendInteractionUpdate(socket, p, { dialogueId, nodeId: gated.nodeId, node: gated.node });
}

async function runEffects(socket, player, effects, {
    dialogueId = null,
    nodeId = null,
    node = null,
    context = {},
} = {}) {
    if (!effects || typeof effects !== 'object') return [];

    const results = [];
    const charId = Number(player?.id);

    const okRes = (applied, detail, extra = {}) => ({ ok: true, applied, detail, ...extra });
    const errRes = (applied, error, extra = {}) => ({ ok: false, applied, error, ...extra });
    const logSuccess = async (res) => {
        if (!res?.ok) return;
        const objectId = context?.objectId ?? player?._lastInteraction?.objectId;
        try { await logInteractionSuccess(player, { objectId }); } catch (_) { }
    };

    // ---------- keyword_add ----------
    if (Array.isArray(effects.keyword_add) && effects.keyword_add.length) {
        const ks = effects.keyword_add.filter(k => typeof k === 'string' && k.trim());
        if (ks.length) {
            try {
                const { ok, added, skipped, error } = await addKeywords(charId, ks);
                const res = ok ? okRes('keyword_add', 'keyword_added', { added, skipped })
                    : errRes('keyword_add', error || 'KW_ADD_FAILED');
                results.push(res); await logSuccess(res);
            } catch (e) { results.push(errRes('keyword_add', String(e))); }
        }
    }

    // ---------- keyword_remove ----------
    if (Array.isArray(effects.keyword_remove) && effects.keyword_remove.length) {
        const ks = effects.keyword_remove.filter(k => typeof k === 'string' && k.trim());
        if (ks.length) {
            try {
                const { ok, removed, missing, error } = await removeKeywords(charId, ks);
                const res = ok ? okRes('keyword_remove', 'keyword_removed', { removed, missing })
                    : errRes('keyword_remove', error || 'KW_REMOVE_FAILED');
                results.push(res); await logSuccess(res);
            } catch (e) { results.push(errRes('keyword_remove', String(e))); }
        }
    }

    // ---------- item_add ----------
    if (effects.item_add) {
        const src = Array.isArray(effects.item_add) ? effects.item_add : [effects.item_add];
        const items = src.map(it => ({
            item_id: Number(it?.item_id ?? it?.it_id),
            count: Number.isFinite(it?.count) ? Number(it.count) : 1,
        })).filter(x => x.item_id > 0 && x.count > 0);

        if (items.length) {
            try {
                const { ok, items: done, errors } = await insertInventoryItems(charId, items);
                const res = ok ? okRes('item_add', 'item_added', { items: done })
                    : errRes('item_add', errors?.join(',') || 'ADD_FAILED');
                results.push(res); await logSuccess(res);
            } catch (e) { results.push(errRes('item_add', String(e))); }
        } else {
            results.push(errRes('item_add', 'NO_ITEMS'));
        }
    }

    // ---------- item_remove ----------
    if (effects.item_remove) {
        const src = Array.isArray(effects.item_remove) ? effects.item_remove : [effects.item_remove];
        const items = src.map(it => ({
            item_id: Number(it?.item_id ?? it?.it_id),
            count: Number.isFinite(it?.count) ? Number(it.count) : 1,
        })).filter(x => x.item_id > 0 && x.count > 0);

        if (items.length) {
            try {
                const { ok, items: done, errors } = await removeInventoryItemsAtomic(charId, items);
                const res = ok ? okRes('item_remove', 'item_removed', { items: done })
                    : errRes('item_remove', errors?.join(',') || 'NOT_ENOUGH_ITEMS');
                results.push(res); await logSuccess(res);
            } catch (e) { results.push(errRes('item_remove', String(e))); }
        } else {
            results.push(errRes('item_remove', 'NO_ITEMS'));
        }
    }

    // ---------- quest (기본 action: start) ----------
    if (Array.isArray(effects.quest) && effects.quest.length) {
        for (const qidRaw of effects.quest) {
            const qid = String(qidRaw ?? '').trim();
            if (!qid) { results.push(errRes('quest', 'NO_QUEST_ID')); continue; }
            try {
                const started = await startQuestIfNotActive(charId, qid);
                const res = started?.ok
                    ? okRes('quest', started.inserted ? 'quest_started' : 'quest_already_active', {
                        quest: {
                            questId: qid,
                            curSubId: started.row?.cur_sub_id ?? started.curSubId ?? null,
                            meta: started.meta,
                        },
                    })
                    : errRes('quest', started?.reason || 'START_FAILED');

                results.push(res); await logSuccess(res);
            } catch (e) { results.push(errRes('quest', String(e))); }
        }
        try { await updatePlayerQuestSnapshot(player); } catch (_) { }
    }

    // ---------- quest_complete ----------
    if (Array.isArray(effects.quest_complete) && effects.quest_complete.length) {
        for (const qidRaw of effects.quest_complete) {
            const qid = String(qidRaw ?? '').trim();
            if (!qid) { results.push(errRes('quest_complete', 'NO_QUEST_ID')); continue; }
            try {
                const done = await completeQuestIfActive(charId, qid);
                const res = done?.ok
                    ? okRes('quest_complete', done.completed ? 'quest_completed' : 'quest_complete_noop', {
                        quest: { questId: qid, completedSubs: done.completedSubs },
                    })
                    : errRes('quest_complete', done?.reason || 'COMPLETE_FAILED');

                results.push(res); await logSuccess(res);
            } catch (e) { results.push(errRes('quest_complete', String(e))); }
        }
        try { await updatePlayerQuestSnapshot(player); } catch (_) { }
    }

    // ---------- state_switch (구현 예정 자리) ----------
    if (effects.state_switch) {
        // TODO: 룸/월드/개인 스위치 저장(DB or 메모리)
        const res = okRes('state_switch', 'state_switched');
        results.push(res); await logSuccess(res);
    }

    // ---------- door ----------
    if (effects.door) {
        const src = typeof effects.door === 'object' ? effects.door : {};
        const nextMap = String(src.target || '').trim();
        if (!nextMap) {
            results.push(errRes('door', 'NO_TARGET_MAP'));
        } else {
            try {
                const dbOk = await updateCharacterLocationDB(charId, { map: nextMap });
                if (!dbOk?.ok) {
                    results.push(errRes('door', dbOk?.error || 'DB_UPDATE_FAILED'));
                } else {
                    const spawnLike = src.targetSpawn || {};
                    const nx = Number.isFinite(spawnLike.x) ? spawnLike.x : 200;
                    const ny = Number.isFinite(spawnLike.y) ? spawnLike.y : 200;
                    const ndir = typeof spawnLike.dir === 'string' ? spawnLike.dir : 'down';

                    const prevMap = player.map;
                    if (prevMap && maps.has(prevMap)) maps.get(prevMap).delete(charId);

                    ensureRoom(nextMap);

                    const updated = {
                        ...player,
                        map: nextMap,
                        x: nx,
                        y: ny,
                        dir: ndir,
                        anim: 0,
                        dialogue: null,
                    };
                    players.set(charId, updated);

                    const res = okRes('door', 'character_moved', { moved: { map: nextMap, x: nx, y: ny, dir: ndir } });
                    results.push(res); await logSuccess(res);

                    socket.emit('new_map', nextMap);
                }
            } catch (e) { results.push(errRes('door', String(e))); }
        }
    }

    return results;
}
