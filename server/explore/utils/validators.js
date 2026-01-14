import mysql from 'mysql2/promise';
import { ensureObjectState, peekObjectState } from '../state/worldState.js';

// ── MySQL 커넥션 풀 ─────────────────────────────────────────
let pool = null;
export async function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.MYSQL_HOST,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASS,
            database: process.env.MYSQL_DB,
            timezone: '+09:00',           // Asia/Seoul
            waitForConnections: true,
            connectionLimit: 10,
        });
    }
    return pool;
}

// ──────────────── 공통 유틸 ────────────────
function matchesSet(spec, hasFn) {
    if (!spec || typeof spec !== 'object') return true;
    const { all, any, none } = spec;

    if (Array.isArray(all) && !all.every(k => hasFn(k))) return false;
    if (Array.isArray(any) && any.length > 0 && !any.some(k => hasFn(k))) return false;
    if (Array.isArray(none) && none.some(k => hasFn(k))) return false;

    return true;
}

// KST 자정(오늘 00:00:00) 유닉스 타임스탬프(초)
function kstMidnightTodayTs() {
    const now = new Date();
    // KST(UTC+9) 보정: 현지 시간을 UTC로 환산하는 대신, 에폭 초를 KST 기준으로 맞춰 계산
    const kstOffsetMs = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + kstOffsetMs);
    const y = kstNow.getUTCFullYear();
    const m = kstNow.getUTCMonth();
    const d = kstNow.getUTCDate();
    const kstMidnightUtcMs = Date.UTC(y, m, d, 0, 0, 0);
    return Math.floor((kstMidnightUtcMs - kstOffsetMs) / 1000); // 다시 UTC 에폭으로
}

// KST 기준 이번 주 월요일 00:00:00
function kstMondayMidnightThisWeekTs() {
    const now = new Date();
    const kstOffsetMs = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + kstOffsetMs);

    // JS: 0=Sun,1=Mon,... → 월요일 시작으로 보정
    const day = kstNow.getUTCDay(); // 0~6
    const diff = (day === 0 ? 6 : day - 1); // 월요일까지 되돌아갈 일수
    const base = new Date(Date.UTC(
        kstNow.getUTCFullYear(),
        kstNow.getUTCMonth(),
        kstNow.getUTCDate(), 0, 0, 0
    ));
    const mondayKstUtcMs = base.getTime() - diff * 24 * 60 * 60 * 1000;
    return Math.floor((mondayKstUtcMs - kstOffsetMs) / 1000);
}

// ──────────────── 키워드 조회 ────────────────
async function dbFetchKeywords(chId) {
    if (!chId) return [];
    const pool = await getPool();
    const [rows] = await pool.query(
        'SELECT keyword FROM aa_keyword WHERE ch_id = ?',
        [chId]
    );
    const set = new Set();
    for (const r of rows) {
        const s = String(r.keyword || '').trim();
        if (s) set.add(s);
    }
    return [...set];
}

// ──────────────── LIMIT 집계 ────────────────
async function getUsedCount({ chId, scope, window, objId }) {
    const pool = await getPool();

    let since = 0;
    if (window === 'daily') {
        since = kstMidnightTodayTs();
    } else if (window === 'weekly') {
        since = kstMondayMidnightThisWeekTs();
    }

    const where = [];
    const params = [];

    where.push('obj_id = ?'); params.push(String(objId));
    if (scope === 'personal') {
        where.push('ch_id = ?'); params.push(Number(chId));
    }
    if (since > 0) {
        where.push('`timestamp` >= ?'); params.push(Number(since));
    }

    const sql = `SELECT COUNT(*) AS cnt FROM aa_interaction WHERE ${where.join(' AND ')}`;
    const [rows] = await pool.query(sql, params);
    return Number(rows?.[0]?.cnt || 0);
}

//아이템 확인
export async function checkHasItem(chId, it_id, count = 1) {
    const pool = await getPool();

    try {
        const [rows] = await pool.query(
            'SELECT item_stack FROM avo_inventory WHERE ch_id = ? AND it_id = ?',
            [chId, it_id]
        );

        if (!rows.length) return false; // 아이템 없음

        const itemStack = Number(rows[0].item_stack || 0);
        return itemStack >= Number(count);
    } catch (err) {
        console.error('[checkHasItem] error:', err);
        return false;
    }
}

// ──────────────── 공개 API: Requires / Limits ────────────────
export async function checkRequires(requires, { player, objectId, nodeId }) {
    if (!requires) return true;
    const chId = player?.id;

    // keyword
    if (requires.keyword) {
        const kwList = await dbFetchKeywords(chId);
        const hasKeyword = (k) => kwList.includes(String(k));
        if (!matchesSet(requires.keyword, hasKeyword)) return false;
    }

    // switch
    if (requires.switch) {
        const ok = await matchesSwitchSet(requires.switch);
        if (!ok) return false;
    }

    // 아이템
    if (requires.item) {
        const items = Array.isArray(requires.item) ? requires.item : [requires.item];
        for (const req of items) {
            const it_id = req.item_id;
            const count = req.count ?? 1;

            const has = await checkHasItem(chId, it_id, count);
            if (!has) return false;
        }
    }

    return true;
}

// switch 조건 확인용 (none은 전부 불일치해야 통과)
async function matchesSwitchSet(spec) {
    if (!spec || typeof spec !== 'object') return true;
    const { all, any, none } = spec;

    const normalizeSwitchList = (input) => {
        if (input == null) return [];
        if (Array.isArray(input)) {
            const looksLikeTuple =
                input.length >= 2 &&
                (typeof input[0] === 'string' || typeof input[0] === 'number') &&
                !Array.isArray(input[0]) &&
                !Array.isArray(input[1]);
            return looksLikeTuple ? [input] : input;
        }
        return [input];
    };

    const checkEntry = async (entry) => {
        let id, expected;
        if (Array.isArray(entry)) {
            [id, expected] = entry;
        } else if (entry && typeof entry === 'object') {
            ({ id, state: expected } = entry);
        } else {
            id = entry;
            expected = true;
        }
        const cur = peekObjectState(String(id));
        console.log(cur, expected);
        return String(cur) == String(expected);
    };

    const everyAsync = async (arr, fn) => {
        for (const x of arr) {
            if (!(await fn(x))) {
                return false;
            }
        }

        return true;
    };
    const someAsync = async (arr, fn) => {
        for (const x of arr) {
            if (await fn(x)) {
                return true;
            }
        }
        return false;
    };

    // all: 전부 일치해야 통과
    const allList = normalizeSwitchList(all);
    if (allList.length && !(await everyAsync(allList, checkEntry))) return false;

    // any: 하나라도 일치해야 통과
    const anyList = normalizeSwitchList(any);
    if (anyList.length && !(await someAsync(anyList, checkEntry))) return false;

    // none: 나열된 항목 중 "단 하나도" 일치하면 안 됨 (완전 none)
    const noneList = normalizeSwitchList(none);
    if (noneList.length && (await someAsync(noneList, checkEntry))) return false;

    return true;
}

export async function checkLimits(limit, { player, objectId, nodeId }) {
    if (!limit) return true;

    const countLimit = Number(limit.count || 0);
    if (countLimit === 0) {
        // PHP: limit=0 → 항상 허용 + remaining=null …
        return true;
    }

    const scope = (limit.target === 'global') ? 'global' : 'personal';
    const window = (limit.type === 'daily' || limit.type === 'weekly') ? limit.type : 'constant';
    if (window === 'constant') {
        // 상수 제한(한계 없음으로 간주)
        return true;
    }

    const chId = player?.id;
    const used = await getUsedCount({ chId, scope, window, objId: objectId });
    const ok = used < countLimit;

    return ok;
}

/** 상호작용 성공 로그 (aa_interaction) */
export async function logInteractionSuccessDB(chId, objId) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        if (!objId) return { ok: false, error: 'empty obj_id' };
        await conn.query(
            `INSERT INTO aa_interaction (ch_id, obj_id) VALUES (?, ?)`,
            [chId, String(objId)]
        );
        return { ok: true };
    } finally {
        conn.release();
    }
}
