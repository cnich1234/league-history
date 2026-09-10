'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/book', label: 'Board' },
  { href: '/book/standings', label: 'Standings' },
  { href: '/book/results', label: 'Results' },
  { href: '/book/rules', label: 'Rules' },
];

export default function BookTabs({ commissioner }) {
  const pathname = usePathname();
  const tabs = commissioner ? [...TABS, { href: '/book/admin', label: 'Admin' }] : TABS;

  return (
    <nav className="book-tabs">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={pathname === t.href ? 'book-tab book-tab-on' : 'book-tab'}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
