'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import MarketTab from './market/MarketTab';

// The games sit together -- Trophies feed The Book, Daily and the Market --
// and the reading is on the far right. The Market tab mounts after Daily.
const TABS = [
  { href: '/', label: 'Home', icon: '🏈' },
  { href: '/trophies', label: 'Trophies', icon: '🏅' },
  { href: '/book', label: 'The Book', icon: '🎲' },
  { href: '/dfs', label: 'Daily', icon: '⚡', market: true },
  { href: '/owners', label: 'Owners', icon: '👥' },
  { href: '/writeups', label: 'Reads', icon: '📰' },
  { href: '/records', label: 'Records', icon: '🏆' },
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
          <Fragment key={tab.href}>
            <Link href={tab.href} className={active ? 'active' : ''}>
              <span className="icon">{tab.icon}</span>
              {tab.label}
            </Link>
            {/* Renders nothing for anyone who cannot see the Market. */}
            {tab.market && <MarketTab />}
          </Fragment>
        );
      })}
    </nav>
  );
}
