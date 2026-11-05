import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, makeCard, rankOf, CATEGORY } from '../js/evaluator.js';

const SUITS = 'shdc';
const RANKS = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
const card = (s) => makeCard(RANKS[s[0]] || Number(s[0]), SUITS.indexOf(s[1]));
const hand = (str) => str.split(' ').map(card);

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cases = [
  ['As Ks Qs Js Ts 2d 3c', CATEGORY.STRAIGHT_FLUSH, '로열 플러시'],
  ['9h 8h 7h 6h 5h Ad Ac', CATEGORY.STRAIGHT_FLUSH, '스트레이트 플러시'],
  ['Ah 2h 3h 4h 5h Kd Qc', CATEGORY.STRAIGHT_FLUSH, '스트레이트 플러시'],
  ['9s 9h 9d 9c Ks 2d 3c', CATEGORY.QUADS, '포카드'],
  ['Ks Kh Kd 2s 2h 3d 4c', CATEGORY.FULL_HOUSE, '풀하우스'],
  ['Ks Kh Kd 2s 2h 2d 4c', CATEGORY.FULL_HOUSE, '풀하우스'],
  ['As 9s 7s 4s 2s Kd Qc', CATEGORY.FLUSH, '플러시'],
  ['Ts 9h 8d 7c 6s 2d 3c', CATEGORY.STRAIGHT, '스트레이트'],
  ['As 2h 3d 4c 5s Kd Qc', CATEGORY.STRAIGHT, '스트레이트'],
  ['7s 7h 7d Ks 2h 3d 9c', CATEGORY.TRIPS, '트리플'],
  ['Ks Kh 2d 2c 9s 8d 3c', CATEGORY.TWO_PAIR, '투페어'],
  ['Ks Kh 9d 7c 5s 3d 2c', CATEGORY.PAIR, '원페어'],
  ['As Kh 9d 7c 5s 3d 2c', CATEGORY.HIGH_CARD, '하이카드'],
];

for (const [cards, category, name] of cases) {
  test(`${cards} is ${name}`, () => {
    const r = evaluate(hand(cards));
    assert.equal(r.category, category);
    assert.equal(r.name, name);
    assert.equal(r.best.length, 5);
    assert.equal(new Set(r.best).size, 5);
  });
}

test('hand order: every category beats the one below it', () => {
  const scores = [...cases].reverse().map(([c]) => evaluate(hand(c)).score);
  const order = [...cases].reverse().map(([, cat]) => cat);
  for (let i = 1; i < scores.length; i++) {
    if (order[i] > order[i - 1]) assert.ok(scores[i] > scores[i - 1]);
  }
});

test('the wheel loses to a six-high straight', () => {
  const wheel = evaluate(hand('As 2h 3d 4c 5s Kd Qc'));
  const six = evaluate(hand('2s 3h 4d 5c 6s Kd Qc'));
  assert.ok(six.score > wheel.score);
});

test('kickers decide equal pairs', () => {
  const a = evaluate(hand('As Ah Kd 7c 5s 3d 2c'));
  const b = evaluate(hand('Ad Ac Qd 7h 5h 3s 2h'));
  assert.ok(a.score > b.score);
});

test('a kicker beyond the best five does not count', () => {
  const a = evaluate(hand('As Ks Qd Jc 9h 3d 2c'));
  const b = evaluate(hand('Ad Kh Qs Jd 9c 4d 2h'));
  assert.equal(a.score, b.score);
});

test('two pair uses the best kicker, including a third pair', () => {
  const r = evaluate(hand('Ks Kh Qd Qc 2s 2d Ac'));
  assert.equal(r.category, CATEGORY.TWO_PAIR);
  assert.deepEqual(r.best.map(rankOf).sort((x, y) => y - x), [14, 13, 13, 12, 12]);
});

test('the board plays when nothing beats it, so both hands tie', () => {
  const board = 'Ts Jh Qd Kc As';
  const a = evaluate(hand(`2h 3h ${board}`));
  const b = evaluate(hand(`4d 5d ${board}`));
  assert.equal(a.score, b.score);
});

// Independent check: a plain five-card classifier tried on all 21 combinations.
function classify5(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => (c & 3) === (cards[0] & 3));
  const unique = [...new Set(ranks)];
  let straightTop = 0;
  if (unique.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightTop = ranks[0];
    else if (ranks.join() === '14,5,4,3,2') straightTop = 5;
  }
  const groups = unique
    .map((r) => [ranks.filter((x) => x === r).length, r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const shape = groups.map((g) => g[0]).join('');
  const order = groups.map((g) => g[1]);
  let category;
  if (flush && straightTop) category = 8;
  else if (shape === '41') category = 7;
  else if (shape === '32') category = 6;
  else if (flush) category = 5;
  else if (straightTop) category = 4;
  else if (shape === '311') category = 3;
  else if (shape === '221') category = 2;
  else if (shape === '2111') category = 1;
  else category = 0;
  const key = straightTop ? [straightTop] : order;
  return key.reduce((acc, r, i) => acc + r * 15 ** (4 - i), category * 15 ** 5);
}

function brute7(cards) {
  let best = 0;
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      best = Math.max(best, classify5(cards.filter((_, k) => k !== i && k !== j)));
    }
  }
  return best;
}

test('matches a brute-force evaluator on 100,000 random deals', () => {
  const rng = mulberry32(42);
  for (let n = 0; n < 100000; n++) {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const cards = [];
    for (let i = 0; i < 7; i++) {
      cards.push(deck.splice(Math.floor(rng() * deck.length), 1)[0]);
    }
    const expected = brute7(cards);
    assert.equal(evaluate(cards).score, expected, `cards ${cards}`);
  }
});

test('the best five are all from the input and score the same hand', () => {
  const rng = mulberry32(7);
  for (let n = 0; n < 20000; n++) {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const cards = [];
    for (let i = 0; i < 7; i++) {
      cards.push(deck.splice(Math.floor(rng() * deck.length), 1)[0]);
    }
    const r = evaluate(cards);
    assert.ok(r.best.every((c) => cards.includes(c)));
    assert.equal(evaluate(r.best).score, r.score);
  }
});
