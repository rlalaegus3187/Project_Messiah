export const socket = io("https://scenario-messiah.com:5000");

// 숫자 변환 유틸: 순수 숫자면 그대로, 아니면 문자열에서 숫자 덩어리(마지막 것) 추출
function toInt(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);

  const s = String(v ?? "").trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  // 예: "raid-team-12-1694512345678" → 1694512345678 (마지막 숫자 덩어리)
  const m = s.match(/\d+/g);
  if (m && m.length) return parseInt(m[m.length - 1], 10);

  return NaN;
}

export function joinRaid({ raidId, chId, isView } = {}) {
  const raidIdNum = toInt(raidId);
  const chIdNum = toInt(chId ?? (typeof window !== "undefined" ? window.characterId : undefined));

  if (!Number.isFinite(raidIdNum) || raidIdNum <= 0) {
    console.error("[joinRaid] invalid raidId:", raidId);
    return false;
  }
  if (!Number.isFinite(chIdNum) || chIdNum <= 0) {
    console.error("[joinRaid] invalid chId:", chId);
    return false;
  }

  socket.emit("joinRaid", { raidId: raidIdNum, chId: chIdNum, isView });
  return true;
}
