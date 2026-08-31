# EventPulse

Real-time incident reporting for live events.

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
- **Floor plan upload** — organisers upload the venue map to Convex file storage
- **Pin-based reporting** — tap the map, pick a priority, describe the issue
- **Staff moderation** — approve, reject and resolve, behind a strict server-side
  state machine
- **Real-time propagation** — a verified report reaches every connected device
  without a refresh
- **Trust Score** — reporters build a score from their reporting history
- **Points of interest** — staff place facilities on the map for attendees
- **Session restore** — a refresh puts you back exactly where you were

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
Attendee    login → join with attendee code → map · feed · you
Staff       login → join with staff code → map · poi · reports · feed · you
```

---

## Stack

```
React 19 · Vite · TypeScript · Tailwind CSS 4
Convex — database, server functions, real-time subscriptions, file storage
Convex Auth — Google provider
```

No REST layer and no polling. Convex queries are reactive: when a mutation writes,
every subscribed client re-renders automatically.

---

## Running locally

```bash
npm install

npx convex dev        # terminal 1 — backend, keep running
npm run dev           # terminal 2 — frontend
```

Open http://localhost:5173

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
| Authorized JavaScript origins | `http://localhost:5173` |
| Authorized redirect URIs | `https://<your-deployment>.convex.site/api/auth/callback/google` |

Note the redirect URI uses **`.convex.site`**, not `.convex.cloud`. They are
different hosts: `.cloud` serves data, `.site` serves HTTP actions.

---

## Architecture notes

**Coordinates are percentages, not pixels.**
Report pins are stored as `pinX` / `pinY` in the range 0–100, relative to the
floor plan image. Capturing a tap undoes the current pan and zoom transform
before normalising, and markers are counter-scaled by `1/zoom` with their
transform origin at the pin tip. The result: a pin placed while zoomed in lands
on the same landmark at any zoom, on any screen size, after any refresh.

**Session state is derived from the database.**
The active event and the user's role are never held in React state as the source
of truth — they are derived from the user's membership records on every render.
Routing waits until both the auth state and the membership query have settled, so
"still loading" is never mistaken for "not a member".

**Every backend function authorises itself.**
Role is read from the membership document server-side and never trusted from the
client. Attendees cannot reach staff functionality even by calling it directly.

**Report status is a state machine.**
```
pending  → approved | rejected
approved → resolved
rejected, resolved → terminal
```
Illegal transitions are rejected by the backend, and the UI only ever renders the
legal actions for a report's current status.

**Reports are idempotent.**
Each submission carries a client-generated UUID. A retried request — which
happens when a phone loses signal mid-send — returns the existing report instead
of creating a duplicate.

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
  imports/              floor plan and image assets
```

---


Team EXO
