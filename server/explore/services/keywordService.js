import { getPool } from '../utils/validators.js';

const TBL = {
    keyword: process.env.DB_TABLE_KEYWORD,
};

function normalizeKeywords(input) {
    const arr = Array.isArray(input) ? input : [input];
    const set = new Set(
        arr
            .map(k => (typeof k === 'string' ? k.trim() : ''))
            .filter(k => k.length > 0)
    );
    return [...set];
}

/** 목록 조회 */
export async function listKeywords(chId) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.query(
            `SELECT keyword FROM \`${TBL.keyword}\` WHERE ch_id = ? ORDER BY kw_id ASC`,
            [chId]
        );
        return { ok: true, keywords: rows.map(r => r.keyword) };
    } catch (e) {
        return { ok: false, error: e?.message };
    } finally {
        conn.release();
    }
}

/** 단건 보유 여부 */
export async function hasKeyword(chId, keyword) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.query(
            `SELECT 1 FROM \`${TBL.keyword}\` WHERE ch_id = ? AND keyword = ? LIMIT 1`,
            [chId, keyword]
        );
        return { ok: true, has: rows.length > 0 };
    } catch (e) {
        return { ok: false, error: e?.message };
    } finally {
        conn.release();
    }
}

//키워드 추가
export async function addKeywords(chId, keywords, { dedupeAfter = true } = {}) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    const added = [];
    const skipped = [];
    try {
        const ks = normalizeKeywords(keywords);
        if (ks.length === 0) return { ok: true, added, skipped };

        await conn.beginTransaction();

        for (const kw of ks) {
            const [rows] = await conn.query(
                `SELECT * FROM \`${TBL.keyword}\` WHERE ch_id = ? AND keyword = ? LIMIT 1`,
                [chId, kw]
            );
            if (rows.length) {
                skipped.push(kw);
                continue;
            }
            await conn.query(
                `INSERT INTO \`${TBL.keyword}\` (ch_id, keyword) VALUES (?, ?)`,
                [chId, kw]
            );
            added.push(kw);
        }

        await conn.commit();
        return { ok: true, added, skipped };
    } catch (e) {
        try { await conn.rollback(); } catch { }
        return { ok: false, error: e?.message, added, skipped };
    } finally {
        conn.release();
    }
}

/** 키워드 삭제 (없으면 skip) */
export async function removeKeywords(chId, keywords) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    const removed = [];
    const missing = [];
    try {
        const ks = normalizeKeywords(keywords);
        if (ks.length === 0) return { ok: true, removed, missing };

        await conn.beginTransaction();

        for (const kw of ks) {
            const [rows] = await conn.query(
                `SELECT idx FROM \`${TBL.keyword}\` WHERE ch_id = ? AND keyword = ?`,
                [chId, kw]
            );
            if (rows.length === 0) {
                missing.push(kw);
                continue;
            }
            // 동일 키워드가 여러 행인 경우 전부 삭제
            const ids = rows.map(r => r.idx);            
            await conn.query(
                `DELETE FROM \`${TBL.keyword}\` WHERE idx IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            removed.push(kw);
        }

        await conn.commit();
        return { ok: true, removed, missing };
    } catch (e) {
        try { await conn.rollback(); } catch { }
        return { ok: false, error: e?.message, removed, missing };
    } finally {
        conn.release();
    }
}
