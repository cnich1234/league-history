# Bounties: how they work, and why they don't

**Status: shipped, structurally broken, and awaiting a redesign.** The mechanic
runs, is tested, and does exactly what it was built to do. What it was built to
do turns out not to make sense. This document records the current rules, the
flaw, and the fix we are converging on (**§7, Option D — collective bounties**).

Nothing below §7 is built. Four details are still open and are listed there.

Written from the source (`lib/shop.js`, `lib/boosts.js`, `db/015_bounties.sql`),
not from memory.

---

## 1. What a bounty is

A bounty puts points on someone's head for a **specific attack**. Name a target,
name the weapon, name the reward. The first person to land exactly that attack on
exactly that person collects.

It is the only thing in the app that is **not a boost**. It buys the poster
nothing directly — it pays somebody *else* to act. That is why it lives on The
Action rather than in the Store, and why it has its own table rather than a row
in `boosts`.

---

## 2. Current rules, as built

### Posting

| Rule | Enforced by |
|---|---|
| Reward must be a whole number ≥ 1 | `postBounty` |
| Cannot bounty yourself | `postBounty` + `CHECK (poster <> target)` |
| Weapon must be an attack (`def.attack`) | `postBounty` |
| Target must be a real manager | `postBounty` |
| You must hold the points | `postBounty` |
| One live bounty per (target, weapon) per week | unique partial index |

The reward is **escrowed immediately** — a `point_ledger` row for `-reward` at
post time. Without that, someone could advertise ten points, watch a claim land,
and have nothing to pay with. By then the claimer has already spent real points
on the weapon.

Bounties are **public and loud**: a red BOUNTY ALERT banner on The Action and on
the board, naming target, weapon and reward. That is deliberate — the target
learns to buy Insurance, and everyone else learns there are points on the table.

### Claiming

Claims fire automatically when an attack lands, from three hook points:

- `useBoostOnBet` — the bet-targeted attacks (Skim, Void, Grand Theft, Blind
  Sabotage)
- `switcheroo`
- `slowPlay`

A claim matches on `(season, week, target, weapon)`. Consequences:

- **The weapon is named.** Hitting the right person the wrong way earns nothing,
  and the boost is still spent. This is the constraint that makes a bounty a
  *request* rather than a tip for whatever somebody was going to do anyway.
- **You cannot collect your own** (`poster <> attacker`). Otherwise it is a way
  to move points nowhere while looking busy.
- **A reflected attack collects nothing.** If the target had a Mirror, the attack
  rebounded — it never landed, so nothing is owed.

On a successful claim the reward is credited to the hunter and the row is marked
`claimed_by`/`claimed_at`.

### Expiry

`expireBounties(season, week)` runs in the weekly cron for the *previous* week.
Unclaimed bounties are deleted and **the full reward is refunded** to the poster.

---

## 3. The flaw

Both sides of the trade face the same price list. Take a bounty on The Void,
which costs **12 points**:

- A hunter takes the bounty only if **reward > 12** — otherwise they lose money
  buying the weapon.
- A poster posts it only if **reward < 12** — otherwise they should just buy The
  Void and do it themselves.

**Those intervals do not overlap.** There is no reward that satisfies both. Every
bounty is either charity from the poster or a loss for the hunter.

This is not a tuning problem. No price fixes it, because the mechanic has **no
gains from trade**: the hunter can do nothing the poster cannot do, at no better
price. When both parties can take the identical action at the identical cost,
there is no trade to make.

### Current attack costs, for reference

| Attack | Cost | Targets |
|---|---:|---|
| Slow Play | 5 | a person |
| Blind Sabotage | 6 | one bet |
| Skim | 8 | one bet |
| Grand Theft | 9 | one bet |
| Poison the Well | 12 | a market |
| The Void | 12 | one bet |
| Switcheroo | 14 | one bet |
| Because, Fuck You | 16 | a person's week |

Weekly allowance is **5 points**, with trophies on top.

### The narrow case where it does work today

A bounty pays off when the hunter **already owns the weapon**, or **was going to
attack that person anyway**. Then the boost is sunk and the reward is pure bonus.

That is real, but it is luck rather than strategy. It cannot be the basis of the
mechanic.

### The second problem: posting is free

An unclaimed bounty refunds **in full**. Posting is therefore a free option —
advertise anything, and if nobody bites you are made whole. Nothing discourages
posting constantly except the temporary lock-up of escrowed points.

---

## 4. What a fix has to supply

A trade needs the hunter to have an advantage the poster lacks. Four candidates:

| Asymmetry | Exists today? |
|---|---|
| Hunter already owns the boost | Sometimes — luck, not strategy |
| Hunter was attacking anyway | Sometimes — same problem |
| Poster is *barred* from attacking | No — could be added |
| Attacking costs the poster something extra | No — could be added |

The last two are the real candidates. Both amount to: **attacking yourself must
cost the poster something a hunter does not pay.**

---

## 5. Options

### Option A — anonymity (recommended)

The asymmetry already exists in the game: **attacks are anonymous, and Receipt
(1 point) names the attacker.**

Attack someone yourself and you are exposed to a 1-point Receipt. Pay someone
else and the Receipt names *them* — and they took money, so their motive is
public and boring. The poster stays clean.

A bounty stops being outsourced labour at a markup and becomes **buying
deniability**. That is a real good whose value differs by person and moment,
which is what makes a market.

Under this option a reward **above** the boost cost is correct, not a bug: the
two sides are buying different things.

Open question: does a bounty-claimed attack show on Receipt as "claimed a
bounty" (hunter shielded, poster never named), or does it name the poster? The
first is cleaner; the second is crueller and might be better for this league.

**Cost:** changes what Receipt means, which touches the defensive boosts, not
just bounties.

### Option B — you cannot attack whom you bounty

Post a bounty on someone and you are barred from attacking them yourself that
week. Forces the outsourcing.

**Simpler, blunter.** It manufactures the asymmetry by restriction rather than by
selling something. Risk: it reads as an arbitrary rule rather than a strategy.

### Option C — bounties as a discount

The bounty pays the reward *and* the claimer buys the weapon at a discount, so
the total cost to the hunter drops below list. Creates overlap directly.

**Rejected:** it needs a second price system for the same boost and is hard to
explain in one sentence.

---

## 6. The spam fix (independent of A/B/C)

Unclaimed bounties should **keep a cut** rather than refund in full — say 25%,
rounded up, minimum 1 point.

Not a punishment: a **listing fee**, the same way a book charges for an unfilled
order. It makes people post a number they actually expect somebody to take, which
is the behaviour we want. Post 10, nobody bites, get 8 back.

---

## 7. Option D — collective bounties (the likely direction)

Proposed by Chris, 11 Sep. This supersedes A/B/C and is probably what we build.

**Nobody buys a boost.** A bounty names a target and a weapon, and its cost *is*
the weapon's list price. Anyone can contribute. When contributions reach the
total, the attack fires automatically and the bounty closes.

    Post: "The Void on Devin" -> cost is 12, fixed, not typed in
    Six managers put in 2 each -> total reached -> the Void fires

### Why this fixes what A/B/C were working around

There is **no hunter role**, so there is no resale, so the non-overlapping
interval in §3 simply does not arise. Nobody is buying at 12 to sell at 8. The
crowd pays list price once and the attack happens.

It also turns attacking into a **public referendum**: an expensive attack only
lands if enough people agree the target deserves it.

### What the split does to reach

| Attack | Cost | Solo | Split 2 | Split 4 | Split 6 |
|---|---:|---:|---:|---:|---:|
| Slow Play | 5 | 5.0 | 2.5 | 1.3 | 0.8 |
| Blind Sabotage | 6 | 6.0 | 3.0 | 1.5 | 1.0 |
| Skim | 8 | 8.0 | 4.0 | 2.0 | 1.3 |
| Grand Theft | 9 | 9.0 | 4.5 | 2.3 | 1.5 |
| Poison the Well | 12 | 12.0 | 6.0 | 3.0 | 2.0 |
| The Void | 12 | 12.0 | 6.0 | 3.0 | 2.0 |
| Switcheroo | 14 | 14.0 | 7.0 | 3.5 | 2.3 |
| Because, Fuck You | 16 | 16.0 | 8.0 | 4.0 | 2.7 |

Against a 5/week allowance: a solo Void is **2.4 weeks** of income. Split six
ways it is **2 points** — under half a week. That is the mechanic: it makes the
expensive end of the catalogue reachable.

### Open question 1 — why post rather than wait?

As sketched, the costs land only on the poster (barred from attacking that
target, plus a posting fee) while a contributor gets the same attack at the same
per-point price with no restrictions. **Contributing strictly dominates
posting**, so in theory nobody posts.

Candidate fixes:

- **Drop the posting fee**, keep the can't-attack rule. Posting costs optionality,
  and the poster chooses target and weapon — that is the real perk. *(Recommended:
  simplest, and agenda-setting is genuinely valuable.)*
- **Bar contributors too** from attacking that target this week. Symmetric: you
  helped, you are in.
- **Poster's contribution counts double** toward the total. A perk rather than a
  penalty, which flips the incentive.

### Open question 2 — what happens if it does not fill

A Void needs 12 and reaches 7 by week's end.

- Refund everyone in full — encourages lowballing, contributing becomes a free
  option
- **Refund minus a small cut** — the §6 listing fee, applied to all contributors
  *(recommended)*
- Fire it partially — does not work; there is no half-Void

### Open question 3 — must the poster contribute?

If somebody can post a 12-point Void with 1 point down and let others fund it,
that is very cheap agenda-setting. Suggest a **minimum of 25% of the cost**.

### Open question 4 — which bet does it hit?

The hardest one, and unresolved. Void, Skim, Grand Theft, Blind Sabotage and
Switcheroo all target a **specific bet**, but at fire time the target may have
several open.

- Random among their open bets — fits the "attacks are blind" premise
- Their biggest — predictable, and the target can game it by never having one big bet
- The poster names it at post time — but that bet may settle before the bounty fills

Slow Play and Because, Fuck You target a *person* rather than a bet, so they
sidestep this entirely and would be the easiest to ship first.

### Still to decide

1. Which fix for open question 1
2. Refund policy for an unfilled bounty
3. Minimum poster contribution
4. Bet-selection rule at fire time

---

## 7b. Superseded options

The following were the earlier proposals. Kept for the reasoning, not as live
plans.

1. **Option A** — a bounty-claimed attack is anonymous on Receipt.
2. **Unclaimed bounties forfeit 25%** (minimum 1). *Still live: the listing-fee
   idea carries over to Option D as the unfilled-bounty policy.*
3. Allow rewards above the boost cost — moot under D, where the price is fixed.

### A rejected idea worth recording: the claim stipend

Considered 11 Sep: pay hunters a recurring per-week bonus that scales with their
career claim count, so claiming pays off over time.

**Rejected — it compounds.** Modelled over a 14-week season with tiers of
+1/+2/+3/+5 per week:

| Behaviour | Claims | Allowance-side points | vs baseline |
|---|---:|---:|---:|
| Never claims | 0 | 70 | — |
| Claims 1/wk from week 1 | 14 | 110 | +40 |
| Claims 1/wk from week 7 | 8 | 84 | +14 |
| Claims 2/wk from week 1 | 28 | 124 | +54 |

A per-week reward keyed to a running total pays early claims over more weeks, so
whoever notices the mechanic first wins permanently and a latecomer can never
catch up. It also **decays**: the trade only works while weeks remain, so
bounties would die exactly when the season matters most.

A flat one-off bonus at claim time, escalating with career claims, fixes both —
but Option D removes the need for any of it.

---

## 8. Where the code lives

| Thing | File |
|---|---|
| `postBounty`, `openBounties`, `claimBounties`, `expireBounties` | `lib/shop.js` |
| Claim hooks | `useBoostOnBet`, `switcheroo`, `slowPlay` in `lib/shop.js` |
| Schema | `db/015_bounties.sql` |
| Post form + alert | `components/BountyBoard.js` |
| Board announcement | `components/BountyAlert.js` |
| API | `app/api/bounty/route.js` |
| Expiry | `app/api/cron/route.js` |
| Tests | `scripts/bounty.test.mjs` |
| Player-facing rules | `app/book/rules/page.js` ("Putting points on someone") |

---

## 9. Known gap, unrelated to the economics

The **phone notification is not built.** There is no service worker, VAPID key or
subscription store in the app. The BOUNTY ALERT is in-app only — a banner on The
Action and on the board. The alert string is generated in one place
(`postBounty`) so push can attach to that seam later without the wording
drifting.
