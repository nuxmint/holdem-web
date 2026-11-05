import { Table } from './engine.js';
import { BOT_ROSTER } from './bot.js';

export const STORE_KEY = 'holdem.v1';
export const STARTING_CHIPS = 2000;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const HUMAN_SEAT = 0;

const DEFAULT_SETTINGS = { botCount: 4, speed: 'normal' };
const DEFAULT_STATS = { hands: 0, wins: 0, biggestPot: 0, rebuys: 0 };

/** Holds the table between hands and persists chips, settings and stats. */
export class Session {
  constructor({ storage, rng = Math.random }) {
    this.storage = storage;
    this.rng = rng;
    this.settings = { ...DEFAULT_SETTINGS };
    this.stats = { ...DEFAULT_STATS };
    this.handNumber = 0;
    if (!this._load()) this.newGame(this.settings.botCount);
  }

  _buildTable(chips, dealer) {
    const bots = BOT_ROSTER.slice(0, this.settings.botCount);
    const players = [
      { name: '나', isHuman: true, style: null },
      ...bots.map((b) => ({ name: b.name, isHuman: false, style: b.style })),
    ].map((p, i) => ({ ...p, chips: chips[i] }));
    this.table = new Table({
      players,
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      rng: this.rng,
      dealer,
    });
  }

  _load() {
    try {
      const raw = this.storage.getItem(STORE_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      const expected = saved.settings.botCount + 1;
      if (!Array.isArray(saved.chips) || saved.chips.length !== expected) return false;
      this.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
      this.stats = { ...DEFAULT_STATS, ...saved.stats };
      this.handNumber = saved.handNumber || 0;
      this._buildTable(saved.chips, saved.dealer);
      return true;
    } catch {
      return false;
    }
  }

  save() {
    this.storage.setItem(STORE_KEY, JSON.stringify({
      settings: this.settings,
      stats: this.stats,
      handNumber: this.handNumber,
      dealer: this.table.dealer,
      chips: this.table.players.map((p) => p.chips),
    }));
  }

  newGame(botCount) {
    this.settings.botCount = botCount;
    this.stats = { ...DEFAULT_STATS };
    this.handNumber = 0;
    this._buildTable(new Array(botCount + 1).fill(STARTING_CHIPS), -1);
    this.save();
  }

  setSpeed(speed) {
    this.settings.speed = speed;
    this.save();
  }

  get human() {
    return this.table.players[HUMAN_SEAT];
  }

  get needsRebuy() {
    return this.human.chips === 0;
  }

  rebuy() {
    this.human.chips = STARTING_CHIPS;
    this.stats.rebuys++;
    this.save();
  }

  startHand() {
    // Busted bots are replaced so the table stays full.
    for (const p of this.table.players) {
      if (!p.isHuman && p.chips === 0) p.chips = STARTING_CHIPS;
    }
    this.handNumber++;
    this.table.startHand();
  }

  finishHand() {
    const { results } = this.table;
    this.stats.hands++;
    if (results.payouts[HUMAN_SEAT] > this.human.total) this.stats.wins++;
    this.stats.biggestPot = Math.max(this.stats.biggestPot, results.payouts[HUMAN_SEAT]);
    this.save();
  }
}
