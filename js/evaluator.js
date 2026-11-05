// Cards are integers 0..51. rank = 2..14 (14 = ace), suit = 0..3.
export const rankOf = (c) => (c >> 2) + 2;
export const suitOf = (c) => c & 3;
export const makeCard = (rank, suit) => ((rank - 2) << 2) | suit;

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

const NAMES = [
  '하이카드', '원페어', '투페어', '트리플', '스트레이트',
  '플러시', '풀하우스', '포카드', '스트레이트 플러시',
];

function encode(category, ranks) {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (ranks[i] || 0);
  return score;
}

// Returns the top rank of the best straight in a rank bitmask, or 0.
function straightHigh(mask) {
  for (let high = 14; high >= 6; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  // Wheel: A-2-3-4-5
  const wheel = (1 << 14) | 0b111100;
  return (mask & wheel) === wheel ? 5 : 0;
}

function pickRanks(cards, ranks) {
  const used = new Set();
  const picked = [];
  for (const r of ranks) {
    const c = cards.find((x) => rankOf(x) === r && !used.has(x));
    used.add(c);
    picked.push(c);
  }
  return picked;
}

function straightRanks(high) {
  return high === 5 ? [5, 4, 3, 2, 14] : [high, high - 1, high - 2, high - 3, high - 4];
}

/**
 * Evaluates the best five-card hand from 5 to 7 cards.
 * A higher `score` always beats a lower one; equal scores split the pot.
 */
export function evaluate(cards) {
  const counts = new Array(15).fill(0);
  const suits = [[], [], [], []];
  let mask = 0;
  for (const c of cards) {
    const r = rankOf(c);
    counts[r]++;
    mask |= 1 << r;
    suits[suitOf(c)].push(c);
  }

  const flushCards = suits.find((s) => s.length >= 5);
  if (flushCards) {
    let flushMask = 0;
    for (const c of flushCards) flushMask |= 1 << rankOf(c);
    const high = straightHigh(flushMask);
    if (high) {
      return result(CATEGORY.STRAIGHT_FLUSH, [high], pickRanks(flushCards, straightRanks(high)),
        high === 14 ? '로열 플러시' : NAMES[CATEGORY.STRAIGHT_FLUSH]);
    }
  }

  const quads = [];
  const trips = [];
  const pairs = [];
  const singles = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quads.push(r);
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
    else if (counts[r] === 1) singles.push(r);
  }

  if (quads.length) {
    const q = quads[0];
    const kicker = highestExcept(counts, [q]);
    return result(CATEGORY.QUADS, [q, kicker], pickRanks(cards, [q, q, q, q, kicker]));
  }

  if (trips.length && (trips.length > 1 || pairs.length)) {
    const t = trips[0];
    const p = Math.max(trips[1] || 0, pairs[0] || 0);
    return result(CATEGORY.FULL_HOUSE, [t, p], pickRanks(cards, [t, t, t, p, p]));
  }

  if (flushCards) {
    const ranks = flushCards.map(rankOf).sort((a, b) => b - a).slice(0, 5);
    return result(CATEGORY.FLUSH, ranks, pickRanks(flushCards, ranks));
  }

  const high = straightHigh(mask);
  if (high) {
    const ranks = straightRanks(high);
    return result(CATEGORY.STRAIGHT, [high], pickRanks(cards, ranks));
  }

  if (trips.length) {
    const t = trips[0];
    const kickers = topExcept(counts, [t], 2);
    return result(CATEGORY.TRIPS, [t, ...kickers], pickRanks(cards, [t, t, t, ...kickers]));
  }

  if (pairs.length >= 2) {
    const [a, b] = pairs;
    const kicker = highestExcept(counts, [a, b]);
    return result(CATEGORY.TWO_PAIR, [a, b, kicker], pickRanks(cards, [a, a, b, b, kicker]));
  }

  if (pairs.length) {
    const p = pairs[0];
    const kickers = topExcept(counts, [p], 3);
    return result(CATEGORY.PAIR, [p, ...kickers], pickRanks(cards, [p, p, ...kickers]));
  }

  const top = singles.slice(0, 5);
  return result(CATEGORY.HIGH_CARD, top, pickRanks(cards, top));
}

function result(category, ranks, best, name) {
  return { score: encode(category, ranks), category, name: name || NAMES[category], best };
}

function topExcept(counts, excluded, n) {
  const out = [];
  for (let r = 14; r >= 2 && out.length < n; r--) {
    if (counts[r] > 0 && !excluded.includes(r)) out.push(r);
  }
  return out;
}

function highestExcept(counts, excluded) {
  return topExcept(counts, excluded, 1)[0];
}
