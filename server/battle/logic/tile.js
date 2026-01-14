
export const tileKey = (x, y) => `${x},${y}`;

export function getBaseTile(raid, x, y) {
  return raid?.map?.tiles?.[y]?.[x] ?? null;
}

/*
 최종 타일 정보 조회
 - 이 프로젝트에서는 "타일 자체 값"은 base 타일을 사용하고
 - 장판/함정/디버프 같은 동적 요소는 effects로 관리한다
*/
export function getEffectiveTile(raid, x, y) {
  const base = getBaseTile(raid, x, y);
  const effects = getTileEffects(raid, x, y);
  return { base, effects };
}

// 타일 오버라이드 초기화 보장 (호출부가 깜빡해도 안전하게)
function ensureTileMaps(raid) {
  if (!raid.tileOverrides) raid.tileOverrides = new Map();
  if (!raid.tileEffects) raid.tileEffects = new Map();
}

// 특정 타일에 동적 효과(장판/함정 등) 등록
export function setTileOverride(raid, x, y, effects = []) {
  if (!raid) return;

  ensureTileMaps(raid);

  const key = tileKey(x, y);
  const original = getBaseTile(raid, x, y);

  // tileOverrides에는 원본과 효과 메타를 저장 (디버깅/동기화 용도)
  raid.tileOverrides.set(key, { x, y, original, effects });

  // 실제 판정에 쓰는 효과는 tileEffects에 저장
  if (effects.length) raid.tileEffects.set(key, effects);
  else raid.tileEffects.delete(key);
}

// 타일 효과 제거
export function clearTileOverride(raid, x, y) {
  if (!raid) return;

  ensureTileMaps(raid);

  const key = tileKey(x, y);
  raid.tileOverrides.delete(key);
  raid.tileEffects.delete(key);
}


//타일 효과 조회
export function getTileEffects(raid, x, y) {
  const key = tileKey(x, y);

  if (raid?.tileEffects?.has?.(key)) return raid.tileEffects.get(key) || [];
  const ov = raid?.tileOverrides?.get?.(key);
  return ov?.effects || [];
}
