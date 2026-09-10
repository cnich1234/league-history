import { isCommissioner } from '@/lib/auth';
import BookTabs from '@/components/BookTabs';

export const dynamic = 'force-dynamic';

/**
 * Shared chrome for every Book page.
 *
 * Each page used to render its own <h1> and subtitle above the tab bar -- "The
 * Book" with a week and pot line, "Results" with one line, "House Rules" with
 * none. The tabs therefore sat at a different height on each page and visibly
 * jumped when you switched, which read as a full page load rather than a tab.
 *
 * Hoisting the title and tabs into a layout means Next keeps this subtree
 * mounted across navigations and only swaps what is below. Nothing moves.
 */
export default async function BookLayout({ children }) {
  const commissioner = await isCommissioner();

  return (
    <main className="page">
      <header className="page-head">
        <h1>The Book</h1>
      </header>
      <BookTabs commissioner={commissioner} />
      {children}
    </main>
  );
}
