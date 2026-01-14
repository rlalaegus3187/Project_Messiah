export const tileKey = (x, y) => `${x},${y}`;

export function getBaseTile(raid, x, y) {
  return raid?.map?.tiles?.[y]?.[x];
}

export function getEffectiveTile(raid, x, y) {
  const key = tileKey(x, y);
  return raid.tileOverrides?.get(key)?.value ?? getBaseTile(raid, x, y);
}

export function setTileOverride(raid, x, y, effects = []) {
  const key = tileKey(x, y);
  const original = getBaseTile(raid, x, y);
  raid.tileOverrides.set(key, { x, y, original, effects });
  if (effects.length) raid.tileEffects.set(key, effects);
}

export function clearTileOverride(raid, x, y) {
  const key = tileKey(x, y);
  raid.tileOverrides.delete(key);
  raid.tileEffects.delete(key);
}

export function getTileEffects(raid, x, y) {
  const key = tileKey(x, y);
  // 우선순위: tileEffects → tileOverrides.effects
  if (raid?.tileEffects?.has?.(key)) return raid.tileEffects.get(key) || [];
  const ov = raid?.tileOverrides?.get?.(key);
  return ov?.effects || [];
}
