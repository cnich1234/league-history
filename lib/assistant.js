import { readFileSync, existsSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { BOOSTS, WEEKLY_ALLOWANCE, groupedBoosts } from './boosts.js';
import { LINEUP, SALARY_CAP, PLACE_POINTS, PLAYABLE_FLOOR, SALARY_FLOOR, SALARY_PER_POINT } from './dfs.js';

/**
 * The context the assistant answers from.
 *
 * Built from the CODE and the DATABASE at request time rather than from a
 * written document. A hand-maintained brief goes stale the moment anything
 * changes -- docs/THE_BOOK.md was two days old and already had no bounties, no
 * daily fantasy and the wrong boost prices -- and a confidently wrong answer is
 * worse than no assistant at all.
 *
 * The prose docs are still included for the parts that are genuinely prose:
 * why a rule exists, what a boost is for. Anything with a NUMBER in it comes
 * from the source of truth instead.
 */

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);
const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;

/** The live catalogue, so prices can never be quoted from a stale note. */
function catalogue() {
  const lines = [];
  for (const group of groupedBoosts()) {
    lines.push(`\n${group.title} -- ${group.blurb}`);
    for (const b of group.items) {
      lines.push(`  ${b.name} (${b.cost} points): ${b.blurb}`);
    }
  }
  return lines.join('\n');
}

/** Rules that live in code as constants rather than in any document. */
function mechanics() {
  return [
    `Weekly allowance: ${WEEKLY_ALLOWANCE} points a week, every manager.`,
    `Boost prices range ${Math.min(...BOOSTS.map((b) => b.cost))} to ${Math.max(
      ...BOOSTS.map((b) => b.cost),
    )} points.`,
    `Daily fantasy lineup: ${LINEUP.join(', ')} under a $${SALARY_CAP.toLocaleString('en-US')} cap.`,
    `Daily fantasy placement pays ${PLACE_POINTS.join('/')} for 1st through 10th.`,
    `Daily salaries = $${SALARY_FLOOR} + $${SALARY_PER_POINT} per projected point, and anybody`,
    `projected under ${PLAYABLE_FLOOR} points is left off the board entirely.`,
    `Salaries use SLEEPER projections re-scored under this league's own rules -- the league`,
    `pays 6 for a passing touchdown where most daily fantasy sites pay 4, so pocket passers`,
    `are worth more here and rushing quarterbacks less. Our board will NOT match DraftKings.`,
  ].join('\n');
}

/** This week's board, bets and daily contests, as they stand right now. */
async function liveState() {
  const [wk] = await sql`
    select max(week) as week from markets where season = ${SEASON} and status = 'open'`;
  const week = Number(wk?.week ?? 1);

  const [markets, bets, bounties, effects, contests, points] = await Promise.all([
    sql`
      select kind, count(*)::int as n,
             count(*) filter (where status = 'open')::int as open
      from markets where season = ${SEASON} and week = ${week}
      group by kind order by kind`,
    sql`
      select b.bettor, t.display_name, b.stake_cents, b.odds, b.is_parlay, b.status
      from bets b join bettors t on t.slug = b.bettor
      where b.status = 'pending' order by b.placed_at desc limit 40`,
    sql`
      select b.target, b.weapon, b.cost_points, t.display_name as target_name,
             coalesce(sum(c.points), 0)::int as raised
      from bounties b
      join bettors t on t.slug = b.target
      left join bounty_contributions c on c.bounty_id = b.id
      where b.season = ${SEASON} and b.status = 'open'
      group by b.id, b.target, b.weapon, b.cost_points, t.display_name`,
    sql`
      select b.kind, o.display_name as owner, v.display_name as target
      from boosts b
      left join bettors o on o.slug = b.owner
      left join bettors v on v.slug = b.target_bettor
      where b.season = ${SEASON} and b.used_at is not null
        and (b.detail->>'week')::int = ${week}
        and b.kind in ('boost-week', 'week-curse', 'slow-play')`,
    sql`
      select c.id, c.kind, c.name, c.status, c.buyin_points, c.seats,
             count(e.id)::int as entries
      from dfs_contests c
      left join dfs_entries e on e.contest_id = c.id
      where c.season = ${SEASON} and c.week = ${week}
      group by c.id order by c.kind`,
    sql`
      select t.display_name, coalesce(sum(p.amount), 0)::int as points
      from bettors t
      left join point_ledger p on p.bettor = t.slug and p.season = ${SEASON}
      group by t.display_name order by points desc`,
  ]);

  const out = [`CURRENT STATE -- season ${SEASON}, week ${week}`];

  out.push(`\nMarkets this week:`);
  for (const m of markets) out.push(`  ${m.kind}: ${m.open} open of ${m.n}`);

  out.push(`\nPoints held:`);
  for (const p of points) out.push(`  ${p.display_name}: ${p.points}`);

  out.push(`\nOpen bets (${bets.length}):`);
  if (!bets.length) out.push('  none');
  // Stakes and prices only. WHICH side somebody took is withheld on The Action
  // by design, and an assistant that leaks it would undo that.
  for (const b of bets) {
    out.push(
      `  ${b.display_name}: ${money(b.stake_cents)} at ${b.odds > 0 ? '+' : ''}${b.odds}` +
        `${b.is_parlay ? ' (parlay)' : ''}`,
    );
  }

  out.push(`\nOpen bounties (${bounties.length}):`);
  if (!bounties.length) out.push('  none');
  for (const b of bounties) {
    out.push(`  ${b.weapon} on ${b.target_name}: ${b.raised}/${b.cost_points} funded`);
  }

  out.push(`\nWeek-wide boosts in play (${effects.length}):`);
  if (!effects.length) out.push('  none');
  for (const e of effects) {
    out.push(`  ${e.kind}: ${e.owner}${e.target ? ` -> ${e.target}` : ''}`);
  }

  out.push(`\nDaily fantasy contests (${contests.length}):`);
  if (!contests.length) out.push('  none');
  for (const c of contests) {
    out.push(
      `  ${c.kind}${c.name ? ` "${c.name}"` : ''}: ${c.status}, ${c.entries} entered` +
        `${c.kind === 'lobby' ? `, ${c.buyin_points} buy-in, ${c.seats} seats` : ''}`,
    );
  }

  return out.join('\n');
}

/** Prose docs, for the parts that are genuinely prose. */
function docs() {
  const files = ['docs/THE_BOOK.md', 'docs/DAILY_FANTASY.md', 'docs/BOUNTIES.md'];
  const parts = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      parts.push(`\n===== ${f} =====\n${readFileSync(f, 'utf8')}`);
    } catch {}
  }
  return parts.join('\n');
}

/**
 * Everything the assistant knows, assembled fresh.
 *
 * Order matters: live numbers come LAST, because when a stale document and the
 * database disagree the database has to be the thing that sticks.
 */
export async function buildContext() {
  const live = await liveState().catch((e) => `CURRENT STATE unavailable: ${e.message}`);
  return [
    docs(),
    `\n===== BOOST CATALOGUE (live prices) =====${catalogue()}`,
    `\n===== MECHANICS (from code) =====\n${mechanics()}`,
    `\n===== ${live}`,
  ].join('\n');
}

export const SYSTEM_PROMPT = `
You are the in-app assistant for The Book, a play-money sportsbook and daily
fantasy game inside a 10-manager fantasy football league.

Answer questions about how the app works, what the rules are, and what is
happening in the league right now. Be brief -- this is a small chat window on a
phone. Two or three sentences is usually right; use a short list only when the
answer really is a list.

The context you are given has three kinds of material, and they are not equally
reliable:

  - The prose documents explain WHY rules exist. They can be out of date.
  - The BOOST CATALOGUE and MECHANICS sections come from the running code.
  - The CURRENT STATE section comes from the live database.

When a document disagrees with the catalogue, the mechanics, or the current
state, the later sections are right and the document is stale. Say so plainly
rather than splitting the difference.

If you do not know, say you do not know. Never invent a price, a rule, or a
number -- somebody will act on it. If a question is about somebody's private
position, note that open bets deliberately show the money and never the pick,
and that you cannot see picks either.
`.trim();
