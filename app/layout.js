import './globals.css';
import Nav from '@/components/Nav';
import Assistant from '@/components/Assistant';
import { getLeague } from '@/lib/data';

const league = getLeague();

export const metadata = {
  title: league.leagueName,
  description: `Fantasy football league history — ${league.seasons.length} seasons of records, championships, and head-to-head.`,
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'League',
  },
};

export const viewport = {
  themeColor: '#0f1521',
  width: 'device-width',
  initialScale: 1,
  // Allow zoom — disabling it is an accessibility problem.
  maximumScale: 5,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
        />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;650;700;800&display=swap"
          rel="stylesheet"
        />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body>
        <div className="shell">{children}</div>
        {/* Follows you around: the question is usually about whatever is on
            screen, so making somebody navigate away to ask it is backwards. */}
        <Assistant />
        <Nav />
      </body>
    </html>
  );
}
