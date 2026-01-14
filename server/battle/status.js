// 클라이언트 HUD에서 사용할 아이콘 키 매핑
export const STATUS_ICON_KEYS = {
  burn: "burn",
  poison: "poison",
  bleed: "bleed",
  regen: "regen",
  stun: "stun",
  slow: "slow",
  shield: "shield",
  vuln: "vuln",
  vulnerable: "vuln", 
  fortify: "fortify",
  haste: "haste",
  empower: "empower",
  adrenaline: "adrenaline",
  taunt: "taunt",
};

// --- utils ---
export function nowMs() {
  return Date.now();
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function newStatus(spec) {
  const {
    id,
    src = "skill", // 'skill' | 'boss' | 'system'
    stacks = 1,
    durationMs = 3000,
    magnitude = 1, // 상태별 의미가 다름 (계수/고정값 등)
    maxStacks = 5,
    meta = null,
  } = spec || {};

  return {
    id,
    src,
    stacks,
    durationMs,
    remainMs: durationMs,
    magnitude,
    maxStacks,
    meta,
    _accum: 0, 
  };
}

// --- list accessor ---
export function list(entity) {
  return entity.statuses || (entity.statuses = []);
}

// --- taunt meta normalize ---
function normalizeTauntMeta(meta) {
  if (meta == null) return null;
  if (typeof meta === "object") {
    if (meta.taunterId != null) return { taunterId: meta.taunterId };
    if (meta.id != null) return { taunterId: meta.id };
    return meta;
  }
  return { taunterId: meta };
}

// --- add/update status ---
// 같은 id가 있으면 stack/시간 갱신, 없으면 새로 추가
export function add(entity, spec) {
  if (!entity || !spec?.id) return;

  const sts = list(entity);
  const idx = sts.findIndex((s) => s.id === spec.id);

  // 도발은 항상 "최신 대상"으로 교체
  if (spec.id === "taunt") {
    const fixed = { ...spec, meta: normalizeTauntMeta(spec.meta) };
    if (idx >= 0) sts[idx] = newStatus(fixed);
    else sts.push(newStatus(fixed));
    return;
  }

  if (idx >= 0) {
    const s = sts[idx];
    const cap = s.maxStacks ?? spec.maxStacks ?? 5;

    s.stacks = Math.min(cap, (s.stacks || 0) + (spec.stacks || 1));
    s.magnitude = spec.magnitude ?? s.magnitude;
    s.durationMs = spec.durationMs ?? s.durationMs;

    s.remainMs = s.durationMs;
  } else {
    sts.push(newStatus(spec));
  }
}

// --- remove / has ---
export function remove(entity, id) {
  if (!entity?.statuses) return;
  entity.statuses = entity.statuses.filter((s) => s.id !== id);
}
export function has(entity, id) {
  return !!entity?.statuses?.some((s) => s.id === id);
}

/* ---------------- taunt helpers ---------------- */
export function getTauntTargetId(entity) {
  const s = entity?.statuses?.find((ss) => ss.id === "taunt");
  if (!s) return null;
  const meta = s.meta;
  if (meta && typeof meta === "object" && meta.taunterId != null) return meta.taunterId;
  return meta ?? null;
}

/* ---------------- modifiers & ticking ---------------- */

const MOD_CAPS = {
  apRegen: { min: 0.0, max: 10000.0 },
  dmgTaken: { min: 0.0, max: 10000.0 },
  dmgDealt: { min: 0.0, max: 10000.0 },
};

function toAdditive(mag) {
  const m = Number(mag || 0);
  if (!Number.isFinite(m)) return 0;

  if (m > -1 && m < 1) return m;

  return m - 1;
}

export function computeModifiers(entity) {
  const res = {
    apRegenMul: 1,
    dmgTakenMul: 1,
    dmgDealtMul: 1,
    flatShield: 0,
  };

  const arr = Array.isArray(entity?.statuses) ? entity.statuses : [];

  let apAdd = 0;
  let takenAdd = 0;
  let dealtAdd = 0;
  let shieldSum = 0;

  for (const s of arr) {
    const stacks = Math.max(1, s.stacks || 1);

    switch (s.id) {
      case "haste":
        apAdd += toAdditive(s.magnitude) * stacks;
        break;
      case "slow":
        apAdd -= Math.abs(toAdditive(s.magnitude)) * stacks;
        break;

      case "vuln":
      case "vulnerable":
        takenAdd += Math.abs(toAdditive(s.magnitude)) * stacks;
        break;

      case "fortify":
        takenAdd -= Math.abs(toAdditive(s.magnitude)) * stacks;
        break;

      case "empower":
      case "adrenaline":
        dealtAdd += toAdditive(s.magnitude) * stacks;
        break;

      case "shield":
        shieldSum += Number(s.magnitude || 0) * stacks;
        break;

      // DOT/HOT/taunt 등은 tickEntity에서 처리
      default:
        break;
    }
  }

  // 피해 배율: 1 + takenAdd (vuln은 +, fortify는 -)
  // 디자인상 무적을 원치 않으면 하한(예: 0.1)로 바꿀 수 있음
  res.dmgTakenMul = clamp(1 + takenAdd, MOD_CAPS.dmgTaken.min, MOD_CAPS.dmgTaken.max);

  res.apRegenMul = clamp(1 + apAdd, MOD_CAPS.apRegen.min, MOD_CAPS.apRegen.max);
  res.dmgDealtMul = clamp(1 + dealtAdd, MOD_CAPS.dmgDealt.min, MOD_CAPS.dmgDealt.max);

  res.flatShield = Math.max(0, Math.floor(shieldSum));
  return res;
}

/**
 * tickEntity
 * - DOT/HOT는 1초 단위로만 발동(누적 시간으로 처리)
 * - 만료되면 자동 제거
 */
export function tickEntity(entity, dtMs, hooks) {
  const sts = list(entity);
  const expired = [];

  for (const s of sts) {
    s.remainMs -= dtMs;

    s._accum ??= 0;
    s._accum += dtMs;

    while (s._accum >= 1000) {
      s._accum -= 1000;

      if (s.id === "burn" || s.id === "poison" || s.id === "bleed") {
        const dps = Math.max(0, (s.magnitude || 5) * (s.stacks || 1));
        hooks?.onDot?.(entity, dps, s.id);
      } else if (s.id === "regen") {
        const hps = Math.max(0, (s.magnitude || 5) * (s.stacks || 1));
        hooks?.onHot?.(entity, hps, s.id);
      }
    }

    if (s.remainMs <= 0) expired.push(s);
  }

  if (expired.length) {
    entity.statuses = sts.filter((s) => !expired.includes(s));
  }
}


export function serialize(entity) {
  if (!entity?.statuses) return [];

  return entity.statuses.map((s) => ({
    id: s.id,
    stacks: s.stacks,
    remainMs: Math.max(0, Math.floor(s.remainMs || 0)),
    durationMs: s.durationMs,
    magnitude: s.magnitude,
    meta: s.id === "taunt" ? normalizeTauntMeta(s.meta) : undefined,
  }));
}
