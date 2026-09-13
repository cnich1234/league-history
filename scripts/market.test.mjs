/**
 * The Market, without a feed: tickers, the mock price engine, candle
 * bucketing and the live price formula are all pure, so this runs anywhere.
 */
import { tickerFor, assignTickers } from '../lib/market/ticker.js';
import {
  EPOCH,
  DAY,
  dayIndex,
  dayStart,
  gameWindow,
  dailyCloses,
  dayPath,
  mockQuote,
  mockCandles,
} from '../lib/market/mock.js';
import { RANGES, rangeWindow, toCandles } from '../lib/market/candles.js';
import { basePrice, livePrice, gameRemaining, gameLive } from '../lib/market/price.js';
import { explainMove, explainTrack, trackCsv } from '../lib/market/why.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};
const truthy = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${detail}`}`);
  if (!cond) failed++;
};

const MINUTE = 60_000;
const std = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

console.log('\ntickers');
{
  ok('initial plus three of the surname', tickerFor({ firstName: 'Bijan', lastName: 'Robinson' }), 'BROB');
  ok('punctuation is dropped', tickerFor({ firstName: "Ja'Marr", lastName: 'Chase' }), 'JCHA');
  ok('two-part surnames', tickerFor({ firstName: 'Amon-Ra', lastName: 'St. Brown' }), 'ASTB');
  ok('a short surname borrows from the first name', tickerFor({ firstName: 'Josh', lastName: 'Oo' }), 'JOOO');
  ok('a defence is its team plus D', tickerFor({ position: 'DEF', team: 'SF', id: 'SF' }), 'SFD');

  const rows = assignTickers([
    { id: 1, firstName: 'Jaylen', lastName: 'Smith', projection: 8 },
    { id: 2, firstName: 'Justin', lastName: 'Smith', projection: 14 },
    { id: 3, firstName: 'Bijan', lastName: 'Robinson', projection: 20 },
  ]);
  ok('sorted by projection', rows.map((r) => r.id), [3, 2, 1]);
  ok('the bigger name keeps the clean symbol', rows.map((r) => r.ticker), ['BROB', 'JSMI', 'JSMI2']);
  ok('every ticker unique', new Set(rows.map((r) => r.ticker)).size, 3);
}

console.log('\nthe calendar');
{
  ok('day 0 is a Monday, so its window is a night game', gameWindow(0)[0], 20 * 60 + 15);
  ok('day 6 is Sunday, the long slate', gameWindow(6), [13 * 60, 23 * 60 + 30]);
  ok('day 1 is Tuesday: no games', gameWindow(1), null);
  ok('day 3 is Thursday', gameWindow(3)[0], 20 * 60 + 15);
  ok('dayIndex and dayStart agree', dayIndex(dayStart(40) + 5 * MINUTE), 40);
}

console.log('\nthe daily layer');
{
  const closes = dailyCloses('p1', 80, 90);
  ok('one close per day plus the start', closes.length, 92);
  ok('starts at the base', closes[0], 80);
  truthy('every close is positive', closes.every((c) => c > 0));
  ok('deterministic', dailyCloses('p1', 80, 90)[50], closes[50]);
  truthy('a different player walks differently', dailyCloses('p2', 80, 90)[50] !== closes[50]);
}

console.log('\nthe minute layer');
{
  const d = 6; // a Sunday
  const day = dayPath('p1', 80, d);
  const closes = dailyCloses('p1', 80, d);
  ok('opens at the previous close', day.open, closes[d]);
  truthy('lands on the day close', Math.abs(day.prices[1439] - closes[d + 1]) < 1e-3, `${day.prices[1439]} vs ${closes[d + 1]}`);
  truthy('first minute is near the open', Math.abs(day.prices[0] / day.open - 1) < 0.05);

  const rets = (path, from, to) => {
    const out = [];
    for (let m = from + 1; m <= to; m++) out.push(Math.log(path.prices[m] / path.prices[m - 1]));
    return out;
  };
  const sunday = rets(day, 13 * 60, 23 * 60);
  const tuesday = rets(dayPath('p1', 80, 1), 13 * 60, 23 * 60);
  truthy('a game window is much louder than a weekday afternoon', std(sunday) > 3 * std(tuesday), `${std(sunday)} vs ${std(tuesday)}`);
  truthy('game volume is heavier', day.vol[15 * 60] > dayPath('p1', 80, 1).vol[15 * 60] * 2);
}

console.log('\nquotes and candles agree');
{
  const now = dayStart(70) + (14 * 60 + 37) * MINUTE + 20_000; // Thursday 2:37pm ET, mid-minute
  const q = mockQuote('p1', 80, now);
  const dayAgo = dayPath('p1', 80, 69).prices[14 * 60 + 37];
  ok('the reference is the price 24 hours ago', q.prevClose, Math.round(dayAgo * 100) / 100);
  ok('change is price minus the reference', q.change, Math.round((q.price - q.prevClose) * 100) / 100);
  const { from, to, step } = rangeWindow('1D', now);
  ok('1D is a rolling day', from, now - DAY);
  const candles = mockCandles('p1', 80, from, to, step);
  ok('five-minute candles across the day, both ends inclusive', candles.length, 289);
  ok('the last candle closes at the quote', candles[candles.length - 1].c, q.price);
  truthy('lows under, highs over', candles.every((c) => c.l <= Math.min(c.o, c.c) && c.h >= Math.max(c.o, c.c)));
  truthy('strictly increasing time', candles.every((c, i) => i === 0 || c.t > candles[i - 1].t));
  truthy('the day high is the highest candle', Math.abs(Math.max(...candles.map((c) => c.h)) - q.dayHigh) < 0.011);

  // On an exact minute boundary the quote's minute is still in the last candle.
  const sharp = dayStart(70) + 14 * 60 * MINUTE;
  const c2 = mockCandles('p1', 80, from, sharp, step);
  ok('minute boundary is inclusive', c2[c2.length - 1].c, mockQuote('p1', 80, sharp).price);

  const w3 = rangeWindow('3M', now);
  const daily = mockCandles('p1', 80, w3.from, w3.to, w3.step);
  ok('a daily candle per Eastern day', daily.length, 71);
  ok('daily candles start on day boundaries', daily.every((c) => (c.t - EPOCH) % DAY === 0), true);
  const closes = dailyCloses('p1', 80, 70);
  truthy(
    'each finished day closes where the daily layer says',
    daily.slice(0, -1).every((c, i) => Math.abs(c.c - closes[i + 1]) < 0.011),
  );
  ok('1W is a rolling week', rangeWindow('1W', now).from, now - 7 * DAY);
  ok('every range has a step', Object.values(RANGES).every((r) => r.step > 0), true);
}

console.log('\nbucketing recorded ticks');
{
  const t0 = EPOCH + 100 * DAY;
  const ticks = [
    { t: t0 + 1 * MINUTE, price: 10, volume: 1 },
    { t: t0 + 3 * MINUTE, price: 12, volume: 1 },
    { t: t0 + 4 * MINUTE, price: 9, volume: 1 },
    { t: t0 + 6 * MINUTE, price: 11, volume: 2 },
  ];
  const c = toCandles(ticks, 5 * MINUTE);
  ok('two buckets', c.length, 2);
  ok('first bucket ohlc', [c[0].o, c[0].h, c[0].l, c[0].c, c[0].v], [10, 12, 9, 9, 3]);
  ok('second bucket starts on the boundary', c[1].t, t0 + 5 * MINUTE);
}

console.log('\nthe live price');
{
  ok('a 20-point projection is an 80 stock', basePrice(20), 80);
  ok('before kickoff the price is the base', livePrice({ projection: 20 }), 80);
  ok('at the final whistle it is the points', livePrice({ projection: 20, points: 27.5, remaining: 0 }), 110);
  const hot = livePrice({ projection: 15, points: 12, remaining: 0.5 });
  truthy('running hot at halftime is worth more than the projection says', hot > (12 + 7.5) * 4, `${hot}`);
  truthy('but not the full pace', hot < 24 * 4, `${hot}`);
  const cold = livePrice({ projection: 15, points: 2, remaining: 0.5 });
  truthy('running cold is worth less', cold < (2 + 7.5) * 4, `${cold}`);
  ok('a goose egg still has a floor', livePrice({ projection: 0, points: 0, remaining: 0 }), 1);
  // Ten percent in, pace is not yet trusted, so both estimates are the projection's.
  ok('early in the game pace is ignored', livePrice({ projection: 20, points: 9, remaining: 0.9 }), 108);
}

console.log('\nthe game clock');
{
  const game = (status, metadata) => ({ status, metadata });
  ok('pre-game is all to play', gameRemaining(game('pre_game', { has_started: false })), 1);
  ok('and not live', gameLive(game('pre_game', { has_started: false })), false);
  // Verbatim shape from api.sleeper.com/scores on 2026-09-13, CHI at CAR.
  const q1 = game('in_game', { has_started: true, is_in_progress: true, quarter_num: 1, time_remaining: '4:12' });
  ok('4:12 left in the first is 0.82 to go', gameRemaining(q1), 0.82);
  ok('first quarter is live', gameLive(q1), true);
  ok('start of the third is half', gameRemaining(game('in_game', { has_started: true, quarter_num: 3, time_remaining: '15:00' })), 0.5);
  ok('two minutes in the fourth', gameRemaining(game('in_game', { has_started: true, quarter_num: 4, time_remaining: '2:00' })), 0.033);
  ok('no clock falls back to the quarter start', gameRemaining(game('in_game', { has_started: true, quarter_num: 2 })), 0.75);
  ok('overtime is nearly over', gameRemaining(game('in_game', { has_started: true, is_overtime: true, quarter_num: 5 })), 0.05);
  ok('final is nothing left', gameRemaining(game('complete', { has_started: true, is_over: true })), 0);
  ok('and not live', gameLive(game('complete', { has_started: true, is_over: true })), false);
  ok('no game at all is not live', gameLive(null), false);
}

console.log('\nwhy did it move');
{
  const tick = (t, price, points, remaining, projection, status) => ({ t, price, points, remaining, projection, status });
  const pre = tick(1, 80, 0, 1, 20, 'pre');
  const kick = tick(2, 80, 0, 1, 20, 'live');
  const td = tick(3, 98.4, 6, 0.93, 20, 'live');
  const clock = tick(4, 97.1, 6, 0.9, 20, 'live');
  const fix = tick(5, 96.2, 5.8, 0.9, 20, 'live');
  const done = tick(6, 110, 27.5, 0, 20, 'final');
  const ghost = tick(7, 112, 27.5, 0, 20, 'final');
  const revised = tick(8, 88, 0, 1, 22, 'pre');

  ok('kickoff is a status change', explainMove(pre, kick).reason, 'kickoff');
  const scored = explainMove(kick, td);
  ok('scoring beats the clock', scored.reason, 'scored');
  ok('with the points and the clock in the detail', scored.detail, '+6 pts (0 to 6) · 93% of game left');
  ok('a quiet minute is the clock', explainMove(td, clock).reason, 'clock');
  ok('points going down is a stat correction', explainMove(clock, fix).reason, 'stat correction');
  const final = explainMove(fix, done);
  ok('the final whistle', final.reason, 'final whistle');
  ok('says where it settled', final.detail.startsWith('settled at 27.5 pts'), true);
  ok('a move with no input change is flagged', explainMove(done, ghost).reason, 'UNEXPLAINED');
  ok('a new week with a new projection', explainMove(ghost, revised).reason, 'new week');
  ok('no inputs on old rows is said, not guessed', explainMove({ t: 0, price: 1 }, { t: 1, price: 2 }).reason, 'no inputs');

  const track = [pre, kick, td, clock, clock, fix, done, ghost];
  const moves = explainTrack(track);
  ok('quiet ticks are dropped', moves.length, 6);
  ok('newest first', moves[0].t, 8 - 1);
  ok('quiet ticks kept on request', explainTrack(track, { includeQuiet: true }).length, 7);

  const csv = trackCsv([pre, td]).split('\n');
  ok('csv has a header and a row per tick', csv.length, 3);
  ok('csv first row is the first tick', csv[1].includes(',80,0,"first"'), true);
  ok('csv names the reason', csv[2].includes('"scored"'), true);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
