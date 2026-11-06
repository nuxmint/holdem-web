import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, computePots } from '../js/engine.js';
import { decide, estimateEquity, BOT_ROSTER } from '../js/bot.js';
import { Session, STORE_KEY, STARTING_CHIPS } from '../js/session.js';
import { makeCard } from '../js/evaluator.js';

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seats = (...chips) => chips.map((c, i) => ({ name: `P${i}`, chips: c }));
const newTable = (chips, opts = {}) => new Table({ players: seats(...chips), rng: mulberry32(1), ...opts });

function runOut(t) {
  while (t.stage !== 'done') {
    if (t.toAct >= 0) {
      const l = t.legal();
      t.act({ type: l.canCheck ? 'check' : 'call' });
    } else t.advance();
  }
}

test('three-handed: blinds, order and dealer rotation', () => {
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  assert.equal(t.dealer, 0);
  assert.equal(t.players[1].bet, 10);
  assert.equal(t.players[2].bet, 20);
  assert.equal(t.toAct, 0);
  assert.equal(t.players[0].hole.length, 2);
  runOut(t);
  t.startHand();
  assert.equal(t.dealer, 1);
});

test('heads-up: dealer posts the small blind and acts first, then last', () => {
  const t = newTable([1000, 1000]);
  t.startHand();
  assert.equal(t.dealer, 0);
  assert.equal(t.players[0].bet, 10);
  assert.equal(t.players[1].bet, 20);
  assert.equal(t.toAct, 0);
  t.act({ type: 'call' });
  assert.equal(t.toAct, 1); // big blind option
  t.act({ type: 'check' });
  t.advance();
  assert.equal(t.stage, 'flop');
  assert.equal(t.toAct, 1);
});

test('the big blind keeps the option after limps', () => {
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  t.act({ type: 'call' });
  t.act({ type: 'call' });
  assert.equal(t.toAct, 2);
  assert.equal(t.legal().canCheck, true);
  assert.equal(t.legal().canRaise, true);
});

test('minimum raise follows the size of the last raise', () => {
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  assert.equal(t.legal().minRaiseTo, 40);
  t.act({ type: 'raise', amount: 100 }); // raise of 80
  assert.equal(t.legal().minRaiseTo, 180);
  assert.throws(() => t.act({ type: 'raise', amount: 179 }));
});

test('illegal actions are rejected', () => {
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  assert.throws(() => t.act({ type: 'check' }));
  assert.throws(() => t.act({ type: 'raise', amount: 5000 }));
  assert.throws(() => t.advance());
});

test('a short all-in raise does not reopen betting for players who acted', () => {
  const t = newTable([1000, 1000, 1000, 130]);
  t.startHand(); // dealer 0, sb 1, bb 2, UTG 3
  t.act({ type: 'call' }); // seat 3 calls 20
  t.act({ type: 'raise', amount: 100 }); // seat 0 raises by 80
  t.act({ type: 'fold' }); // seat 1
  t.act({ type: 'call' }); // seat 2
  assert.equal(t.toAct, 3);
  t.act({ type: 'raise', amount: 130 }); // all-in for 30 more: not a full raise
  assert.equal(t.toAct, 0);
  assert.equal(t.legal().toCall, 30);
  assert.equal(t.legal().canRaise, false);
  t.act({ type: 'call' });
  assert.equal(t.toAct, 2);
  assert.equal(t.legal().canRaise, false);
  t.act({ type: 'call' });
  assert.ok(t.needsAdvance);
});

test('a full raise reopens betting for players who acted', () => {
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  t.act({ type: 'call' });
  t.act({ type: 'call' });
  t.act({ type: 'raise', amount: 60 });
  assert.equal(t.toAct, 0);
  assert.equal(t.legal().canRaise, true);
});

test('all-in player cannot be raised over when nobody else can call', () => {
  const t = newTable([1000, 300]);
  t.startHand();
  t.act({ type: 'raise', amount: 1000 });
  assert.equal(t.toAct, 1);
  assert.equal(t.legal().canRaise, false);
  assert.equal(t.legal().toCall, 280);
  t.act({ type: 'call' });
  assert.ok(t.needsAdvance);
  runOut(t);
  assert.equal(t.board.length, 5);
  assert.equal(t.players[0].chips + t.players[1].chips, 1300);
  assert.ok(t.players[0].chips >= 700);
});

test('uncalled chips return to the bettor', () => {
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  t.act({ type: 'raise', amount: 500 });
  t.act({ type: 'fold' });
  t.act({ type: 'fold' });
  assert.equal(t.stage, 'done');
  assert.equal(t.results.showdown, false);
  assert.deepEqual(t.players.map((p) => p.chips), [1030, 990, 980]);
});

test('short big blind: heads-up small blind only matches live money', () => {
  const t = newTable([1000, 15]);
  t.startHand(); // seat 0 posts 10, seat 1 all-in 15
  assert.equal(t.toAct, 0);
  assert.equal(t.legal().toCall, 5);
  t.act({ type: 'call' });
  assert.ok(t.needsAdvance);
  runOut(t);
  assert.equal(t.players[0].chips + t.players[1].chips, 1015);
});

test('short big blind smaller than the small blind needs no action', () => {
  const t = newTable([1000, 5]);
  t.startHand();
  assert.equal(t.toAct, -1);
  runOut(t);
  assert.equal(t.players[0].chips + t.players[1].chips, 1005);
});

test('all-in small blind heads-up skips the big blind', () => {
  const t = newTable([5, 1000]);
  t.startHand();
  assert.equal(t.toAct, -1);
  runOut(t);
  assert.equal(t.players[0].chips + t.players[1].chips, 1005);
});

test('side pots: three different stacks', () => {
  const pots = computePots([
    { total: 100, folded: false },
    { total: 300, folded: false },
    { total: 500, folded: false },
  ]);
  assert.deepEqual(pots, [
    { amount: 300, eligible: [0, 1, 2] },
    { amount: 400, eligible: [1, 2] },
    { amount: 200, eligible: [2] },
  ]);
});

test('side pots: folded money stays in but folded players are not eligible', () => {
  const pots = computePots([
    { total: 200, folded: true },
    { total: 100, folded: false },
    { total: 400, folded: false },
    { total: 400, folded: false },
  ]);
  assert.deepEqual(pots, [
    { amount: 400, eligible: [1, 2, 3] },
    { amount: 700, eligible: [2, 3] },
  ]);
});

test('side pots: folded player who put in more than every live player', () => {
  const pots = computePots([
    { total: 10, folded: true },
    { total: 5, folded: false },
  ]);
  assert.deepEqual(pots, [{ amount: 15, eligible: [1] }]);
});

test('side pot payout: short stack wins main pot, big stack wins the side pot', () => {
  const c = (r, s) => makeCard(r, s);
  const t = newTable([100, 300, 300]);
  t.startHand();
  t.players[0].hole = [c(14, 0), c(14, 1)]; // aces
  t.players[1].hole = [c(13, 0), c(13, 1)]; // kings
  t.players[2].hole = [c(2, 2), c(7, 3)];
  // Deal order pops from the end: burn, flop x3, burn, turn, burn, river.
  const board = [c(3, 2), c(4, 3), c(9, 2), c(10, 3), c(12, 2)];
  t.deck = [board[4], 0, board[3], 0, board[2], board[1], board[0], 0].slice();
  t.deck = [...t.deck];
  t.act({ type: 'raise', amount: 100 }); // seat 0 all-in
  t.act({ type: 'raise', amount: 300 }); // seat 1 all-in
  t.act({ type: 'call' }); // seat 2 all-in
  runOut(t);
  assert.equal(t.players[0].chips, 300); // 100 x 3
  assert.equal(t.players[1].chips, 400); // side pot 200 x 2
  assert.equal(t.players[2].chips, 0);
});

test('split pot divides evenly and the odd chip goes left of the button', () => {
  const c = (r, s) => makeCard(r, s);
  const t = newTable([1000, 1000, 1000]);
  t.startHand(); // dealer 0, sb 1, bb 2
  t.players[0].hole = [c(2, 0), c(3, 0)];
  t.players[1].hole = [c(2, 1), c(3, 1)];
  t.players[2].hole = [c(2, 2), c(3, 2)];
  const board = [c(10, 3), c(11, 3), c(12, 3), c(13, 3), c(14, 3)];
  t.deck = [board[4], 0, board[3], 0, board[2], board[1], board[0], 0];
  t.act({ type: 'fold' }); // seat 0
  t.act({ type: 'call' }); // seat 1 completes
  t.act({ type: 'raise', amount: 25 + 15 }); // seat 2 to 40
  t.act({ type: 'call' });
  runOut(t);
  assert.equal(t.players[1].chips + t.players[2].chips, 2000);
  assert.equal(t.players[1].chips, 1000);
});

test('odd chip distribution in a split', () => {
  const c = (r, s) => makeCard(r, s);
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  t.players[0].hole = [c(2, 0), c(3, 0)];
  t.players[1].hole = [c(2, 1), c(3, 1)];
  t.players[2].hole = [c(2, 2), c(3, 2)];
  const board = [c(10, 3), c(11, 3), c(12, 3), c(13, 3), c(14, 3)];
  t.deck = [board[4], 0, board[3], 0, board[2], board[1], board[0], 0];
  t.players[0].total = 1; // force an odd total: 1 extra folded chip
  t.players[0].chips -= 1;
  t.act({ type: 'fold' });
  t.act({ type: 'call' });
  t.act({ type: 'check' });
  runOut(t);
  // Pot is 41. Seat 1 sits left of the button and takes the odd chip.
  assert.equal(t.players[1].chips, 1001);
  assert.equal(t.players[2].chips, 1000 - 20 + 20);
  assert.equal(t.players.reduce((s, p) => s + p.chips, 0), 3000);
});

test('equity estimates are sensible', () => {
  const rng = mulberry32(3);
  const aces = [makeCard(14, 0), makeCard(14, 1)];
  const junk = [makeCard(7, 0), makeCard(2, 1)];
  const a = estimateEquity(aces, [], 1, 4000, rng);
  const j = estimateEquity(junk, [], 1, 4000, rng);
  assert.ok(a > 0.8 && a < 0.89, `aces ${a}`);
  assert.ok(j > 0.3 && j < 0.4, `seven-deuce ${j}`);
});

test('bots do not receive other players hole cards', () => {
  const t = newTable([1000, 1000, 1000]);
  t.startHand();
  const view = t.viewFor(t.toAct);
  const text = JSON.stringify(view);
  assert.ok(!('players' in view));
  assert.ok(!('deck' in view));
  assert.ok(!text.includes('hole":[]'));
});

for (const botCount of [1, 2, 5, 6]) {
  test(`bot simulation keeps chips conserved with ${botCount + 1} players`, () => {
    const rng = mulberry32(100 + botCount);
    const players = seats(...new Array(botCount + 1).fill(1000)).map((p, i) => ({
      ...p,
      style: BOT_ROSTER[i % BOT_ROSTER.length].style,
    }));
    const t = new Table({ players, rng });
    const total = 1000 * (botCount + 1);
    let showdowns = 0;

    for (let hand = 0; hand < 1500; hand++) {
      if (t.seatedCount < 2) {
        for (const p of t.players) p.chips = 1000;
      }
      const before = t.players.reduce((s, p) => s + p.chips, 0);
      t.startHand();
      let guard = 0;
      while (t.stage !== 'done') {
        assert.ok(guard++ < 300, 'hand did not terminate');
        if (t.toAct >= 0) {
          assert.ok(!t.players[t.toAct].folded && !t.players[t.toAct].allIn);
          t.act(decide(t.viewFor(t.toAct), t.players[t.toAct].style, rng, 8));
        } else t.advance();
      }
      assert.equal(t.players.reduce((s, p) => s + p.chips, 0), before, `hand ${hand}`);
      assert.ok(t.players.every((p) => p.chips >= 0 && Number.isInteger(p.chips)));
      if (t.results.showdown) {
        showdowns++;
        assert.equal(t.board.length, 5);
      }
    }
    assert.ok(showdowns > 0);
    assert.ok(total > 0);
  });
}

// Plays hands with a scripted human in seat 0 and records who was left at each flop.
function flopFields(botCount, human, hands = 200) {
  const rng = mulberry32(40 + botCount);
  const bots = BOT_ROSTER.slice(0, botCount).map((b) => ({ ...b, isHuman: false, chips: 3000 }));
  const t = new Table({ players: [{ name: '나', isHuman: true, chips: 3000 }, ...bots], rng });
  const fields = [];
  for (let hand = 0; hand < hands; hand++) {
    for (const p of t.players) if (p.chips === 0) p.chips = 3000;
    t.startHand();
    while (t.stage !== 'done') {
      if (t.toAct === 0) t.act(human(t.legal(), t.stage));
      else if (t.toAct > 0) t.act(decide(t.viewFor(t.toAct), t.players[t.toAct].style, rng, 8));
      else {
        if (t.stage === 'preflop') {
          const live = t.players.filter((p) => p.inHand && !p.folded);
          fields.push({ total: live.length, bots: live.filter((p) => !p.isHuman).length });
        }
        t.advance();
      }
    }
  }
  return fields;
}

const passive = (l) => ({ type: l.canCheck ? 'check' : 'call' });
const quitter = (l) => ({ type: l.canCheck ? 'check' : 'fold' });
const shover = (l, stage) => {
  if (stage !== 'preflop') return quitter(l);
  return l.canRaise ? { type: 'raise', amount: l.maxRaiseTo } : passive(l);
};

test('at a full table at least five players see every flop', () => {
  const fields = flopFields(6, passive);
  assert.equal(fields.length, 200);
  assert.ok(fields.every((f) => f.total >= 5), JSON.stringify(fields.find((f) => f.total < 5)));
  assert.ok(fields.some((f) => f.total > 5), 'the field size should still vary');
});

test('five players still see the flop when the human shoves every hand', () => {
  const fields = flopFields(6, shover);
  assert.equal(fields.length, 200);
  assert.ok(fields.every((f) => f.total >= 5));
});

test('four bots stay in even when the human folds', () => {
  const fields = flopFields(6, quitter);
  assert.equal(fields.length, 200);
  assert.ok(fields.every((f) => f.bots >= 4));
});

test('at a table of exactly five nobody but the human can leave before the flop', () => {
  const fields = flopFields(4, passive);
  assert.equal(fields.length, 200);
  assert.ok(fields.every((f) => f.total === 5));
});

const SEVEN_DEUCE = [makeCard(7, 0), makeCard(2, 1)];
const ACES = [makeCard(14, 0), makeCard(14, 1)];
const STEADY = { loose: 0, aggression: 1, bluff: 0 };
const facing = (toCall, overrides = {}) => ({
  hole: SEVEN_DEUCE,
  board: [],
  stage: 'preflop',
  pot: 30,
  chips: 3000,
  bet: 0,
  currentBet: toCall,
  raises: 0,
  bigBlind: 20,
  opponents: 6,
  seated: 7,
  botsLeft: 6,
  legal: { toCall, canCheck: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0 },
  ...overrides,
});

test('while the field allows it, preflop folds follow the strength of the hand', () => {
  const rng = mulberry32(5);
  assert.equal(decide(facing(20), STEADY, rng, 400).type, 'fold');
  assert.equal(decide(facing(20, { hole: ACES }), STEADY, rng, 400).type, 'call');
  const middling = [makeCard(11, 0), makeCard(10, 0)];
  assert.equal(decide(facing(20, { hole: middling }), STEADY, rng, 400).type, 'call');
});

test('the last four bots call even a huge preflop bet', () => {
  const view = facing(3000, { pot: 3030, botsLeft: 4, opponents: 4 });
  assert.equal(decide(view, STEADY, mulberry32(6), 100).type, 'call');
});

test('the rule ends at the flop', () => {
  const board = [makeCard(13, 2), makeCard(12, 2), makeCard(9, 3)];
  const view = facing(500, { pot: 1000, botsLeft: 4, opponents: 4, stage: 'flop', board });
  assert.equal(decide(view, STEADY, mulberry32(7), 100).type, 'fold');
});

test('a table too small for five players keeps normal folding', () => {
  const view = facing(3000, { pot: 3030, seated: 4, botsLeft: 3, opponents: 3 });
  assert.equal(decide(view, STEADY, mulberry32(8), 100).type, 'fold');
});

test('bots bluff a full field less than a single opponent', () => {
  const rng = mulberry32(9);
  const style = { loose: 0, aggression: 0, bluff: 0.3 };
  const legal = { toCall: 20, canCheck: false, canRaise: true, minRaiseTo: 40, maxRaiseTo: 3000 };
  const raises = (opponents) => {
    let count = 0;
    for (let i = 0; i < 1000; i++) {
      if (decide(facing(20, { legal, opponents }), style, rng, 20).type === 'raise') count++;
    }
    return count;
  };
  const heads = raises(1);
  const field = raises(6);
  assert.ok(heads > 240 && heads < 360, `heads-up ${heads}`);
  assert.ok(field > 25 && field < 85, `full field ${field}`);
});

test('a raise over a raise needs a stronger hand', () => {
  const rng = mulberry32(10);
  const legal = { toCall: 20, canCheck: false, canRaise: true, minRaiseTo: 40, maxRaiseTo: 3000 };
  const view = { hole: ACES, opponents: 1, seated: 2, botsLeft: 1, legal };
  assert.equal(decide(facing(20, view), STEADY, rng, 400).type, 'raise');
  assert.equal(decide(facing(20, { ...view, raises: 2 }), STEADY, rng, 400).type, 'call');
});

test('random legal play never breaks the engine', () => {
  const rng = mulberry32(55);
  const t = new Table({ players: seats(300, 50, 700, 25, 1000, 120), rng });
  for (let hand = 0; hand < 5000; hand++) {
    if (t.seatedCount < 2) t.players.forEach((p, i) => { p.chips = [300, 50, 700, 25, 1000, 120][i]; });
    const before = t.players.reduce((s, p) => s + p.chips, 0);
    t.startHand();
    let guard = 0;
    while (t.stage !== 'done') {
      assert.ok(guard++ < 300, 'hand did not terminate');
      if (t.toAct < 0) {
        t.advance();
        continue;
      }
      const l = t.legal();
      const roll = rng();
      if (l.canRaise && roll < 0.35) {
        const span = l.maxRaiseTo - l.minRaiseTo;
        t.act({ type: 'raise', amount: l.minRaiseTo + Math.floor(rng() * (span + 1)) });
      } else if (!l.canCheck && roll < 0.55) t.act({ type: 'fold' });
      else t.act({ type: l.canCheck ? 'check' : 'call' });
    }
    assert.equal(t.players.reduce((s, p) => s + p.chips, 0), before, `hand ${hand}`);
  }
});

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
  };
}

test('session saves and restores chips, settings and stats', () => {
  const storage = memoryStorage();
  const a = new Session({ storage, rng: mulberry32(9) });
  a.newGame(2);
  a.setSpeed('fast');
  a.startHand();
  runOut(a.table);
  a.finishHand();
  const chips = a.table.players.map((p) => p.chips);

  const b = new Session({ storage, rng: mulberry32(10) });
  assert.deepEqual(b.table.players.map((p) => p.chips), chips);
  assert.equal(b.settings.botCount, 2);
  assert.equal(b.settings.speed, 'fast');
  assert.equal(b.stats.hands, 1);
  assert.equal(b.table.dealer, a.table.dealer);
});

test('session survives corrupt saved data', () => {
  const storage = memoryStorage();
  storage.setItem(STORE_KEY, '{not json');
  const s = new Session({ storage });
  assert.equal(s.table.players.length, 7);
  assert.equal(s.human.chips, STARTING_CHIPS);
});

test('a new game seats seven players with 3,000 chips each', () => {
  const s = new Session({ storage: memoryStorage() });
  assert.equal(STARTING_CHIPS, 3000);
  assert.equal(s.table.players.length, 7);
  assert.ok(s.table.players.every((p) => p.chips === 3000));
  const names = s.table.players.map((p) => p.name);
  assert.equal(new Set(names).size, 7);
  assert.ok(s.table.players.slice(1).every((p) => p.style));
});

test('an older save moves to the new table and keeps its record', () => {
  const storage = memoryStorage();
  storage.setItem(STORE_KEY, JSON.stringify({
    settings: { botCount: 4, speed: 'fast' },
    stats: { hands: 120, wins: 40, biggestPot: 5100, rebuys: 2 },
    handNumber: 120,
    dealer: 3,
    chips: [6400, 900, 1200, 800, 700],
  }));
  const s = new Session({ storage });
  assert.equal(s.table.players.length, 7);
  assert.ok(s.table.players.every((p) => p.chips === 3000));
  assert.equal(s.settings.botCount, 6);
  assert.equal(s.settings.speed, 'fast');
  assert.deepEqual(s.stats, { hands: 120, wins: 40, biggestPot: 5100, rebuys: 2 });
  assert.equal(s.handNumber, 120);
});

test('the upgrade happens once, so later play and bot count choices survive a reload', () => {
  const storage = memoryStorage();
  storage.setItem(STORE_KEY, JSON.stringify({
    settings: { botCount: 4, speed: 'normal' },
    stats: {},
    chips: [2000, 2000, 2000, 2000, 2000],
  }));
  const a = new Session({ storage, rng: mulberry32(4) });
  a.startHand();
  runOut(a.table);
  a.finishHand();
  const chips = a.table.players.map((p) => p.chips);
  assert.deepEqual(new Session({ storage }).table.players.map((p) => p.chips), chips);

  a.newGame(3);
  const b = new Session({ storage });
  assert.equal(b.table.players.length, 4);
  assert.equal(b.settings.botCount, 3);
});

test('busted bots rebuy and a busted human must rebuy', () => {
  const s = new Session({ storage: memoryStorage(), rng: mulberry32(2) });
  s.table.players[1].chips = 0;
  s.startHand();
  assert.ok(s.table.players[1].inHand);
  runOut(s.table);
  s.finishHand();
  s.human.chips = 0;
  assert.ok(s.needsRebuy);
  s.rebuy();
  assert.equal(s.human.chips, STARTING_CHIPS);
  assert.equal(s.stats.rebuys, 1);
});
