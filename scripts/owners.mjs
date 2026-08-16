/**
 * Owner identity resolution.
 *
 * ESPN keys ownership by member GUID, and one human can hold several. Chad
 * Rissland has three, verified by checking every season: all three appear as
 * co-owners of the SAME team (team 9) in every year they exist, never different
 * teams — so they are one person, not relatives.
 *
 * Because ESPN records co-ownership at the team level, stats must be keyed by
 * franchise-season and resolved to a person. Summing per member GUID would
 * count Chad's seasons three times.
 */

/**
 * Explicit merges: every GUID belonging to one human, keyed by a stable slug.
 * Add an entry here if someone else ever creates a second account.
 */
export const OWNER_ALIASES = {
  // Key doubles as the URL slug, so keep it in the same first-last form the
  // automatic slugs use.
  'chad-rissland': [
    '{B6D2F68F-B360-4ED0-AC5B-DC46664A5BC3}', // Youhateme39 — primary, all seasons
    '{02D15407-7C14-4A7E-BDDE-576FE6062918}', // crissl1470547 / chad39 — 2019-2020
    '{0A74113B-DB16-42B7-87CE-1F291CEDF361}', // ESPNfan4893280917 — 2021-2026
  ],
  // Steve ran Computadora Diablo under two accounts: 2008, then 2009-2014.
  // The windows do not overlap, consistent with re-registering rather than
  // two people sharing a franchise name.
  'steve-bazaar': [
    '{CC17DFA5-A98E-4BB4-84E2-02747F65CE41}', // 2009-2014
    '{51881F56-9FD8-4E01-B0E2-93123F04DCB8}', // 2008
  ],
};

/** Preferred display names, so the UI is not at the mercy of ESPN handles. */
export const OWNER_NAMES = {
  'chad-rissland': 'Chad Rissland',
  'steve-bazaar': 'Steve Bazaar',
};

/**
 * Managers who left before 2019 have no `members` entry anywhere in the data —
 * ESPN only returns member records for the current roster — so their names come
 * from the league rather than the API.
 */
export const DEPARTED_OWNERS = {
  '{FF4D143B-04BA-4ABA-875B-9534719AEB96}': {
    slug: 'john-nicholson',
    name: 'John Nicholson',
  },
  '{DACF41A0-9585-492A-8108-5A8D99FC81E1}': {
    slug: 'matt-meyerhoff',
    name: 'Matt Meyerhoff',
  },
  '{6419246A-3DA2-428C-8538-98CF0048943A}': {
    slug: 'ray-blakely',
    name: 'Ray Blakely',
  },
};

const guidToSlug = new Map();
for (const [slug, guids] of Object.entries(OWNER_ALIASES)) {
  for (const guid of guids) guidToSlug.set(guid.toUpperCase(), slug);
}

/**
 * ESPN stores whatever casing a manager typed at signup, so names arrive as a
 * mix of "Kevin Malina" and "mike rossi". Title-case them for display, leaving
 * internal capitals alone (McBride, O'Neil).
 */
function titleCase(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      // Already has a capital somewhere past the first letter — trust it.
      /[A-Z]/.test(word.slice(1))
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(' ');
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build a GUID -> person map from every season's `members` array.
 * Aliased GUIDs collapse to one person; everyone else gets their own slug.
 */
export function buildOwnerIndex(seasons) {
  const people = new Map(); // slug -> person
  const byGuid = new Map(); // guid -> slug

  // Pass 1: real identities from `members`, which only the fully-fetched
  // seasons (2019+) carry.
  for (const { season, data } of seasons) {
    for (const member of data.members ?? []) {
      const guid = String(member.id).toUpperCase();
      const fullName =
        `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim() ||
        member.displayName ||
        guid;

      // An explicit alias wins; otherwise fall back to the person's name so
      // capitalization changes ("chad rissland" vs "Chad Rissland") do not
      // create two people.
      const slug = guidToSlug.get(guid) ?? slugify(fullName);

      byGuid.set(guid, slug);

      const person = people.get(slug) ?? {
        slug,
        name: OWNER_NAMES[slug] ?? titleCase(fullName),
        guids: new Set(),
        handles: new Set(),
        seasons: new Set(),
      };
      person.guids.add(guid);
      if (member.displayName) person.handles.add(member.displayName);
      person.seasons.add(season);
      people.set(slug, person);
    }
  }

  // Pass 2: GUIDs that only ever appear as team owners — managers who left
  // before 2019, so no `members` entry exists for them anywhere. Without this
  // they would be dropped and their seasons would vanish from the totals.
  for (const { season, data } of seasons) {
    for (const team of data.teams ?? []) {
      for (const rawGuid of team.owners ?? []) {
        const guid = String(rawGuid).toUpperCase();
        if (byGuid.has(guid)) {
          // Known person — just record that they played this season.
          people.get(byGuid.get(guid))?.seasons.add(season);
          continue;
        }

        const departed = DEPARTED_OWNERS[guid];
        const slug =
          guidToSlug.get(guid) ??
          departed?.slug ??
          `unknown-${guid.slice(1, 9).toLowerCase()}`;
        byGuid.set(guid, slug);

        const person = people.get(slug) ?? {
          slug,
          // Real name unavailable — label by franchise instead of a raw GUID.
          name: OWNER_NAMES[slug] ?? departed?.name ?? team.name ?? slug,
          guids: new Set(),
          handles: new Set(),
          seasons: new Set(),
          // Flags that this is a franchise label, not a person's name.
          nameUnknown: true,
        };
        person.guids.add(guid);
        person.seasons.add(season);
        people.set(slug, person);
      }
    }
  }

  return { people, byGuid };
}

/**
 * Resolve a team to its person slug. Prefers `primaryOwner`, then any owner
 * GUID we recognize — which is what makes co-owned teams resolve to one person.
 */
export function resolveTeamOwner(team, byGuid) {
  const candidates = [team.primaryOwner, ...(team.owners ?? [])].filter(Boolean);
  for (const guid of candidates) {
    const slug = byGuid.get(String(guid).toUpperCase());
    if (slug) return slug;
  }
  return null;
}
