'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * The Market's nav tab. Renders nothing until the server says this person is
 * on the testers list, so for everyone else the tab does not exist. Self
 * contained: the nav mounts it and knows nothing about the rule.
 */
export default function MarketTab() {
  const pathname = usePathname();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/market/access')
      .then((r) => r.json())
      .then((d) => alive && setOk(Boolean(d?.ok)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!ok) return null;
  return (
    <Link href="/market" className={pathname.startsWith('/market') ? 'active' : ''}>
      <span className="icon">📈</span>
      Market
    </Link>
  );
}
