/**
 * ESPN Fantasy Football API client.
 *
 * Two endpoint eras, and they behave differently:
 *   - 2018+   /seasons/{year}/segments/0/leagues/{id}   -> returns an object
 *   - <=2017  /leagueHistory/{id}?seasonId={year}       -> returns an ARRAY of one
 *
 * ESPN moved the host to lm-api-reads.fantasy.espn.com around April 2024; the
 * old fantasy.espn.com host still works for some calls but is less reliable.
 *
 * Public leagues need no auth. Private leagues need espn_s2 + SWID cookies,
 * which are session tokens — keep them in .env.local, never in the repo.
 */

const HOST = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

/** Views worth requesting for historical analysis. */
export const HISTORY_VIEWS = ['mTeam', 'mSettings', 'mMatchup', 'mStandings'];

function buildUrl(leagueId, season, views) {
  const params = new URLSearchParams();
  for (const view of views) params.append('view', view);

  // Seasons from 2018 on live at the per-season path; earlier ones only exist
  // under leagueHistory.
  if (season >= 2018) {
    return `${HOST}/seasons/${season}/segments/0/leagues/${leagueId}?${params}`;
  }
  params.set('seasonId', String(season));
  return `${HOST}/leagueHistory/${leagueId}?${params}`;
}

export class EspnError extends Error {
  constructor(message, { status, season } = {}) {
    super(message);
    this.name = 'EspnError';
    this.status = status;
    this.season = season;
  }
}

/**
 * Fetch one season. Returns null for seasons the league did not exist in
 * (ESPN answers 404), so callers can probe a range without special-casing.
 */
export async function fetchSeason(
  leagueId,
  season,
  { views = HISTORY_VIEWS, cookies = null, retries = 3 } = {}
) {
  const url = buildUrl(leagueId, season, views);

  const headers = {
    // ESPN rejects requests without a browser-like UA.
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    Accept: 'application/json',
  };
  if (cookies?.espnS2 && cookies?.swid) {
    headers.Cookie = `espn_s2=${cookies.espnS2}; SWID=${cookies.swid}`;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = 600 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff));
    }

    let response;
    try {
      response = await fetch(url, { headers });
    } catch (cause) {
      lastError = new EspnError(`Network error: ${cause.message}`, { season });
      continue;
    }

    // League did not exist that year — a normal outcome when probing a range.
    if (response.status === 404) return null;

    if (response.status === 401) {
      throw new EspnError(
        `401 Unauthorized for ${season}. The league is private — set ESPN_S2 and ESPN_SWID in .env.local.`,
        { status: 401, season }
      );
    }

    if (response.ok) {
      const payload = await response.json();
      // The leagueHistory endpoint wraps its result in a single-element array.
      return Array.isArray(payload) ? payload[0] ?? null : payload;
    }

    const retryable = response.status === 429 || response.status >= 500;
    lastError = new EspnError(`${response.status} ${response.statusText}`, {
      status: response.status,
      season,
    });
    if (!retryable) throw lastError;
  }

  throw lastError;
}

/**
 * Probe which seasons exist for a league, walking back from `endSeason`.
 * Stops after `maxGap` consecutive misses so a single missing year does not
 * truncate the history.
 */
export async function discoverSeasons(
  leagueId,
  { endSeason, earliest = 2010, maxGap = 3, cookies = null } = {}
) {
  const found = [];
  let gap = 0;

  for (let season = endSeason; season >= earliest; season--) {
    let data = null;
    try {
      data = await fetchSeason(leagueId, season, {
        views: ['mTeam'],
        cookies,
      });
    } catch (error) {
      if (error.status === 401) throw error;
      // Treat other failures as a miss rather than aborting the probe.
    }

    if (data) {
      found.push(season);
      gap = 0;
    } else {
      gap++;
      if (gap >= maxGap && found.length > 0) break;
    }
  }

  return found.sort((a, b) => a - b);
}
