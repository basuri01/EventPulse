# EventPulse

Real-time incident reporting for live events.

**Live:** https://eventpulsee.netlify.app

Attendees scan a QR at the gate, see a live floor plan of the venue, and report
issues by dropping a pin. Staff verify those reports. Once verified, everyone
sees them — instantly, with no refresh.

The problem at a large event isn't a lack of information. Thousands of people can
see what's going wrong. The problem is that there's no shared, verified view of
the ground: attendees act on stale information, and organisers find out last.

---

## Features

- **Google sign-in** — one tap, no signup form
- **Two-code joining** — separate attendee and staff codes determine your role at
  join time
- **Camera QR scanning** — attendees scan the event QR with the device camera on
  mobile; desktop uses QR upload or manual code entry
- **Floor plan upload** — organisers upload the venue map to Convex file storage
- **Pin-based reporting** — tap the map, pick a priority, describe the issue
- **Automatic zone naming** — on the bundled campus map, a pin resolves to a
  named zone rather than a coordinate
- **Staff moderation** — approve, reject and resolve, behind a strict server-side
  state machine
- **Real-time propagation** — a verified report reaches every connected device
  without a refresh
- **Trust Score** — reporters build a score from their reporting history
- **Points of interest** — staff place facilities on the map for attendees
- **Session restore** — a refresh puts you back exactly where you were
- **Responsive** — full-bleed on mobile, framed phone layout on desktop

---

## Roles

Roles are **per event**, not global. The same person can organise one event and
attend another.

| Role | Can do |
|---|---|
| **Organizer** | Create the event, upload the floor plan, plus all staff powers |
| **Staff** | Verify / reject / resolve reports, place POIs, ban reporters |
| **Attendee** | Report incidents, view the map and feed, build a Trust Score |

### Flows

```
Organizer   login → create event → upload floor plan → share codes → dashboard
Attendee    login → scan QR or enter code → map · feed · you
Staff       login → enter staff code → map · poi · reports · feed · you
```

---

## Stack

```
React 19 · Vite · TypeScript · Tailwind CSS 4
Convex — database, server functions, real-time subscriptions, file storage
Convex Auth — Google provider
jsQR — client-side QR decoding, no external service
```

No REST layer and no polling. Convex queries are reactive: when a mutation
writes, every subscribed client re-renders automatically.

---

## Running locally

```bash
npm install

npx convex dev        # terminal 1 — backend, keep running
npm run dev           # terminal 2 — frontend
```

Open http://localhost:5173

> Camera QR scanning needs a secure context. It works on the deployed HTTPS URL
> and will not work over plain HTTP on a phone. The manual code entry is always
> available as a fallback.

### Environment

`.env.local` (git-ignored, created by `npx convex dev`):

```
VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
VITE_CONVEX_SITE_URL=https://<your-deployment>.convex.site
```

Set on the Convex deployment:

```bash
npx @convex-dev/auth          # generates JWT_PRIVATE_KEY and JWKS

npx convex env set SITE_URL            "http://localhost:5173"
npx convex env set AUTH_GOOGLE_ID      "<google oauth client id>"
npx convex env set AUTH_GOOGLE_SECRET  "<google oauth client secret>"
```

### Google Cloud Console

Create an OAuth 2.0 Client ID of type **Web application**, then add:

| Field | Value |
|---|---|
| Authorized JavaScript origins | `http://localhost:5173` and your deployed origin |
| Authorized redirect URIs | `https://<your-deployment>.convex.site/api/auth/callback/google` |

The redirect URI uses **`.convex.site`**, not `.convex.cloud`. They are different
hosts: `.cloud` serves data, `.site` serves HTTP actions.

### Deploying

The frontend deploys to Netlify from `main` (`npm run build` → `dist`). Set
`VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` in the Netlify environment, then
point `SITE_URL` at the deployed origin and add it to the Google Console
JavaScript origins.

---

## Architecture notes

**Coordinates are percentages, not pixels.**
Report pins are stored as `pinX` / `pinY` in the range 0–100, relative to the
floor plan image. Capturing a tap undoes the current pan and zoom transform
before normalising, and markers are counter-scaled by `1/zoom` with their
transform origin at the pin tip. A pin placed while zoomed in lands on the same
landmark at any zoom, on any screen size, after any refresh.

**Zone names are gated to the map they were measured against.**
`inferLocation` resolves a coordinate to a named zone using bands measured off
the bundled campus map. When an organiser uploads their own floor plan those
names cannot apply, so the report stores a neutral label instead of guessing a
place. A confidently wrong location is worse than none.

**Session state is derived from the database.**
The active event and the user's role are never held in React state as the source
of truth — they are derived from the user's membership records on every render.
Routing waits until both the auth state and the membership query have settled, so
"still loading" is never mistaken for "not a member".

**Every backend function authorises itself.**
Role is read from the membership document server-side and never trusted from the
client. Attendees cannot reach staff functionality even by calling it directly.
An organiser cannot leave their own event, which would orphan its members and
reports.

**Report status is a state machine.**
```
pending  → approved | rejected
approved → resolved
rejected, resolved → terminal
```
Illegal transitions are rejected by the backend, and the UI only ever renders the
legal actions for a report's current status.

**One predicate drives every report surface.**
The map, the feed and the alert badge all filter through a single `isLiveReport`
function, so they cannot drift out of sync. Two surfaces deliberately opt out —
the staff queue and a reporter's own history — and the reasons are recorded in
the code.

**Reports are idempotent.**
Each submission carries a client-generated UUID. A retried request — which
happens when a phone loses signal mid-send — returns the existing report instead
of creating a duplicate.

**Camera scanning is phone-only and gated twice.**
The camera activates behind `(max-width: 639px) and (pointer: coarse)`, so a
resized desktop window reflows the layout but never triggers a permission
prompt. The stream stops on unmount.

---

## Project structure

```
convex/                 backend — schema, functions, auth, authorisation
  schema.ts             events · memberships · reports · mapPins
  lib/authz.ts          requireUser · requireMembership · requireRole
  lib/geo.ts            inferLocation — coordinate → venue zone name
  events.ts             create · joinByCode · updateFloorMap
  memberships.ts        listMine · leave
  reports.ts            create · listForEvent · listForStaff · updateStatus
  mapPins.ts            points of interest
  files.ts              upload URL generation and retrieval

src/
  App.tsx               all screens
  main.tsx              providers and error boundary
  index.css             fonts, base styles, phone-only overrides
  imports/              floor plan and image assets
```

---

## Known limitations

- Zone names apply only to the bundled campus map. An uploaded floor plan stores
  a neutral location label — per-venue zone mapping is the next thing to build.
- The floor plan upload is required when creating an event.
- Staff join by code only; there is no staff QR.
- Trust Score is stored per membership but not yet computed from report history.

---

**Team EXO**
