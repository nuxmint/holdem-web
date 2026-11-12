import { evaluate } from './evaluator.js';

export const BOT_ROSTER = [
  { name: '민수', style: { loose: -0.05, aggression: 0.4, bluff: 0.03 } },
  { name: '지아', style: { loose: 0.02, aggression: 0.8, bluff: 0.12 } },
  { name: '현우', style: { loose: 0.08, aggression: 0.25, bluff: 0.02 } },
  { name: '서연', style: { loose: 0, aggression: 0.55, bluff: 0.07 } },
  { name: '도윤', style: { loose: 0.05, aggression: 0.9, bluff: 0.18 } },
  { name: '하린', style: { loose: 0.03, aggression: 0.35, bluff: 0.05 } },
];

// Players, the human included, who reach the flop on a table that seats that many.
const MIN_FLOP_PLAYERS = 5;

/** Monte Carlo share of the pot against random hands. Ties count fractionally. */
export function estimateEquity(hole, board, opponents, iterations, rng) {
  const known = new Set([...hole, ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);

  const missing = 5 - board.length;
  const needed = missing + opponents * 2;
  let share = 0;

  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < needed; j++) {
      const k = j + Math.floor(rng() * (deck.length - j));
      [deck[j], deck[k]] = [deck[k], deck[j]];
    }
    const fullBoard = board.concat(deck.slice(0, missing));
    const mine = evaluate(hole.concat(fullBoard)).score;
    let tied = 1;
    let lost = false;
    for (let o = 0; o < opponents; o++) {
      const at = missing + o * 2;
      const theirs = evaluate([deck[at], deck[at + 1]].concat(fullBoard)).score;
      if (theirs > mine) {
        lost = true;
        break;
      }
      if (theirs === mine) tied++;
    }
    if (!lost) share += 1 / tied;
  }
  return share / iterations;
}

// Bets and raises are "to" amounts: a share of the pot on top of the current bet,
// rounded to 10. `stackCap` keeps a bet below that share of the remaining stack.
function raiseAmount(view, fraction, stackCap = 1) {
  const { legal, pot, currentBet, bet, chips } = view;
  const wanted = currentBet + (pot + legal.toCall) * fraction;
  const capped = Math.min(wanted, bet + chips * stackCap);
  const rounded = Math.round(capped / 10) * 10;
  const clamped = Math.min(Math.max(rounded, legal.minRaiseTo), legal.maxRaiseTo);
  // Betting most of a stack leaves nothing worth keeping, so commit it all.
  return clamped > legal.maxRaiseTo * 0.7 ? legal.maxRaiseTo : clamped;
}

const between = (rng, low, high) => low + rng() * (high - low);

/**
 * Hands are judged by `hs`, the share of the pot won against one random hand.
 * It reads the same at a full table and heads-up, so thresholds stay simple:
 * about 0.5 is an average hand, 0.7 a fair pair and 0.85 or more a strong hand.
 */
export function decide(view, style, rng = Math.random, iterations = 120) {
  const { legal, pot, chips, opponents } = view;
  const { toCall } = legal;
  const preflop = view.stage === 'preflop';
  const hs = estimateEquity(view.hole, view.board, 1, iterations, rng);
  // Each extra opponent makes it likelier that somebody holds a better hand.
  const field = Math.max(0, opponents - 1);
  // A bet that would take most of the stack needs a much better hand.
  const pressure = Math.min(1, toCall / Math.max(1, chips));
  const jitter = between(rng, -0.04, 0.04);
  // The human is counted as staying, so a bot may only fold while four others remain.
  const mustStay = preflop && view.seated >= MIN_FLOP_PLAYERS && view.botsLeft < MIN_FLOP_PLAYERS;
  const aggressive = (base) => rng() < base + (1 - base) * style.aggression;

  if (preflop) {
    // A raise over a raise shows real strength, and without this a full field
    // keeps raising itself all-in.
    if (legal.canRaise && hs > 0.63 + 0.12 * view.raises && aggressive(0.3)) {
      return { type: 'raise', amount: raiseAmount(view, between(rng, 0.7, 1), 0.3) };
    }
    if (legal.canRaise && pressure < 0.15 && rng() < style.bluff / opponents) {
      return { type: 'raise', amount: raiseAmount(view, between(rng, 0.6, 0.8), 0.2) };
    }
    if (legal.canCheck) return { type: 'check' };
    // Measured in big blinds, so limping costs little and a big raise a lot.
    const price = Math.min(10, toCall / view.bigBlind - 1);
    const need = 0.4 + 0.02 * price + 0.35 * pressure - style.loose + jitter;
    return hs >= need || mustStay ? { type: 'call' } : { type: 'fold' };
  }

  // Once the pot is large next to the stack, only good hands keep building it.
  const deep = Math.min(1, pot / Math.max(1, chips));

  if (legal.canCheck) {
    // Nobody has bet yet. Good hands bet for value, fair hands sometimes take a
    // stab, and now and then a bot bets with nothing. In a big field each bot
    // bets less often, so most streets see one bet rather than a flurry.
    // Sizes stay between a third and about two thirds of the pot.
    const strong = 0.8 + 0.025 * field;
    const fair = 0.61 + 0.02 * field + 0.12 * deep;
    const spread = Math.sqrt(opponents);
    if (legal.canRaise && hs > strong + jitter && aggressive(0.55)) {
      return { type: 'raise', amount: raiseAmount(view, between(rng, 0.4, 0.7), hs > 0.92 ? 1 : 0.35) };
    }
    if (legal.canRaise && hs > fair + jitter && rng() < (0.4 + 0.35 * style.aggression) / spread) {
      return { type: 'raise', amount: raiseAmount(view, between(rng, 0.3, 0.45), 0.2) };
    }
    if (legal.canRaise && deep < 0.5 && rng() < (0.04 + style.bluff) / opponents) {
      return { type: 'raise', amount: raiseAmount(view, between(rng, 0.33, 0.5), 0.15) };
    }
    return { type: 'check' };
  }

  // Facing a bet. Small bets get called by most fair hands, so the field
  // stays in; a pot-sized bet or a raise takes a real hand.
  const betSize = toCall / Math.max(1, pot - toCall);
  const reraises = Math.max(0, view.raises - 1);
  // Cards still to come make draws and small pairs worth a look.
  const toCome = view.board.length === 3 ? 0.04 : view.board.length === 4 ? 0.015 : 0;
  const need = 0.4 + 0.2 * Math.min(1.5, betSize) + 0.012 * field + 0.06 * reraises
    + 0.45 * pressure - toCome - style.loose + jitter;
  // Raises cap out so a full field does not keep re-raising itself all-in.
  const raiseBar = reraises >= 2 ? 0.95 : 0.86 + 0.05 * reraises + 0.015 * field;
  if (legal.canRaise && hs > raiseBar && aggressive(0.1)) {
    return { type: 'raise', amount: raiseAmount(view, between(rng, 0.5, 0.8), hs > 0.92 ? 1 : 0.45) };
  }
  if (hs >= need) return { type: 'call' };
  return { type: 'fold' };
}
