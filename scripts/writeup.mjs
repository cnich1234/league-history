/**
 * Generate, verify and publish one weekly writeup.
 *
 * Run by Windows Task Scheduler on Chris's machine -- a recap on Tuesday
 * morning and a preview on Wednesday morning. It runs locally rather than as a
 * Vercel cron for two reasons: a deployed app cannot write a markdown file into
 * its own repo, and a single scheduled API call cannot do what a full agent
 * session does. This script drives Claude Code headlessly, which can gather its
 * own data, follow what looks interesting, and run the verification passes.
 *
 * THE GATES ARE THE POINT. Auto-publishing is only defensible because nothing
 * reaches the league without passing all of them:
 *
 *   attribution  every player named is checked against who actually rosters him
 *   numbers      every score quoted is checked against the source data
 *   privacy      nobody's portfolio or point balance reaches the league
 *   two agents   independent structured verdicts, both must pass
 *
 * Any failure stops the publish, writes the draft to a holding directory, and
 * pushes a notification saying what blocked it. Silence never means success:
 * the run notifies on publish AND on block AND on crash.
 *
 * Usage:
 *   node --env-file=.env.local scripts/writeup.mjs preview
 *   node --env-file=.env.local scripts/writeup.mjs recap --dry-run
 *
 * --dry-run writes the draft and runs every gate but never commits, pushes or
 * notifies the league. Use it to see what an unattended run would have done.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const HOLD = join(ROOT, '.writeups-blocked');
const args = process.argv.slice(2);
const KIND = args.find((a) => a === 'preview' || a === 'recap');
const DRY = args.includes('--dry-run');
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';

if (!KIND) {
  console.error('Usage: node scripts/writeup.mjs <preview|recap> [--dry-run]');
  process.exit(2);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

/** Push to the league, or to nobody on a dry run. */
async function tell(payload, { everyone = false } = {}) {
  if (DRY) {
    log('DRY RUN, would have notified:', payload.title, '--', payload.body);
    return;
  }
  try {
    const push = await import('../lib/push.js');
    if (everyone) await push.notifyAll(payload);
    else await push.notify('chris-nicholson', payload);
  } catch (err) {
    log('notification failed:', err.message);
  }
}

/**
 * Run Claude Code headlessly and return its stdout.
 *
 * `--print` runs one turn and exits. The prompt does the work; the permission
 * mode lets it read the repo and run the data queries it needs without a human
 * to approve each one. It is pointed at this repo and nothing else.
 */
function claude(prompt, { timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE,
      ['--print', '--permission-mode', 'acceptEdits', '--add-dir', ROOT],
      { cwd: ROOT, shell: process.platform === 'win32' },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude timed out after ${Math.round(timeoutMs / 60000)} minutes.`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Claude exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** The last JSON object in a blob of text, which is where a verdict lands. */
function lastJson(text) {
  const matches = [...text.matchAll(/\{[\s\S]*?\}(?=\s*$|\s*\n)/g)];
  for (const m of matches.reverse()) {
    try {
      const v = JSON.parse(m[0]);
      if (v && typeof v === 'object') return v;
    } catch {
      /* keep looking */
    }
  }
  // Fall back to the largest brace-balanced span.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* give up */ }
  }
  return null;
}

async function main() {
  const { nflState, buildWriteupContext } = await import('../lib/writeup-context.js');
  const { checkAttribution, checkNumbers, checkPrivacy, decide } = await import('../lib/writeup-verify.js');

  const { season, week } = await nflState();
  log(`${KIND} for season ${season}, Sleeper week ${week}${DRY ? ' (dry run)' : ''}`);

  // A recap covers the week that just finished; a preview the one about to
  // start. Sleeper flips its counter some hours after Monday night, so by the
  // time either job runs the current week is the one being previewed.
  const targetWeek = KIND === 'recap' ? week - 1 : week;
  if (targetWeek < 1) {
    log('nothing to write yet');
    return;
  }

  const file = join(ROOT, 'content', 'writeups', `${KIND}-week-${targetWeek}.md`);
  if (existsSync(file)) {
    log(`${KIND}-week-${targetWeek}.md already exists, nothing to do`);
    return;
  }

  const context = await buildWriteupContext({ kind: KIND, season, week: targetWeek });
  log(`context: ${context.results.length} results, ${context.preview.length} matchups, ` +
      `${Object.keys(context.playerOwnership).length} players`);

  // ---- write ----
  const written = await claude(writePrompt({ kind: KIND, week: targetWeek, file, context }));
  log('draft written:', written.trim().split('\n').slice(-1)[0]?.slice(0, 120));

  if (!existsSync(file)) throw new Error('Claude did not produce the writeup file.');
  const markdown = readFileSync(file, 'utf8');
  if (markdown.trim().length < 800) throw new Error('The draft is too short to be real.');

  // ---- gate 1 and 2: code, no model ----
  const attribution = checkAttribution(markdown, context);
  const numbers = checkNumbers(markdown, context);
  const privacy = checkPrivacy(markdown, context);
  log(`code gates: ${attribution.length} attribution, ${numbers.length} number, ${privacy.length} privacy findings`);

  // ---- gate 3: two independent agents ----
  const verdicts = [];
  for (const strategy of ['in-order', 'ground-truth-first']) {
    const raw = await claude(verifyPrompt({ file, strategy, season, week: targetWeek }));
    const parsed = lastJson(raw);
    log(`verification (${strategy}):`, parsed ? `pass=${parsed.pass}, ${parsed.claims?.length ?? 0} claims` : 'UNPARSEABLE');
    verdicts.push(parsed);
  }

  const decision = decide({ attribution, numbers, privacy, agentVerdicts: verdicts });
  log(decision.summary);

  if (!decision.publish) {
    mkdirSync(HOLD, { recursive: true });
    const held = join(HOLD, `${KIND}-week-${targetWeek}.md`);
    writeFileSync(held, markdown, 'utf8');
    writeFileSync(
      join(HOLD, `${KIND}-week-${targetWeek}.problems.json`),
      JSON.stringify({ decision, attribution, numbers, privacy, verdicts }, null, 2),
      'utf8',
    );
    // The draft must not sit in content/ or the next run will think it is done.
    await run('git', ['checkout', '--', file]).catch(() => {});
    await run('git', ['clean', '-f', file]).catch(() => {});

    for (const p of decision.problems.slice(0, 6)) log('  BLOCKED:', p.why);
    await tell({
      title: `Week ${targetWeek} ${KIND} blocked`,
      body: `${decision.problems.length} problem(s) found. Draft held for review.`,
      url: '/writeups',
      tag: `writeup-${KIND}-${targetWeek}`,
    });
    process.exitCode = 1;
    return;
  }

  // ---- publish ----
  if (DRY) {
    log('DRY RUN: every gate passed. Not committing.');
    log(`draft is at ${file}`);
    return;
  }

  await run('git', ['add', file]);
  await run('git', ['commit', '-m', commitMessage(KIND, targetWeek, verdicts)]);
  await run('git', ['push']);
  log('pushed');

  await tell(
    {
      title: `Week ${targetWeek} ${KIND} is up`,
      body: firstLine(markdown),
      url: `/writeups/${KIND}-week-${targetWeek}`,
      tag: `writeup-${KIND}-${targetWeek}`,
    },
    { everyone: true },
  );
  log('league notified');
}

function firstLine(markdown) {
  const h1 = markdown.split('\n').find((l) => l.startsWith('# '));
  return (h1 ?? 'A new writeup is up.').replace(/^#\s*/, '').slice(0, 120);
}

function commitMessage(kind, week, verdicts) {
  const claims = verdicts.reduce((n, v) => n + (v?.claims?.length ?? 0), 0);
  return (
    `Week ${week} ${kind}\n\n` +
    `Written and published by scripts/writeup.mjs.\n\n` +
    `Gates: attribution and arithmetic checked in code, then two independent\n` +
    `verification passes over ${claims} claims, both clean. Nothing publishes\n` +
    `unless every gate passes.\n\n` +
    `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
  );
}

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, cmdArgs, { cwd: ROOT, shell: process.platform === 'win32' });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`))));
    c.on('error', reject);
  });
}

/* ---------- prompts ---------- */

function writePrompt({ kind, week, file, context }) {
  return `Write the week ${week} ${kind} for this fantasy football league and save it to ${file}.

Everything you need is in this context object, built from Sleeper, the league's
own 18-year history file and the database. Use it rather than re-fetching, but
DO dig further with your own queries if you spot something worth chasing --
that is the whole reason this runs as an agent and not a single API call.

${JSON.stringify(context, null, 1)}

VOICE. Read content/writeups/preview-week-1.md and recap-week-1.md first and
match them. Heavy trash talk, specific and earned, never generic. Name people.
Use real numbers. The joke should be the fact, not an adjective. Managers are
referred to by manager name, teams by team name. Roughly 900-1200 words with a
section per matchup, a "Lock of the Week", and a short section on The Market if
anyone is holding shares.

FACTS ARE THE PRODUCT. Every number you write will be checked by two
independent verifiers and by code, and a single wrong one stops publication.

  - Scores, margins and player points: quote them exactly as the context gives
    them. Do not round a margin into a different number.
  - Head-to-head records in the history block are REGULAR SEASON. If you want to
    say "lifetime" or "all-time", use allTimeIncludingPlayoffs instead, and note
    the playoff split when it differs -- that contrast is usually the better line.
  - Superlatives must be true across the whole set, not just plausible. If you
    write "lowest in the league" or "biggest blowout in the series", confirm it
    against every value in the context before writing it.
  - OWNERSHIP IS THE TRAP. playerOwnership says who actually rosters each player
    and who started him. book.marketHoldings says who owns SHARES in a player --
    which is a completely different thing. A manager can hold stock in a player
    who starts for somebody else. Never write "<manager>'s <player>" unless
    playerOwnership says that manager rosters him. The first draft of the week 2
    preview got every number right and still read as though one manager's stock
    positions were his own bad lineup. Do not repeat that.
  - If a claim would be interesting but you cannot confirm it, leave it out.

NOBODY'S PORTFOLIO, NOBODY'S POINTS. Individual Market holdings and point
balances are private, exactly like a bet before its market locks, and for the
same reason: if everyone can see the positions, everyone copies them. Never
write that a named manager holds N shares, owns a particular player's stock,
spent N points or has N points left. The context gives you anonymous totals --
how many people are trading, how concentrated the market is -- and those are
fair game and worth a paragraph. A named position is not, and the check will
stop the publish.

Write the file and then reply with one line saying what you wrote. Do not commit.`;
}

function verifyPrompt({ file, strategy, season, week }) {
  const approach =
    strategy === 'ground-truth-first'
      ? `Do NOT read the article first. Independently compute the ground truth from
primary sources -- pull the week's scores, every starter and bench line, the
standings, career and head-to-head records, points balances and Market
holdings. Only then read the article and compare it against what you computed.
This ordering catches wrong FRAMING as well as wrong numbers.`
      : `Go through the article claim by claim in the order written, and verify each
one against a primary source before moving on.`;

  return `Fact-check ${file} before it is published to a fantasy football league. Be
adversarial. Do NOT edit any file.

${approach}

Sources: the Sleeper API at https://api.sleeper.app/v1 (league id
${process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312'}, season ${season}, week ${week}),
data/league.json for career and head-to-head history, and the Neon database via
@neondatabase/serverless using process.env.DATABASE_URL -- run database queries
with \`node --env-file=.env.local -e "..."\`. Projections come from
lib/live.js liveMatchups(${season}, ${week}).

Check every score, margin, player stat line, career record, head-to-head figure,
superlative and projection. Check especially:

  - Arithmetic. Recompute every margin and every "games over .500" claim.
  - Superlatives. "Lowest in the league", "biggest blowout", "closest game" --
    verify against the complete set, not a plausible subset.
  - Started versus benched. Check the starters array, not just players_points.
  - ATTRIBUTION. For every player named, confirm which manager actually rosters
    him. Owning shares in a player on the Market is NOT the same as having him
    on your roster, and conflating the two is the exact error this check exists
    to catch.
  - PRIVACY. Individual Market holdings and point balances must not appear at
    all. If the article says a named manager holds shares, bought a particular
    player, spent points or has a points balance, mark that claim WRONG even if
    the number is accurate -- it is private information, like a bet before its
    market locks. Anonymous totals are fine.

Then reply with ONLY a JSON object as the last thing in your response, in this
shape and nothing else after it:

{"pass": true|false, "claims": [{"claim": "...", "verdict": "VERIFIED"|"WRONG"|"UNVERIFIABLE", "correction": "..."}]}

pass must be false if ANY claim is WRONG. A claim that is merely a prediction or
an opinion is UNVERIFIABLE, not WRONG, and does not fail the check.`;
}

main().catch(async (err) => {
  log('FAILED:', err.message);
  await tell({
    title: `Week ${KIND} writeup failed`,
    body: err.message.slice(0, 160),
    url: '/writeups',
  });
  process.exitCode = 1;
});
