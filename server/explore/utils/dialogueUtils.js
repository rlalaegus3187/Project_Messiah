import { getDialogues } from '../services/dataCache.js';
import { checkRequires, checkLimits } from './validators.js';

export function getDialogueNode(dialoguesData, dialogueId, nodeId) {
    const dlg = dialoguesData?.[dialogueId];
    if (!dlg) return { ok: false, code: 'DIALOGUE_NOT_FOUND' };
    const nodes = dlg.nodes || {};
    const node = nodes[nodeId];
    if (!node) return { ok: false, code: 'NODE_NOT_FOUND' };
    return { ok: true, dlg, node, nodes };
}

export function normalizeNodeForClient(node) {
    const text = Array.isArray(node?.text) ? node.text : (node?.text ? [node.text] : []);
    const choices = Array.isArray(node?.choices) ? node.choices : [];
    return { text, choices };
}

export function resolveChoiceIndex(choices, choicePayload) {
    const list = Array.isArray(choices) ? choices : [];
    if (typeof choicePayload === 'number' && Number.isInteger(choicePayload)) {
        return (choicePayload >= 0 && choicePayload < list.length) ? choicePayload : -1;
    }
    if (typeof choicePayload === 'string') {
        let idx = list.findIndex(c => c && typeof c.id === 'string' && c.id === choicePayload);
        if (idx >= 0) return idx;
        idx = list.findIndex(c => c && typeof c.label === 'string' && c.label === choicePayload);
        if (idx >= 0) return idx;
        const n = Number(choicePayload);
        if (Number.isInteger(n) && n >= 0 && n < list.length) return n;
    }
    return -1;
}

// 노드 gate 검사: requires/limit 실패시 onfail → 없으면 fallback
export async function gateNode({ DIALOGUES, dialogueId, nodeId, nodes, node, player, objectId }) {
    const reqOk = await checkRequires(node.requires, { player, objectId, nodeId });
    const limOk = await checkLimits(node.limit, { player, objectId, nodeId });

    if (reqOk && limOk) return { ok: true, nodeId, node };

    // onfail 우선
    if (typeof node.onfail === 'string' && node.onfail) {
        const nf = getDialogueNode(DIALOGUES, dialogueId, node.onfail);
        if (nf.ok) return { ok: true, nodeId: "onfail", node: nf.node };
        return { ok: false, code: nf.code, nodeId: "onfail" };
    }

    // fallback 시도
    const fb = getDialogueNode(DIALOGUES, dialogueId, 'fallback');
    if (fb.ok) return { ok: true, nodeId: 'fallback', node: fb.node };

    return { ok: false, code: 'GATE_FAIL' };
}

// 외부에서 다이얼로그 JSON을 원할 때
export async function loadDialogues() {
    const { data: DIALOGUES } = await getDialogues();
    return DIALOGUES;
}
