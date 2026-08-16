'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Home', icon: '🏈' },
  { href: '/records', label: 'Records', icon: '🏆' },
  { href: '/owners', label: 'Owners', icon: '👥' },
  { href: '/h2h', label: 'H2H', icon: '⚔️' },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {TABS.map((tab) => {
        // Only the exact root should match "/", or every route lights it up.
        const active =
          tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
        return (
          <Link key={tab.href} href={tab.href} className={active ? 'active' : ''}>
            <span className="icon">{tab.icon}</span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
