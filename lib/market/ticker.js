/**
 * Stock symbols for players.
 *
 * A ticker is the first initial plus the first three letters of the surname,
 * so Bijan Robinson is BROB and Ja'Marr Chase is JCHA. A defence is its team
 * plus D: SFD, KCD. Collisions are settled by projection -- the bigger name
 * keeps the clean symbol and the next one gets a digit, the way real exchanges
 * hand out MSFT and then live with it.
 */
const letters = (s) => String(s ?? '').replace(/[^a-z]/gi, '').toUpperCase();

export function tickerFor(p) {
  if (p.position === 'DEF') return `${letters(p.team || p.id)}D`;
  const first = letters(p.firstName);
  const last = letters(p.lastName);
  let sym = `${first.slice(0, 1)}${last.slice(0, 3)}`;
  // A two-letter surname (Ty Chandler is fine, Josh Oo is not) borrows from
  // the first name so every symbol is four characters.
  if (sym.length < 4) sym = `${sym}${first.slice(1)}`.slice(0, 4);
  return sym || 'UNKN';
}

/**
 * Assigns a unique ticker to every player. Sorted by projection first so the
 * best player at a symbol owns it; returns a new array in that order.
 */
export function assignTickers(players) {
  const taken = new Set();
  return [...players]
    .sort((a, b) => (b.projection ?? 0) - (a.projection ?? 0))
    .map((p) => {
      const base = tickerFor(p);
      let sym = base;
      for (let n = 2; taken.has(sym); n++) sym = `${base}${n}`;
      taken.add(sym);
      return { ...p, ticker: sym };
    });
}
