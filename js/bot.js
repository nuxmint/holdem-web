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

function raiseAmount(view, fraction) {
  const { legal, pot, currentBet } = view;
  const wanted = currentBet + Math.round((pot + legal.toCall) * fraction);
  const rounded = Math.round(wanted / 10) * 10;
  const clamped = Math.min(Math.max(rounded, legal.minRaiseTo), legal.maxRaiseTo);
  // Betting most of a stack leaves nothing worth keeping, so commit it all.
  return clamped > legal.maxRaiseTo * 0.7 ? legal.maxRaiseTo : clamped;
}

export function decide(view, style, rng = Math.random, iterations = 120) {
  const { legal, pot, chips, opponents } = view;
  const { toCall } = legal;
  const preflop = view.stage === 'preflop';
  const equity = estimateEquity(view.hole, view.board, opponents, iterations, rng);

  const fairShare = 1 / (opponents + 1);
  const strong = fairShare + (1 - fairShare) * 0.45;
  // Equity against a full table starts low, but so does the price: preflop the
  // pot keeps growing as the field calls, so measure against the pot it becomes.
  const potOdds = toCall > 0 ? toCall / (pot + toCall * (preflop ? opponents + 1 : 1)) : 0;
  // Equity is measured against random hands, but big bets rarely come from
  // random hands, so demand more the larger the bet and the more raises there are.
  const pressure = Math.min(1, toCall / Math.max(1, chips));
  const margin = preflop ? 0 : 0.04;
  const required = potOdds + margin + 0.22 * pressure + 0.04 * view.raises - style.loose;
  // The human is counted as staying, so a bot may only fold while four others remain.
  const mustStay = preflop && view.seated >= MIN_FLOP_PLAYERS && view.botsLeft < MIN_FLOP_PLAYERS;

  // A raise over a raise shows real strength, and without this a full field
  // keeps raising itself all-in. Bluffs likewise have more hands to get through.
  if (legal.canRaise && equity > strong + 0.1 * view.raises && rng() < 0.5 + style.aggression / 2) {
    return { type: 'raise', amount: raiseAmount(view, 0.5 + rng() * 0.5) };
  }
  if (legal.canRaise && pressure < 0.15 && rng() < style.bluff / opponents) {
    return { type: 'raise', amount: raiseAmount(view, 0.5 + rng() * 0.25) };
  }
  if (legal.canCheck) return { type: 'check' };
  if (equity >= required || mustStay) return { type: 'call' };
  return { type: 'fold' };
}
