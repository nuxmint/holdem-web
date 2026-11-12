import { rankOf, suitOf, evaluate } from './evaluator.js';
import { decide } from './bot.js';
import { Session, HUMAN_SEAT, SMALL_BLIND, BIG_BLIND, STARTING_CHIPS } from './session.js';

// U+FE0E keeps iOS from drawing the suits as color emoji.
const SUIT_GLYPHS = ['♠︎', '♥︎', '♦︎', '♣︎'];
const RANK_LABELS = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const STAGE_LABELS = { preflop: '프리플롭', flop: '플롭', turn: '턴', river: '리버' };
const DELAYS = {
  normal: { bot: 800, street: 750 },
  fast: { bot: 300, street: 350 },
};

// Seat anchors as [left %, top %] of the table, by number of bots.
const SEAT_LAYOUTS = {
  1: [[50, 0]],
  2: [[22, 0], [78, 0]],
  3: [[13, 30], [50, 0], [87, 30]],
  4: [[13, 62], [28, 0], [72, 0], [87, 62]],
  5: [[13, 64], [13, 14], [50, 0], [87, 14], [87, 64]],
  6: [[12.5, 64], [12.5, 14], [37, 0], [63, 0], [87.5, 14], [87.5, 64]],
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');

const session = new Session({ storage: window.localStorage });
let humanResolve = null;
let raiseOpen = false;
let raiseValue = 0;
let shownBoard = 0;
let shownHole = false;
let handActive = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const delays = () => DELAYS[session.settings.speed] || DELAYS.normal;

function cardHtml(card, classes = '') {
  const rank = rankOf(card);
  const suit = suitOf(card);
  const red = suit === 1 || suit === 2 ? ' red' : '';
  const label = RANK_LABELS[rank] || String(rank);
  return `<div class="card${red} ${classes}"><span class="r">${label}</span><span class="s">${SUIT_GLYPHS[suit]}</span></div>`;
}

const backHtml = (classes = '') => `<div class="card back ${classes}"></div>`;

function winningCards(table) {
  const { results } = table;
  if (!results || !results.showdown) return null;
  const set = new Set();
  for (const pot of results.pots) {
    if (!pot.contested) continue;
    for (const { seat } of pot.winners) {
      for (const c of results.hands[seat].best) set.add(c);
    }
  }
  return set;
}

function winnerSeats(table) {
  const seats = new Set();
  if (!table.results) return seats;
  for (const pot of wonPots(table.results)) {
    for (const { seat } of pot.winners) seats.add(seat);
  }
  return seats;
}

function renderSeats(table) {
  const bots = table.players.slice(1);
  const layout = SEAT_LAYOUTS[bots.length];
  const winners = winnerSeats(table);
  const winCards = winningCards(table);
  const showdown = table.results && table.results.showdown;

  $('seats').innerHTML = bots.map((p, i) => {
    const seat = i + 1;
    const [left, top] = layout[i];
    const classes = ['seat'];
    if (table.toAct === seat) classes.push('turn');
    if (p.folded || (!p.inHand && table.stage !== 'idle')) classes.push('folded');
    if (winners.has(seat)) classes.push('winner');

    let cards = '';
    if (p.inHand && !p.folded) {
      if (showdown) {
        cards = p.hole.map((c) => cardHtml(c, winCards.has(c) ? 'win' : '')).join('');
      } else if (p.hole.length) {
        cards = backHtml() + backHtml();
      }
    }
    const badge = table.dealer === seat && table.stage !== 'idle' ? '<span class="badge">D</span>' : '';
    const handName = showdown && table.results.hands[seat] ? table.results.hands[seat].name : '';
    return `<div class="${classes.join(' ')}" style="left:${left}%;top:${top}%">
      <div class="row"><span class="name">${p.name}</span>${badge}</div>
      <div class="chips">${fmt(p.chips)}</div>
      <div class="act">${handName || p.lastAction}</div>
      <div class="mini">${cards}</div>
    </div>`;
  }).join('');
}

function renderBoard(table) {
  const winCards = winningCards(table);
  $('board').innerHTML = table.board.map((c, i) => {
    const classes = [];
    if (i >= shownBoard) classes.push('new');
    if (winCards) classes.push(winCards.has(c) ? 'win' : 'dim');
    return cardHtml(c, classes.join(' '));
  }).join('');
  shownBoard = table.board.length;
}

function renderHero(table) {
  const me = table.players[HUMAN_SEAT];
  const results = table.results;
  const badge = table.dealer === HUMAN_SEAT && table.stage !== 'idle' ? ' <span class="badge">D</span>' : '';
  $('hero-info').innerHTML = `${me.name}${badge}<span class="chips">${fmt(me.chips)}</span><span class="act">${me.lastAction}</span>`;
  $('hero').className = table.toAct === HUMAN_SEAT ? 'turn' : '';

  const winCards = winningCards(table);
  const dim = me.folded ? 'dim' : '';
  $('hero-cards').innerHTML = me.hole.map((c) => {
    const classes = [dim];
    if (!shownHole) classes.push('new');
    if (winCards && winCards.has(c)) classes.push('win');
    return cardHtml(c, classes.join(' '));
  }).join('');
  shownHole = me.hole.length > 0;

  let name = '';
  if (me.hole.length && !me.folded && table.board.length >= 3) {
    name = evaluate([...me.hole, ...table.board]).name;
  } else if (me.hole.length === 2 && !me.folded && rankOf(me.hole[0]) === rankOf(me.hole[1])) {
    name = '포켓 페어';
  }
  $('hero-hand').textContent = results && !results.showdown ? '' : name;
}

// A side pot with one eligible player is just an uncalled bet coming back.
function wonPots(results) {
  return results.pots.filter((pot) => results.pots.length === 1 || pot.contested);
}

function resultText(table) {
  const { results, players } = table;
  const lines = [];
  for (const pot of wonPots(results)) {
    const names = pot.winners.map((w) => players[w.seat].name).join(', ');
    const hand = results.showdown ? ` · ${results.hands[pot.winners[0].seat].name}` : '';
    const split = pot.winners.length > 1 ? ' 분할' : '';
    lines.push(`${names} +${fmt(pot.amount)}${split}${hand}`);
  }
  return lines.join('<br>');
}

function render() {
  const { table } = session;
  $('hand-no').textContent = session.handNumber ? `핸드 #${session.handNumber}` : "Texas Hold'em";
  $('blinds').textContent = `블라인드 ${SMALL_BLIND}/${BIG_BLIND}`;
  const pot = table.results
    ? wonPots(table.results).reduce((sum, p) => sum + p.amount, 0)
    : table.pot;
  $('pot').textContent = table.stage === 'idle' || pot === 0 ? '' : `팟 ${fmt(pot)}`;
  if (table.results) {
    $('status').innerHTML = resultText(table);
  } else if (table.toAct > 0) {
    $('status').textContent = '';
  } else {
    $('status').textContent = STAGE_LABELS[table.stage] || '';
  }
  renderSeats(table);
  renderBoard(table);
  renderHero(table);
}

function resolveHuman(action) {
  if (!humanResolve) return;
  const resolve = humanResolve;
  humanResolve = null;
  raiseOpen = false;
  resolve(action);
}

function button(label, classes, onClick, disabled = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${classes}`;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function row(...children) {
  const div = document.createElement('div');
  div.className = 'btn-row';
  div.append(...children);
  return div;
}

function clampRaise(legal, value) {
  const stepped = Math.round(value / 10) * 10;
  return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, stepped));
}

// − and + fine-tune the amount 10 chips per tap, apart from the pot-share presets.
const RAISE_STEP = 10;

function stepButton(label, ariaLabel, onTap) {
  const b = button(label, 'small step', onTap);
  b.setAttribute('aria-label', ariaLabel);
  return b;
}

function presetButton(text, value, onPick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small preset';
  b.dataset.value = value;
  b.innerHTML = `<span class="lbl">${text}</span><span class="amt">${fmt(value)}</span>`;
  b.addEventListener('click', () => onPick(value));
  return b;
}

function renderRaisePanel(table, legal) {
  const box = $('actions');
  box.innerHTML = '';
  const label = table.currentBet === 0 ? '베팅' : '레이즈';
  const potAfterCall = table.pot + legal.toCall;

  const confirm = button('', 'raise', () => resolveHuman({ type: 'raise', amount: raiseValue }));
  const minus = stepButton('−', '금액 줄이기', () => update(raiseValue - RAISE_STEP));
  const plus = stepButton('+', '금액 늘리기', () => update(raiseValue + RAISE_STEP));
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = legal.minRaiseTo;
  slider.max = legal.maxRaiseTo;
  slider.step = 10;
  const sliderLine = document.createElement('div');
  sliderLine.className = 'raise-line';
  sliderLine.append(minus, slider, plus);

  // Pot shares are "raise to" totals: call first, then add that share of the pot.
  const shares = [['¼ 팟', 1 / 4], ['½ 팟', 1 / 2], ['팟', 1]];
  // A share below the minimum raise shows its amount but stays off, and one
  // that needs the whole stack is left to the all-in button.
  const presets = shares.map(([text, share]) => {
    const target = Math.round((table.currentBet + potAfterCall * share) / 10) * 10;
    const b = presetButton(text, Math.min(target, legal.maxRaiseTo), update);
    b.disabled = target < legal.minRaiseTo || target >= legal.maxRaiseTo;
    return b;
  });
  const allIn = presetButton('올인', legal.maxRaiseTo, update);
  allIn.classList.add('all-in');
  presets.push(allIn);

  function update(value) {
    // The slider's steps can miss an odd all-in amount, so the top snaps to it.
    const atTop = value >= legal.maxRaiseTo - 5;
    raiseValue = atTop ? legal.maxRaiseTo : clampRaise(legal, value);
    slider.value = raiseValue;
    const total = raiseValue === legal.maxRaiseTo;
    confirm.textContent = total ? `올인 ${fmt(raiseValue)}` : `${label} ${fmt(raiseValue)}`;
    confirm.classList.toggle('all-in', total);
    minus.disabled = raiseValue <= legal.minRaiseTo;
    plus.disabled = raiseValue >= legal.maxRaiseTo;
    for (const b of presets) {
      b.classList.toggle('selected', !b.disabled && Number(b.dataset.value) === raiseValue);
    }
  }
  slider.addEventListener('input', () => update(Number(slider.value)));

  box.append(
    sliderLine,
    row(...presets),
    row(
      button('취소', '', () => {
        raiseOpen = false;
        renderActions();
      }),
      confirm,
    ),
  );
  update(raiseValue || legal.minRaiseTo);
}

function renderActions() {
  const { table } = session;
  const box = $('actions');

  if (humanResolve) {
    const legal = table.legal();
    if (raiseOpen) {
      renderRaisePanel(table, legal);
      return;
    }
    const me = table.players[HUMAN_SEAT];
    const callLabel = legal.toCall >= me.chips ? `올인 ${fmt(legal.toCall)}` : `콜 ${fmt(legal.toCall)}`;
    const raiseLabel = table.currentBet === 0 ? '베팅' : '레이즈';
    box.innerHTML = '';
    box.append(row(
      button('폴드', 'fold', () => resolveHuman({ type: 'fold' }), legal.canCheck),
      legal.canCheck
        ? button('체크', 'call', () => resolveHuman({ type: 'check' }))
        : button(callLabel, 'call', () => resolveHuman({ type: 'call' })),
      button(raiseLabel, 'raise', () => {
        raiseOpen = true;
        raiseValue = legal.minRaiseTo;
        renderActions();
      }, !legal.canRaise),
    ));
    return;
  }

  if (handActive) {
    box.innerHTML = `<div class="waiting">${table.toAct > 0 ? `${table.players[table.toAct].name} 생각 중…` : ''}</div>`;
    return;
  }

  box.innerHTML = '';
  const label = session.handNumber ? '다음 핸드' : '게임 시작';
  box.append(row(button(label, 'primary', startNextHand)));
}

function waitForHuman() {
  return new Promise((resolve) => {
    humanResolve = resolve;
    renderActions();
  });
}

async function playHand() {
  handActive = true;
  shownBoard = 0;
  shownHole = false;
  session.startHand();
  const { table } = session;
  render();
  renderActions();

  while (table.stage !== 'done') {
    if (table.toAct === HUMAN_SEAT) {
      const action = await waitForHuman();
      table.act(action);
      render();
      renderActions();
    } else if (table.toAct > 0) {
      render();
      renderActions();
      await sleep(delays().bot);
      const seat = table.toAct;
      table.act(decide(table.viewFor(seat), table.players[seat].style));
      render();
    } else {
      await sleep(delays().street);
      table.advance();
      render();
      renderActions();
    }
  }

  session.finishHand();
  handActive = false;
  render();
  renderActions();
}

function startNextHand() {
  if (session.needsRebuy) {
    showRebuy();
    return;
  }
  playHand();
}

function openModal(build) {
  const box = $('modal-box');
  box.innerHTML = '';
  build(box);
  $('modal').hidden = false;
}

function closeModal() {
  $('modal').hidden = true;
}

function showRebuy() {
  openModal((box) => {
    box.innerHTML = `<h2>칩을 모두 잃었어요</h2><p>${fmt(STARTING_CHIPS)}칩을 다시 받고 계속할까요?</p>`;
    box.append(row(button('다시 받기', 'primary', () => {
      session.rebuy();
      closeModal();
      render();
      renderActions();
    })));
  });
}

function showSettings() {
  openModal((box) => {
    const { stats, settings } = session;
    const rate = stats.hands ? Math.round((stats.wins / stats.hands) * 100) : 0;
    box.innerHTML = `<h2>설정</h2>
      <div class="stats">
        <span>플레이한 핸드</span><b>${fmt(stats.hands)}</b>
        <span>이긴 핸드</span><b>${fmt(stats.wins)} (${rate}%)</b>
        <span>최대 획득 칩</span><b>${fmt(stats.biggestPot)}</b>
        <span>칩 다시 받은 횟수</span><b>${fmt(stats.rebuys)}</b>
      </div>
      <h3>진행 속도</h3>`;

    const speeds = [['normal', '보통'], ['fast', '빠름']].map(([key, label]) => (
      button(label, `small ${settings.speed === key ? 'selected' : ''}`, () => {
        session.setSpeed(key);
        showSettings();
      })
    ));
    box.append(row(...speeds));

    const heading = document.createElement('h3');
    heading.textContent = handActive
      ? '봇 수 (핸드가 끝난 뒤 바꿀 수 있어요)'
      : '봇 수 (바꾸면 칩과 기록이 초기화돼요)';
    box.append(heading);
    const counts = [1, 2, 3, 4, 5, 6].map((n) => (
      button(String(n), `small ${settings.botCount === n ? 'selected' : ''}`, () => confirmNewGame(n), handActive)
    ));
    box.append(row(...counts));

    const footer = row(
      button('새 게임', 'small', () => confirmNewGame(settings.botCount), handActive),
      button('닫기', 'small primary', closeModal),
    );
    footer.style.marginTop = '16px';
    box.append(footer);
  });
}

function confirmNewGame(botCount) {
  openModal((box) => {
    box.innerHTML = `<h2>새 게임</h2><p>봇 ${botCount}명과 새로 시작합니다. 지금 칩과 기록은 초기화돼요.</p>`;
    box.append(row(
      button('취소', '', showSettings),
      button('시작', 'primary', () => {
        session.newGame(botCount);
        shownBoard = 0;
        shownHole = false;
        closeModal();
        render();
        renderActions();
      }),
    ));
  });
}

$('open-settings').addEventListener('click', showSettings);
render();
renderActions();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
