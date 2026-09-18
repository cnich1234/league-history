/**
 * A daily-fantasy lineup locks ONE SLOT AT A TIME.
 *
 * A slot whose player has taken the field is frozen; every other slot stays
 * editable until its own player's game starts. The whole lineup used to freeze
 * the moment any one player kicked off, so a Thursday quarterback locked the
 * seven Sunday slots behind him for three days -- for no reason, since nothing
 * about those players was known yet.
 *
 * Both directions are refused on a locked slot: you cannot swap a started
 * player OUT (his points are already on the board) and you cannot swap one IN
 * (his game began without him being yours).
 *
 * Pure: exercises the comparison directly rather than standing up a contest,
 * so it needs no database and no real Thursday.
 */
import { fitSlots, LINEUP } from '../lib/dfs.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

/**
 * The rule as saveLineup applies it: walk the slots and refuse a change that
 * touches a started player from either side.
 */
function rejectedSlot(before, after, locked) {
  const was = fitSlots(before) ?? [];
  const now = fitSlots(after) ?? [];
  for (let i = 0; i < now.length; i++) {
    const a = was[i] == null ? null : String(was[i]);
    const b = now[i] == null ? null : String(now[i]);
    if (a === b) continue;
    if (a && locked.has(a)) return { slot: i, why: 'out' };
    if (b && locked.has(b)) return { slot: i, why: 'in' };
  }
  return null;
}

// Eight slots. The QB played Thursday; everyone else plays later.
const BEFORE = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'te', 'flex', 'def'];
const LOCKED = new Set(['qb']);

console.log('\nthe slot that has played is frozen');
{
  const after = ['qb2', 'rb1', 'rb2', 'wr1', 'wr2', 'te', 'flex', 'def'];
  ok('swapping the started QB out is refused', rejectedSlot(BEFORE, after, LOCKED), { slot: 0, why: 'out' });
}
{
  // Somebody else's Thursday player cannot be added after his game began.
  const locked = new Set(['qb', 'thu']);
  const after = ['qb', 'thu', 'rb2', 'wr1', 'wr2', 'te', 'flex', 'def'];
  ok('swapping a started player in is refused', rejectedSlot(BEFORE, after, locked), { slot: 1, why: 'in' });
}

console.log('\nevery other slot stays open -- the whole point');
{
  const after = ['qb', 'rb9', 'rb2', 'wr1', 'wr2', 'te', 'flex', 'def'];
  ok('a Sunday RB can still be changed', rejectedSlot(BEFORE, after, LOCKED), null);
}
{
  const after = ['qb', 'rb9', 'rb8', 'wr9', 'wr8', 'te9', 'flex9', 'def9'];
  ok('all seven can be changed at once', rejectedSlot(BEFORE, after, LOCKED), null);
}
{
  ok('saving an unchanged lineup is fine', rejectedSlot(BEFORE, BEFORE, LOCKED), null);
}

console.log('\nbefore anybody has played');
{
  const after = ['qb2', 'rb9', 'rb8', 'wr9', 'wr8', 'te9', 'flex9', 'def9'];
  ok('everything is editable', rejectedSlot(BEFORE, after, new Set()), null);
}

console.log('\na first entry, with no saved lineup');
{
  // No prior slots: nothing can be swapped OUT, but a started player still
  // cannot be picked up.
  ok('a fresh lineup of unplayed men is fine', rejectedSlot(null, BEFORE, LOCKED), { slot: 0, why: 'in' });
  const clean = ['qb2', 'rb1', 'rb2', 'wr1', 'wr2', 'te', 'flex', 'def'];
  ok('and one avoiding the started player is allowed', rejectedSlot(null, clean, LOCKED), null);
}

console.log('\nthe shape holds');
ok('eight slots', LINEUP.length, 8);
ok('fitSlots pads a short lineup', (fitSlots(['qb']) ?? []).length, LINEUP.length);

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
