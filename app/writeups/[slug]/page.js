import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getWriteups, getWriteup } from '@/lib/content';
import Markdown from '@/components/Markdown';

export function generateStaticParams() {
  return getWriteups().map((w) => ({ slug: w.slug }));
}

export function generateMetadata({ params }) {
  const w = getWriteup(params.slug);
  return { title: w?.title ?? 'Writeup' };
}

export default function WriteupPage({ params }) {
  const writeup = getWriteup(params.slug);
  if (!writeup) notFound();

  return (
    <main className="page">
      <Link href="/writeups" className="back">
        ‹ Writeups
      </Link>
      <header className="page-head">
        <h1>{writeup.title}</h1>
      </header>
      <section className="section">
        <Markdown source={writeup.body} />
      </section>
    </main>
  );
}
