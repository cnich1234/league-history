import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getWriteups, getWriteup } from '@/lib/content';
import Markdown from '@/components/Markdown';

export function generateStaticParams() {
  return getWriteups().map((w) => ({ slug: w.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const w = getWriteup(slug);
  return { title: w?.title ?? 'Writeup' };
}

export default async function WriteupPage({ params }) {
  const { slug } = await params;
  const writeup = getWriteup(slug);
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
