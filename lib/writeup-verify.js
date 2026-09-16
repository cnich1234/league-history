/**
 * The gate between a generated writeup and the league reading it.
 *
 * Automated publishing is only defensible if the checks can REFUSE. A verifier
 * that reports findings into a log nobody reads is not a guardrail, it is a
 * receipt. Everything here returns a verdict the caller can branch on, and the
 * publish step treats anything other than a clean pass as a stop.
 *
 * Three gates, cheapest first, because there is no reason to spend a model call
 * on a draft that a regular expression can already prove wrong:
 *
 *   1. attribution  -- every player named is checked against who actually
 *      rosters him. This is the cheap gate that catches the expensive mistake:
 *      the week 2 draft had every number right and still implied a manager's
 *      Market holdings were his own lineup.
 *   2. arithmetic   -- every score and margin quoted is checked against the
 *      results the context was built from.
 *   3. agents       -- two independent passes over the claims, one reading in
 *      order and one computing ground truth first, both returning structured
 *      verdicts. Run by the caller, since they need the Agent tool.
 *
 * The first two run here, in plain code, with no model involved.
 */

/** Every number in the draft that looks like a fantasy score. */
function quotedNumbers(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(/\b(\d{2,3}\.\d{1,2})\b/g)) out.add(Number(m[1]));
  return [...out];
}

/**
 * Names that appear in the draft, matched against the players the context
 * knows about. Deliberately not a general NER: we only care about players who
 * actually exist in this league's week, and a full-name match is enough.
 */
function namedPlayers(markdown, ownership) {
  const hits = [];
  for (const [pid, p] of Object.entries(ownership)) {
    if (!p.name || p.name.length < 6) continue;
    if (markdown.includes(p.name)) hits.push({ pid, ...p });
  }
  return hits;
}

/**
 * Gate 1: attribution.
 *
 * For every player the draft names, find the sentence naming him and check
 * that no OTHER manager is named in that same sentence without his real owner
 * also being there. A sentence that says "Kevin bought ten shares of Ja'Marr
 * Chase" is fine when the context also carries the owner; one that says
 * "Kevin's Ja'Marr Chase" is not.
 *
 * Returns warnings rather than hard failures for the possessive case, because
 * "Kevin's shares in Chase" is legitimate and a regex cannot reliably tell the
 * two apart. The agents settle it. What IS a hard failure is a possessive that
 * names the wrong manager directly against the player.
 */
export function checkAttribution(markdown, context) {
  const ownership = context.playerOwnership ?? {};
  const managers = [...new Set(Object.values(ownership).map((p) => p.rosteredBy).filter(Boolean))];
  const named = namedPlayers(markdown, ownership);
  const sentences = markdown.split(/(?<=[.!?])\s+/);

  const problems = [];
  for (const p of named) {
    for (const s of sentences) {
      if (!s.includes(p.name)) continue;
      // "<Manager>'s <Player>" is a direct ownership claim.
      for (const m of managers) {
        if (m === p.rosteredBy) continue;
        const possessive = new RegExp(`${m}'s\\s+(?:[A-Za-z'’.-]+\\s+){0,3}${escape(p.name)}`);
        if (possessive.test(s)) {
          problems.push({
            severity: 'error',
            player: p.name,
            claimedBy: m,
            actuallyRosteredBy: p.rosteredBy,
            sentence: s.trim().slice(0, 200),
            why: `${p.name} is rostered by ${p.rosteredBy}, not ${m}.`,
          });
        }
      }
    }
  }
  return problems;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Gate 2: arithmetic.
 *
 * Every score-shaped number in the draft must appear somewhere in the data the
 * draft was written from -- a team total, a margin, a player's points, or a
 * historical figure. A number that matches nothing is either invented or
 * miscopied, and both are publication stoppers.
 *
 * Historical scores live in the history block, so they count as known too.
 */
export function checkNumbers(markdown, context) {
  const known = new Set();
  const add = (n) => {
    if (n == null) return;
    const v = Number(n);
    if (Number.isFinite(v)) {
      known.add(Number(v.toFixed(2)));
      known.add(Number(v.toFixed(1)));
      known.add(Math.round(v));
    }
  };

  for (const t of context.standings ?? []) { add(t.pointsFor); add(t.pointsAgainst); }
  for (const g of context.results ?? []) {
    add(g.margin);
    for (const side of [g.home, g.away]) {
      add(side.points);
      for (const p of [...(side.starters ?? []), ...(side.bench ?? [])]) add(p.points);
    }
    // Differences between any two team totals: "would have beaten" comparisons.
    for (const other of context.results ?? []) {
      for (const a of [g.home, g.away]) for (const b of [other.home, other.away]) {
        add(Math.abs((a.points ?? 0) - (b.points ?? 0)));
      }
    }
  }
  // Projections move with injury news between the draft being written and the
  // check running, so an exact match is the wrong test for them. Anything
  // within a point of a current projection counts as quoted correctly; a number
  // further out than that was either invented or has gone stale enough to be
  // worth stopping for.
  const projections = [];
  for (const m of context.preview ?? []) {
    for (const side of [m.home, m.away]) {
      add(side.projected);
      if (side.projected != null) projections.push(Number(side.projected));
    }
  }
  for (const h of Object.values(context.history ?? {})) {
    if (!h) continue;
    for (const g of [h.biggestBlowout, h.mostRecent]) {
      if (!g) continue;
      add(g.homePoints); add(g.awayPoints); add(g.margin);
      add(Math.abs((g.homePoints ?? 0) - (g.awayPoints ?? 0)));
    }
    for (const c of Object.values(h.careers ?? {})) {
      if (!c) continue;
      add(c.highestScore?.points); add(c.lowestScore?.points);
    }
  }

  const nearProjection = (n) => projections.some((p) => Math.abs(p - n) <= 1);

  return quotedNumbers(markdown)
    .filter((n) => !known.has(n) && !known.has(Math.round(n)))
    .map((n) => {
      // A stale projection is a warning: the number was right when written and
      // the feed has moved since. An unmatched number of any other shape is an
      // error, because nothing in the source data ever said it.
      const stale = nearProjection(n);
      return {
        severity: stale ? 'warning' : 'error',
        number: n,
        why: stale
          ? `${n} was a projection when written; the feed now says ${projections
              .filter((p) => Math.abs(p - n) <= 1)
              .join(' / ')}.`
          : `${n} does not match any score, margin or projection in the source data.`,
      };
    });
}

/**
 * The shape every agent verdict must come back in.
 *
 * Prose findings are useless to an unattended job -- it cannot read "this is
 * mostly fine but check line 40" and decide. A verdict is a boolean and a list.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  required: ['pass', 'claims'],
  properties: {
    pass: { type: 'boolean', description: 'false if ANY claim is wrong' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'verdict'],
        properties: {
          claim: { type: 'string' },
          verdict: { enum: ['VERIFIED', 'WRONG', 'UNVERIFIABLE'] },
          correction: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Fold every gate into one decision.
 *
 * `agentVerdicts` is whatever the caller's verification agents returned. A
 * missing or malformed verdict is a STOP, not a pass: "the checker did not run"
 * and "the checker approved" must never look the same to this function.
 */
export function decide({ attribution = [], numbers = [], agentVerdicts = [] }) {
  const blocking = [
    ...attribution.filter((p) => p.severity === 'error'),
    ...numbers.filter((p) => p.severity === 'error'),
  ];

  const agentProblems = [];
  if (agentVerdicts.length < 2) {
    agentProblems.push({
      severity: 'error',
      why: `Expected two independent verifications, got ${agentVerdicts.length}.`,
    });
  }
  for (const [i, v] of agentVerdicts.entries()) {
    if (!v || typeof v.pass !== 'boolean' || !Array.isArray(v.claims)) {
      agentProblems.push({ severity: 'error', why: `Verification ${i + 1} returned no usable verdict.` });
      continue;
    }
    const wrong = v.claims.filter((c) => c.verdict === 'WRONG');
    if (wrong.length || !v.pass) {
      for (const w of wrong) {
        agentProblems.push({
          severity: 'error',
          why: `Verification ${i + 1}: ${w.claim}`,
          correction: w.correction ?? null,
        });
      }
      if (!wrong.length) {
        agentProblems.push({ severity: 'error', why: `Verification ${i + 1} failed without naming a claim.` });
      }
    }
  }

  const problems = [...blocking, ...agentProblems];
  return {
    publish: problems.length === 0,
    problems,
    summary: problems.length === 0
      ? 'All gates passed.'
      : `${problems.length} problem${problems.length === 1 ? '' : 's'} blocked publication.`,
  };
}
