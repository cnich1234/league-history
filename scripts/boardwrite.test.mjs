/**
 * A week's board is written all at once or not at all.
 *
 * Week 3 of 2026 was written market by market, and the cron hit its time limit
 * 120 markets in: every spread and showdown, half the props, none of the four
 * specials. The cron's "does this week have markets" gate then said yes on
 * every later run, so the specials never appeared.
 *
 * Pinned here: one statement writes every market with its options; a failure
 * anywhere writes nothing; a rerun after the lines move adds nothing twice;
 * and a half-built board is filled in rather than duplicated.
 *
 * Sentinel season, cleaned up in a finally.
 */
import { neon } from '@neondatabase/serverless';
import { writeBoard, marketIdentity } from '../lib/cron.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9971;
const W = 1;

let failed = 0;
const ok = (label, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ` -- got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

const locksAt = new Date('2099-01-01T00:15:00Z');
const prop = (playerId, line) => ({
  kind: 'prop',
  title: `Player ${playerId} over/under ${line}`,
  subtitle: 'WR',
  meta: { playerId, line },
  locksAt,
  live: false,
  options: [
    { key: 'over', label: `Over ${line}`, odds: -110 },
    { key: 'under', label: `Under ${line}`, odds: -110 },
  ],
});
const spread = (home, away, line) => ({
  kind: 'spread',
  title: `T${home} -${line} vs T${away}`,
  subtitle: null,
  meta: { homeRoster: home, awayRoster: away, spread: line },
  locksAt,
  live: true,
  options: [
    { key: 'cover', label: `-${line}`, odds: -110 },
    { key: 'nocover', label: `+${line}`, odds: -110 },
  ],
});
const special = (title, rosters) => ({
  kind: 'special',
  title,
  subtitle: 'Most points in the league this week',
  meta: { special: 'team' },
  locksAt,
  live: false,
  options: rosters.map((r, i) => ({ key: String(r), label: `Team ${r}`, odds: 300 + i * 50 })),
});

const board = [
  spread(1, 6, 7.5),
  prop('4046', 22.5),
  prop('6794', 15.5),
  special('Highest scoring team', [1, 2, 3, 4]),
  special('Highest scoring TE', [1, 2, 3]),
];

const count = async () => {
  const [r] = await sql`
    select count(distinct m.id)::int as markets, count(o.*)::int as options
    from markets m left join market_options o on o.market_id = m.id
    where m.season = ${S} and m.week = ${W}`;
  return r;
};

try {
  await sql`delete from markets where season = ${S}`;

  console.log('what makes two markets the same');
  ok('a prop is its player, whatever the line',
    marketIdentity(prop('4046', 22.5)) === marketIdentity(prop('4046', 24.5)), true);
  ok('different players are different props',
    marketIdentity(prop('4046', 22.5)) === marketIdentity(prop('6794', 22.5)), false);
  ok('a spread is its matchup, whatever the line, either way round',
    marketIdentity(spread(1, 6, 7.5)) === marketIdentity(spread(6, 1, 3.5)), true);
  ok('each blowout line is its own market',
    marketIdentity({ kind: 'spread', meta: { homeRoster: 1, awayRoster: 6, blowout: true, spread: 20.5 } }) ===
      marketIdentity({ kind: 'spread', meta: { homeRoster: 1, awayRoster: 6, blowout: true, spread: 30.5 } }),
    false);
  ok('and a blowout is not the plain spread',
    marketIdentity({ kind: 'spread', meta: { homeRoster: 1, awayRoster: 6, blowout: true, spread: 20.5 } }) ===
      marketIdentity(spread(1, 6, 20.5)),
    false);
  ok('a special is its title', marketIdentity(special('Highest scoring TE', [1])), 'special:Highest scoring TE');
  ok('something without the fields falls back to kind and title',
    marketIdentity({ kind: 'total', title: 'Old total', meta: {} }), 'total:Old total');

  console.log('\na dry run writes nothing');
  {
    const r = await writeBoard(sql, S, W, board, { dryRun: true });
    ok('reports all five as new', r.planned.length, 5);
    ok('and nothing is on the board', await count(), { markets: 0, options: 0 });
  }

  console.log('\na failure anywhere writes nothing');
  {
    // The last market's odds are not a number, so its option insert fails --
    // after four markets and their options were already written in the same
    // statement. Market by market, those four would have stayed.
    const bad = special('Highest scoring RB', [1, 2]);
    bad.options[1].odds = 'not a price';
    let threw = false;
    try {
      await writeBoard(sql, S, W, [...board, bad]);
    } catch {
      threw = true;
    }
    ok('the write fails', threw, true);
    ok('and leaves the board empty, not half-built', await count(), { markets: 0, options: 0 });
  }

  console.log('\nthe whole board in one go');
  {
    const r = await writeBoard(sql, S, W, board);
    ok('five markets created', r.created, 5);
    ok('with all thirteen options (2+2+2+4+3)', r.options, 13);
    ok('on the board', await count(), { markets: 5, options: 13 });
    const [{ odds, label }] = await sql`
      select o.odds, o.label from market_options o join markets m on m.id = o.market_id
      where m.season = ${S} and m.title = 'Highest scoring team' and o.option_key = '4'`;
    ok('each option lands on its own market', { odds, label }, { odds: 450, label: 'Team 4' });
    const [m] = await sql`
      select live, locks_at, meta from markets where season = ${S} and kind = 'spread'`;
    ok('live flag kept', m.live, true);
    ok('lock time kept', new Date(m.locks_at).toISOString(), locksAt.toISOString());
    ok('meta kept', [m.meta.homeRoster, m.meta.awayRoster, m.meta.spread], [1, 6, 7.5]);
  }

  console.log('\na rerun after the lines move');
  {
    const moved = [spread(6, 1, 3.5), prop('4046', 24.5), prop('6794', 13.5), ...board.slice(3)];
    const r = await writeBoard(sql, S, W, moved);
    ok('adds nothing', r.created, 0);
    ok('skips all five', r.skipped, 5);
    const [{ line }] = await sql`
      select (meta->>'line')::float as line from markets where season = ${S} and meta->>'playerId' = '4046'`;
    ok('and leaves the old line alone, since someone may have bet it', line, 22.5);
  }

  console.log('\na half-built board is filled in, not duplicated');
  {
    const more = [...board, prop('9509', 8.5), special('Highest scoring WR', [2, 3, 4])];
    const r = await writeBoard(sql, S, W, more);
    ok('adds just the two missing', r.created, 2);
    ok('skips the five already there', r.skipped, 5);
    ok('seven markets, eighteen options', await count(), { markets: 7, options: 18 });
  }

  console.log('\nthe same market twice in one batch goes in once');
  {
    const r = await writeBoard(sql, S, 2, [prop('4046', 22.5), prop('4046', 23.5)]);
    ok('one created', r.created, 1);
    ok('one skipped', r.skipped, 1);
  }
} finally {
  await sql`delete from markets where season = ${S}`;
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
