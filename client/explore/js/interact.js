import { renderDialogueNode, showHint } from './dialogue.js';
import { spawnForDoor } from '../data/maps.js';

function matchesSet(requireDef, hasFn) {
    if (!requireDef) return true;

    const asArray = (v) => Array.isArray(v) ? v : (v != null ? [v] : []);

    if (Array.isArray(requireDef)) {
        const arr = requireDef.map(String);
        return arr.every(hasFn);
    }

    // 객체 형태: any / all / not / none 지원
    const anyArr = asArray(requireDef.any).map(String);
    const allArr = asArray(requireDef.all).map(String);
    const notArr = asArray(requireDef.not ?? requireDef.none).map(String);

    if (allArr.length > 0 && !allArr.every(hasFn)) return false;
    if (anyArr.length > 0 && !anyArr.some(hasFn)) return false;
    if (notArr.length > 0 && notArr.some(hasFn)) return false;

    return true;
}

async function fetchMyKeywords() {
    try {
        const resp = await fetch("https://scenario-messiah.com/explore/ajax/keyword.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "fetchMyKeywords" })
        });
        if (!resp.ok) throw new Error("키워드 서버 오류 " + resp.status);
        const data = await resp.json();
        if (Array.isArray(data)) return data.map(String);
        if (data && Array.isArray(data.keywords)) return data.keywords.map(String);
        return [];
    } catch (e) {
        console.error("fetchMyKeywords 에러:", e);
        return [];
    }
}

function fetchSwitches() {
    // await net.getSwitches();  //차후 socket 으로ㅓ 받아서 사용할 예정

    return switches;
}

export async function checkRequires(requires) {
    if (!requires) return true;

    // --- keyword 조건 검사 ---
    if (requires.keyword) {
        const kw = await fetchMyKeywords();
        const hasKeyword = (k) => kw.includes(String(k));
        if (!matchesSet(requires.keyword, hasKeyword)) return false;
    }

    // --- switch 조건 검사 ---
    if (requires.switch) {
        const sw = await fetchSwitches();
        const hasGlobal = (k) => !!sw?.[String(k)];
        if (!matchesSet(requires.switch, hasGlobal)) return false;
    }

    return true;
}

export async function checkLimits(limits, objId) {
    if (!limits || limits.count === 0) return true;
    const target = limits.target || 'personal';
    const type = limits.type || 'constant';
    const count = Number.isFinite(limits.count) ? limits.count : 0;

    try {
        const resp = await fetch("https://scenario-messiah.com/explore/ajax/limit.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type: "checkLimits",
                limits: { target, type, count },
                objId: objId,
            })
        });

        if (!resp.ok) {
            console.error("checkLimits 서버 오류:", resp.status);
            return false;
        }

        const data = await resp.json();
        const ok = !!data?.ok;

        return ok;
    } catch (e) {
        console.error("checkLimits 에러:", e);
        return false;
    }
}

export async function interactionComplete(objId) {
    try {
        const resp = await fetch("https://scenario-messiah.com/explore/ajax/limit.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type: "interactionComplete",   // 서버에서 이 타입 처리
                context: { obj_id: String(objId) }
            })
        });
        if (!resp.ok) throw new Error("interactionComplete 서버 오류 " + resp.status);
        const data = await resp.json();
        if (!data?.ok) {
            console.warn("interactionComplete 실패 응답:", data);
            return false;
        }
        return true;
    } catch (e) {
        console.error("interactionComplete 에러:", e);
        return false;
    }
}

async function interactionNPC(DIALOGUES, obj) {
    const dialogueId = obj.dialogue || obj.id;
    const data = DIALOGUES?.[dialogueId];
    if (!data) { showHint("대화 데이터 없음"); return; }

    const nodes = data.nodes || {};
    const startNode = nodes['start'];
    if (!startNode) { showHint("start 노드 없음"); return; }

    if (!checkRequires(obj.requires) || !checkLimits(obj.limits)) {
        const fb = nodes['fallback'];
        if (fb) renderDialogueNode(data, fb);
        else closeDialogue();

        return;
    }

    renderDialogueNode(data, startNode);

    const logged = await interactionComplete(obj.id);
    if (!logged) {
        // 실패해도 플레이 흐름은 막지 않되, 콘솔 경고
        console.warn("상호작용 로그 저장 실패 (obj_id:", obj.id, ")");
    }
}

export async function interactionItem(type, DIALOGUES, net, obj) {
    const dialogueId = obj.dialogue || obj.id;
    const data = DIALOGUES?.[dialogueId];
    if (!data) { showHint("대화 데이터 없음"); return; }

    const nodes = data.nodes || {};
    const startNode = nodes['start'];
    const fallbackNode = nodes['fallback'];

    if (!startNode) { showHint("start 노드 없음"); return; }

    const okRequires = await checkRequires(obj.requires);
    const okLimits = await checkLimits(obj.limits, obj.id);

    if (!okRequires || !okLimits) {

        if (fallbackNode) renderDialogueNode(data, fallbackNode);
        else closeDialogue();

        return;
    }

    const items = Array.isArray(obj.item) ? obj.item : (obj.item ? [obj.item] : []);
    const payload = {
        type,
        items: items.map(it => ({
            item_id: Number(it.item_id),
            count: Number.isFinite(it.count) ? Number(it.count) : 1
        })),
    };

    try {
        const resp = await fetch("https://scenario-messiah.com/explore/ajax/item.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const result = await resp.json();

        if (!result?.ok) {
            const msg = result?.error || "itemTx 실패";
            throw new Error(msg);
        }

        renderDialogueNode(data, startNode);
        await interactionComplete(obj.id);
    } catch (e) {
        console.error(e);
        if (fallbackNode) renderDialogueNode(data, fallbackNode);
        else closeDialogue();

        return;
    }
}

async function interactionKeyword(type, DIALOGUES, net, obj) {
    const dialogueId = obj.dialogue || obj.id;
    const data = DIALOGUES?.[dialogueId];
    if (!data) { showHint("대화 데이터 없음"); return; }

    const nodes = data.nodes || {};
    const startNode = nodes['start'];
    const fallbackNode = nodes['fallback'];

    if (!startNode) { showHint("start 노드 없음"); return; }

    const okRequires = await checkRequires(obj.requires);
    const okLimits = await checkLimits(obj.limits, obj.id);

    if (!okRequires || !okLimits) {

        if (fallbackNode) renderDialogueNode(data, fallbackNode);
        else closeDialogue();

        return;
    }

    const raw = Array.isArray(obj.keyword) ? obj.keyword : (obj.keyword == null ? [] : [obj.keyword]);
    const keyword = [...new Set(
        raw.map(v => String(v ?? '').trim()).filter(s => s.length > 0)
    )];

    if (keyword.length === 0) {
        showHint("등록할 키워드가 없습니다");
        if (fallbackNode) await renderDialogueNode(data, fallbackNode);
        else closeDialogue();
        return;
    }

    const payload = { type, keyword }; // 서버는 keyword 배열을 받음

    try {
        const resp = await fetch("https://scenario-messiah.com/explore/ajax/keyword.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const result = await resp.json();

        if (!result?.ok) {
            const msg = result?.error || "itemTx 실패";
            throw new Error(msg);
        }

        renderDialogueNode(data, startNode);
        await interactionComplete(obj.id);
    } catch (e) {
        if (fallbackNode) renderDialogueNode(data, fallbackNode);
        else closeDialogue();

        return;
    }
}

// === 맵/오브젝트 상호작용 메인 ===
export async function handleInteract(DIALOGUES, world, net, obj, mapSelectEl) {
    if (!obj) return;

    switch (obj.type) {
        case 'npc':
            await interactionNPC(DIALOGUES, net, obj);
            break;
        case 'switch':
            net.interact(obj.id, 'switch:toggle');
            break;

         case 'door': {
							await world.loadMap(obj.target);
							net.switchMap(obj.target, spawnForDoor(obj));
             if (mapSelectEl) mapSelectEl.value = obj.target;
             showHint(`이동: ${obj.target}`, 800);
             break;
         }

        // case 'door_locked': {
        //     const need = obj.needSwitch;
        //     const on = !!net.roomState?.switches?.[need];
        //     if (on) {
        //         await world.loadMap(obj.target);
        //         net.switchMap(obj.target, spawnForDoor(obj));
        //         if (mapSelectEl) mapSelectEl.value = obj.target;
        //         showHint(`문이 열렸다 → ${obj.target}`, 1200);
        //     } else {
        //         showHint('문이 잠겨 있다. (레버가 필요)');
        //     }
        //     break;
        // }
        case 'item_add':
        case 'item_remove':
            await interactionItem(obj.type, DIALOGUES, net, obj);
            break;
        case 'keyword_add':
        case 'keyword_remove':
            await interactionKeyword(obj.type, DIALOGUES, net, obj);
            break;

        default:
            console.warn(`Unknown object type: ${obj.type}`);
            break;
    }
}
