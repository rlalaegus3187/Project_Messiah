import { getPool } from '../utils/validators.js'; 

const TBL = {
    inventory: process.env.DB_TABLE_INVENTORY ,
    items: process.env.DB_TABLE_ITEMS,
    char: process.env.DB_TABLE_CHAR,
    interLog: process.env.DB_TABLE_INTERACT,
};

function normalizeItems(items) {
    const need = new Map(); 
    for (const it of items || []) {
        const id = Number(it?.item_id ?? it?.it_id);
        const cnt = Number(it?.count ?? 0);
        if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(cnt) || cnt <= 0) {
            return { ok: false, error: 'invalid item_id/count' };
        }
        need.set(id, (need.get(id) || 0) + cnt);
    }
    return { ok: true, need };
}

/** 아이템 추가(업서트, 스택 누적). 이름 칼럼은 있으면 업데이트, 없으면 무시 */
export async function insertInventoryItems(chId, items) {
    const pool = await getPool();
    const conn = await pool.getConnection();

    try {
        const norm = normalizeItems(items);
        if (!norm.ok) return { ok: false, errors: [norm.error] };

        const [charRows] = await conn.query(
            `SELECT ch_name FROM \`${TBL.char}\` WHERE ch_id = ? LIMIT 1`,
            [chId]
        );
        const chName = charRows?.[0]?.ch_name ?? null;

        const itemIds = [...norm.need.keys()];
        const [itemRows] = await conn.query(
            `SELECT it_id, it_name FROM \`${TBL.items}\` WHERE it_id IN (?)`,
            [itemIds]
        );
        const nameMap = new Map(itemRows.map(r => [Number(r.it_id), r.it_name]));

        await conn.beginTransaction();

        for (const [itId, cnt] of norm.need.entries()) {
            const itName = nameMap.get(Number(itId)) || null;

            // 1) 기존 인벤토리 중 첫 번째 행 업데이트
            const [upd] = await conn.query(
                `UPDATE \`${TBL.inventory}\`
                 SET item_stack = item_stack + ?,
                     it_name = COALESCE(?, it_name),
                     ch_name = COALESCE(?, ch_name)
                 WHERE ch_id = ? AND it_id = ?
                 ORDER BY in_id ASC
                 LIMIT 1`,
                [cnt, itName, chName, chId, itId]
            );

            // 2) 없으면 새로 추가
            if (upd.affectedRows === 0) {
                await conn.query(
                    `INSERT INTO \`${TBL.inventory}\`
                     (ch_id, it_id, it_name, ch_name, item_stack)
                     VALUES (?, ?, ?, ?, ?)`,
                    [chId, itId, itName, chName, cnt]
                );
            }
        }

        await conn.commit();

        return {
            ok: true,
            items: itemIds.map(id => ({
                item_id: id,
                count: norm.need.get(id),
                action: 'add',
            })),
        };
    } catch (e) {
        if (conn) try { await conn.rollback(); } catch { }
        return { ok: false, errors: ['EXCEPTION', e?.message].filter(Boolean) };
    } finally {
        conn.release();
    }
}

/** 아이템 제거(원자성 보장). 전부 충분해야 커밋. */
export async function removeInventoryItemsAtomic(chId, items) {
    const pool = await getPool();
    const conn = await pool.getConnection();

    try {
        const norm = normalizeItems(items);
        if (!norm.ok) {
            console.warn('[removeInventoryItemsAtomic] normalize failed:', norm.error);
            return { ok: false, errors: [norm.error] };
        }

        await conn.beginTransaction();

        const ids = [...norm.need.keys()];
        const [rows] = await conn.query(
            `SELECT it_id, item_stack FROM \`${TBL.inventory}\`
             WHERE ch_id = ? AND it_id IN (?) FOR UPDATE`,
            [chId, ids]
        );

        const stockMap = new Map(rows.map(r => [Number(r.it_id), Number(r.item_stack || 0)]));

        for (const [itId, needCnt] of norm.need.entries()) {
            const have = stockMap.get(itId) || 0;
            if (have < needCnt) {
                throw new Error(`NOT_ENOUGH_${itId}_NEED_${needCnt}_HAVE_${have}`);
            }
        }

        for (const [itId, needCnt] of norm.need.entries()) {
            await conn.query(
                `UPDATE \`${TBL.inventory}\`
                 SET item_stack = item_stack - ?
                 WHERE ch_id = ? AND it_id = ?`,
                [needCnt, chId, itId]
            );
        }

        await conn.query(
            `DELETE FROM \`${TBL.inventory}\`
             WHERE ch_id = ? AND item_stack <= 0`,
            [chId]
        );

        await conn.commit();

        const result = {
            ok: true,
            items: [...norm.need.entries()].map(([item_id, count]) => ({
                item_id,
                count,
                action: 'remove',
            })),
        };
        return result;

    } catch (e) {
        console.error('[removeInventoryItemsAtomic] EXCEPTION:', e);
        if (conn) try { await conn.rollback(); } catch (e2) { console.error('[removeInventoryItemsAtomic] rollback error', e2); }
        return { ok: false, errors: ['EXCEPTION', e?.message].filter(Boolean) };
    } finally {
        conn.release();
    }
}
