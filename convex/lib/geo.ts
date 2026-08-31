/**
 * Map coordinates are PERCENTAGES 0-100 of the floor-map extent, never 0-1.
 * This function is copied verbatim from the reference UI so that a pin's
 * location string is identical whether it is derived on the client or here.
 */
export function inferLocation(x: number, y: number): string {
  if (x < 28 && y < 45) return "Hostels (North-West)";
  if (x < 28 && y > 55) return "West / New Campus";
  if (x < 28) return "Nalanda Grounds";
  if (x < 45 && y < 40) return "Hostels (Central)";
  if (x < 45 && y < 55) return "SAC / OAT Area";
  if (x < 45) return "Gulmohar / Nalanda";
  if (x < 62 && y < 40) return "Academic Area";
  if (x < 62 && y < 55) return "Main Grounds";
  if (x < 62) return "Indoor Sports / Block 102";
  if (x < 78 && y < 40) return "Main Building / Library";
  if (x < 78 && y < 55) return "LHC / Block 99B";
  if (x < 78) return "IRD Hostel";
  return "East / Old Campus";
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
