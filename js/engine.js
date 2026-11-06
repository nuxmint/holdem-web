import { evaluate } from './evaluator.js';

const STREETS = ['preflop', 'flop', 'turn', 'river'];

export function shuffledDeck(rng) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Splits contributions into a main pot and side pots.
 * `players` need { total, folded, inHand }. Returns [{ amount, eligible: [seat] }].
 */
export function computePots(players) {
  const seats = players.map((p, seat) => ({ ...p, seat })).filter((p) => p.total > 0);
  const live = seats.filter((p) => !p.folded);
  const levels = [...new Set(live.map((p) => p.total))].sort((a, b) => a - b);

  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of seats) amount += Math.min(p.total, level) - Math.min(p.total, prev);
    const eligible = live.filter((p) => p.total >= level).map((p) => p.seat);
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length) last.amount += amount;
    else pots.push({ amount, eligible });
    prev = level;
  }

  // A folded player can have put in more than every live player, for example
  // a small blind folding to a short all-in big blind. That money goes to the last pot.
  const leftover = seats.reduce((sum, p) => sum + Math.max(0, p.total - prev), 0);
  if (leftover && pots.length) pots[pots.length - 1].amount += leftover;
  return pots;
}

export class Table {
  constructor({ players, smallBlind = 10, bigBlind = 20, rng = Math.random, dealer = -1 }) {
    this.players = players.map((p) => ({
      ...p,
      hole: [],
      bet: 0,
      total: 0,
      folded: false,
      allIn: false,
      acted: false,
      inHand: false,
      lastAction: '',
    }));
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.rng = rng;
    this.dealer = dealer;
    this.stage = 'idle';
    this.board = [];
    this.deck = [];
    this.toAct = -1;
    this.currentBet = 0;
    this.lastRaise = bigBlind;
    this.raises = 0;
    this.results = null;
  }

  get pot() {
    return this.players.reduce((sum, p) => sum + p.total, 0);
  }

  get seatedCount() {
    return this.players.filter((p) => p.chips > 0).length;
  }

  _next(seat, predicate) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat + i) % n;
      if (predicate(this.players[s])) return s;
    }
    return -1;
  }

  _live() {
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  _canAct(p) {
    return p.inHand && !p.folded && !p.allIn;
  }

  _commit(p, amount) {
    const paid = Math.min(amount, p.chips);
    p.chips -= paid;
    p.bet += paid;
    p.total += paid;
    if (p.chips === 0) p.allIn = true;
    return paid;
  }

  startHand() {
    if (this.seatedCount < 2) throw new Error('Need at least two players with chips');
    for (const p of this.players) {
      p.hole = [];
      p.bet = 0;
      p.total = 0;
      p.folded = false;
      p.allIn = false;
      p.acted = false;
      p.inHand = p.chips > 0;
      p.lastAction = '';
    }
    this.board = [];
    this.results = null;
    this.deck = shuffledDeck(this.rng);
    this.stage = 'preflop';
    this.dealer = this._next(this.dealer, (p) => p.inHand);

    // Heads-up, the dealer posts the small blind and acts first preflop.
    const headsUp = this.players.filter((p) => p.inHand).length === 2;
    const inHand = (p) => p.inHand;
    this.sbSeat = headsUp ? this.dealer : this._next(this.dealer, inHand);
    this.bbSeat = this._next(this.sbSeat, inHand);
    this._commit(this.players[this.sbSeat], this.smallBlind);
    this._commit(this.players[this.bbSeat], this.bigBlind);
    this.players[this.sbSeat].lastAction = 'SB';
    this.players[this.bbSeat].lastAction = 'BB';

    for (let round = 0; round < 2; round++) {
      let seat = this.sbSeat;
      do {
        this.players[seat].hole.push(this.deck.pop());
        seat = this._next(seat, inHand);
      } while (seat !== this.sbSeat);
    }

    this.currentBet = this.bigBlind;
    this.lastRaise = this.bigBlind;
    this.raises = 0;
    this._setNextToAct(this.bbSeat);
  }

  // With no opponent left to act, a player only has to match live money.
  // That can be less than the big blind when the big blind is all-in for less.
  _callTarget(player) {
    const others = this._live().filter((p) => p !== player);
    if (others.some((p) => this._canAct(p))) return this.currentBet;
    return Math.max(0, ...others.map((p) => p.bet));
  }

  _needsAction(p) {
    if (!this._canAct(p)) return false;
    const target = this._callTarget(p);
    if (p.bet < target) return true;
    if (p.acted) return false;
    return this._live().some((o) => o !== p && this._canAct(o));
  }

  _setNextToAct(fromSeat) {
    this.toAct = this._next(fromSeat, (p) => this._needsAction(p));
  }

  /** What the player to act may do. `raise` amounts are street totals ("raise to"). */
  legal() {
    const p = this.players[this.toAct];
    const target = this._callTarget(p);
    const toCall = Math.max(0, Math.min(target - p.bet, p.chips));
    const maxRaiseTo = p.bet + p.chips;
    const opponentCanCall = this._live().some((o) => o !== p && this._canAct(o));
    const canRaise = !p.acted && opponentCanCall && maxRaiseTo > this.currentBet;
    const fullRaiseTo = this.currentBet + this.lastRaise;
    return {
      toCall,
      canCheck: toCall === 0,
      canRaise,
      minRaiseTo: canRaise ? Math.min(fullRaiseTo, maxRaiseTo) : 0,
      maxRaiseTo: canRaise ? maxRaiseTo : 0,
    };
  }

  act({ type, amount }) {
    if (this.toAct < 0) throw new Error('No player to act');
    const seat = this.toAct;
    const p = this.players[seat];
    const legal = this.legal();

    if (type === 'fold') {
      p.folded = true;
      p.lastAction = '폴드';
    } else if (type === 'check') {
      if (!legal.canCheck) throw new Error('Cannot check facing a bet');
      p.lastAction = '체크';
    } else if (type === 'call') {
      if (legal.toCall === 0) throw new Error('Nothing to call');
      this._commit(p, legal.toCall);
      p.lastAction = p.allIn ? '올인' : `콜 ${legal.toCall}`;
    } else if (type === 'raise') {
      if (!legal.canRaise) throw new Error('Raise not allowed');
      if (amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
        throw new Error(`Raise must be ${legal.minRaiseTo}-${legal.maxRaiseTo}, got ${amount}`);
      }
      const wasBet = this.currentBet === 0;
      const increase = amount - this.currentBet;
      this._commit(p, amount - p.bet);
      // Only a full raise reopens the betting for players who already acted.
      if (increase >= this.lastRaise) {
        this.lastRaise = increase;
        for (const o of this.players) if (o !== p) o.acted = false;
      }
      this.currentBet = amount;
      this.raises++;
      p.lastAction = p.allIn ? '올인' : `${wasBet ? '베팅' : '레이즈'} ${amount}`;
    } else {
      throw new Error(`Unknown action ${type}`);
    }

    p.acted = true;

    if (this._live().length === 1) {
      this.toAct = -1;
      this._finish(false);
      return;
    }
    this._setNextToAct(seat);
  }

  /** True when betting has closed and the next street or showdown is due. */
  get needsAdvance() {
    return this.toAct < 0 && this.stage !== 'done' && this.stage !== 'idle';
  }

  advance() {
    if (!this.needsAdvance) throw new Error('Betting round is not finished');
    if (this.stage === 'river') {
      this._finish(true);
      return;
    }
    this.stage = STREETS[STREETS.indexOf(this.stage) + 1];
    this.deck.pop(); // burn
    const count = this.stage === 'flop' ? 3 : 1;
    for (let i = 0; i < count; i++) this.board.push(this.deck.pop());

    for (const p of this.players) {
      p.bet = 0;
      p.acted = false;
      if (this._canAct(p)) p.lastAction = '';
    }
    this.currentBet = 0;
    this.lastRaise = this.bigBlind;
    this.raises = 0;
    this._setNextToAct(this.dealer);
  }

  _finish(showdown) {
    this.stage = 'done';
    this.toAct = -1;
    const hands = {};
    if (showdown) {
      this.players.forEach((p, seat) => {
        if (p.inHand && !p.folded) hands[seat] = evaluate([...p.hole, ...this.board]);
      });
    }

    const payouts = this.players.map(() => 0);
    const pots = computePots(this.players).map((pot) => {
      let winners = pot.eligible;
      if (showdown && winners.length > 1) {
        const best = Math.max(...winners.map((s) => hands[s].score));
        winners = winners.filter((s) => hands[s].score === best);
      }
      // Odd chips go to the first winner left of the button.
      const ordered = [...winners].sort((a, b) => this._distance(a) - this._distance(b));
      const share = Math.floor(pot.amount / ordered.length);
      let odd = pot.amount - share * ordered.length;
      const split = ordered.map((seat) => {
        const amount = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        payouts[seat] += amount;
        return { seat, amount };
      });
      return { amount: pot.amount, winners: split, contested: pot.eligible.length > 1 };
    });

    this.players.forEach((p, seat) => {
      p.chips += payouts[seat];
    });
    this.results = { showdown, pots, hands, payouts };
  }

  _distance(seat) {
    const n = this.players.length;
    return (seat - this.dealer - 1 + n) % n;
  }

  /** Everything a bot may know. Other players' hole cards are deliberately absent. */
  viewFor(seat) {
    const p = this.players[seat];
    return {
      hole: [...p.hole],
      board: [...this.board],
      stage: this.stage,
      pot: this.pot,
      chips: p.chips,
      bet: p.bet,
      currentBet: this.currentBet,
      raises: this.raises,
      bigBlind: this.bigBlind,
      opponents: this._live().length - 1,
      seated: this.players.filter((p) => p.inHand).length,
      botsLeft: this._live().filter((p) => !p.isHuman).length,
      legal: this.legal(),
    };
  }
}
