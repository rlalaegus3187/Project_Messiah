import { getPool } from '../utils/validators.js';

export async function updateCharacterLocationDB(characterId, { map }) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.query(
           ` UPDATE avo_character SET ch_map = ? WHERE ch_id = ?`,
            [map, characterId]
        );
        return { ok: true};
    } catch (e) {
        return { ok: false, error: e?.message };
    } finally {
        conn.release();
    }
}
