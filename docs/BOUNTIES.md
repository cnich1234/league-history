# Bounties: how they work, and why they don't

**Status: shipped, and structurally broken.** The mechanic runs, is tested, and
does exactly what it was built to do. What it was built to do turns out not to
make sense. This document records the current rules, the flaw, and the options
for fixing it.

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

## 7. Proposed change set

1. Adopt **Option A**: a bounty-claimed attack is anonymous on Receipt.
2. **Unclaimed bounties forfeit 25%** (minimum 1), remainder refunded.
3. Allow rewards **above** the boost cost — correct under A, and document why.

Together these give a reason to post, a reason to take, and a cost to spamming.

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
