/**
 * Minimal markdown renderer covering exactly what league-bot emits:
 * H2/H3 headers, paragraphs, bold, italic, horizontal rules and list items.
 *
 * A full parser would mean a new dependency in a static export for content we
 * generate ourselves and therefore control the shape of. If the bot ever starts
 * emitting tables or links, extend this rather than reaching for a library.
 */

function inline(text, keyPrefix) {
  // Split on bold first, then italics inside the remaining plain runs, so
  // **bold** wins over the single asterisks it contains.
  const out = [];
  const boldSplit = text.split(/(\*\*[^*]+\*\*)/g);

  boldSplit.forEach((chunk, i) => {
    if (!chunk) return;
    if (chunk.startsWith('**') && chunk.endsWith('**')) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{chunk.slice(2, -2)}</strong>);
      return;
    }
    chunk.split(/(\*[^*]+\*|_[^_]+_)/g).forEach((piece, j) => {
      if (!piece) return;
      const italic =
        (piece.startsWith('*') && piece.endsWith('*') && piece.length > 2) ||
        (piece.startsWith('_') && piece.endsWith('_') && piece.length > 2);
      if (italic) out.push(<em key={`${keyPrefix}-i${i}-${j}`}>{piece.slice(1, -1)}</em>);
      else out.push(piece);
    });
  });

  return out;
}

export default function Markdown({ source }) {
  const blocks = source.split(/\n{2,}/);

  return (
    <div className="prose">
      {blocks.map((block, i) => {
        const text = block.trim();
        if (!text) return null;

        if (/^---+$/.test(text)) return <hr key={i} />;
        if (text.startsWith('### ')) return <h3 key={i}>{inline(text.slice(4), i)}</h3>;
        if (text.startsWith('## ')) return <h2 key={i}>{inline(text.slice(3), i)}</h2>;
        if (text.startsWith('# ')) return <h2 key={i}>{inline(text.slice(2), i)}</h2>;

        // A block whose every line is a bullet becomes a list.
        const lines = text.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''), `${i}-${j}`)}</li>
              ))}
            </ul>
          );
        }

        return <p key={i}>{inline(text, i)}</p>;
      })}
    </div>
  );
}
