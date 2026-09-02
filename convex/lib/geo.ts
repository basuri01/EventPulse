/**
 * Map coordinates are PERCENTAGES 0-100 of the floor-map extent, never 0-1.
 *
 * ONLY meaningful for the bundled IIT Delhi campus map. An event with a custom
 * uploaded floor plan must NOT be labelled with these names — see reports.create.
 *
 * Bands are measured off src/imports/iitd-campus-map.jpg.jpeg by reading where
 * each printed label actually sits, so every cell is named for what is inside
 * it. Kept byte-identical to the copy in src/App.tsx.
 */
/**
 * X bands are in PIN coordinates (fractions of the pannable layer), NOT of the
 * source image. The map <img> uses objectFit:"cover" in a layer whose aspect is
 * 1170x815 at the 390x844 phone frame, while iitd-campus-map.jpg.jpeg is
 * 3200x1800 -- so ~139px of source is cropped off each side and only source x
 * 9.6%..90.4% is reachable. These values are the source-image boundaries
 * 28/45/62/78 pushed through that crop:
 *
 *     source 28 45 62 78  ->  pin 22.7559 43.8082 64.8604 84.6743
 *
 * Floored to 2dp so a landmark sitting exactly ON a source boundary still
 * lands in the higher band, matching bandIndex's >= test in source space.
 *
 * So they are tied to THREE things: the 390x844 frame, objectFit:"cover", and
 * this exact 3200x1800 asset. Change any one and these numbers are wrong. The
 * robust fix is to size the pannable layer to the image's aspect ratio, which
 * would make pin coords equal source coords and let these go back to
 * 28/45/62/78 -- deliberately not done yet.
 *
 * Y needs no such correction: cover crops only horizontally here, so pin y and
 * source y are 1:1.
 */
const X_BANDS = [22.75, 43.80, 64.86, 84.67];  // 5 columns, far-left -> far-right (pin coords)
const Y_BANDS = [40, 55, 68];      // 4 rows, top -> bottom

const ZONES: string[][] = [
  // far-left              left                 centre                       right                    far-right
  ["Hostels (North-West)", "Hostels / Creche",  "Academic Area",             "Rose Garden / Nursery", "Amaltas / IITD Market"],
  ["Nalanda Grounds",      "Hospital / SAC",    "Main Grounds / Library",    "LHC / SBI",             "East / Old Campus"],
  ["Gulmohar / Mini Mart", "Nalanda / OAT",     "Indoor Sports / Block 102", "IRD Hostel",            "Residences (East Campus)"],
  ["West / New Campus",    "West / New Campus", "Block 102",                 "Campus Edge (South)",   "Campus Edge (South)"],
];

function bandIndex(value: number, edges: number[]): number {
  let i = 0;
  while (i < edges.length && value >= edges[i]) i++;
  return i;
}

export function inferLocation(x: number, y: number): string {
  return ZONES[bandIndex(y, Y_BANDS)][bandIndex(x, X_BANDS)];
}

/** Critical first, matching the client's PRIORITY_ORDER. */
export const PRIORITY_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

/** Reject NaN/Infinity and clamp into the 0-100 percentage range. */
export function clampPercent(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be a number between 0 and 100.`);
  return Math.max(0, Math.min(100, value));
}
