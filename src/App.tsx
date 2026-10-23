import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import jsQR from "jsqr";
import qrcodeGenerator from "qrcode-generator";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
// The bundled fallback map, used when an event has no uploaded floor plan.
// 3200x1800. inferLocation's zone bands are measured off THIS file, so the two
// must be changed together.
import campusMap from "@/imports/iitd-campus-map.jpg.jpeg";
// 665x595, opaque, background exactly the `cream` token so it sits flush on
// the login screen.
import landingIllustration from "@/assets/landing-illustration.png";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type Screen = "login" | "home" | "my-events" | "create-1" | "create-2" | "create-3" | "create-done" | "join-scan" | "staff-code" | "app" | "staff-app";
type Role = "organizer" | "attendee" | "staff";
type Tab = "map" | "feed" | "info" | "you";
type StaffTab = "map" | "poi" | "reports" | "feed" | "you";
type Priority = "critical" | "high" | "medium" | "low";

interface POI { id: string; x: number; y: number; emoji: string; label: string; }

interface EventData {
  name: string; venue: string; date: string;
  // Last day of the event, "YYYY-MM-DD"; same as `date` for a single day.
  endDate: string;
  // "HH:MM" as typed into the time inputs; converted to ms on submit.
  startTime: string; endTime: string;
  // Plain text; at most 2,000 words (and 20,000 characters, server-side).
  description: string;
  floorPlanUploaded: boolean; staff: string[];
  attendeeCode: string; staffCode: string;
  // Set while the create wizard is in flight, before the event row exists.
  eventId?: Id<"events">;
  mapStorageId?: Id<"_storage">;
  mapWidth?: number; mapHeight?: number; mapPreviewUrl?: string;
}

interface Report {
  id: string; author: string; location: string; description: string;
  time: string; status: "pending" | "approved" | "rejected";
  pinX: number; pinY: number; banned?: boolean; resolved?: boolean;
  priority?: Priority; views: number; officialStatement?: string;
  createdAt: number; authorTrustScore: number; isMine: boolean;
  reviewedByMe: boolean; reviewedAt?: number;
}

/**
 * THE single definition of "live on a public surface": approved, not withdrawn
 * by a ban, not yet resolved. The feed, the map markers and the critical-alert
 * badge all derive from this one predicate, so they cannot drift apart -- a
 * resolved report used to leave the feed while its pin stayed on the map.
 *
 * Deliberately NOT used by MyReportsSheet or StaffReportsView: those two show
 * a reporter their own rejections and give moderators the full history.
 */
function isLiveReport(r: Report): boolean {
  return r.status === "approved" && !r.banned && !r.resolved;
}

/**
 * Awaiting a moderator: pending, and the reporter is not banned. Used ONLY on
 * rows from listForStaff (moderators), for the "?" pins on the staff map.
 * Attendees never receive other people's pending reports, and their own are
 * never drawn on the map.
 */
function isAwaitingReview(r: Report): boolean {
  return r.status === "pending" && !r.banned;
}

interface Pin { id: number; x: number; y: number; }

interface AppNotification {
  id: string; reportId: string; location: string;
  description: string; statement: string; time: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────────────────────
const MOCK_ATTENDEE_CODE = "EP26-QR";
const MOCK_STAFF_CODE = "STAFF-4821";
const MAX_MAP_BYTES = 5 * 1024 * 1024;
// Mirrors events.create; the server enforces both.
const MAX_DESCRIPTION_WORDS = 2000;
const MAX_DESCRIPTION_CHARS = 20000;

/**
 * Convex surfaces a thrown Error whose message embeds the server-side text,
 * wrapped in a request id and a stack. Pull the sentence back out so the UI
 * can show it verbatim.
 */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/Uncaught (?:Convex)?Error:\s*(.+)/);
  const text = (match ? match[1] : raw).replace(/\s+at\s+handler[\s\S]*$/, "").trim();
  return text || "Something went wrong. Please try again.";
}

/** "just now" / "14 min ago" — the relative stamp the reference UI shows. */
function timeAgo(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Per-tab "this tab was inside a workspace" flag, so a REFRESH keeps you in
 * your workspace while a fresh open (new tab or window, or a new sign-in)
 * shows the role picker. It stores no event and no role: those always come
 * from memberships.listMine. If storage is unavailable the safe default is
 * the role picker.
 */
const WORKSPACE_FLAG = "eventpulse.inWorkspace";
function readWorkspaceFlag(): boolean {
  try { return sessionStorage.getItem(WORKSPACE_FLAG) === "1"; } catch { return false; }
}
function writeWorkspaceFlag(inWorkspace: boolean): void {
  try {
    if (inWorkspace) sessionStorage.setItem(WORKSPACE_FLAG, "1");
    else sessionStorage.removeItem(WORKSPACE_FLAG);
  } catch { /* storage unavailable: the next load shows the role picker */ }
}

type EventTimes = { date: string; endDate: string | null; startTime: number | null; endTime: number | null };

/** "5 Nov · 10:00 AM – 5:30 PM", or "5 Nov, 10:00 AM → 7 Nov, 5:30 PM"; date only when there are no times. */
function formatEventRange(e: EventTimes): string {
  const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (e.startTime === null || e.endTime === null) {
    const d = new Date(`${e.date}T00:00`);
    return Number.isNaN(d.getTime()) ? e.date : day(d);
  }
  const s = new Date(e.startTime), f = new Date(e.endTime);
  return s.toDateString() === f.toDateString()
    ? `${day(s)} · ${time(s)} – ${time(f)}`
    : `${day(s)}, ${time(s)} → ${day(f)}, ${time(f)}`;
}

type EventStatus = "live" | "upcoming" | "completed" | "ended";
/** Ended = the organiser ended it. Otherwise from the times; events without times read as live. */
function eventStatus(e: EventTimes & { isActive: boolean }, now: number): EventStatus {
  if (!e.isActive) return "ended";
  if (e.startTime === null || e.endTime === null) return "live";
  if (now < e.startTime) return "upcoming";
  return now < e.endTime ? "live" : "completed";
}

/**
 * `Date.now()` that re-renders at the next of `boundaries` (event starts and
 * ends), so status pills flip on their own. One timeout at a time, clamped to
 * a minute: browsers treat delays over ~24.8 days as immediate.
 */
function useNowAtBoundaries(boundaries: number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const key = boundaries.join(",");
  useEffect(() => {
    const t = Date.now();
    const next = boundaries.filter((b) => b > t).sort((a, b) => a - b)[0];
    const delay = next === undefined ? 60_000 : Math.min(next - t + 50, 60_000);
    const id = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(id);
    // `key` stands in for `boundaries`, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, key]);
  return now;
}

/** Natural pixel dimensions of an image, read before it is uploaded. */
function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("That image could not be read."));
    img.src = src;
  });
}

async function decodeQrFromFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/**
 * Same 640px breakpoint as the phone-only block in index.css. A media query
 * gates layout but cannot stop a JS API call, so the camera needs this check.
 * `pointer: coarse` is deliberately stricter than the CSS gate: a narrow
 * desktop window should reflow, but must never raise a camera prompt.
 */
const PHONE_MQ = "(max-width: 639px) and (pointer: coarse)";
const isPhone = () => typeof window !== "undefined" && window.matchMedia(PHONE_MQ).matches;

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_STYLE: Record<Priority, { bg: string; text: string; label: string }> = {
  critical: { bg: "rgba(220,38,38,0.12)", text: "#dc2626", label: "🔴 Critical" },
  high:     { bg: "rgba(234,88,12,0.12)", text: "#ea580c", label: "🟠 High" },
  medium:   { bg: "rgba(217,119,6,0.12)", text: "#d97706", label: "🟡 Medium" },
  low:      { bg: "rgba(22,163,74,0.12)", text: "#16a34a", label: "🟢 Low" },
};
// Attendee feed cards are tinted by priority. A report with no priority keeps
// the neutral card: tinting it "low" would claim a triage that never happened.
const PRIORITY_CARD_STYLE: Record<Priority, { bg: string; border: string }> = {
  critical: { bg: "rgba(251,113,133,0.24)", border: "rgba(220,38,38,0.48)" },
  high:     { bg: "rgba(255,237,213,0.72)", border: "rgba(234,88,12,0.4)" },
  medium:   { bg: "rgba(254,243,199,0.72)", border: "rgba(217,119,6,0.4)" },
  low:      { bg: "rgba(220,252,231,0.68)", border: "rgba(22,163,74,0.36)" },
};

const cream = "#f5f1ea", bg = "#e8e4dc", ink = "#1a1917", muted = "#8a7f6e";
const dimmed = "#a09585", accent = "#5b3ff8", border = "rgba(0,0,0,0.08)";
const card = "rgba(255,255,255,0.75)";

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

function inferLocation(x: number, y: number): string {
  return ZONES[bandIndex(y, Y_BANDS)][bandIndex(x, X_BANDS)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared small components
// ─────────────────────────────────────────────────────────────────────────────
function BackBtn({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="flex items-center gap-1.5 text-sm font-medium" style={{ color: muted }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 3L5 8l5 5" stroke={muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Back
    </button>
  );
}

function GmailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
      <path d="M44 24.5c0-1.4-.1-2.7-.4-4H24v7.6h11.3c-.5 2.6-2 4.8-4.1 6.3v5.2h6.6c3.9-3.6 6.2-8.9 6.2-15.1z" fill="#4285F4"/>
      <path d="M24 45c5.7 0 10.4-1.9 13.9-5.1l-6.6-5.2c-1.9 1.3-4.3 2-7.3 2-5.6 0-10.4-3.8-12.1-8.9H5v5.4C8.5 40.9 15.7 45 24 45z" fill="#34A853"/>
      <path d="M11.9 27.8c-.4-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1V14.2H5C3.5 17.1 2.7 20.4 2.7 24s.8 6.9 2.3 9.8l6.9-6z" fill="#FBBC05"/>
      <path d="M24 10.8c3.2 0 6 1.1 8.2 3.2l6.2-6.2C34.4 4.5 29.6 2.7 24 2.7 15.7 2.7 8.5 6.8 5 14.2l6.9 5.4c1.7-5.1 6.5-8.8 12.1-8.8z" fill="#EA4335"/>
    </svg>
  );
}

/** Location-pin glyph for the map's pinpoint button and its hint text. */
function PinpointIcon({ color = "currentColor", size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 1.25a6.25 6.25 0 00-6.25 6.25C2.75 12.18 9 17 9 17s6.25-4.82 6.25-9.5A6.25 6.25 0 009 1.25zm0 3.5a2.75 2.75 0 100 5.5 2.75 2.75 0 000-5.5z"
        fill={color}
      />
    </svg>
  );
}

function QRCodeSVG({ value }: { value: string }) {
  const size = 112;
  // A real QR: solid modules on a 4-module quiet zone, so a phone can read it.
  const modules = useMemo(() => {
    const qr = qrcodeGenerator(0, "M");
    qr.addData(value || " ");
    qr.make();
    const count = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) dark.push([r, c]);
    }
    return { count, dark };
  }, [value]);
  const quiet = 4;
  const cell = size / (modules.count + quiet * 2);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ borderRadius: 8 }} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="white" />
      {modules.dark.map(([r, c]) => (
        <rect key={`${r}-${c}`} x={(c + quiet) * cell} y={(r + quiet) * cell} width={cell} height={cell} fill={ink} />
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Pin Detail Sheet
// ─────────────────────────────────────────────────────────────────────────────
/** The Reports queue's own handlers, passed in for a moderator's pending pin. */
interface PinModeration {
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onSetPriority: (id: string, p: Priority) => void;
  onSetCritical: (report: Report) => void;
}

function ReportPinDetailSheet({ report, onClose, moderation }: { report: Report; onClose: () => void; moderation?: PinModeration }) {
  // Only the moves the state machine allows from "pending": set a priority
  // (critical = approve with a statement), approve, or reject.
  const canModerate = !!moderation && report.status === "pending";
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.4)", backdropFilter: "blur(5px)" }} onClick={onClose}>
      <div className="w-full p-5 pb-8 rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {report.priority && (
              <div className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                style={{ background: PRIORITY_STYLE[report.priority].bg, color: PRIORITY_STYLE[report.priority].text }}>
                {PRIORITY_STYLE[report.priority].label}
              </div>
            )}
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
              style={{
                background: report.status === "approved" ? "rgba(22,163,74,0.12)" : "rgba(75,85,99,0.12)",
                color: report.status === "approved" ? "#15803d" : "#4b5563",
              }}>
              {report.status === "approved" ? "Verified" : "Unverified"}
            </span>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ background: "#edeae4", color: "#6b6456" }}>✕</button>
        </div>
        <p className="text-[11px] font-mono mb-1" style={{ color: muted }}>{report.location}</p>
        <p className="text-base font-semibold leading-snug mb-3" style={{ color: ink }}>{report.description}</p>
        {report.officialStatement && (
          <div className="rounded-2xl p-3.5 mb-3" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.18)" }}>
            <div className="flex items-center gap-1.5 mb-1.5">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M6.5 1L1 11.5h11L6.5 1z" stroke="#dc2626" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M6.5 5v2.5" stroke="#dc2626" strokeWidth="1.3" strokeLinecap="round" />
                <circle cx="6.5" cy="9.5" r="0.5" fill="#dc2626" />
              </svg>
              <span className="text-[10px] font-mono font-semibold" style={{ color: "#dc2626" }}>Official Statement</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: "#7f1d1d" }}>{report.officialStatement}</p>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <p className="text-[10px] font-mono" style={{ color: dimmed }}>Reported by {report.author}</p>
          <span style={{ color: dimmed }}>·</span>
          <p className="text-[10px] font-mono" style={{ color: dimmed }}>{report.time}</p>
        </div>
        {canModerate && moderation && (
          <>
            <div className="mt-4 mb-2">
              <p className="text-[9px] font-mono uppercase tracking-widest mb-1.5" style={{ color: dimmed }}>Priority</p>
              <div className="flex gap-1.5 flex-wrap">
                {(["critical", "high", "medium", "low"] as Priority[]).map((p) => (
                  <button key={p}
                    onClick={() => { if (p === "critical") { onClose(); moderation.onSetCritical(report); } else { moderation.onSetPriority(report.id, p); } }}
                    className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
                    style={{
                      background: report.priority === p ? PRIORITY_STYLE[p].bg : "rgba(0,0,0,0.04)",
                      color: report.priority === p ? PRIORITY_STYLE[p].text : dimmed,
                      border: `1px solid ${report.priority === p ? PRIORITY_STYLE[p].text + "40" : "transparent"}`,
                    }}>
                    {PRIORITY_STYLE[p].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={() => { moderation.onApprove(report.id); onClose(); }} className="flex-1 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
                style={{ background: "rgba(22,163,74,0.1)", color: "#15803d" }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#15803d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Approve
              </button>
              <button onClick={() => { moderation.onReject(report.id); onClose(); }} className="flex-1 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
                style={{ background: "rgba(220,38,38,0.1)", color: "#dc2626" }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" /></svg>
                Reject
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Critical Statement Modal
// ─────────────────────────────────────────────────────────────────────────────
function CriticalStatementModal({ report, onClose, onConfirm }: { report: Report; onClose: () => void; onConfirm: (statement: string) => void }) {
  const [statement, setStatement] = useState("");
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.5)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full p-5 pb-8 rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0" style={{ background: "rgba(220,38,38,0.1)" }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 1.5L1 16.5h16L9 1.5z" stroke="#dc2626" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M9 7v4" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="9" cy="13" r="0.75" fill="#dc2626" />
            </svg>
          </div>
          <div>
            <p className="font-bold text-base" style={{ color: ink }}>Mark as Critical</p>
            <p className="text-xs" style={{ color: muted }}>Provide an official statement for attendees</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-sm ml-auto shrink-0" style={{ background: "#edeae4", color: "#6b6456" }}>✕</button>
        </div>
        <div className="px-3 py-2.5 rounded-xl mb-4" style={{ background: "rgba(0,0,0,0.04)", border: `1px solid ${border}` }}>
          <p className="text-[10px] font-mono mb-0.5" style={{ color: muted }}>{report.location}</p>
          <p className="text-sm font-medium" style={{ color: ink }}>{report.description}</p>
        </div>
        <p className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: muted }}>Official Statement</p>
        <textarea
          value={statement} onChange={(e) => setStatement(e.target.value)}
          placeholder="Describe the situation and what actions are being taken…"
          rows={4}
          className="w-full rounded-xl px-3 py-3 text-sm outline-none resize-none mb-4"
          style={{ background: "#edeae4", border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }}
          autoFocus
        />
        <p className="text-[10px] mb-3 text-center" style={{ color: dimmed }}>This will be broadcast as an in-app alert to all attendees.</p>
        <button onClick={() => { if (statement.trim()) onConfirm(statement.trim()); }} disabled={!statement.trim()}
          className="w-full py-4 rounded-2xl font-semibold text-sm text-white"
          style={{ background: "#dc2626", opacity: statement.trim() ? 1 : 0.4, cursor: statement.trim() ? "pointer" : "not-allowed" }}>
          Mark Critical &amp; Send Alert
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification Panel
// ─────────────────────────────────────────────────────────────────────────────
function NotificationPanel({ notifications, onClose, onDismiss }: { notifications: AppNotification[]; onClose: () => void; onDismiss: (id: string) => void }) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="flex-1 sm:flex-none" />
      <div className="w-full flex flex-col rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}`, maxHeight: "70%" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <div>
            <p className="font-bold text-base" style={{ color: ink }}>Alerts</p>
            <p className="text-xs font-mono" style={{ color: muted }}>{notifications.length} critical alert{notifications.length !== 1 ? "s" : ""}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ background: "#edeae4", color: "#6b6456" }}>✕</button>
        </div>
        <div className="overflow-y-auto px-4 pb-8 flex flex-col gap-3">
          {notifications.length === 0 ? (
            <div className="py-10 flex items-center justify-center"><p className="text-sm" style={{ color: dimmed }}>No alerts</p></div>
          ) : notifications.map((n) => (
            <div key={n.id} className="rounded-2xl p-4" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)" }}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: "#dc2626" }} />
                  <span className="text-[10px] font-mono font-semibold" style={{ color: "#dc2626" }}>CRITICAL ALERT</span>
                </div>
                <button onClick={() => onDismiss(n.id)} className="text-[10px] font-mono shrink-0" style={{ color: dimmed }}>Dismiss</button>
              </div>
              <p className="text-[10px] font-mono mb-1" style={{ color: muted }}>{n.location}</p>
              <p className="text-sm font-semibold mb-2" style={{ color: ink }}>{n.description}</p>
              <div className="rounded-xl p-2.5" style={{ background: "rgba(255,255,255,0.6)" }}>
                <p className="text-[10px] font-mono mb-0.5" style={{ color: "#dc2626" }}>Official Statement</p>
                <p className="text-xs leading-relaxed" style={{ color: "#7f1d1d" }}>{n.statement}</p>
              </div>
              <p className="text-[10px] font-mono mt-2" style={{ color: dimmed }}>{n.time}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pannable Map
// ─────────────────────────────────────────────────────────────────────────────
function PannableMap({
  pins, onPin, approvedReports, pendingReports = [], headerContent, belowMapContent, allowPin, pois = [],
  onReportPinTap, pinpointMode, notifCount = 0, onNotifOpen, onPinpointToggle, mapUrl = null,
}: {
  mapUrl?: string | null;
  pins: Pin[];
  onPin?: (p: Pin) => void;
  approvedReports: Report[];
  // Moderator maps only: reports awaiting review, drawn as "?" pins.
  pendingReports?: Report[];
  headerContent: React.ReactNode;
  belowMapContent: React.ReactNode;
  allowPin: boolean;
  pois?: POI[];
  onReportPinTap?: (id: string) => void;
  pinpointMode?: boolean;
  notifCount?: number;
  onNotifOpen?: () => void;
  onPinpointToggle?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  // Mirror of `scale` for the native wheel listener below, which is attached once.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const clampOffset = useCallback((x: number, y: number, s: number) => {
    const el = containerRef.current;
    if (!el) return { x, y };
    const cw = el.clientWidth, ch = el.clientHeight;
    const maxX = cw * (1 + (s - 1) * 0.5);
    const maxY = Math.max(0, (ch * (s - 1)) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    drag.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX, dy = e.clientY - drag.current.startY;
    setOffset(clampOffset(drag.current.ox + dx, drag.current.oy + dy, scale));
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (drag.current) {
      const dx = Math.abs(e.clientX - drag.current.startX), dy = Math.abs(e.clientY - drag.current.startY);
      if (dx < 4 && dy < 4 && allowPin && onPin && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const cw = rect.width, ch = rect.height;
        const innerW = cw * 3;
        const originContainerX = cw / 2, originContainerY = ch / 2;
        const originLocalX = innerW / 2, originLocalY = ch / 2;
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const localX = originLocalX + (clickX - originContainerX - offset.x) / scale;
        const localY = originLocalY + (clickY - originContainerY - offset.y) / scale;
        const mapX = localX / innerW * 100;
        const mapY = localY / ch * 100;
        onPin({ id: Date.now(), x: Math.max(0, Math.min(100, mapX)), y: Math.max(0, Math.min(100, mapY)) });
      }
    }
    drag.current = null;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = { dist: Math.hypot(dx, dy), scale };
    } else if (e.touches.length === 1) {
      drag.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, ox: offset.x, oy: offset.y };
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDist = Math.hypot(dx, dy);
      const newScale = Math.max(0.4, Math.min(4, pinchRef.current.scale * (newDist / pinchRef.current.dist)));
      setScale(newScale);
      setOffset((o) => clampOffset(o.x, o.y, newScale));
    } else if (e.touches.length === 1 && drag.current) {
      const ddx = e.touches[0].clientX - drag.current.startX;
      const ddy = e.touches[0].clientY - drag.current.startY;
      setOffset(clampOffset(drag.current.ox + ddx, drag.current.oy + ddy, scale));
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.changedTouches.length === 1 && drag.current && e.touches.length === 0) {
      const t = e.changedTouches[0];
      const dx = Math.abs(t.clientX - drag.current.startX), dy = Math.abs(t.clientY - drag.current.startY);
      if (dx < 6 && dy < 6 && allowPin && onPin && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const cw = rect.width, ch = rect.height;
        const innerW = cw * 3;
        const originContainerX = cw / 2, originContainerY = ch / 2;
        const originLocalX = innerW / 2, originLocalY = ch / 2;
        const clickX = t.clientX - rect.left;
        const clickY = t.clientY - rect.top;
        const localX = originLocalX + (clickX - originContainerX - offset.x) / scale;
        const localY = originLocalY + (clickY - originContainerY - offset.y) / scale;
        const mapX = localX / innerW * 100;
        const mapY = localY / ch * 100;
        onPin({ id: Date.now(), x: Math.max(0, Math.min(100, mapX)), y: Math.max(0, Math.min(100, mapY)) });
      }
    }
    drag.current = null;
    pinchRef.current = null;
  };

  const zoomIn  = () => { const s = Math.min(4, scale * 1.3); setScale(s); setOffset((o) => clampOffset(o.x, o.y, s)); };
  const zoomOut = () => { const s = Math.max(0.4, scale / 1.3); setScale(s); setOffset((o) => clampOffset(o.x, o.y, s)); };

  // Wheel and trackpad-pinch zoom about the centre, through the same
  // setScale/clampOffset path as the buttons. Attached natively and
  // non-passive: React registers wheel listeners as passive, so a
  // preventDefault there is ignored and a trackpad pinch (ctrl+wheel) would
  // zoom the whole page instead of the map.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      const s = Math.max(0.4, Math.min(4, scaleRef.current * factor));
      setScale(s);
      setOffset((o) => clampOffset(o.x, o.y, s));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampOffset]);

  return (
    <div className="relative flex-1 overflow-hidden" style={{ background: cream }}>
      {/* Map container */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: allowPin ? "crosshair" : "grab", userSelect: "none", touchAction: "none" }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={() => { drag.current = null; }}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      >
        {/* Transformed map layer */}
        <div
          style={{
            position: "absolute",
            width: "300%", height: "100%",
            left: "-100%",
            background: cream,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: drag.current || pinchRef.current ? "none" : "transform 0.15s ease",
          }}
        >
          <img src={mapUrl ?? campusMap} alt={mapUrl ? "Event floor plan" : "IIT Delhi campus map"} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} draggable={false} />

          {/* Approved report pins — clickable when not in pinpoint mode */}
          {approvedReports.map((r) => (
            <div key={r.id}
              className="absolute"
              style={{
                left: `${r.pinX}%`, top: `${r.pinY}%`,
                // Counter-scale so the marker stays the same size at any zoom;
                // the origin is the pin's tip, so that point never moves.
                transform: `translate(-50%, -100%) scale(${1 / scale})`,
                transformOrigin: "50% 100%",
                pointerEvents: !allowPin && onReportPinTap ? "auto" : "none",
                cursor: !allowPin && onReportPinTap ? "pointer" : "default",
              }}
              onClick={(e) => { if (!allowPin && onReportPinTap) { e.stopPropagation(); onReportPinTap(r.id); } }}
            >
              <div className="flex flex-col items-center">
                <div className="w-7 h-7 rounded-full flex items-center justify-center shadow-md"
                  style={{ background: r.priority === "critical" ? "#dc2626" : r.priority === "high" ? "#ea580c" : r.priority === "medium" ? "#d97706" : "#16a34a", border: "2px solid white" }}>
                  <span style={{ fontSize: 9, color: "white", fontWeight: 700 }}>
                    {r.priority === "critical" ? "!!" : r.priority === "high" ? "!" : r.priority === "medium" ? "·" : "·"}
                  </span>
                </div>
                <div className="w-0 h-0" style={{ borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderTop: `6px solid ${r.priority === "critical" ? "#dc2626" : r.priority === "high" ? "#ea580c" : r.priority === "medium" ? "#d97706" : "#16a34a"}` }} />
              </div>
            </div>
          ))}

          {/* Reports awaiting review (moderators only). After the live pins so
              they draw above them; same anchoring and counter-scale. */}
          {pendingReports.map((r) => (
            <div key={r.id}
              className="absolute"
              style={{
                left: `${r.pinX}%`, top: `${r.pinY}%`,
                transform: `translate(-50%, -100%) scale(${1 / scale})`,
                transformOrigin: "50% 100%",
                pointerEvents: !allowPin && onReportPinTap ? "auto" : "none",
                cursor: !allowPin && onReportPinTap ? "pointer" : "default",
              }}
              onClick={(e) => { if (!allowPin && onReportPinTap) { e.stopPropagation(); onReportPinTap(r.id); } }}
              aria-label="Report awaiting review"
            >
              <div className="flex flex-col items-center">
                <div className="w-7 h-7 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(75,85,99,0.5)", border: "2px dashed rgba(255,255,255,0.9)", boxShadow: "0 3px 9px rgba(31,41,55,0.25)", backdropFilter: "blur(2px)" }}>
                  <span className="text-[10px] font-bold text-white">?</span>
                </div>
                <div className="w-0 h-0" style={{ borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderTop: "6px solid rgba(75,85,99,0.5)" }} />
              </div>
            </div>
          ))}

          {/* User-placed pins */}
          {pins.map((pin) => (
            <div key={pin.id} className="absolute pointer-events-none"
              style={{ left: `${pin.x}%`, top: `${pin.y}%`, transform: `translate(-50%, -100%) scale(${1 / scale})`, transformOrigin: "50% 100%" }}>
              <div className="flex flex-col items-center">
                <div className="w-9 h-9 rounded-full flex items-center justify-center shadow-lg"
                  style={{ background: accent, border: "2.5px solid white" }}>
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                    <circle cx="7.5" cy="6" r="2.5" stroke="white" strokeWidth="1.4" />
                    <path d="M7.5 15C7.5 15 2 10 2 6a5.5 5.5 0 0111 0c0 4-5.5 9-5.5 9z" stroke="white" strokeWidth="1.3" />
                  </svg>
                </div>
                <div className="w-0 h-0" style={{ borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: `8px solid ${accent}` }} />
              </div>
            </div>
          ))}

          {/* POI markers */}
          {pois.map((poi) => (
            <div key={poi.id} className="absolute pointer-events-none"
              style={{ left: `${poi.x}%`, top: `${poi.y}%`, transform: `translate(-50%, -100%) scale(${1 / scale})`, transformOrigin: "50% 100%" }}>
              <div className="flex flex-col items-center gap-0.5">
                <span style={{ fontSize: 22, lineHeight: 1 }}>{poi.emoji}</span>
                <span className="text-[9px] font-bold text-center max-w-[64px] leading-tight" style={{ color: "#0f172a", textShadow: "0 0 4px rgba(255,255,255,0.9), 0 0 4px rgba(255,255,255,0.9)" }}>{poi.label}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Gradient */}
        <div className="absolute top-0 left-0 right-0 pointer-events-none" style={{ height: 80, background: "linear-gradient(to bottom, rgba(245,241,234,0.55) 0%, transparent 100%)" }} />
      </div>

      {/* Header overlay */}
      <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none flex flex-col items-center pt-2 px-5">
        {headerContent}
      </div>

      {/* Pinpoint mode toggle button — top right */}
      {onPinpointToggle && (
        <button
          onClick={onPinpointToggle}
          className="absolute z-20 top-3 right-3 w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-all active:scale-90"
          style={{
            background: pinpointMode ? accent : "rgba(255,255,255,0.92)",
            border: pinpointMode ? "none" : `1px solid ${border}`,
            boxShadow: pinpointMode ? "0 4px 16px rgba(91,63,248,0.35)" : "0 2px 8px rgba(0,0,0,0.12)",
          }}
        >
          <PinpointIcon color={pinpointMode ? "white" : accent} size={19} />
        </button>
      )}

      {/* Notification bell — top left (attendee map) */}
      {onNotifOpen !== undefined && (
        <button
          onClick={onNotifOpen}
          className="absolute z-20 top-3 left-3 w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-all active:scale-90"
          style={{ background: "rgba(255,255,255,0.92)", border: `1px solid ${border}`, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
        >
          <div className="relative">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 2a5 5 0 00-5 5v3l-1.5 2.5h13L14 10V7a5 5 0 00-5-5z" stroke={ink} strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M7.5 14.5a1.5 1.5 0 003 0" stroke={ink} strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            {notifCount > 0 && (
              <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center"
                style={{ background: "#dc2626", fontSize: 8, color: "white", fontWeight: 700 }}>
                {notifCount > 9 ? "9+" : notifCount}
              </div>
            )}
          </div>
        </button>
      )}

      {/* Zoom controls */}
      <div className="absolute right-3 z-20 flex flex-col gap-1.5" style={{ top: "50%", transform: "translateY(-50%)" }}>
        <button onClick={zoomIn} className="w-8 h-8 rounded-xl flex items-center justify-center font-bold text-lg shadow-md"
          style={{ background: "rgba(255,255,255,0.9)", color: ink, border: `1px solid ${border}` }}>+</button>
        <button onClick={zoomOut} className="w-8 h-8 rounded-xl flex items-center justify-center font-bold text-lg shadow-md"
          style={{ background: "rgba(255,255,255,0.9)", color: ink, border: `1px solid ${border}` }}>−</button>
      </div>

      {/* Below-map content (hint / report button) */}
      {belowMapContent}
    </div>
  );
}

/**
 * PannableMap inside the box that sizes it. On phone the box is a plain flex
 * column, so the map fills the workspace exactly as before. From 640px the box
 * keeps the PHONE's map proportions (390:811.5, measured in the DOM at
 * 390x844) at the largest size that fits, centred. Pins are percentages of a
 * layer whose shape follows this box, so this is what keeps a pin on the same
 * spot of the image on every device. PannableMap itself is untouched.
 */
function FramedMap(props: React.ComponentProps<typeof PannableMap>) {
  return (
    <div className="flex-1 flex flex-col min-h-0 relative sm:flex-none sm:h-full sm:w-auto sm:max-w-full sm:mx-auto sm:aspect-[390/811.5] sm:rounded-[28px] sm:overflow-hidden sm:shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_40px_80px_rgba(0,0,0,0.25)]">
      <PannableMap {...props} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Google sign-in navigates away. Coming back with the browser's Back button
  // can restore this page from the back/forward cache with its React state
  // intact, which would leave `busy` true and the button disabled for good.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) setBusy(false); };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      // On success the browser is redirected to Google, so `busy` stays set.
      await onLogin();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center px-6 pt-[70px] pb-8 min-h-0" style={{ background: cream }}>
      <div className="flex flex-col items-center shrink-0">
        <div className="w-[60px] h-[60px] rounded-2xl flex items-center justify-center"
          style={{ background: `linear-gradient(135deg, ${accent} 0%, #794df7 100%)`, boxShadow: "0 10px 26px rgba(91,63,248,0.35)" }}>
          <svg width="31" height="31" viewBox="0 0 31 31" fill="none">
            <circle cx="15.5" cy="15.5" r="10.5" stroke="white" strokeWidth="2" />
            <path d="M15.5 8.5v7l5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="mt-4 text-[32px] leading-none font-bold" style={{ color: ink, letterSpacing: "-0.035em" }}>Event Pulse</h1>
        <p className="mt-3 text-base" style={{ color: muted }}>Smart event incident management</p>
      </div>
      {/* Natural size when it fits; the only block allowed to shrink, so on a
          short screen it gives way first and the button never leaves the
          viewport. Leftover height goes to the spacer below the button, which
          is where the design leaves its empty space. */}
      <div className="min-h-0 w-full flex items-start justify-center mt-5" style={{ flex: "0 1 auto" }}>
        <img src={landingIllustration}
          alt="A phone showing a venue map with a location pin, surrounded by cards for crowd updates, events, live updates and live notifications"
          className="w-full max-h-full object-contain" />
      </div>
      <div className="w-full flex flex-col gap-3 shrink-0 mt-5">
        <button onClick={() => { void login(); }} disabled={busy}
          className="w-full flex items-center justify-center gap-3 py-[17px] rounded-2xl font-semibold text-base text-white transition-transform active:scale-[0.98]"
          style={{ background: `linear-gradient(100deg, ${accent} 0%, #6531f4 100%)`, boxShadow: "0 10px 24px rgba(91,63,248,0.28)", opacity: busy ? 0.4 : 1, cursor: busy ? "not-allowed" : "pointer" }}>
          {/* Google's branding wants the coloured G on white, so it sits in its own white disc. */}
          <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: "white" }}>
            <GmailIcon />
          </span>
          Continue with Google
        </button>
        {error && <p className="text-xs text-center" style={{ color: "#dc2626" }}>{error}</p>}
      </div>
      <div className="flex-1" />
    </div>
  );
}

function SplashScreen() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ background: cream }}>
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center animate-pulse"
        style={{ background: `linear-gradient(135deg, ${accent} 0%, #8b74fc 100%)`, boxShadow: "0 8px 24px rgba(91,63,248,0.3)" }}>
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
          <circle cx="15" cy="15" r="10" stroke="white" strokeWidth="2" />
          <path d="M15 8v7l4 4" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: dimmed }}>Event Pulse</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Home
// ─────────────────────────────────────────────────────────────────────────────
function HomeScreen({ userName, onCreateEvent, onJoinEvent, onJoinAsStaff, onLogout, error = null }: { userName: string; onCreateEvent: () => void; onJoinEvent: () => void; onJoinAsStaff: () => void; onLogout: () => void; error?: string | null }) {
  const initials = userName.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);
  const options = [
    { label: "Organizer", sub: "Create and manage events, upload floor plans and manage staff.", color: accent, action: onCreateEvent,
      icon: <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect x="5" y="7" width="22" height="20" rx="4" stroke="white" strokeWidth="1.8" /><path d="M10 4v6M22 4v6M5 13h22M16 17v7M12.5 20.5h7" stroke="white" strokeWidth="1.8" strokeLinecap="round" /></svg> },
    { label: "Attendee", sub: "Join an event with its QR or event code and see live updates.", color: "#0ea5e9", action: onJoinEvent,
      icon: <svg width="34" height="34" viewBox="0 0 34 34" fill="none"><circle cx="13" cy="11" r="5" stroke="white" strokeWidth="1.8" /><path d="M3 29c0-5.5 4.5-10 10-10s10 4.5 10 10M22 9a4.5 4.5 0 010 9M25 21c3.5.8 6 4 6 8" stroke="white" strokeWidth="1.8" strokeLinecap="round" /></svg> },
    { label: "Staff", sub: "Join as event staff and access staff tools using staff code.", color: "#10b981", action: onJoinAsStaff,
      icon: <svg width="34" height="34" viewBox="0 0 34 34" fill="none"><circle cx="14" cy="10" r="5" stroke="white" strokeWidth="1.8" /><path d="M4 29c0-5.5 4.5-10 10-10 2.2 0 4.2.7 5.8 1.9" stroke="white" strokeWidth="1.8" strokeLinecap="round" /><circle cx="25" cy="24" r="5" stroke="white" strokeWidth="1.7" /><path d="M25 16.5v2M25 29.5v2M17.5 24h2M30.5 24h2M19.7 18.7l1.4 1.4M28.9 27.9l1.4 1.4M30.3 18.7l-1.4 1.4M21.1 27.9l-1.4 1.4" stroke="white" strokeWidth="1.4" strokeLinecap="round" /></svg> },
  ];
  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-10" style={{ background: cream }}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.13em]" style={{ color: muted }}>Welcome back</p>
          <h1 className="text-2xl leading-none font-bold mt-1.5" style={{ color: ink, letterSpacing: "-0.025em" }}>{userName.split(" ")[0]}</h1>
        </div>
        <div className="relative" ref={menuRef}>
          <button onClick={() => setShowMenu((v) => !v)}
            className="w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm"
            style={{ background: "#e8e3f0", color: accent }}>{initials}</button>
          {showMenu && (
              <div className="absolute right-0 top-[52px] z-50 rounded-2xl overflow-hidden shadow-xl"
                style={{ background: "#faf8f5", border: `1px solid ${border}`, minWidth: 140 }}>
                <button onClick={() => { setShowMenu(false); onLogout(); }}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-left"
                  style={{ color: "#dc2626" }}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6" stroke="#dc2626" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Log Out
                </button>
              </div>
            )}
        </div>
      </div>
      <h2 className="text-[22px] font-bold mt-[82px] mb-9 text-center" style={{ color: ink, letterSpacing: "-0.025em" }}>What&apos;s your role</h2>
      <div className="flex flex-col gap-3.5">
        {options.map((opt) => (
          <button key={opt.label} onClick={opt.action}
            className="flex items-center gap-4 px-4 py-3.5 min-h-[94px] rounded-[22px] text-left active:scale-[0.98] transition-all"
            style={{ background: "rgba(255,255,255,0.86)", border: "1px solid rgba(255,255,255,0.92)", boxShadow: "0 7px 18px rgba(90,74,50,0.08)" }}>
            <div className="w-[58px] h-[58px] rounded-[20px] flex items-center justify-center shrink-0"
              style={{ background: `linear-gradient(135deg, ${opt.color} 0%, ${opt.color}b8 100%)`, boxShadow: `0 6px 14px ${opt.color}2e` }}>{opt.icon}</div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-[17px] leading-tight" style={{ color: ink }}>{opt.label}</p>
              <p className="text-[13px] leading-[1.35] mt-1" style={{ color: muted }}>{opt.sub}</p>
            </div>
            <svg className="shrink-0" width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M7.5 5l5 5-5 5" stroke={dimmed} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-center mt-4" style={{ color: "#dc2626" }}>{error}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Organizer: Your events
// ─────────────────────────────────────────────────────────────────────────────
interface MyEventRow extends EventTimes {
  _id: Id<"events">; name: string; venue: string; isActive: boolean;
  attendeeCount: number; attendeeCountCapped: boolean;
}

const STATUS_PILL: Record<EventStatus, { label: string; bg: string; text: string }> = {
  live:      { label: "Live",      bg: "rgba(220,38,38,0.1)",  text: "#dc2626" },
  upcoming:  { label: "Upcoming",  bg: "rgba(91,63,248,0.1)",  text: accent },
  completed: { label: "Completed", bg: "rgba(75,85,99,0.12)",  text: "#4b5563" },
  ended:     { label: "Ended",     bg: "rgba(75,85,99,0.12)",  text: "#4b5563" },
};

function OrganizerEventsScreen({ events, onOpen, onCreate, onBack, opening, error }: {
  events: MyEventRow[] | undefined;
  onOpen: (id: Id<"events">) => void;
  onCreate: () => void;
  onBack: () => void;
  opening: Id<"events"> | null;
  error: string | null;
}) {
  const now = useNowAtBoundaries((events ?? []).filter((e) => e.isActive).flatMap((e) => [e.startTime, e.endTime].filter((t): t is number => t !== null)));
  if (events === undefined) return <SplashScreen />;
  const active = events.filter((e) => e.isActive);
  const past = events.filter((e) => !e.isActive);

  const card = (e: MyEventRow, openable: boolean) => {
    const status = STATUS_PILL[eventStatus(e, now)];
    const body = (
      <div className="flex items-start gap-3.5">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
          style={{ background: `linear-gradient(135deg, ${accent}, #8b74fc)`, boxShadow: "0 7px 16px rgba(91,63,248,0.2)" }}>
          <svg width="27" height="27" viewBox="0 0 27 27" fill="none">
            <rect x="3.5" y="5.5" width="20" height="18" rx="3.5" stroke="white" strokeWidth="1.6" />
            <path d="M8 3.5v5M19 3.5v5M3.5 11h20" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="9" cy="16" r="1.3" fill="white" /><circle cx="14" cy="16" r="1.3" fill="white" /><circle cx="19" cy="16" r="1.3" fill="white" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="font-bold text-base truncate" style={{ color: ink }}>{e.name}</p>
            <span className="px-2 py-1 rounded-full text-[9px] font-mono uppercase shrink-0" style={{ background: status.bg, color: status.text }}>{status.label}</span>
          </div>
          <p className="text-xs mt-1 truncate" style={{ color: muted }}>{e.venue}</p>
          {/* The range is longer than the design's single date, so the range
              and the count each get a line instead of wrapping mid-row. */}
          <p className="text-[10px] font-mono mt-2" style={{ color: dimmed }}>{formatEventRange(e)}</p>
          <p className="text-[10px] font-mono mt-0.5" style={{ color: dimmed }}>
            {e.attendeeCountCapped ? `${e.attendeeCount}+` : e.attendeeCount} attendee{e.attendeeCount === 1 && !e.attendeeCountCapped ? "" : "s"}
          </p>
        </div>
        {openable && (
          <svg className="self-center shrink-0" width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M7 5l4 4-4 4" stroke={dimmed} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
    );
    const style = { background: "rgba(255,255,255,0.86)", border: `1px solid ${border}`, boxShadow: "0 7px 20px rgba(90,74,50,0.08)" };
    return openable ? (
      <button key={e._id} onClick={() => onOpen(e._id)} disabled={opening !== null}
        className="w-full rounded-[22px] p-4 text-left active:scale-[0.985] transition-all"
        style={{ ...style, opacity: opening !== null && opening !== e._id ? 0.5 : 1 }}>{body}</button>
    ) : (
      <div key={e._id} className="w-full rounded-[22px] p-4" style={style}>{body}</div>
    );
  };

  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8 overflow-y-auto" style={{ background: cream }}>
      <BackBtn onBack={onBack} />
      <div className="mt-6 mb-7">
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Organizer workspace</p>
        <h2 className="text-[28px] leading-tight font-bold mt-1" style={{ color: ink, letterSpacing: "-0.035em" }}>Your events</h2>
        {events.length > 0 && (
          <p className="text-sm mt-1.5" style={{ color: muted }}>
            {events.length} event{events.length === 1 ? "" : "s"} created{active.length > 0 ? " · Select one to open its dashboard." : ""}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {active.map((e) => card(e, true))}
        {error && <p className="text-xs text-center" style={{ color: "#dc2626" }}>{error}</p>}
        <button onClick={onCreate}
          className="w-full min-h-[92px] rounded-[22px] flex items-center justify-center gap-3 active:scale-[0.985] transition-all"
          style={{ background: "rgba(91,63,248,0.04)", border: "1.5px dashed rgba(91,63,248,0.35)", color: accent }}>
          <span className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(91,63,248,0.1)" }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke={accent} strokeWidth="1.8" strokeLinecap="round" /></svg>
          </span>
          <span className="font-semibold text-sm">Create a new event</span>
        </button>
      </div>

      {past.length > 0 && (
        <>
          <p className="text-[10px] font-mono uppercase tracking-widest mt-8 mb-3" style={{ color: muted }}>Past</p>
          <div className="flex flex-col gap-3">{past.map((e) => card(e, false))}</div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Event steps
// ─────────────────────────────────────────────────────────────────────────────
function CreateStep1({ eventData, onChange, onNext, onBack }: { eventData: Partial<EventData>; onChange: (d: Partial<EventData>) => void; onNext: () => void; onBack: () => void }) {
  // "YYYY-MM-DDTHH:MM" strings compare correctly as text, so this is
  // end-after-start across the whole range, overnight included.
  const startValue = eventData.date && eventData.startTime ? `${eventData.date}T${eventData.startTime}` : "";
  const endValue = eventData.endDate && eventData.endTime ? `${eventData.endDate}T${eventData.endTime}` : "";
  const timesValid = !!(startValue && endValue) && endValue > startValue;
  const description = eventData.description ?? "";
  // Same count as the server: runs of non-whitespace.
  const descriptionWords = description.match(/\S+/g)?.length ?? 0;
  const tooManyWords = descriptionWords > MAX_DESCRIPTION_WORDS;
  const tooManyChars = description.length > MAX_DESCRIPTION_CHARS;
  const valid = !!(eventData.name?.trim() && eventData.venue?.trim() && description.trim())
    && timesValid && !tooManyWords && !tooManyChars;
  /**
   * A datetime-local value is "YYYY-MM-DDTHH:MM" (no seconds at the default
   * step of 60) or "" when cleared or incomplete. Split it into our stored
   * date + "HH:MM" pair; anything else clears BOTH parts, never just one.
   */
  const splitDateTime = (value: string): [string, string] =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? [value.slice(0, 10), value.slice(11, 16)] : ["", ""];
  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8 overflow-y-auto" style={{ background: cream }}>
      <BackBtn onBack={onBack} />
      <div className="mt-4 mb-6">
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Step 1 of 3</p>
        <h2 className="text-xl font-bold mt-1" style={{ color: ink, letterSpacing: "-0.02em" }}>Event Details</h2>
      </div>
      <div className="flex flex-col gap-4 flex-1">
        {[{ label: "Event Name", key: "name", placeholder: "Event Pulse '26", type: "text" },
          { label: "Venue", key: "venue", placeholder: "IIT Delhi, New Delhi", type: "text" }].map(({ label, key, placeholder, type }) => (
          <div key={key}>
            <label className="text-[10px] font-mono uppercase tracking-widest block mb-1.5" style={{ color: muted }}>{label}</label>
            <input type={type} value={(eventData as Record<string, string>)[key] ?? ""} onChange={(e) => onChange({ ...eventData, [key]: e.target.value })}
              placeholder={placeholder} className="w-full rounded-xl px-4 py-3.5 text-sm outline-none"
              style={{ background: card, border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }} />
          </div>
        ))}

        <div>
          <label className="text-[10px] font-mono uppercase tracking-widest block mb-1.5" style={{ color: muted }}>Start date &amp; time</label>
          <input type="datetime-local" step={60} value={startValue}
            onChange={(e) => { const [date, startTime] = splitDateTime(e.target.value); onChange({ ...eventData, date, startTime }); }}
            className="w-full rounded-xl px-4 py-3.5 text-sm outline-none"
            style={{ background: card, border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }} />
        </div>

        <div>
          <label className="text-[10px] font-mono uppercase tracking-widest block mb-1.5" style={{ color: muted }}>End date &amp; time</label>
          <input type="datetime-local" step={60} value={endValue} min={startValue || undefined}
            onChange={(e) => { const [endDate, endTime] = splitDateTime(e.target.value); onChange({ ...eventData, endDate, endTime }); }}
            className="w-full rounded-xl px-4 py-3.5 text-sm outline-none"
            style={{ background: card, border: `1px solid ${startValue && endValue && !timesValid ? "rgba(220,38,38,0.4)" : border}`, color: ink, fontFamily: "'Outfit', sans-serif" }} />
          {startValue && endValue && !timesValid && (
            <p className="text-[11px] mt-1.5" style={{ color: "#dc2626" }}>End time must be after the start time.</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Event description</label>
            <span className="text-[10px] font-mono" style={{ color: tooManyWords ? "#dc2626" : dimmed }}>{descriptionWords} / 2000 words</span>
          </div>
          {/* Never truncated: whatever is typed or pasted is kept, and Next stays
              disabled until it is within the limits. */}
          <textarea value={description} onChange={(e) => onChange({ ...eventData, description: e.target.value })}
            placeholder="Tell attendees what the event is about, what to expect, and any important information."
            rows={7} className="w-full rounded-xl px-4 py-3.5 text-sm outline-none resize-none"
            style={{ background: card, border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }} />
          {tooManyWords ? (
            <p className="text-[11px] mt-1.5" style={{ color: "#dc2626" }}>Description must be 2,000 words or fewer.</p>
          ) : tooManyChars ? (
            <p className="text-[11px] mt-1.5" style={{ color: "#dc2626" }}>Description must be 20,000 characters or fewer.</p>
          ) : (
            <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: dimmed }}>The description is limited to 2,000 words.</p>
          )}
        </div>
      </div>
      <button onClick={onNext} disabled={!valid} className="w-full py-4 rounded-2xl font-semibold text-sm text-white mt-6"
        style={{ background: accent, opacity: valid ? 1 : 0.4, cursor: valid ? "pointer" : "not-allowed" }}>Next: Upload Floor Plan</button>
    </div>
  );
}

function CreateStep2({ eventData, onChange, onNext, onBack }: { eventData: Partial<EventData>; onChange: (d: Partial<EventData>) => void; onNext: () => void; onBack: () => void }) {
  const uploaded = eventData.floorPlanUploaded;
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = () => { setError(null); fileRef.current?.click(); };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // Client-side gate; `events.updateFloorMap` re-checks both server-side.
    if (!file.type.startsWith("image/")) { setError("Choose an image file."); return; }
    if (file.size > MAX_MAP_BYTES) { setError("Image must be 5 MB or smaller."); return; }
    setBusy(true);
    setError(null);
    try {
      const previewUrl = URL.createObjectURL(file);
      const { width, height } = await readImageSize(previewUrl);
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!res.ok) throw new Error("Upload failed. Please try again.");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      onChange({ ...eventData, floorPlanUploaded: true, mapStorageId: storageId, mapWidth: width, mapHeight: height, mapPreviewUrl: previewUrl });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8" style={{ background: cream }}>
      <BackBtn onBack={onBack} />
      <div className="mt-4 mb-6">
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Step 2 of 3</p>
        <h2 className="text-xl font-bold mt-1" style={{ color: ink, letterSpacing: "-0.02em" }}>Upload Floor Plan</h2>
        <p className="text-sm mt-1" style={{ color: muted }}>This will be shown as the venue map to all participants.</p>
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onFileChosen(e); }} />
      {!uploaded ? (
        <button onClick={pickFile} disabled={busy}
          className="flex-1 flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed active:scale-[0.98] transition-all"
          style={{ borderColor: "rgba(91,63,248,0.3)", background: "rgba(91,63,248,0.04)" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: "rgba(91,63,248,0.1)" }}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
              <path d="M13 16V8M10 11l3-3 3 3M5 18v2a1 1 0 001 1h14a1 1 0 001-1v-2" stroke={accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="text-center">
            <p className="font-semibold text-sm" style={{ color: accent }}>Tap to upload</p>
            <p className="text-xs mt-1" style={{ color: error ? "#dc2626" : muted }}>{error ?? (busy ? "Uploading…" : "PNG, JPG, PDF supported")}</p>
          </div>
        </button>
      ) : (
        <div className="flex-1 flex flex-col gap-3">
          <div className="flex-1 rounded-3xl overflow-hidden relative" style={{ border: "2px solid rgba(91,63,248,0.3)" }}>
            <img src={eventData.mapPreviewUrl ?? campusMap} alt="Uploaded floor plan" className="w-full h-full object-cover" />
            <div className="absolute top-3 right-3 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5"
              style={{ background: "rgba(22,163,74,0.9)", color: "white" }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Uploaded
            </div>
          </div>
          <button onClick={() => onChange({ ...eventData, floorPlanUploaded: false, mapStorageId: undefined, mapWidth: undefined, mapHeight: undefined, mapPreviewUrl: undefined })} className="text-xs font-mono text-center py-2" style={{ color: muted }}>Replace file</button>
        </div>
      )}
      <button onClick={onNext} disabled={!uploaded} className="w-full py-4 rounded-2xl font-semibold text-sm text-white mt-4"
        style={{ background: accent, opacity: uploaded ? 1 : 0.4, cursor: uploaded ? "pointer" : "not-allowed" }}>Next: Assign Staff</button>
    </div>
  );
}

function CreateStep3({ eventData, onChange, onNext, onBack, busy = false, error = null }: { eventData: Partial<EventData>; onChange: (d: Partial<EventData>) => void; onNext: () => void; onBack: () => void; busy?: boolean; error?: string | null }) {
  const [input, setInput] = useState("");
  const staff = eventData.staff ?? [];
  const add = () => { const v = input.trim(); if (v && !staff.includes(v)) { onChange({ ...eventData, staff: [...staff, v] }); setInput(""); } };
  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8 overflow-y-auto" style={{ background: cream }}>
      <BackBtn onBack={onBack} />
      <div className="mt-4 mb-6">
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Step 3 of 3</p>
        <h2 className="text-xl font-bold mt-1" style={{ color: ink, letterSpacing: "-0.02em" }}>Assign Staff</h2>
        <p className="text-sm mt-1" style={{ color: error ? "#dc2626" : muted }}>{error ?? (busy ? "Creating your event…" : "Add staff emails. They'll receive a private code to join.")}</p>
      </div>
      <div className="flex gap-2 mb-4">
        <input type="email" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="staff@example.com" className="flex-1 rounded-xl px-4 py-3 text-sm outline-none"
          style={{ background: card, border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }} />
        <button onClick={add} className="px-4 py-3 rounded-xl font-semibold text-sm text-white shrink-0" style={{ background: accent }}>Add</button>
      </div>
      <div className="flex flex-col gap-2 flex-1">
        {staff.length === 0 ? (
          <div className="flex-1 flex items-center justify-center"><p className="text-sm" style={{ color: dimmed }}>No staff added yet</p></div>
        ) : staff.map((s) => (
          <div key={s} className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ background: card, border: `1px solid ${border}` }}>
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: "#e8e3f0", color: accent }}>{s[0].toUpperCase()}</div>
              <span className="text-sm font-medium" style={{ color: ink }}>{s}</span>
            </div>
            <button onClick={() => onChange({ ...eventData, staff: staff.filter((x) => x !== s) })} className="text-xs" style={{ color: dimmed }}>✕</button>
          </div>
        ))}
      </div>
      <button onClick={onNext} disabled={busy} className="w-full py-4 rounded-2xl font-semibold text-sm text-white mt-4" style={{ background: accent, opacity: busy ? 0.4 : 1, cursor: busy ? "not-allowed" : "pointer" }}>
        {staff.length === 0 ? "Skip & Generate Codes" : "Generate Codes"}
      </button>
    </div>
  );
}

function CreateDoneScreen({ eventData, onEnterEvent, onHome }: { eventData: EventData; onEnterEvent: () => void; onHome: () => void }) {
  const [tab, setTab] = useState<"attendee" | "staff">("attendee");
  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8 overflow-y-auto" style={{ background: cream }}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Event Created</p>
          <h2 className="text-xl font-bold mt-0.5" style={{ color: ink, letterSpacing: "-0.02em" }}>{eventData.name || "Event Pulse '26"}</h2>
          <p className="text-xs mt-0.5" style={{ color: muted }}>{eventData.venue || "IIT Delhi"}</p>
        </div>
        <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(22,163,74,0.12)" }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 10l4.5 4.5L16 6" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      </div>
      <div className="flex rounded-2xl p-1 mb-5" style={{ background: "rgba(0,0,0,0.06)" }}>
        {(["attendee", "staff"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold capitalize transition-all"
            style={{ background: tab === t ? "white" : "transparent", color: tab === t ? ink : muted, boxShadow: tab === t ? "0 1px 4px rgba(0,0,0,0.1)" : "none" }}>
            {t === "attendee" ? "Attendee QR" : "Staff Code"}
          </button>
        ))}
      </div>
      {tab === "attendee" ? (
        <div className="flex flex-col items-center gap-4 flex-1">
          <div className="p-4 rounded-3xl" style={{ background: "white", border: `1px solid ${border}`, boxShadow: "0 4px 16px rgba(0,0,0,0.06)" }}>
            <QRCodeSVG value={eventData.attendeeCode} />
          </div>
          <div className="text-center">
            <p className="font-mono text-lg font-semibold tracking-widest" style={{ color: ink }}>{eventData.attendeeCode}</p>
            <p className="text-xs mt-1" style={{ color: muted }}>Share this QR or code with attendees</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 flex-1 justify-center">
          <div className="px-8 py-6 rounded-3xl flex flex-col items-center gap-3" style={{ background: "white", border: `1px solid ${border}` }}>
            <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Staff Access Code</p>
            <p className="font-mono text-2xl font-bold tracking-[0.15em]" style={{ color: ink }}>{eventData.staffCode}</p>
            <p className="text-xs text-center" style={{ color: muted }}>Staff scan the attendee QR first, then enter this code</p>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 mt-6">
        <button onClick={onEnterEvent} className="w-full py-4 rounded-2xl font-semibold text-sm text-white" style={{ background: accent }}>Enter Event Dashboard</button>
        <button onClick={onHome} className="w-full py-3 text-sm font-medium" style={{ color: muted }}>Back to Home</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Join / Staff scan screens
// ─────────────────────────────────────────────────────────────────────────────
function ScanScreen({ title, sub, accentColor, onJoin, onBack, extraContent, onDecode, busy = false }: { title: string; sub: string; accentColor: string; onJoin: (code?: string) => void; onBack: () => void; extraContent?: React.ReactNode; onDecode?: (code: string) => void; busy?: boolean }) {
  const [uploaded, setUploaded] = useState(false);
  const [mode, setMode] = useState<"scan" | "upload">("scan");
  const [decoded, setDecoded] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // Evaluated once on mount. Desktop is false forever, so every camera branch
  // below is dead there: no <video>, no getUserMedia, no label change.
  const [phone] = useState(isPhone);
  const cameraOn = phone && !!onDecode;   // join-scan is the only caller now
  const cbRef = useRef({ onDecode, onJoin });
  cbRef.current = { onDecode, onJoin };

  // Live camera, PHONE ONLY. Decodes with the same jsQR call and the same
  // inversionAttempts as the upload path, so both routes read a QR identically.
  useEffect(() => {
    if (!cameraOn || mode !== "scan") return;
    let stream: MediaStream | null = null;
    let raf = 0, done = false;
    const canvas = document.createElement("canvas");
    const stop = () => {
      done = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const tick = () => {
      if (done) return;
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth) { raf = requestAnimationFrame(tick); return; }
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(v, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data;
      if (hit) {
        const normalised = hit.trim().toUpperCase();
        stop();                             // release the camera before navigating
        setDecoded(normalised);
        setDecodeError(null);
        cbRef.current.onDecode?.(normalised);
        cbRef.current.onJoin(normalised);   // the same handleJoin the input uses
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((granted) => {
        if (done) { granted.getTracks().forEach((t) => t.stop()); return; }
        stream = granted;
        const v = videoRef.current;
        if (!v) { stop(); return; }
        v.srcObject = granted;
        return v.play().then(() => { raf = requestAnimationFrame(tick); });
      })
      .catch(() => setCameraError("Camera unavailable — enter the code below."));

    return stop;   // leaving the screen, or switching to the Upload tab
  }, [cameraOn, mode]);

  const onQrChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploaded(true);
    try {
      const code = await decodeQrFromFile(file);
      if (!code) {
        setDecoded(null);
        setDecodeError("No QR code found in that image.");
        return;
      }
      const normalised = code.trim().toUpperCase();
      setDecoded(normalised);
      setDecodeError(null);
      onDecode?.(normalised);
    } catch {
      setDecoded(null);
      setDecodeError("That image could not be read.");
    }
  };

  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8" style={{ background: cream }}>
      <BackBtn onBack={onBack} />
      <div className="mt-4 mb-4">
        <h2 className="text-xl font-bold" style={{ color: ink, letterSpacing: "-0.02em" }}>{title}</h2>
        <p className="text-sm mt-1" style={{ color: muted }}>{sub}</p>
      </div>
      <div className="flex rounded-2xl p-1 mb-4" style={{ background: "rgba(0,0,0,0.06)" }}>
        {[{ id: "scan", label: "Scan QR" }, { id: "upload", label: "Upload QR" }].map((m) => (
          <button key={m.id} onClick={() => { setMode(m.id as typeof mode); setUploaded(false); setDecoded(null); setDecodeError(null); }}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: mode === m.id ? "white" : "transparent", color: mode === m.id ? ink : muted, boxShadow: mode === m.id ? "0 1px 4px rgba(0,0,0,0.1)" : "none" }}>
            {m.label}
          </button>
        ))}
      </div>
      {mode === "scan" ? (
        <div className="flex-1 flex flex-col gap-4">
          <div className="flex-1 rounded-3xl overflow-hidden flex items-center justify-center relative" style={{ background: "#0f0d0b", minHeight: 240 }}>
            {cameraOn && (
              <video ref={videoRef} playsInline muted autoPlay
                className="absolute inset-0 w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <div className="w-44 h-44 relative">
                {[["top-0 left-0", "rounded-tl-xl border-t-2 border-l-2"], ["top-0 right-0", "rounded-tr-xl border-t-2 border-r-2"],
                  ["bottom-0 left-0", "rounded-bl-xl border-b-2 border-l-2"], ["bottom-0 right-0", "rounded-br-xl border-b-2 border-r-2"]
                ].map(([pos, cls], i) => <div key={i} className={`absolute w-7 h-7 ${pos} ${cls}`} style={{ borderColor: accentColor }} />)}
                <div className="absolute left-2 right-2 h-0.5 rounded-full"
                  style={{ background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`, top: "50%", animation: "scanline 2s ease-in-out infinite" }} />
              </div>
            </div>
            <p className="absolute bottom-5 text-xs font-mono text-center px-8" style={{ color: "rgba(255,255,255,0.4)" }}>Point camera at QR code</p>
          </div>
          {cameraError && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: "#dc2626" }} />
              <p className="text-sm font-medium" style={{ color: "#dc2626" }}>{cameraError}</p>
            </div>
          )}
          {extraContent}
          <button onClick={() => onJoin()} disabled={busy} className="w-full py-4 rounded-2xl font-semibold text-sm text-white" style={{ background: accentColor, opacity: busy ? 0.4 : 1, cursor: busy ? "not-allowed" : "pointer" }}>{cameraOn ? "Join Event" : "Simulate Scan (Demo)"}</button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-4">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onQrChosen(e); }} />
          {!uploaded ? (
            <button onClick={() => { if (onDecode) fileRef.current?.click(); else setUploaded(true); }} className="flex-1 flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed" style={{ borderColor: accentColor + "66", background: accentColor + "08", minHeight: 240 }}>
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: accentColor + "18" }}>
                <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                  <rect x="4" y="4" width="8" height="8" rx="2" stroke={accentColor} strokeWidth="1.5" />
                  <rect x="14" y="4" width="8" height="8" rx="2" stroke={accentColor} strokeWidth="1.5" />
                  <rect x="4" y="14" width="8" height="8" rx="2" stroke={accentColor} strokeWidth="1.5" />
                  <path d="M14 14h4M18 14v4M14 18h8" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <p className="font-semibold text-sm" style={{ color: accentColor }}>Choose from Gallery</p>
            </button>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              {(!onDecode || decoded !== null) && (
                <div className="p-4 rounded-3xl" style={{ background: "white", border: `1px solid ${border}` }}><QRCodeSVG value={onDecode ? (decoded ?? "") : MOCK_ATTENDEE_CODE} /></div>
              )}
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ background: decodeError ? "#dc2626" : "#10b981" }} />
                <p className="text-sm font-medium" style={{ color: decodeError ? "#dc2626" : "#15803d" }}>
                  {decodeError ?? (onDecode ? `QR detected: ${decoded}` : "QR detected: Event Pulse '26")}
                </p>
              </div>
            </div>
          )}
          {uploaded && !decodeError && <button onClick={() => onJoin()} disabled={busy} className="w-full py-4 rounded-2xl font-semibold text-sm text-white" style={{ background: accentColor, opacity: busy ? 0.4 : 1, cursor: busy ? "not-allowed" : "pointer" }}>Join Event</button>}
        </div>
      )}
      <style>{`@keyframes scanline { 0%, 100% { top: 10%; } 50% { top: 85%; } }`}</style>
    </div>
  );
}

function StaffCodeScreen({ onJoin, onBack, error = null, busy = false }: { onJoin: (code: string) => void; onBack: () => void; error?: string | null; busy?: boolean }) {
  const [code, setCode] = useState("");
  const verify = () => onJoin(code);
  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8" style={{ background: cream }}>
      <BackBtn onBack={onBack} />
      <div className="mt-4 mb-6">
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: "#10b981" }}>STAFF ACCESS</p>
        <h2 className="text-xl font-bold mt-1" style={{ color: ink, letterSpacing: "-0.02em" }}>Enter Staff Code</h2>
        <p className="text-sm mt-1" style={{ color: muted }}>Enter the private code provided by your organizer</p>
      </div>
      <div className="flex-1 flex flex-col justify-center gap-4">
        <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) verify(); }}
          placeholder={MOCK_STAFF_CODE} className="w-full rounded-2xl px-4 py-4 text-base font-mono font-semibold tracking-widest outline-none text-center"
          style={{ background: error ? "rgba(220,38,38,0.06)" : card, border: `2px solid ${error ? "#dc2626" : code ? "#10b981" : border}`, color: ink, fontFamily: "'JetBrains Mono', monospace", transition: "border-color 0.2s" }} />
        {error && <p className="text-xs text-center" style={{ color: "#dc2626" }}>{error}</p>}
        <p className="text-xs text-center" style={{ color: dimmed }}>Ask the organizer for the staff code</p>
      </div>
      <button onClick={verify} disabled={!code.trim() || busy} className="w-full py-4 rounded-2xl font-semibold text-sm text-white mt-4"
        style={{ background: "#10b981", opacity: code.trim() && !busy ? 1 : 0.4, cursor: code.trim() && !busy ? "pointer" : "not-allowed" }}>Verify & Join</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Map header
// ─────────────────────────────────────────────────────────────────────────────
function MapHeader({ eventName, venue }: { eventName: string; venue: string }) {
  return (
    <>
      <h1 className="text-2xl font-bold text-center mt-0.5" style={{ color: ink, letterSpacing: "-0.02em" }}>{eventName}</h1>
      <p className="text-xs font-medium" style={{ color: "#6b6456" }}>{venue}</p>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed View
// ─────────────────────────────────────────────────────────────────────────────
function FeedView({ reports, onView, trustScores, onResolve, seenIds, showSeen = true, notifications, error = null }: {
  reports: Report[]; onView: (id: string) => void; trustScores: Record<string, number>;
  onResolve?: (id: string) => void; seenIds?: Set<string>; showSeen?: boolean;
  notifications?: AppNotification[]; error?: string | null;
}) {
  const approved = [...reports.filter(isLiveReport)]
    .sort((a, b) => (PRIORITY_ORDER[a.priority ?? "low"] ?? 3) - (PRIORITY_ORDER[b.priority ?? "low"] ?? 3));

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: cream }}>
      <div className="sticky top-0 z-10 px-5 pt-4 pb-3" style={{ background: `linear-gradient(to bottom, ${cream} 80%, transparent)` }}>
        <h2 className="text-xl font-bold text-center" style={{ color: ink, letterSpacing: "-0.02em" }}>Issue Feed</h2>
        <p className="text-xs font-mono mt-0.5 text-center" style={{ color: error ? "#dc2626" : muted }}>{error ?? `${approved.length} verified reports · sorted by priority`}</p>
      </div>
      <div className="px-4 pb-32 flex flex-col gap-3">
        {/* Critical alerts at the top of the attendee feed */}
        {notifications && notifications.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-mono uppercase tracking-widest px-1" style={{ color: "#dc2626" }}>Critical Alerts</p>
            {notifications.map((n) => (
              <div key={n.id} className="rounded-2xl p-4" style={{ background: "rgba(220,38,38,0.07)", border: "1px solid rgba(220,38,38,0.22)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: "#dc2626" }} />
                  <span className="text-[10px] font-mono font-semibold" style={{ color: "#dc2626" }}>CRITICAL ALERT</span>
                  <span className="text-[10px] font-mono ml-auto" style={{ color: dimmed }}>{n.time}</span>
                </div>
                <p className="text-[10px] font-mono mb-1" style={{ color: muted }}>{n.location}</p>
                <p className="text-sm font-semibold mb-2" style={{ color: ink }}>{n.description}</p>
                <div className="rounded-xl p-2.5" style={{ background: "rgba(255,255,255,0.55)", border: "1px solid rgba(220,38,38,0.12)" }}>
                  <p className="text-[10px] font-mono mb-0.5" style={{ color: "#dc2626" }}>Official Statement</p>
                  <p className="text-xs leading-relaxed" style={{ color: "#7f1d1d" }}>{n.statement}</p>
                </div>
              </div>
            ))}
            <div className="h-px mx-1 mb-1" style={{ background: border }} />
          </div>
        )}

        {approved.length === 0 ? (
          <div className="flex items-center justify-center py-16"><p className="text-sm" style={{ color: dimmed }}>No verified reports yet</p></div>
        ) : approved.map((item) => (
          <div key={item.id} className="rounded-2xl p-4"
            style={showSeen && item.priority
              ? { background: PRIORITY_CARD_STYLE[item.priority].bg, border: `1.5px solid ${PRIORITY_CARD_STYLE[item.priority].border}` }
              : { background: card, border: `1px solid ${border}` }}>
            {item.priority && (
              <div className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold mb-2"
                style={{ background: PRIORITY_STYLE[item.priority].bg, color: PRIORITY_STYLE[item.priority].text }}>
                {PRIORITY_STYLE[item.priority].label}
              </div>
            )}
            <div className="flex items-start gap-2 mb-1">
              <span className="text-[11px] font-mono" style={{ color: muted }}>{item.location}</span>
            </div>
            <p className="text-sm font-semibold leading-snug" style={{ color: ink }}>{item.description}</p>

            {/* Official statement for critical reports */}
            {item.priority === "critical" && item.officialStatement && (
              <div className="mt-3 rounded-xl p-3" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.16)" }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                    <path d="M5.5 1L1 10h9L5.5 1z" stroke="#dc2626" strokeWidth="1.2" strokeLinejoin="round" />
                    <path d="M5.5 4.5V6.5" stroke="#dc2626" strokeWidth="1.2" strokeLinecap="round" />
                    <circle cx="5.5" cy="8" r="0.5" fill="#dc2626" />
                  </svg>
                  <span className="text-[9px] font-mono font-semibold" style={{ color: "#dc2626" }}>Official Statement</span>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: "#7f1d1d" }}>{item.officialStatement}</p>
              </div>
            )}

            <div className="flex items-center justify-between mt-3">
              <div className="flex items-center gap-1.5">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <ellipse cx="6.5" cy="6.5" rx="6" ry="4" stroke={dimmed} strokeWidth="1.2" />
                  <circle cx="6.5" cy="6.5" r="1.5" fill={dimmed} />
                </svg>
                <span className="text-xs font-mono" style={{ color: dimmed }}>{item.views} seen</span>
              </div>
              {showSeen && (() => {
                const seen = seenIds?.has(item.id) ?? false;
                return (
                  <button
                    onClick={() => { if (!seen) onView(item.id); }}
                    disabled={seen}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
                    style={{ background: seen ? "rgba(0,0,0,0.05)" : "rgba(91,63,248,0.08)", color: seen ? dimmed : accent, cursor: seen ? "default" : "pointer" }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M1 6C2.5 3 4.5 1.5 6 1.5S9.5 3 11 6c-1.5 3-3.5 4.5-5 4.5S2.5 9 1 6z" stroke={seen ? dimmed : accent} strokeWidth="1.2" />
                      <circle cx="6" cy="6" r="1.5" fill={seen ? dimmed : accent} />
                    </svg>
                    {seen ? "Seen" : "+1"}
                  </button>
                );
              })()}
            </div>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-1.5">
                <p className="text-[10px] font-mono" style={{ color: dimmed }}>{item.author}</p>
                {trustScores[item.author] !== undefined && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full"
                    style={{ background: "rgba(91,63,248,0.08)", color: accent }}>
                    {trustScores[item.author]}
                  </span>
                )}
                <p className="text-[10px] font-mono" style={{ color: dimmed }}>· {item.time}</p>
              </div>
              {onResolve && (
                <button
                  onClick={() => onResolve(item.id)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold active:scale-95 transition-transform"
                  style={{ background: "rgba(22,163,74,0.1)", color: "#15803d" }}
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                    <path d="M1.5 5.5l3 3 5-5" stroke="#15803d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Resolve
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust score
// ─────────────────────────────────────────────────────────────────────────────
function TrustScoreCircle({ score }: { score: number }) {
  const R = 52, stroke = 7, circ = 2 * Math.PI * R, filled = (score / 100) * circ;
  const color = score >= 80 ? "#16a34a" : score >= 50 ? "#d97706" : "#dc2626";
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: 128, height: 128 }}>
        <svg width="128" height="128" viewBox="0 0 128 128" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="64" cy="64" r={R} fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth={stroke} />
          <circle cx="64" cy="64" r={R} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${filled} ${circ}`} style={{ transition: "stroke-dasharray 1s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold" style={{ color: ink, letterSpacing: "-0.03em" }}>{score}</span>
          <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Trust</span>
        </div>
      </div>
      <div className="px-3 py-1 rounded-full text-xs font-semibold" style={{ background: color + "18", color }}>
        {score >= 80 ? "Trusted Member" : score >= 50 ? "Building Trust" : "New Attendee"}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// My Reports Sheet
// ─────────────────────────────────────────────────────────────────────────────
function MyReportsSheet({ reports, userName, onClose }: { reports: Report[]; userName: string; onClose: () => void }) {
  // `isMine` comes from the server (reporterId), so two people sharing a display
  // name never see each other's reports here.
  const mine = reports.filter((r) => r.isMine || r.author === userName);
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.4)", backdropFilter: "blur(5px)" }} onClick={onClose}>
      <div className="w-full flex flex-col rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}`, maxHeight: "75%" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <div>
            <p className="font-bold text-base" style={{ color: ink }}>My Reports</p>
            <p className="text-xs font-mono" style={{ color: muted }}>{mine.length} filed lifetime</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "#edeae4", color: "#6b6456" }}>✕</button>
        </div>
        <div className="overflow-y-auto px-4 pb-8 flex flex-col gap-2">
          {mine.length === 0 ? (
            <div className="py-10 flex items-center justify-center"><p className="text-sm" style={{ color: dimmed }}>No reports filed yet</p></div>
          ) : mine.map((r) => (
            <div key={r.id} className="rounded-2xl p-3.5" style={{ background: card, border: `1px solid ${border}` }}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-[10px] font-mono" style={{ color: muted }}>{r.location}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full shrink-0"
                  style={{ background: r.status === "approved" ? "rgba(22,163,74,0.12)" : r.status === "rejected" ? "rgba(220,38,38,0.12)" : "rgba(217,119,6,0.12)",
                    color: r.status === "approved" ? "#15803d" : r.status === "rejected" ? "#dc2626" : "#b45309" }}>
                  {r.status}
                </span>
              </div>
              <p className="text-sm font-semibold" style={{ color: ink }}>{r.description}</p>
              <p className="text-[10px] font-mono mt-1" style={{ color: dimmed }}>{r.time}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Info (attendee)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The event's details for attendees: date tile, start-end range, venue and
 * About. The description is rendered as plain text (React escapes it; never
 * HTML) with its line breaks kept by `white-space: pre-wrap`.
 */
function EventInfoView({ name, venue, date, endDate, startTime, endTime, description }: EventTimes & {
  name: string; venue: string; description: string | null;
}) {
  const fromDate = new Date(`${date}T00:00`);
  const start = startTime !== null ? new Date(startTime) : (Number.isNaN(fromDate.getTime()) ? null : fromDate);
  const month = start?.toLocaleDateString("en-US", { month: "short" }).toUpperCase() || "TBA";
  const day = start?.getDate() || "—";
  const fullDate = start?.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) || "Date to be announced";
  const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const shortDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  let range: string | null = null;
  if (startTime !== null && endTime !== null) {
    const s = new Date(startTime), f = new Date(endTime);
    range = s.toDateString() === f.toDateString() ? `${time(s)} – ${time(f)}` : `${time(s)} → ${shortDay(f)}, ${time(f)}`;
  } else if (endDate && endDate !== date) {
    const f = new Date(`${endDate}T00:00`);
    if (!Number.isNaN(f.getTime())) range = `Until ${shortDay(f)}`;
  }
  const about = description?.trim() ? description : "The organizer has not added an event description yet.";

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-5 pb-32 lg:pb-8" style={{ background: cream }}>
      <div className="relative overflow-hidden rounded-[28px] p-5 mb-5"
        style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.96) 0%, rgba(250,246,255,0.95) 64%, rgba(236,224,255,0.96) 100%)", border: "1px solid rgba(91,63,248,0.08)", boxShadow: "0 10px 28px rgba(77,57,35,0.1)" }}>
        <div className="absolute -right-14 -top-10 w-40 h-40 rounded-full" style={{ background: "rgba(139,92,246,0.08)" }} />
        <div className="absolute -right-10 top-24 w-48 h-48 rounded-full" style={{ border: "34px solid rgba(139,92,246,0.09)" }} />
        <div className="absolute right-20 top-28 w-10 h-10 rounded-full" style={{ background: "rgba(139,92,246,0.13)" }} />

        <h2 className="relative text-[27px] leading-[1.08] font-bold mb-5 pr-4 break-words" style={{ color: ink, letterSpacing: "-0.04em" }}>
          {name}
        </h2>

        <div className="relative flex items-center gap-3 mb-4">
          <div className="w-[58px] h-[58px] rounded-2xl flex flex-col items-center justify-center shrink-0"
            style={{ background: "linear-gradient(145deg, #eee6ff, #ddd0ff)" }}>
            <span className="text-[10px] font-bold leading-none" style={{ color: accent }}>{month}</span>
            <span className="text-[24px] font-bold leading-none mt-1" style={{ color: ink }}>{day}</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold leading-snug" style={{ color: ink }}>{fullDate}</p>
            {range && <p className="text-sm font-medium mt-1" style={{ color: "#7770aa" }}>{range}</p>}
          </div>
        </div>

        <div className="relative flex items-center gap-3">
          <div className="w-[58px] h-[58px] rounded-2xl flex items-center justify-center shrink-0"
            style={{ background: "linear-gradient(145deg, #eee6ff, #ddd0ff)" }}>
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
              <path d="M15 27s9-8 9-16A9 9 0 006 11c0 8 9 16 9 16z" fill={accent} />
              <circle cx="15" cy="11" r="3.5" fill="#f8f5ff" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold leading-snug break-words" style={{ color: ink }}>{venue.trim() || "Venue to be announced"}</p>
            <p className="text-xs mt-1" style={{ color: "#7770aa" }}>Event venue</p>
          </div>
        </div>
      </div>

      <div>
        <p className="text-[10px] font-mono uppercase tracking-widest mb-2 px-1" style={{ color: muted }}>About this event</p>
        <div className="rounded-3xl p-5" style={{ background: "rgba(255,255,255,0.82)", border: `1px solid ${border}`, boxShadow: "0 5px 18px rgba(77,57,35,0.05)" }}>
          <p className="text-sm leading-[1.7] whitespace-pre-wrap break-words" style={{ color: "#514b42" }}>{about}</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// You-tab menu rows and sheets
// ─────────────────────────────────────────────────────────────────────────────
function ProfileMenuRow({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3.5 py-3.5 text-left active:bg-black/[0.02] transition-colors">
      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(91,63,248,0.08)", color: accent }}>{icon}</span>
      <span className="flex-1 min-w-0 text-sm font-semibold" style={{ color: ink }}>{label}</span>
      <svg className="shrink-0" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M6 4.5L9.5 8 6 11.5" stroke={dimmed} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const MENU_ICON = {
  events: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2.5" y="4" width="13" height="11.5" rx="2.5" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 2.5v3M12.5 2.5v3M2.5 7.5h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  staffManagement: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="7" cy="6" r="3" stroke="currentColor" strokeWidth="1.4" /><path d="M2 16c0-3 2.2-5.5 5-5.5S12 13 12 16M13 6.5h3M14.5 5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  codes: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2.5" y="2.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" /><rect x="10.5" y="2.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" /><rect x="2.5" y="10.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 10.5h2.5v2.5h2.5v2.5h-5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>,
  people: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.4" /><circle cx="13" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" /><path d="M1.5 16c0-3 2-5 4.5-5s4.5 2 4.5 5M10.5 12c2.5-.5 5 1 5.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="7" cy="5" r="1.8" fill="#f7f3ff" stroke="currentColor" strokeWidth="1.3" /><circle cx="12" cy="9" r="1.8" fill="#f7f3ff" stroke="currentColor" strokeWidth="1.3" /><circle cx="6" cy="13" r="1.8" fill="#f7f3ff" stroke="currentColor" strokeWidth="1.3" /></svg>,
  profile: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 14l.8-3.2L12.6 3a1.4 1.4 0 012 2l-7.8 7.8L4 14z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M11.5 4.2l2.3 2.3M3 16h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
};

const fieldStyle = { background: card, border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" };
const fieldLabel = "text-[10px] font-mono uppercase tracking-widest block mb-1.5";

/** The bottom sheet every You-tab dashboard uses (centred card from 640px, like My Reports). */
function SheetFrame({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.42)", backdropFilter: "blur(5px)" }} onClick={onClose}>
      <div role="dialog" aria-label={title} className="w-full flex flex-col rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}`, maxHeight: "78%" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 shrink-0">
          <div className="min-w-0">
            <p className="font-bold text-lg" style={{ color: ink }}>{title}</p>
            <p className="text-xs mt-0.5" style={{ color: muted }}>{subtitle}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: "#edeae4", color: "#6b6456" }}>✕</button>
        </div>
        <div className="overflow-y-auto px-5 pb-8">{children}</div>
      </div>
    </div>
  );
}

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

function MemberAvatar({ name }: { name: string }) {
  return <div className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ background: "#e8e3f0", color: accent }}>{initialsOf(name)}</div>;
}

function SheetEmpty({ text }: { text: string }) {
  return (
    <div className="rounded-2xl py-10 text-center" style={{ background: card, border: `1px solid ${border}` }}>
      <p className="text-sm" style={{ color: muted }}>{text}</p>
    </div>
  );
}

function SheetError({ text }: { text: string | null }) {
  return text ? <p className="text-xs mt-3 text-center" style={{ color: "#dc2626" }}>{text}</p> : null;
}

/** A code in the design's tinted box. */
function CodeBox({ label, code }: { label: string; code: string | null }) {
  return (
    <>
      <p className="text-[10px] font-mono uppercase tracking-widest mb-1.5 text-center" style={{ color: muted }}>{label}</p>
      <div className="w-full rounded-2xl px-4 py-3.5 text-center" style={{ background: "rgba(91,63,248,0.07)", border: "1px solid rgba(91,63,248,0.14)" }}>
        <p className="font-mono text-lg font-bold tracking-[0.12em] break-all" style={{ color: accent }}>{code ?? "…"}</p>
      </div>
    </>
  );
}

/**
 * Organizer: attendee QR + code and the staff code (no staff QR: staff join
 * by typing the code). Staff: the attendee QR + code only.
 */
function AccessCodesSheet({ attendeeCode, staffCode, onClose }: { attendeeCode: string | null; staffCode: string | null; onClose: () => void }) {
  const includeStaff = staffCode !== null;
  const [type, setType] = useState<"attendee" | "staff">("attendee");
  const active = includeStaff ? type : "attendee";
  return (
    <SheetFrame title={includeStaff ? "Event Access Codes" : "Attendee Access"} subtitle="Share the QR code or event code to grant access." onClose={onClose}>
      {includeStaff && (
        <div className="flex rounded-2xl p-1 mb-5" style={{ background: "rgba(0,0,0,0.06)" }}>
          {(["attendee", "staff"] as const).map((t) => (
            <button key={t} onClick={() => setType(t)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold capitalize transition-all"
              style={{ background: type === t ? "white" : "transparent", color: type === t ? ink : muted, boxShadow: type === t ? "0 1px 4px rgba(0,0,0,0.1)" : "none" }}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col items-center">
        {active === "attendee" ? (
          <>
            <div className="p-4 rounded-3xl mb-4" style={{ background: "white", border: `1px solid ${border}`, boxShadow: "0 5px 18px rgba(77,57,35,0.07)" }}>
              {attendeeCode ? <QRCodeSVG value={attendeeCode} /> : <div className="w-[112px] h-[112px]" />}
            </div>
            <CodeBox label="attendee event code" code={attendeeCode} />
          </>
        ) : (
          <>
            <CodeBox label="staff event code" code={staffCode} />
            <p className="text-xs text-center mt-3 leading-relaxed" style={{ color: muted }}>Staff choose Staff on the role screen and enter this code. There is no staff QR code.</p>
          </>
        )}
      </div>
    </SheetFrame>
  );
}

/** Two-tap remove: the first tap asks, the second removes. */
function RemoveButton({ busy, onRemove }: { busy: boolean; onRemove: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button onClick={() => { if (armed) onRemove(); else setArmed(true); }} onBlur={() => setArmed(false)} disabled={busy}
      className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold shrink-0"
      style={armed ? { background: "#dc2626", color: "white" } : { background: "rgba(220,38,38,0.08)", color: "#dc2626" }}>
      {busy ? "Removing…" : armed ? "Confirm" : "Remove"}
    </button>
  );
}

/** Organizer: staff with emails, remove, and how to add more (share the staff code). */
function StaffManagementSheet({ eventId, staffCode, onClose }: { eventId: Id<"events">; staffCode: string | null; onClose: () => void }) {
  const staff = useQuery(api.memberships.listStaff, { eventId });
  const removeStaff = useMutation(api.memberships.removeStaff);
  const [busyId, setBusyId] = useState<Id<"memberships"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (membershipId: Id<"memberships">) => {
    setBusyId(membershipId); setError(null);
    try { await removeStaff({ membershipId }); } catch (err) { setError(errorMessage(err)); } finally { setBusyId(null); }
  };
  return (
    <SheetFrame title="Staff Management" subtitle="Staff members and contact information" onClose={onClose}>
      <div className="rounded-2xl p-4 mb-4" style={{ background: "rgba(91,63,248,0.04)", border: "1.5px dashed rgba(91,63,248,0.3)" }}>
        <p className="text-sm font-semibold" style={{ color: ink }}>Add staff</p>
        <p className="text-xs mt-1 leading-relaxed" style={{ color: muted }}>Share this staff code. They choose Staff on the role screen and enter it.</p>
        <p className="font-mono text-lg font-bold tracking-[0.12em] mt-2 break-all" style={{ color: accent }}>{staffCode ?? "…"}</p>
      </div>
      <div className="flex flex-col gap-2">
        {staff === undefined ? <SheetEmpty text="Loading…" />
          : staff.length === 0 ? <SheetEmpty text="No staff have joined yet." />
          : staff.map((m) => (
            <div key={m.membershipId} className="rounded-2xl p-3.5 flex items-center gap-3" style={{ background: card, border: `1px solid ${border}` }}>
              <MemberAvatar name={m.name} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: ink }}>{m.name}</p>
                {m.email && <p className="text-xs truncate mt-0.5" style={{ color: muted }}>{m.email}</p>}
              </div>
              <RemoveButton busy={busyId === m.membershipId} onRemove={() => { void remove(m.membershipId); }} />
            </div>
          ))}
      </div>
      <SheetError text={error} />
    </SheetFrame>
  );
}

/** Organizer: attendees with emails; remove = banned from rejoining. */
function AttendeeManagementSheet({ eventId, onClose }: { eventId: Id<"events">; onClose: () => void }) {
  const data = useQuery(api.memberships.listAttendees, { eventId });
  const removeAttendee = useMutation(api.memberships.removeAttendee);
  const [busyId, setBusyId] = useState<Id<"memberships"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (membershipId: Id<"memberships">) => {
    setBusyId(membershipId); setError(null);
    try { await removeAttendee({ membershipId }); } catch (err) { setError(errorMessage(err)); } finally { setBusyId(null); }
  };
  const attendees = data?.attendees;
  return (
    <SheetFrame title="Attendee Management" subtitle="Registered attendees and contact information" onClose={onClose}>
      <p className="text-xs mb-3 leading-relaxed" style={{ color: muted }}>A removed attendee leaves the event and can't rejoin with the event code.</p>
      <div className="flex flex-col gap-2">
        {attendees === undefined ? <SheetEmpty text="Loading…" />
          : attendees.length === 0 ? <SheetEmpty text="No attendees have joined yet." />
          : attendees.map((m) => (
            <div key={m.membershipId} className="rounded-2xl p-3.5 flex items-center gap-3" style={{ background: card, border: `1px solid ${border}` }}>
              <MemberAvatar name={m.name} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: ink }}>{m.name}</p>
                {m.email && <p className="text-xs truncate mt-0.5" style={{ color: muted }}>{m.email}</p>}
              </div>
              <RemoveButton busy={busyId === m.membershipId} onRemove={() => { void remove(m.membershipId); }} />
            </div>
          ))}
      </div>
      {data?.capped && <p className="text-[11px] mt-3 text-center" style={{ color: dimmed }}>Showing the first {data.attendees.length} attendees.</p>}
      <SheetError text={error} />
    </SheetFrame>
  );
}

/** Staff: the event's organizers and staff, names only. */
function StaffNamesSheet({ eventId, onClose }: { eventId: Id<"events">; onClose: () => void }) {
  const people = useQuery(api.memberships.listStaffNames, { eventId });
  return (
    <SheetFrame title="Staff List" subtitle={people ? `${people.length} ${people.length === 1 ? "person runs" : "people run"} this event` : "Organizers and staff"} onClose={onClose}>
      <div className="flex flex-col gap-2">
        {people === undefined ? <SheetEmpty text="Loading…" />
          : people.map((m, i) => (
            <div key={`${m.role}-${i}`} className="rounded-2xl p-3.5 flex items-center gap-3" style={{ background: card, border: `1px solid ${border}` }}>
              <MemberAvatar name={m.name} />
              <p className="flex-1 min-w-0 text-sm font-semibold truncate" style={{ color: ink }}>{m.name}</p>
              <span className="text-[10px] font-mono px-2 py-1 rounded-lg shrink-0" style={{ background: "rgba(91,63,248,0.08)", color: accent }}>{m.role === "ORGANIZER" ? "Organizer" : "Staff"}</span>
            </div>
          ))}
      </div>
    </SheetFrame>
  );
}

const MAX_NAME_CHARS = 60;

/** Everyone: change the display name. The email comes from Google and is read-only. */
function EditProfileSheet({ name, email, onClose }: { name: string; email: string | null; onClose: () => void }) {
  const updateName = useMutation(api.users.updateName);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleaned = draft.trim().replace(/\s+/g, " ");
  const tooLong = cleaned.length > MAX_NAME_CHARS;
  const valid = !!cleaned && !tooLong && cleaned !== name;
  const save = async () => {
    setBusy(true); setError(null);
    try { await updateName({ name: draft }); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <SheetFrame title="Edit Profile" subtitle="Update your personal information" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor="profile-name" className={fieldLabel} style={{ color: muted }}>Name</label>
          <input id="profile-name" value={draft} onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && valid && !busy) void save(); }}
            className="w-full rounded-xl px-4 py-3.5 text-sm outline-none" style={{ ...fieldStyle, border: `1px solid ${tooLong ? "rgba(220,38,38,0.4)" : border}` }} />
          {tooLong && <p className="text-[11px] mt-1.5" style={{ color: "#dc2626" }}>Name must be {MAX_NAME_CHARS} characters or fewer.</p>}
        </div>
        <div>
          <label htmlFor="profile-email" className={fieldLabel} style={{ color: muted }}>Email</label>
          <input id="profile-email" type="email" value={email ?? ""} readOnly disabled
            className="w-full rounded-xl px-4 py-3.5 text-sm outline-none" style={{ ...fieldStyle, color: muted, cursor: "not-allowed" }} />
          <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: dimmed }}>Your email comes from your Google account and can't be changed here.</p>
        </div>
        <button onClick={() => { void save(); }} disabled={!valid || busy} className="w-full py-3.5 rounded-2xl font-semibold text-sm text-white"
          style={{ background: accent, opacity: valid && !busy ? 1 : 0.4, cursor: valid && !busy ? "pointer" : "not-allowed" }}>{busy ? "Saving…" : "Save Changes"}</button>
        <SheetError text={error} />
      </div>
    </SheetFrame>
  );
}

/** Epoch ms -> the "YYYY-MM-DDTHH:MM" a datetime-local input shows, in this device's zone. */
function toLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface EditableEvent {
  _id: Id<"events">; name: string; venue: string; startTime: number | null; endTime: number | null;
  description: string | null; mapUrl: string | null;
}

/** Organizer: edit the event's details, times, description and floor plan. */
function EventSettingsSheet({ event, onClose }: { event: EditableEvent; onClose: () => void }) {
  const updateEvent = useMutation(api.events.update);
  const updateFloorMap = useMutation(api.events.updateFloorMap);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const [name, setName] = useState(event.name);
  const [venue, setVenue] = useState(event.venue);
  const [start, setStart] = useState(toLocalInput(event.startTime));
  const [end, setEnd] = useState(toLocalInput(event.endTime));
  const [description, setDescription] = useState(event.description ?? "");
  // A replacement floor plan is held locally and only uploaded on Save, so
  // closing the sheet never leaves an unused file in storage.
  const [newPlan, setNewPlan] = useState<{ file: File; previewUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (newPlan) URL.revokeObjectURL(newPlan.previewUrl); }, [newPlan]);

  const isDateTime = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v);
  const timesValid = isDateTime(start) && isDateTime(end) && end > start;
  const words = description.match(/\S+/g)?.length ?? 0;
  const tooManyWords = words > MAX_DESCRIPTION_WORDS;
  const tooManyChars = description.length > MAX_DESCRIPTION_CHARS;
  const valid = !!name.trim() && !!venue.trim() && timesValid && !tooManyWords && !tooManyChars;

  const pickPlan = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Choose an image file."); return; }
    if (file.size > MAX_MAP_BYTES) { setError("Image must be 5 MB or smaller."); return; }
    setError(null);
    setNewPlan({ file, previewUrl: URL.createObjectURL(file) });
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await updateEvent({
        eventId: event._id, name, venue,
        date: start.slice(0, 10), endDate: end.slice(0, 10),
        startTime: new Date(start).getTime(), endTime: new Date(end).getTime(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        description,
      });
      if (newPlan) {
        const { width, height } = await readImageSize(newPlan.previewUrl);
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": newPlan.file.type }, body: newPlan.file });
        if (!res.ok) throw new Error("The details were saved, but the floor plan upload failed. Please try again.");
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        await updateFloorMap({ eventId: event._id, storageId, width, height });
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const planSrc = newPlan?.previewUrl ?? event.mapUrl;
  return (
    <SheetFrame title="Event Settings" subtitle="Update the active event details" onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        {[{ label: "Event name", value: name, set: setName, id: "settings-name" }, { label: "Venue", value: venue, set: setVenue, id: "settings-venue" }].map((f) => (
          <div key={f.id}>
            <label htmlFor={f.id} className={fieldLabel} style={{ color: muted }}>{f.label}</label>
            <input id={f.id} type="text" value={f.value} onChange={(e) => { f.set(e.target.value); setError(null); }}
              className="w-full rounded-xl px-4 py-3 text-sm outline-none" style={fieldStyle} />
          </div>
        ))}
        <div>
          <label htmlFor="settings-start" className={fieldLabel} style={{ color: muted }}>Start date &amp; time</label>
          <input id="settings-start" type="datetime-local" step={60} value={start} onChange={(e) => { setStart(e.target.value); setError(null); }}
            className="w-full rounded-xl px-4 py-3 text-sm outline-none" style={fieldStyle} />
        </div>
        <div>
          <label htmlFor="settings-end" className={fieldLabel} style={{ color: muted }}>End date &amp; time</label>
          <input id="settings-end" type="datetime-local" step={60} value={end} min={start || undefined} onChange={(e) => { setEnd(e.target.value); setError(null); }}
            className="w-full rounded-xl px-4 py-3 text-sm outline-none" style={{ ...fieldStyle, border: `1px solid ${start && end && !timesValid ? "rgba(220,38,38,0.4)" : border}` }} />
          {start && end && !timesValid && <p className="text-[11px] mt-1.5" style={{ color: "#dc2626" }}>End time must be after the start time.</p>}
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="settings-description" className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Description</label>
            <span className="text-[10px] font-mono" style={{ color: tooManyWords ? "#dc2626" : dimmed }}>{words} / 2000 words</span>
          </div>
          {/* Never truncated, as in the create flow: Save stays disabled until it fits. */}
          <textarea id="settings-description" value={description} onChange={(e) => { setDescription(e.target.value); setError(null); }} rows={5}
            className="w-full rounded-xl px-4 py-3 text-sm outline-none resize-none" style={fieldStyle} />
          {tooManyWords ? <p className="text-[11px] mt-1.5" style={{ color: "#dc2626" }}>Description must be 2,000 words or fewer.</p>
            : tooManyChars ? <p className="text-[11px] mt-1.5" style={{ color: "#dc2626" }}>Description must be 20,000 characters or fewer.</p> : null}
        </div>
        <div>
          <p className={fieldLabel} style={{ color: muted }}>Floor plan</p>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickPlan} />
          <div className="rounded-2xl overflow-hidden" style={{ background: card, border: `1px solid ${border}` }}>
            {planSrc && <img src={planSrc} alt="Current event floor plan" className="w-full h-32 object-cover" />}
            <div className="flex gap-2 p-3">
              <button onClick={() => fileRef.current?.click()} className="flex-1 py-2.5 rounded-xl text-xs font-semibold" style={{ background: "rgba(91,63,248,0.09)", color: accent }}>
                {planSrc ? "Replace image" : "Upload floor plan"}
              </button>
              {newPlan && (
                <button onClick={() => setNewPlan(null)} className="px-4 py-2.5 rounded-xl text-xs font-semibold" style={{ background: "#edeae4", color: ink }}>Undo</button>
              )}
            </div>
          </div>
          {newPlan && <p className="text-[10px] mt-1.5" style={{ color: dimmed }}>The new floor plan is uploaded when you save.</p>}
        </div>
        <button onClick={() => { void save(); }} disabled={!valid || busy} className="w-full py-3.5 rounded-2xl font-semibold text-sm text-white"
          style={{ background: accent, opacity: valid && !busy ? 1 : 0.4, cursor: valid && !busy ? "pointer" : "not-allowed" }}>{busy ? "Saving…" : "Save Event Changes"}</button>
        <SheetError text={error} />
      </div>
    </SheetFrame>
  );
}

/** Organizer: end the event for everyone. Nothing is deleted. */
function EndEventModal({ eventName, busy, error, onConfirm, onCancel }: { eventName: string; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.5)", backdropFilter: "blur(6px)" }} onClick={onCancel}>
      <div role="dialog" aria-label="End this event?" className="w-full p-6 pb-8 rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(127,29,29,0.1)" }}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M4 6h14M8 6V3.5h6V6M7 9v7M11 9v7M15 9v7M6 6l1 13h8l1-13" stroke="#991b1b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="font-bold text-lg" style={{ color: ink }}>End this event?</p>
          <p className="text-sm text-center leading-relaxed" style={{ color: muted }}>
            <span className="font-semibold" style={{ color: ink }}>{eventName}</span> will end for everyone. Attendees and staff can no longer open it, and its codes stop working. Its reports and history are kept, and it stays under Past in Your events.
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={busy} className="flex-1 py-3.5 rounded-2xl font-semibold text-sm" style={{ background: "#edeae4", color: ink }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} className="flex-1 py-3.5 rounded-2xl font-semibold text-sm text-white" style={{ background: "#991b1b", opacity: busy ? 0.6 : 1 }}>{busy ? "Ending…" : "End Event"}</button>
        </div>
        <SheetError text={error} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// You View
// ─────────────────────────────────────────────────────────────────────────────
type YouEvent = EditableEvent & { attendeeCode: string | null; staffCode: string | null };
type YouSheet = "staff-management" | "access" | "attendee-management" | "event-settings" | "staff-list" | "edit-profile";

function YouView({ role, name, email, onLeave, reports, trustScore, eventName, venue, date, joinedAt, reviewedToday, event = null, onOpenEvents, onEndEvent }: {
  role: Role; name: string; email: string | null; onLeave: () => void; reports: Report[]; trustScore: number;
  eventName: string; venue: string; date: string; joinedAt: number | null; reviewedToday: number;
  /** The active event (events.get). Codes are null where the server withholds them. */
  event?: YouEvent | null;
  onOpenEvents?: () => void;
  /** Ends the event; resolves to an error message, or null once it has ended. */
  onEndEvent?: () => Promise<string | null>;
}) {
  const [showMyReports, setShowMyReports] = useState(false);
  const [sheet, setSheet] = useState<YouSheet | null>(null);
  const [showEnd, setShowEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const closeSheet = () => setSheet(null);
  const managementRows = role === "organizer" ? [
    { label: "My Events", icon: MENU_ICON.events, onClick: () => onOpenEvents?.() },
    { label: "Staff Management", icon: MENU_ICON.staffManagement, onClick: () => setSheet("staff-management") },
    { label: "Event Access Codes", icon: MENU_ICON.codes, onClick: () => setSheet("access") },
    { label: "Attendee Management", icon: MENU_ICON.people, onClick: () => setSheet("attendee-management") },
    { label: "Event Settings", icon: MENU_ICON.settings, onClick: () => setSheet("event-settings") },
  ] : role === "staff" ? [
    { label: "Staff List", icon: MENU_ICON.people, onClick: () => setSheet("staff-list") },
    { label: "Attendee Access", icon: MENU_ICON.codes, onClick: () => setSheet("access") },
  ] : [];
  const confirmEnd = async () => {
    if (!onEndEvent) return;
    setEnding(true); setEndError(null);
    const err = await onEndEvent();
    // On success the workspace unmounts (we are taken to Your events).
    if (err) { setEndError(err); setEnding(false); }
  };
  const initials = name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  const myReports = reports.filter((r) => r.isMine);
  const checkIn = joinedAt === null
    ? "—"
    : `Verified · ${new Date(joinedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  // Only what the server does: +5 per approved report, capped at 100, never
  // lowered. Scores start at 60, so the last tier is a fallback.
  const trustMessage = trustScore >= 80
    ? "Moderators have approved several of your reports at this event. Keep them clear and accurate."
    : trustScore >= 50
      ? "Each report a moderator approves adds 5 points to your score."
      : "Clear, accurate reports build your score over time.";

  const attendeeRows = [
    { label: "Event", value: eventName || "—" },
    { label: "Check-in", value: checkIn },
    { label: "Reports Filed (Lifetime)", value: String(myReports.length) },
  ];
  const staffRows = [
    { label: "Event", value: eventName || "—" },
    { label: "Venue", value: venue || "—" },
    { label: "Date", value: date || "—" },
    { label: "Reports Reviewed", value: `${reviewedToday} today` },
    { label: "Check-in", value: checkIn },
  ];
  const rows = role === "attendee" ? attendeeRows : staffRows;

  return (
    <>
      <div className="flex-1 overflow-y-auto" style={{ background: cream }}>
        {/* 8rem clears the floating tab bar (about 83px with its offset) once
            scrolled to the bottom. The tab bar is lifted by the safe-area inset
            on notched phones, so the padding grows by the same inset; it is 0
            elsewhere, so nothing moves on other screens. */}
        <div className="px-4 pt-4" style={{ paddingBottom: "calc(8rem + env(safe-area-inset-bottom))" }}>
          <div className="rounded-3xl p-4 mb-5" style={{ background: "rgba(255,255,255,0.82)", border: `1px solid ${border}`, boxShadow: "0 6px 20px rgba(77,57,35,0.06)" }}>
            <div className="flex items-center gap-4">
              <div className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-xl font-bold shrink-0"
                style={{ background: "linear-gradient(145deg, #eee8ff, #ddd2ff)", color: accent, border: "3px solid white", boxShadow: "0 5px 18px rgba(91,63,248,0.18)" }}>{initials}</div>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-bold leading-tight truncate" style={{ color: ink }}>{name}</p>
                <p className="text-sm font-semibold mt-1 capitalize" style={{ color: accent }}>{role}</p>
                {/* The signed-in account's real email; left out when the account has none. */}
                {email && <p className="text-[13px] mt-1 truncate" style={{ color: muted }}>{email}</p>}
              </div>
            </div>
          </div>

          {role === "attendee" && (
            <div className="rounded-3xl p-5 flex flex-col items-center mb-5" style={{ background: card, border: `1px solid ${border}` }}>
              <p className="text-xs font-mono uppercase tracking-widest mb-4" style={{ color: muted }}>Trust Score</p>
              <TrustScoreCircle score={trustScore} />
              <p className="text-xs text-center mt-4 leading-relaxed max-w-[280px]" style={{ color: muted }}>{trustMessage}</p>
            </div>
          )}

          {managementRows.length > 0 && (
            <>
              <p className="text-[10px] font-mono uppercase tracking-widest mb-2 px-1" style={{ color: muted }}>Event management</p>
              <div className="rounded-3xl overflow-hidden mb-5" style={{ background: "rgba(255,255,255,0.78)", border: `1px solid ${border}` }}>
                {managementRows.map((row, i) => (
                  <div key={row.label}>
                    {i > 0 && <div style={{ height: 1, background: border }} />}
                    <ProfileMenuRow label={row.label} icon={row.icon} onClick={row.onClick} />
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="text-[10px] font-mono uppercase tracking-widest mb-2 px-1" style={{ color: muted }}>Event details</p>
          <div className="rounded-3xl overflow-hidden mb-5" style={{ background: "rgba(255,255,255,0.78)", border: `1px solid ${border}` }}>
            {rows.map(({ label, value }, i) => (
              <div key={label}>
                {i > 0 && <div style={{ height: 1, background: border }} />}
                <div className="px-4 py-3.5 flex justify-between items-center gap-3">
                  <span className="text-xs font-mono shrink-0" style={{ color: muted }}>{label}</span>
                  <span className="text-sm font-semibold text-right min-w-0 truncate" style={{ color: ink }}>{value}</span>
                </div>
              </div>
            ))}
            {role === "attendee" && (
              <>
                <div style={{ height: 1, background: border }} />
                <button onClick={() => setShowMyReports(true)} className="w-full flex items-center gap-3 px-3.5 py-3.5 text-left active:bg-black/[0.02] transition-colors">
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(91,63,248,0.08)", color: accent }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="flex-1 min-w-0 text-sm font-semibold" style={{ color: ink }}>My Reports</span>
                  <svg className="shrink-0" width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M6 4.5L9.5 8 6 11.5" stroke={dimmed} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
          </div>

          <p className="text-[10px] font-mono uppercase tracking-widest mb-2 px-1" style={{ color: muted }}>Account &amp; preferences</p>
          <div className="rounded-3xl overflow-hidden mb-5" style={{ background: "rgba(255,255,255,0.78)", border: `1px solid ${border}` }}>
            <ProfileMenuRow label="Edit Profile" icon={MENU_ICON.profile} onClick={() => setSheet("edit-profile")} />
          </div>

          <button onClick={onLeave}
            className="w-full py-4 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2"
            style={{ background: "rgba(239,68,68,0.08)", color: "#dc2626", border: "1px solid rgba(239,68,68,0.18)" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6" stroke="#dc2626" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Leave Event
          </button>
          {role === "organizer" && onEndEvent && (
            <button onClick={() => { setEndError(null); setShowEnd(true); }}
              className="w-full mt-2.5 py-4 rounded-2xl font-semibold text-sm text-white flex items-center justify-center gap-2"
              style={{ background: "#991b1b", boxShadow: "0 5px 14px rgba(153,27,27,0.2)" }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V2.5h4V4M5 6.5v5M8 6.5v5M11 6.5v5M4 4l.7 10h6.6L12 4" stroke="white" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Delete Event
            </button>
          )}
        </div>
      </div>

      {showMyReports && <MyReportsSheet reports={reports} userName={name} onClose={() => setShowMyReports(false)} />}
      {sheet === "edit-profile" && <EditProfileSheet name={name} email={email} onClose={closeSheet} />}
      {event && sheet === "access" && <AccessCodesSheet attendeeCode={event.attendeeCode} staffCode={role === "organizer" ? event.staffCode : null} onClose={closeSheet} />}
      {event && sheet === "staff-management" && <StaffManagementSheet eventId={event._id} staffCode={event.staffCode} onClose={closeSheet} />}
      {event && sheet === "attendee-management" && <AttendeeManagementSheet eventId={event._id} onClose={closeSheet} />}
      {event && sheet === "event-settings" && <EventSettingsSheet event={event} onClose={closeSheet} />}
      {event && sheet === "staff-list" && <StaffNamesSheet eventId={event._id} onClose={closeSheet} />}
      {showEnd && <EndEventModal eventName={eventName} busy={ending} error={endError} onConfirm={() => { void confirmEnd(); }} onCancel={() => { if (!ending) setShowEnd(false); }} />}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff Reports (moderation + priority)
// ─────────────────────────────────────────────────────────────────────────────
function StaffReportsView({ reports, onApprove, onReject, onBan, onSetPriority, onSetCritical, error = null }: {
  reports: Report[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onBan: (id: string) => void;
  onSetPriority: (id: string, p: Priority) => void;
  onSetCritical: (report: Report) => void;
  error?: string | null;
}) {
  const pending = reports.filter((r) => r.status === "pending");
  const done = reports.filter((r) => r.status !== "pending");

  const Card = ({ r, showActions }: { r: Report; showActions: boolean }) => (
    <div className="rounded-2xl p-4" style={{ background: card, border: `1px solid ${border}` }}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <span className="text-[11px] font-mono block" style={{ color: muted }}>{r.location}</span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ background: "#e8e3f0", color: accent }}>{r.author[0]}</div>
            <span className="text-xs font-medium" style={{ color: muted }}>{r.author}</span>
          </div>
        </div>
        <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full shrink-0"
          style={{ background: r.status === "pending" ? "rgba(217,119,6,0.12)" : r.status === "approved" ? "rgba(22,163,74,0.12)" : "rgba(220,38,38,0.12)",
            color: r.status === "pending" ? "#b45309" : r.status === "approved" ? "#15803d" : "#dc2626" }}>
          {r.status}
        </span>
      </div>
      <p className="text-sm font-semibold" style={{ color: ink }}>{r.description}</p>

      {/* Official statement indicator */}
      {r.officialStatement && (
        <div className="mt-2 rounded-xl px-3 py-2" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.16)" }}>
          <p className="text-[9px] font-mono mb-0.5" style={{ color: "#dc2626" }}>Statement issued</p>
          <p className="text-[11px] leading-relaxed" style={{ color: "#7f1d1d" }}>{r.officialStatement}</p>
        </div>
      )}

      {/* Priority selector */}
      <div className="mt-3 mb-2">
        <p className="text-[9px] font-mono uppercase tracking-widest mb-1.5" style={{ color: dimmed }}>Priority</p>
        <div className="flex gap-1.5 flex-wrap">
          {(["critical", "high", "medium", "low"] as Priority[]).map((p) => (
            <button key={p}
              onClick={() => {
                // Critical implies approval, so it is only offered where
                // pending/approved -> approved is a legal move.
                if (p === "critical" && r.status !== "rejected" && !r.resolved) { onSetCritical(r); }
                else { onSetPriority(r.id, p); }
              }}
              className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
              style={{
                background: r.priority === p ? PRIORITY_STYLE[p].bg : "rgba(0,0,0,0.04)",
                color: r.priority === p ? PRIORITY_STYLE[p].text : dimmed,
                border: `1px solid ${r.priority === p ? PRIORITY_STYLE[p].text + "40" : "transparent"}`,
              }}>
              {PRIORITY_STYLE[p].label}
            </button>
          ))}
        </div>
      </div>

      {showActions && (
        <div className="flex gap-2 mt-3">
          <button onClick={() => onApprove(r.id)} className="flex-1 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
            style={{ background: "rgba(22,163,74,0.1)", color: "#15803d" }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#15803d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Approve
          </button>
          <button onClick={() => onReject(r.id)} className="flex-1 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
            style={{ background: "rgba(220,38,38,0.1)", color: "#dc2626" }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" /></svg>
            Reject
          </button>
          <button onClick={() => onBan(r.id)} className="px-3 py-2 rounded-xl text-xs font-semibold" style={{ background: "rgba(0,0,0,0.06)", color: muted }} title="Ban user">🚫</button>
        </div>
      )}
      <p className="text-[10px] font-mono mt-2" style={{ color: dimmed }}>{r.time}</p>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: cream }}>
      <div className="sticky top-0 z-10 px-5 pt-4 pb-3" style={{ background: `linear-gradient(to bottom, ${cream} 80%, transparent)` }}>
        <h2 className="text-xl font-bold text-center" style={{ color: ink, letterSpacing: "-0.02em" }}>Reports</h2>
        <p className="text-xs font-mono mt-0.5 text-center" style={{ color: error ? "#dc2626" : muted }}>{error ?? `${pending.length} pending · set priority before approving`}</p>
      </div>
      <div className="px-4 pb-32 flex flex-col gap-4">
        {pending.length > 0 && (
          <div>
            <p className="text-[10px] font-mono uppercase tracking-widest mb-2 px-1" style={{ color: muted }}>Pending Review</p>
            <div className="flex flex-col gap-2">{pending.map((r) => <Card key={r.id} r={r} showActions={true} />)}</div>
          </div>
        )}
        {done.length > 0 && (
          <div>
            <p className="text-[10px] font-mono uppercase tracking-widest mb-2 px-1" style={{ color: muted }}>Reviewed</p>
            <div className="flex flex-col gap-2">{done.map((r) => <Card key={r.id} r={r} showActions={false} />)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Modal — description only
// ─────────────────────────────────────────────────────────────────────────────
function ReportModal({ onClose, onSubmit, pin }: { onClose: () => void; onSubmit: (desc: string, loc: string) => Promise<string | null>; pin: Pin | null }) {
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const location = pin ? inferLocation(pin.x, pin.y) : "Pinned Location";

  const submit = async () => {
    if (!description.trim() || busy) return;
    setBusy(true);
    const failed = await onSubmit(description, location);
    setBusy(false);
    if (failed) { setFailure(failed); setSubmitted(true); return; }
    setSubmitted(true);
    setTimeout(onClose, 2000);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full p-6 pb-8 rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        {submitted ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: failure ? "rgba(220,38,38,0.1)" : "#dcfce7" }}>
              {failure ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7L7 17" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" /></svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </div>
            <p className="font-bold text-lg" style={{ color: ink }}>{failure ? "Not Submitted" : "Report Submitted"}</p>
            <p className="text-sm text-center" style={{ color: failure ? "#dc2626" : muted }}>{failure ?? "A staff member will review it shortly."}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <p className="font-bold text-lg" style={{ color: ink }}>Report an Issue</p>
              <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ background: "#edeae4", color: "#6b6456" }}>✕</button>
            </div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue briefly…" rows={5}
              className="w-full rounded-xl px-3 py-3 text-sm outline-none resize-none mb-3"
              style={{ background: "#edeae4", border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }}
              autoFocus />
            <button onClick={() => { void submit(); }} disabled={!description.trim() || busy} className="w-full py-4 rounded-2xl font-semibold text-sm text-white"
              style={{ background: accent, opacity: description.trim() && !busy ? 1 : 0.4, cursor: description.trim() && !busy ? "pointer" : "not-allowed" }}>
              Submit Report
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Leave Confirm
// ─────────────────────────────────────────────────────────────────────────────
function LeaveModal({ onConfirm, onCancel, isOrganizer = false }: { onConfirm: () => void; onCancel: () => void; isOrganizer?: boolean }) {
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onCancel}>
      <div className="w-full p-6 pb-8 rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(239,68,68,0.1)" }}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M8 3H5a1 1 0 00-1 1v14a1 1 0 001 1h3M14 16l4-4-4-4M18 12H8" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="font-bold text-lg" style={{ color: ink }}>Leave Event?</p>
          <p className="text-sm text-center" style={{ color: muted }}>{isOrganizer ? "Your event stays live. You'll return to the home screen." : "You'll return to the home screen and lose your session."}</p>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-3.5 rounded-2xl font-semibold text-sm" style={{ background: "#edeae4", color: ink }}>Stay</button>
          <button onClick={onConfirm} className="flex-1 py-3.5 rounded-2xl font-semibold text-sm text-white" style={{ background: "#dc2626" }}>Leave</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Island Nav
// ─────────────────────────────────────────────────────────────────────────────
function IslandNav<T extends string>({ items, active, onChange }: { items: { id: T; label: string; icon: (a: boolean) => React.ReactNode }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div className="absolute bottom-5 left-1/2 z-30 island-nav" style={{ transform: "translateX(-50%)" }}>
      <div className="flex items-center gap-1 px-3 py-2.5"
        style={{ background: "rgba(26,25,23,0.92)", backdropFilter: "blur(20px)", borderRadius: 999, boxShadow: "0 8px 32px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.08)", minWidth: items.length > 3 ? 300 : 240 }}>
        {items.map(({ id, label, icon }) => (
          <button key={id} onClick={() => onChange(id)}
            className="flex flex-col items-center gap-0.5 flex-1 transition-all active:scale-90 py-1 px-2 rounded-full"
            style={{ background: active === id ? "rgba(91,63,248,0.18)" : "transparent" }}>
            {icon(active === id)}
            <span className="text-[9px] font-mono" style={{ color: active === id ? "#8b74fc" : "#6b6456" }}>{label.toUpperCase()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Laptop-only (>=1024px) counterpart of IslandNav: the same items, icons and
 * dark pill, stacked down the left edge. Never rendered on phone or tablet,
 * where IslandNav stays.
 */
function SideNav<T extends string>({ items, active, onChange }: { items: { id: T; label: string; icon: (a: boolean) => React.ReactNode }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div className="hidden lg:flex lg:flex-col lg:items-center lg:justify-center lg:shrink-0 lg:w-[72px]">
      <div className="flex flex-col items-center gap-1 px-2.5 py-3"
        style={{ background: "rgba(26,25,23,0.92)", backdropFilter: "blur(20px)", borderRadius: 999, boxShadow: "0 8px 32px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.08)" }}>
        {items.map(({ id, label, icon }) => (
          <button key={id} onClick={() => onChange(id)}
            className="flex flex-col items-center gap-0.5 transition-all active:scale-90 py-2 px-2 rounded-full w-12"
            style={{ background: active === id ? "rgba(91,63,248,0.18)" : "transparent" }}>
            {icon(active === id)}
            <span className="text-[9px] font-mono" style={{ color: active === id ? "#8b74fc" : "#6b6456" }}>{label.toUpperCase()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POI Modal
// ─────────────────────────────────────────────────────────────────────────────
const POI_EMOJIS = [
  "🍔","🍕","🌮","🌯","🍜","🍣","🍦","🧁","🥤","☕","🍺","🧃",
  "🎵","🎤","🎸","🥁","🎹","🎺","🎪","🎭","🎟️","🎡","🎠","🎢",
  "🚻","🚑","🏥","🩺","🧯","🔑","🔒","🚪","🪑","🛒","🛍️","📦",
  "🅿️","ℹ️","🚧","⛽","🚿","🧹","🗑️","💡","🔌","📸","🎨","🏆",
  "⛺","🏕️","🌳","🌿","💐","🐾","🎯","🎲","♟️","🧩","🪁","🎳",
];

function POIModal({ onClose, onAdd, pin }: { onClose: () => void; onAdd: (emoji: string, label: string) => void; pin: Pin }) {
  const [emoji, setEmoji] = useState("📍");
  const [label, setLabel] = useState("");
  const submit = () => { if (label.trim()) { onAdd(emoji, label.trim()); } };
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full p-5 pb-8 rounded-t-[28px] sm:rounded-[28px] sm:max-w-[480px]" style={{ background: "#faf8f5", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <p className="font-bold text-lg" style={{ color: ink }}>Add Point of Interest</p>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ background: "#edeae4", color: "#6b6456" }}>✕</button>
        </div>
        <div className="flex items-center gap-3 mb-4 px-3 py-2.5 rounded-xl" style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)" }}>
          <span style={{ fontSize: 28 }}>{emoji}</span>
          <span className="text-sm font-medium" style={{ color: label.trim() ? ink : muted }}>{label.trim() || "No label yet"}</span>
        </div>
        <p className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: muted }}>Choose an emoji</p>
        <div className="grid grid-cols-6 gap-1.5 mb-4 overflow-y-auto" style={{ maxHeight: 200 }}>
          {POI_EMOJIS.map((e) => (
            <button key={e} onClick={() => setEmoji(e)}
              className="w-full aspect-square rounded-xl flex items-center justify-center text-xl transition-all active:scale-90"
              style={{ background: emoji === e ? "rgba(16,185,129,0.15)" : "rgba(0,0,0,0.04)", border: emoji === e ? "1.5px solid rgba(16,185,129,0.5)" : "1.5px solid transparent" }}>
              <span style={{ fontSize: 20 }}>{e}</span>
            </button>
          ))}
        </div>
        <p className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: muted }}>Label</p>
        <input
          value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Food Stall, First Aid…"
          className="w-full rounded-xl px-3 py-3 text-sm outline-none mb-4"
          style={{ background: "#edeae4", border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }}
          autoFocus
        />
        <button onClick={submit} disabled={!label.trim()}
          className="w-full py-4 rounded-2xl font-semibold text-sm text-white"
          style={{ background: "#10b981", opacity: label.trim() ? 1 : 0.4, cursor: label.trim() ? "pointer" : "not-allowed" }}>
          Place POI
        </button>
      </div>
    </div>
  );
}

const mkIcon = (active: boolean, ac: string, children: React.ReactNode) =>
  <svg width="20" height="20" viewBox="0 0 22 22" fill="none" style={{ color: active ? ac : "#a09585" }}>{children}</svg>;

const attendeeNav = [
  { id: "map" as Tab, label: "Map", icon: (a: boolean) => mkIcon(a, accent, <><path d="M9 2L3 5.5v14l6-3.5 8 3.5 6-3.5v-14l-6 3.5-8-3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill={a ? "rgba(91,63,248,0.1)" : "none"} /><path d="M9 2v14.5M17 6v14" stroke="currentColor" strokeWidth="1.5" /></>) },
  { id: "feed" as Tab, label: "Feed", icon: (a: boolean) => mkIcon(a, accent, <><rect x="3" y="5" width="16" height="3" rx="1.5" fill="currentColor" /><rect x="3" y="10.5" width="11" height="2.5" rx="1.25" fill="currentColor" opacity={a ? 0.7 : 1} /><rect x="3" y="16" width="8" height="2.5" rx="1.25" fill="currentColor" opacity={a ? 0.4 : 0.7} /></>) },
  { id: "info" as Tab, label: "Info", icon: (a: boolean) => mkIcon(a, accent, <><circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.5" fill={a ? "rgba(91,63,248,0.1)" : "none"} /><path d="M11 10v5M11 7v.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>) },
  { id: "you" as Tab, label: "You", icon: (a: boolean) => mkIcon(a, accent, <><circle cx="11" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" fill={a ? "rgba(91,63,248,0.1)" : "none"} /><path d="M4 20c0-3.866 3.134-7 7-7s7 3.134 7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>) },
];

const staffNav = [
  { id: "map" as StaffTab, label: "Map", icon: (a: boolean) => mkIcon(a, "#10b981", <><path d="M9 2L3 5.5v14l6-3.5 8 3.5 6-3.5v-14l-6 3.5-8-3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill={a ? "rgba(16,185,129,0.1)" : "none"} /><path d="M9 2v14.5M17 6v14" stroke="currentColor" strokeWidth="1.5" /></>) },
  { id: "poi" as StaffTab, label: "POI", icon: (a: boolean) => mkIcon(a, "#10b981", <><circle cx="11" cy="9" r="4" stroke="currentColor" strokeWidth="1.5" fill={a ? "rgba(16,185,129,0.1)" : "none"} /><path d="M11 13v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M8 19h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>) },
  { id: "reports" as StaffTab, label: "Reports", icon: (a: boolean) => mkIcon(a, "#10b981", <><path d="M11 3L3 18h16L11 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill={a ? "rgba(16,185,129,0.1)" : "none"} /><path d="M11 9v4M11 15.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>) },
  { id: "feed" as StaffTab, label: "Feed", icon: (a: boolean) => mkIcon(a, "#10b981", <><rect x="3" y="5" width="16" height="3" rx="1.5" fill="currentColor" /><rect x="3" y="10.5" width="11" height="2.5" rx="1.25" fill="currentColor" opacity={a ? 0.7 : 1} /><rect x="3" y="16" width="8" height="2.5" rx="1.25" fill="currentColor" opacity={a ? 0.4 : 0.7} /></>) },
  { id: "you" as StaffTab, label: "You", icon: (a: boolean) => mkIcon(a, "#10b981", <><circle cx="11" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" fill={a ? "rgba(16,185,129,0.1)" : "none"} /><path d="M4 20c0-3.866 3.134-7 7-7s7 3.134 7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>) },
];

// ─────────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const { signIn, signOut } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  // "skip" while signed out — an authenticated query fired during sign-out throws
  // Unauthenticated and white-screens the app.
  const viewer = useQuery(api.users.viewer, isAuthenticated ? {} : "skip");
  const userName = viewer?.name ?? viewer?.email ?? "";

  // ── Session restore ────────────────────────────────────────────────────────
  // The active event is DERIVED from the server on every render. It is never
  // parked in useState, so a hard refresh re-reads it instead of coming back
  // undefined and skipping every dependent query.
  const memberships = useQuery(api.memberships.listMine, isAuthenticated ? {} : "skip");
  const membershipsLoading = isAuthenticated && memberships === undefined;
  const activeMembership = memberships?.[0] ?? null;
  const activeEventId = activeMembership?.eventId ?? null;
  const activeEvent = useQuery(api.events.get, activeEventId ? { eventId: activeEventId } : "skip");
  // The event doc carries mapUrl. Until it resolves we do not know WHICH map
  // this event uses, and the bundled fallback is not a safe guess -- rendering
  // it flashed the wrong venue's map over the right one.
  //
  // `undefined` covers BOTH windows: the query still in flight, and the query
  // still skipped because `memberships` has not yet pushed the new membership.
  // That second window is the one you hit on first entry, where handleJoin
  // sets screen="app" before activeEventId exists.
  const eventLoading = activeEvent === undefined;

  const isModerator = activeMembership?.role === "ORGANIZER" || activeMembership?.role === "STAFF";
  const reportRows = useQuery(api.reports.listForEvent, activeEventId ? { eventId: activeEventId } : "skip");
  const staffReportRows = useQuery(api.reports.listForStaff, activeEventId && isModerator ? { eventId: activeEventId } : "skip");
  const poiRows = useQuery(api.mapPins.listForEvent, activeEventId ? { eventId: activeEventId } : "skip");

  const createEventMutation = useMutation(api.events.create);
  const updateFloorMapMutation = useMutation(api.events.updateFloorMap);
  const joinByCodeMutation = useMutation(api.events.joinByCode);
  const leaveMutation = useMutation(api.memberships.leave);
  const openMembershipMutation = useMutation(api.memberships.open);
  const endEventMutation = useMutation(api.events.end);
  const createReportMutation = useMutation(api.reports.create);
  const updateStatusMutation = useMutation(api.reports.updateStatus);
  const setPriorityMutation = useMutation(api.reports.setPriority);
  const setCriticalMutation = useMutation(api.reports.setCritical);
  const markViewedMutation = useMutation(api.reports.markViewed);
  const banReporterMutation = useMutation(api.reports.banReporter);
  const createMapPinMutation = useMutation(api.mapPins.create);
  const removeMapPinMutation = useMutation(api.mapPins.remove);

  const [screen, setScreen] = useState<Screen>("login");
  // Your events: only fetched while that screen is showing.
  const myEvents = useQuery(api.events.listMine, isAuthenticated && screen === "my-events" ? {} : "skip");
  const [openingEventId, setOpeningEventId] = useState<Id<"events"> | null>(null);
  const [myEventsError, setMyEventsError] = useState<string | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  // Set once, when auth and memberships have both settled, so "still loading"
  // is never mistaken for "no membership".
  const [restored, setRestored] = useState(false);
  // Only used before a membership exists (the create/join wizards). Once there
  // is a membership, the role comes from that document.
  const [pendingRole, setPendingRole] = useState<Role>("attendee");
  const role: Role =
    activeMembership?.role === "ORGANIZER" ? "organizer"
    : activeMembership?.role === "STAFF" ? "staff"
    : activeMembership?.role === "ATTENDEE" ? "attendee"
    : pendingRole;
  const [tab, setTab] = useState<Tab>("map");
  const [staffTab, setStaffTab] = useState<StaffTab>("map");
  const [showReport, setShowReport] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [pins, setPins] = useState<Pin[]>([]);
  const [eventData, setEventData] = useState<Partial<EventData>>({ attendeeCode: MOCK_ATTENDEE_CODE, staffCode: MOCK_STAFF_CODE, staff: [] });
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const [poiPin, setPoiPin] = useState<Pin | null>(null);
  const [poiPinning, setPoiPinning] = useState(false);
  const [showPoiModal, setShowPoiModal] = useState(false);

  // Reports, points of interest and trust scores all come from the server.
  const reports: Report[] = useMemo(
    () => (reportRows ?? []).map((r) => ({ ...r, time: timeAgo(r.createdAt, Date.now()) })),
    [reportRows],
  );
  const staffReports: Report[] = useMemo(
    () => (staffReportRows ?? []).map((r) => ({ ...r, time: timeAgo(r.createdAt, Date.now()) })),
    [staffReportRows],
  );
  const pois: POI[] = useMemo(() => poiRows ?? [], [poiRows]);
  const trustScores: Record<string, number> = useMemo(() => {
    const scores: Record<string, number> = {};
    for (const r of [...reports, ...staffReports]) scores[r.author] = r.authorTrustScore;
    return scores;
  }, [reports, staffReports]);

  // Pinpoint mode (attendee and staff maps)
  const [pinpointMode, setPinpointMode] = useState(false);
  const [staffPinpointMode, setStaffPinpointMode] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);

  // Critical statement workflow
  const [criticalStatementFor, setCriticalStatementFor] = useState<Report | null>(null);

  // Notifications are derived from critical reports that carry a statement, so
  // they survive a refresh. Dismissal stays local, as it did in the reference.
  const [dismissedNotifs, setDismissedNotifs] = useState<Set<string>>(new Set());
  const [showNotifs, setShowNotifs] = useState(false);
  const notifications: AppNotification[] = useMemo(
    () => reports
      .filter((r) => isLiveReport(r) && r.priority === "critical" && !!r.officialStatement && !dismissedNotifs.has(r.id))
      .map((r) => ({ id: r.id, reportId: r.id, location: r.location, description: r.description, statement: r.officialStatement ?? "", time: r.time })),
    [reports, dismissedNotifs],
  );

  const [actionError, setActionError] = useState<string | null>(null);

  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Signing out returns to login and drops all in-memory event state.
  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    setRestored(false);
    setScreen("login");
    writeWorkspaceFlag(false);
    setPendingRole("attendee");
    setCreateBusy(false);
    setCreateError(null);
    setJoinCode("");
    setJoinBusy(false);
    setJoinError(null);
    setTab("map");
    setStaffTab("map");
    setShowReport(false);
    setShowLeave(false);
    setPins([]);
    setEventData({ attendeeCode: MOCK_ATTENDEE_CODE, staffCode: MOCK_STAFF_CODE, staff: [] });
    setSeenIds(new Set());
    setPoiPin(null);
    setPoiPinning(false);
    setShowPoiModal(false);
    setPinpointMode(false);
    setStaffPinpointMode(false);
    setSelectedReportId(null);
    setCriticalStatementFor(null);
    setDismissedNotifs(new Set());
    setShowNotifs(false);
    setActionError(null);
  }, [isAuthenticated, isLoading]);

  // Route exactly once, and only after BOTH auth and the membership list have
  // settled. Loading is never treated as "no membership".
  useEffect(() => {
    if (isLoading || !isAuthenticated || membershipsLoading || restored) return;
    setRestored(true);
    // A refresh inside a workspace returns to it; a fresh open (or a new
    // sign-in) shows the role picker. Which event and role is always the DB's.
    if (activeMembership && readWorkspaceFlag()) {
      setScreen(activeMembership.role === "ATTENDEE" ? "app" : "staff-app");
    } else {
      setScreen("home");
    }
  }, [isLoading, isAuthenticated, membershipsLoading, restored, activeMembership]);

  // Keep the per-tab flag in step with the screen (after the first route).
  useEffect(() => {
    if (!restored) return;
    writeWorkspaceFlag(screen === "app" || screen === "staff-app");
  }, [screen, restored]);

  /** Make an event active in the DB, then show its workspace. Errors stay on screen. */
  const openEvent = async (eventId: Id<"events">, target: "app" | "staff-app", onError: (m: string) => void) => {
    setOpeningEventId(eventId);
    try {
      await openMembershipMutation({ eventId });
      setScreen(target);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setOpeningEventId(null);
    }
  };

  /** Attendee / Staff on the role picker: resume the most recent such membership, else join. */
  const resumeOrJoin = (role: "ATTENDEE" | "STAFF") => {
    setHomeError(null);
    const membership = memberships?.find((m) => m.role === role);
    if (!membership) { setScreen(role === "ATTENDEE" ? "join-scan" : "staff-code"); return; }
    void openEvent(membership.eventId, role === "ATTENDEE" ? "app" : "staff-app", setHomeError);
  };

  const approvedReports = reports.filter(isLiveReport);
  const eventName = activeEvent?.name ?? ((eventData.name?.trim()) || "Event Pulse '26");
  // Empty, never a place name: asserting a specific venue we were not given
  // would be confidently wrong. MapHeader's venue line is its last child, so an
  // empty string collapses it to zero height and moves nothing.
  const eventVenue = activeEvent?.venue ?? ((eventData.venue?.trim()) || "");
  const eventDate = activeEvent?.date ?? (eventData.date ?? "");
  const mapUrl = activeEvent?.mapUrl ?? null;
  const reviewedToday = useMemo(() => {
    const midnight = new Date().setHours(0, 0, 0, 0);
    return staffReports.filter((r) => r.reviewedByMe && (r.reviewedAt ?? 0) >= midnight).length;
  }, [staffReports]);
  const myTrustScore = activeMembership?.trustScore ?? trustScores[userName] ?? 60;

  // Pending reports come ONLY from listForStaff, which the server returns to
  // moderators alone; for attendees staffReports is always empty.
  const pendingReviewReports = staffReports.filter(isAwaitingReview);
  const selectedReport = selectedReportId !== null
    ? approvedReports.find((r) => r.id === selectedReportId) ?? pendingReviewReports.find((r) => r.id === selectedReportId) ?? null
    : null;

  /** Run a mutation, showing any server refusal in the existing error slot. */
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const handleCreateEvent = async () => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      // "YYYY-MM-DDTHH:MM" with no offset parses as LOCAL time, which is the
      // zone the organizer typed the times in. The server re-checks both land
      // on `date` in that same zone.
      const date = eventData.date ?? "";
      const endDate = eventData.endDate || date;
      const created = await createEventMutation({
        name: eventData.name ?? "", venue: eventData.venue ?? "", date, endDate,
        startTime: new Date(`${date}T${eventData.startTime ?? ""}`).getTime(),
        endTime: new Date(`${endDate}T${eventData.endTime ?? ""}`).getTime(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        description: eventData.description ?? "",
      });
      if (eventData.mapStorageId) {
        await updateFloorMapMutation({
          eventId: created.eventId,
          storageId: eventData.mapStorageId,
          width: eventData.mapWidth ?? 0,
          height: eventData.mapHeight ?? 0,
        });
      }
      setEventData((d) => ({ ...d, eventId: created.eventId, attendeeCode: created.attendeeCode, staffCode: created.staffCode }));
      setPendingRole("organizer");
      setScreen("create-done");
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const handleJoin = async (code: string) => {
    if (!code.trim()) { setJoinError("Enter a code to join."); return; }
    setJoinBusy(true);
    setJoinError(null);
    try {
      const joined = await joinByCodeMutation({ code });
      setJoinCode("");
        setPendingRole(joined.role === "ATTENDEE" ? "attendee" : joined.role === "STAFF" ? "staff" : "organizer");
      setScreen(joined.role === "ATTENDEE" ? "app" : "staff-app");
    } catch (err) {
      setJoinError(errorMessage(err));
    } finally {
      setJoinBusy(false);
    }
  };

  // Set while this tab itself leaves or ends the active event, so the guard
  // below does not treat that as being removed.
  const expectedExitRef = useRef(false);
  const prevEventIdRef = useRef<Id<"events"> | null>(null);
  const resetWorkspaceUi = () => {
    setPins([]); setTab("map"); setStaffTab("map"); setShowLeave(false); setShowReport(false);
    setPinpointMode(false); setStaffPinpointMode(false); setSelectedReportId(null);
  };
  // The active event is listMine[0]. If the event open in this workspace drops
  // out of that list (the organizer ended it, or this user was removed), the
  // first row silently becomes some OTHER membership -- possibly with another
  // role. Send the user to the role picker with a message instead.
  useEffect(() => {
    const prev = prevEventIdRef.current;
    prevEventIdRef.current = activeEventId;
    if (!restored || memberships === undefined || expectedExitRef.current) return;
    if (screen !== "app" && screen !== "staff-app") return;
    if (prev !== null && prev !== activeEventId && !memberships.some((m) => m.eventId === prev)) {
      resetWorkspaceUi();
      setHomeError("That event is no longer available to you. It has ended, or you were removed from it.");
      setScreen("home");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEventId, memberships, restored, screen]);

  /** Organizer: end the active event for everyone, then show Your events. */
  const handleEndEvent = async (): Promise<string | null> => {
    if (!activeEventId) return "You are not in an event.";
    expectedExitRef.current = true;
    try {
      await endEventMutation({ eventId: activeEventId });
      resetWorkspaceUi();
      setMyEventsError(null);
      setScreen("my-events");
      return null;
    } catch (err) {
      return errorMessage(err);
    } finally {
      expectedExitRef.current = false;
    }
  };

  const handleLeave = async () => {
    // An organizer cannot leave — that would orphan the event, its members and
    // its reports. Leave is the only route out of a workspace in this UI, so for
    // them it navigates Home and keeps the membership intact.
    if (role !== "organizer" && activeEventId) {
      try {
        expectedExitRef.current = true;
        await leaveMutation({ eventId: activeEventId });
      } catch (err) {
        expectedExitRef.current = false;
        // Keep the modal open rather than pretending the leave succeeded.
        console.error("Leaving the event failed:", err);
        return;
      }
    }
    setScreen("home"); setPins([]); setTab("map"); setStaffTab("map"); setShowLeave(false); setShowReport(false); setPinpointMode(false); setStaffPinpointMode(false);
    expectedExitRef.current = false;
    setPendingRole("attendee");
    setEventData({ attendeeCode: MOCK_ATTENDEE_CODE, staffCode: MOCK_STAFF_CODE, staff: [] });
  };

  /** Returns an error message, or null when the report was filed. */
  const handleReport = async (desc: string): Promise<string | null> => {
    if (!activeEventId) return "You are not in an event.";
    const pin = pins[0];
    if (!pin) return "Place a pin on the map first.";
    try {
      // One UUID per submission: a retry re-sends it and the server returns the
      // report it already wrote instead of filing a second one.
      await createReportMutation({
        eventId: activeEventId,
        clientId: crypto.randomUUID(),
        description: desc,
        pinX: pin.x,
        pinY: pin.y,
      });
      setPins([]);
      setPinpointMode(false);
      setStaffPinpointMode(false);
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  };

  const handleApprove = (id: string) => { void run(() => updateStatusMutation({ reportId: id as Id<"reports">, status: "approved" })); };
  const handleReject = (id: string) => { void run(() => updateStatusMutation({ reportId: id as Id<"reports">, status: "rejected" })); };
  const handleResolve = (id: string) => { void run(() => updateStatusMutation({ reportId: id as Id<"reports">, status: "resolved" })); };
  const handleBan = (id: string) => { void run(() => banReporterMutation({ reportId: id as Id<"reports"> })); };
  const handleSetPriority = (id: string, priority: Priority) => { void run(() => setPriorityMutation({ reportId: id as Id<"reports">, priority })); };
  const handleView = (id: string) => {
    setSeenIds((seen) => new Set([...seen, id]));
    void run(() => markViewedMutation({ reportId: id as Id<"reports"> }));
  };

  const handleSetCritical = (report: Report) => {
    setCriticalStatementFor(report);
  };

  const handleCriticalConfirm = (statement: string) => {
    const target = criticalStatementFor;
    if (!target) return;
    setCriticalStatementFor(null);
    void run(() => setCriticalMutation({ reportId: target.id as Id<"reports">, statement }));
  };

  const handleAddPoi = (emoji: string, label: string) => {
    const pin = poiPin;
    if (!activeEventId || !pin) return;
    setShowPoiModal(false);
    setPoiPin(null);
    void run(() => createMapPinMutation({ eventId: activeEventId, emoji, label, x: pin.x, y: pin.y }));
  };

  const renderContent = () => {
    // Loading: show the splash and make NO routing decision.
    if (isLoading) return <SplashScreen />;
    if (isAuthenticated && (membershipsLoading || !restored)) return <SplashScreen />;
    // Same treatment for the event doc, so no map image renders before we know
    // its URL. Scoped to the in-event screens; Home and the create flow do not
    // read the event doc and must not splash while it loads.
    if ((screen === "app" || screen === "staff-app") && eventLoading) return <SplashScreen />;
    switch (screen) {
      case "login":
        return <LoginScreen onLogin={() => signIn("google")} />;

      case "home":
        return <HomeScreen userName={userName} error={homeError}
          onCreateEvent={() => { setHomeError(null); setMyEventsError(null); setScreen("my-events"); }}
          onJoinEvent={() => resumeOrJoin("ATTENDEE")} onJoinAsStaff={() => resumeOrJoin("STAFF")} onLogout={() => { void signOut(); }} />;

      case "my-events":
        return <OrganizerEventsScreen events={myEvents} opening={openingEventId} error={myEventsError}
          onBack={() => setScreen("home")} onCreate={() => setScreen("create-1")}
          onOpen={(id) => { setMyEventsError(null); void openEvent(id, "staff-app", setMyEventsError); }} />;

      case "create-1": return <CreateStep1 eventData={eventData} onChange={setEventData} onNext={() => setScreen("create-2")} onBack={() => setScreen("my-events")} />;
      case "create-2": return <CreateStep2 eventData={eventData} onChange={setEventData} onNext={() => setScreen("create-3")} onBack={() => setScreen("create-1")} />;
      case "create-3": return <CreateStep3 eventData={eventData} onChange={setEventData} onNext={() => { void handleCreateEvent(); }} onBack={() => { setCreateError(null); setScreen("create-2"); }} busy={createBusy} error={createError} />;

      case "create-done":
        return <CreateDoneScreen eventData={eventData as EventData} onEnterEvent={() => { setPendingRole("organizer"); setScreen("staff-app"); }} onHome={() => setScreen("home")} />;

      case "join-scan":
        return (
          <ScanScreen
            title="Join an Event"
            sub="Scan the event QR code from your organizer"
            accentColor={accent}
            busy={joinBusy}
            onDecode={(code) => { setJoinCode(code); setJoinError(null); }}
            onJoin={(code) => { void handleJoin(code ?? joinCode); }}
            onBack={() => { setJoinCode(""); setJoinError(null); setScreen("home"); }}
            extraContent={
              <div className="flex flex-col gap-4">
                <input type="text" value={joinCode} onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setJoinError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && joinCode.trim()) void handleJoin(joinCode); }}
                  placeholder="Or enter the event code" className="w-full rounded-2xl px-4 py-4 text-base font-mono font-semibold tracking-widest outline-none text-center"
                  style={{ background: joinError ? "rgba(220,38,38,0.06)" : card, border: `2px solid ${joinError ? "#dc2626" : joinCode ? accent : border}`, color: ink, fontFamily: "'JetBrains Mono', monospace", transition: "border-color 0.2s" }} />
                {joinError && <p className="text-xs text-center" style={{ color: "#dc2626" }}>{joinError}</p>}
              </div>
            }
          />
        );

      // Staff join is code-only: the organizer never produces a staff QR, so the
      // scan and upload tabs could never succeed. StaffCodeScreen already stands
      // alone, so this routes straight to it rather than gutting ScanScreen --
      // which the attendee flow still needs unchanged.
      case "staff-code":
        return <StaffCodeScreen onJoin={(code) => { void handleJoin(code); }} onBack={() => { setJoinError(null); setScreen("home"); }} error={joinError} busy={joinBusy} />;

      case "app":
        return (
          // Workspace layout. On phone the wrapper and the centre column are
          // the same flex column the workspace always lived in, so nothing
          // moves. From 640px the centre column pads the phone-shaped map;
          // from 1024px a side nav and a live-feed panel flank it. On laptop
          // the centre column takes the map's phone proportions, so it is
          // exactly as wide as the map, and the panel fills the rest of the
          // row up to 720px for readability, sitting right beside the map.
          <div className="flex-1 flex flex-col min-h-0 relative lg:flex-row lg:gap-6 lg:p-6">
            <SideNav items={attendeeNav.filter((i) => i.id !== "feed")} active={tab} onChange={(t) => { setTab(t); if (t !== "map") setPinpointMode(false); }} />
            <div className="flex-1 flex flex-col min-h-0 relative sm:p-6 lg:p-0 lg:flex-none lg:aspect-[390/811.5]">
            {tab === "map" && (
              <>
                <FramedMap
                  mapUrl={mapUrl}
                  pins={pins}
                  onPin={(p) => { if (pinpointMode) setPins([p]); }}
                  approvedReports={approvedReports}
                  allowPin={pinpointMode}
                  pois={pois}
                  pinpointMode={pinpointMode}
                  onPinpointToggle={() => { setPinpointMode((v) => !v); setPins([]); }}
                  onReportPinTap={(id) => { setSelectedReportId(id); }}
                  notifCount={notifications.length}
                  onNotifOpen={() => setShowNotifs(true)}
                  headerContent={<MapHeader eventName={eventName} venue={eventVenue} />}
                  belowMapContent={
                    <div>
                      {/* Pinpoint mode hint */}
                      {pinpointMode && !pins.length && (
                        <div className="absolute left-4 right-4 pointer-events-none"
                          style={{ bottom: 92, background: "rgba(91,63,248,0.9)", backdropFilter: "blur(10px)", borderRadius: 14, padding: "10px 16px" }}>
                          <p className="text-xs text-center font-medium text-white">Tap anywhere on the map to pin your report</p>
                        </div>
                      )}
                      {/* Non-pinpoint hint */}
                      {!pinpointMode && !pins.length && (
                        <div className="absolute left-4 right-4 pointer-events-none"
                          style={{ bottom: 92, background: "rgba(255,255,255,0.88)", backdropFilter: "blur(10px)", borderRadius: 14, padding: "10px 16px", border: `1px solid ${border}` }}>
                          <p className="text-xs text-center font-medium flex items-center justify-center gap-1" style={{ color: "#6b6456" }}>
                          <span>Tap a pin to view · use the</span>
                          <PinpointIcon color="#6b6456" size={13} />
                          <span>button to report</span>
                        </p>
                        </div>
                      )}
                      {pins.length > 0 && (
                        <div className="absolute left-0 right-0 flex justify-center gap-2.5" style={{ bottom: 92 }}>
                          <button onClick={() => { setPins([]); }}
                            className="flex items-center justify-center gap-2 font-semibold text-sm active:scale-[0.98] transition-all"
                            style={{ background: "rgba(255,255,255,0.92)", color: ink, borderRadius: 18, padding: "15px 20px", border: `1px solid ${border}`, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <path d="M2 2l10 10M12 2L2 12" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                            Cancel
                          </button>
                          <button onClick={() => setShowReport(true)}
                            className="flex items-center justify-center gap-2.5 font-semibold text-sm text-white active:scale-[0.98] transition-all"
                            style={{ background: accent, borderRadius: 18, padding: "15px 22px", boxShadow: "0 8px 24px rgba(91,63,248,0.35)" }}>
                            <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
                              <path d="M8.5 2L1.5 14.5h14L8.5 2z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
                              <path d="M8.5 7v3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                              <circle cx="8.5" cy="12.5" r="0.75" fill="white" />
                            </svg>
                            Report an Issue
                          </button>
                        </div>
                      )}
                    </div>
                  }
                />
              </>
            )}
            {tab === "feed" && (
              <div className="flex-1 flex flex-col min-h-0 w-full sm:max-w-[640px] sm:mx-auto">
                <FeedView
                  reports={reports}
                  onView={handleView}
                  trustScores={trustScores}
                  seenIds={seenIds}
                  notifications={notifications}
                  error={actionError}
                />
              </div>
            )}
            {tab === "info" && <div className="flex-1 flex flex-col min-h-0 w-full sm:max-w-[640px] sm:mx-auto lg:rounded-[28px] lg:overflow-hidden lg:shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_40px_80px_rgba(0,0,0,0.25)]"><EventInfoView name={eventName} venue={eventVenue} date={eventDate} endDate={activeEvent?.endDate ?? null} startTime={activeEvent?.startTime ?? null} endTime={activeEvent?.endTime ?? null} description={activeEvent?.description ?? null} /></div>}
            {tab === "you" && <div className="flex-1 flex flex-col min-h-0 w-full sm:max-w-[640px] sm:mx-auto lg:rounded-[28px] lg:overflow-hidden lg:shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_40px_80px_rgba(0,0,0,0.25)]"><YouView role={role} name={userName} email={viewer?.email ?? null} onLeave={() => setShowLeave(true)} reports={reports} trustScore={myTrustScore} eventName={eventName} venue={eventVenue} date={eventDate} joinedAt={activeMembership?.joinedAt ?? null} reviewedToday={reviewedToday} /></div>}
            <div className="contents lg:hidden">
              <IslandNav items={attendeeNav} active={tab} onChange={(t) => { setTab(t); if (t !== "map") setPinpointMode(false); }} />
            </div>
            </div>
            {/* Laptop right panel: the live feed, always visible. */}
            <aside className="hidden lg:flex lg:flex-col lg:flex-1 lg:min-w-0 lg:max-w-[720px] lg:min-h-0 lg:rounded-[28px] lg:overflow-hidden lg:bg-[#f5f1ea] lg:shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_40px_80px_rgba(0,0,0,0.25)]">
              <FeedView
                reports={reports}
                onView={handleView}
                trustScores={trustScores}
                seenIds={seenIds}
                notifications={notifications}
                error={actionError}
              />
            </aside>
            {showReport && <ReportModal onClose={() => { setShowReport(false); setPins([]); setPinpointMode(false); }} onSubmit={(desc) => handleReport(desc)} pin={pins[0] ?? null} />}
            {showLeave && <LeaveModal onConfirm={() => { void handleLeave(); }} onCancel={() => setShowLeave(false)} isOrganizer={role === "organizer"} />}
            {selectedReport && (
              <ReportPinDetailSheet report={selectedReport} onClose={() => setSelectedReportId(null)} />
            )}
            {showNotifs && (
              <NotificationPanel
                notifications={notifications}
                onClose={() => setShowNotifs(false)}
                onDismiss={(id) => setDismissedNotifs((d) => new Set([...d, id]))}
              />
            )}
          </div>
        );

      case "staff-app":
        return (
          // Same shell as the attendee workspace; the laptop panel is the
          // reports queue.
          <div className="flex-1 flex flex-col min-h-0 relative lg:flex-row lg:gap-6 lg:p-6">
            <SideNav items={staffNav.filter((i) => i.id !== "reports")} active={staffTab} onChange={setStaffTab} />
            <div className="flex-1 flex flex-col min-h-0 relative sm:p-6 lg:p-0 lg:flex-none lg:aspect-[390/811.5]">
            {staffTab === "map" && (
              <FramedMap mapUrl={mapUrl} pins={pins} onPin={(p) => { if (staffPinpointMode) setPins([p]); }} approvedReports={approvedReports} pendingReports={pendingReviewReports} allowPin={staffPinpointMode} pois={pois}
                pinpointMode={staffPinpointMode}
                onPinpointToggle={() => { setStaffPinpointMode((v) => !v); setPins([]); }}
                onReportPinTap={(id) => { setSelectedReportId(id); }}
                headerContent={<MapHeader eventName={eventName} venue={eventVenue} />}
                belowMapContent={
                  <div>
                    {staffPinpointMode && !pins.length && (
                      <div className="absolute left-4 right-4 pointer-events-none"
                        style={{ bottom: 100, background: "rgba(16,185,129,0.9)", backdropFilter: "blur(10px)", borderRadius: 14, padding: "8px 12px" }}>
                        <p className="text-xs text-center font-medium text-white">Tap anywhere on the map to pin your report</p>
                      </div>
                    )}
                    {!staffPinpointMode && !pins.length && (
                      <div className="absolute left-4 right-4 pointer-events-none"
                        style={{ bottom: 100, background: "rgba(255,255,255,0.88)", backdropFilter: "blur(10px)", borderRadius: 14, padding: "8px 12px", border: `1px solid ${border}` }}>
                        <p className="text-xs text-center font-medium flex items-center justify-center gap-1" style={{ color: "#6b6456" }}>
                          <span>Tap a pin to view · use the</span>
                          <PinpointIcon color="#6b6456" size={13} />
                          <span>button to report</span>
                        </p>
                      </div>
                    )}
                    {pins.length > 0 && (
                      <div className="absolute left-0 right-0 flex justify-center gap-2.5" style={{ bottom: 100 }}>
                        <button onClick={() => setPins([])}
                          className="flex items-center justify-center gap-2 font-semibold text-xs active:scale-[0.98] transition-all"
                          style={{ background: "rgba(255,255,255,0.92)", color: ink, borderRadius: 14, padding: "12px 16px", border: `1px solid ${border}`, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                            <path d="M2 2l10 10M12 2L2 12" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                          Cancel
                        </button>
                        <button onClick={() => setShowReport(true)}
                          className="flex items-center justify-center gap-2 font-semibold text-xs text-white active:scale-[0.98] transition-all"
                          style={{ background: "#10b981", borderRadius: 14, padding: "12px 16px", boxShadow: "0 6px 20px rgba(16,185,129,0.35)" }}>
                          <svg width="14" height="14" viewBox="0 0 17 17" fill="none">
                            <path d="M8.5 2L1.5 14.5h14L8.5 2z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
                            <path d="M8.5 7v3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                            <circle cx="8.5" cy="12.5" r="0.75" fill="white" />
                          </svg>
                          File Report
                        </button>
                      </div>
                    )}
                  </div>
                }
              />
            )}
            {staffTab === "poi" && (
              <>
                <FramedMap
                  mapUrl={mapUrl}
                  pins={poiPin ? [poiPin] : []}
                  onPin={(p) => { setPoiPin(p); setPoiPinning(false); }}
                  approvedReports={[]} allowPin={poiPinning} pois={pois}
                  headerContent={<MapHeader eventName={eventName} venue={eventVenue} />}
                  belowMapContent={
                    <div>
                      {!poiPinning && !poiPin && (
                        <div className="absolute left-3 right-3 z-30" style={{ bottom: 88 }}>
                          <div className="rounded-2xl overflow-hidden shadow-lg" style={{ background: "rgba(250,248,245,0.97)", border: `1px solid ${border}`, backdropFilter: "blur(12px)" }}>
                            <div className="flex items-center justify-between px-4 pt-3 pb-1">
                              <p className="font-bold text-sm" style={{ color: ink }}>Points of Interest <span className="font-normal text-xs ml-1" style={{ color: muted }}>({pois.length})</span></p>
                              <button onClick={() => setPoiPinning(true)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold text-xs text-white active:scale-95 transition-all"
                                style={{ background: "#10b981", boxShadow: "0 3px 10px rgba(16,185,129,0.35)" }}>
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="white" strokeWidth="1.6" strokeLinecap="round" /></svg>
                                Add POI
                              </button>
                            </div>
                            {pois.length === 0 ? (
                              <p className="text-xs text-center py-3 px-4" style={{ color: dimmed }}>Tap "Add POI" then tap the map to place one.</p>
                            ) : (
                              <div className="flex flex-col gap-1.5 px-3 pb-3 max-h-36 overflow-y-auto">
                                {pois.map((poi) => (
                                  <div key={poi.id} className="flex items-center gap-2.5 px-3 py-2 rounded-xl" style={{ background: card, border: `1px solid ${border}` }}>
                                    <span style={{ fontSize: 20 }}>{poi.emoji}</span>
                                    <span className="flex-1 text-xs font-medium truncate" style={{ color: ink }}>{poi.label}</span>
                                    <button onClick={() => { void run(() => removeMapPinMutation({ pinId: poi.id as Id<"mapPins"> })); }}
                                      className="w-6 h-6 rounded-full flex items-center justify-center text-xs active:scale-90 shrink-0"
                                      style={{ background: "rgba(220,38,38,0.08)", color: "#dc2626" }}>✕</button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {poiPinning && !poiPin && (
                        <div className="absolute left-3 right-3 z-30 pointer-events-none" style={{ bottom: 88 }}>
                          <div className="rounded-2xl px-4 py-3 shadow-lg flex items-center justify-between" style={{ background: "rgba(250,248,245,0.97)", border: `1px solid ${border}`, backdropFilter: "blur(12px)" }}>
                            <p className="text-xs font-medium" style={{ color: "#6b6456" }}>Tap anywhere on the map to place your POI</p>
                            <button onClick={() => setPoiPinning(false)} className="pointer-events-auto ml-3 shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs" style={{ background: "rgba(0,0,0,0.08)", color: ink }}>✕</button>
                          </div>
                        </div>
                      )}
                      {poiPin && (
                        <div className="absolute left-3 right-3 z-30" style={{ bottom: 88 }}>
                          <div className="rounded-2xl px-4 py-3 shadow-lg" style={{ background: "rgba(250,248,245,0.97)", border: `1px solid ${border}`, backdropFilter: "blur(12px)" }}>
                            <p className="text-xs font-medium text-center mb-3" style={{ color: "#6b6456" }}>Pin placed — add details or tap again to reposition</p>
                            <div className="flex gap-2.5">
                              <button onClick={() => { setPoiPin(null); setPoiPinning(false); }}
                                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm active:scale-[0.98] transition-all"
                                style={{ background: "rgba(0,0,0,0.06)", color: ink, border: `1px solid ${border}` }}>
                                <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke={ink} strokeWidth="1.6" strokeLinecap="round" /></svg>
                                Cancel
                              </button>
                              <button onClick={() => setShowPoiModal(true)}
                                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm text-white active:scale-[0.98] transition-all"
                                style={{ background: "#10b981", boxShadow: "0 4px 14px rgba(16,185,129,0.35)" }}>
                                Add Details
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  }
                />
                {showPoiModal && poiPin && (
                  <POIModal
                    pin={poiPin}
                    onClose={() => { setShowPoiModal(false); setPoiPin(null); }}
                    onAdd={handleAddPoi}
                  />
                )}
              </>
            )}
            {staffTab === "reports" && (
              <div className="flex-1 flex flex-col min-h-0 w-full sm:max-w-[640px] sm:mx-auto">
                <StaffReportsView
                  reports={staffReports}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onBan={handleBan}
                  onSetPriority={handleSetPriority}
                  onSetCritical={handleSetCritical}
                  error={actionError}
                />
              </div>
            )}
            {staffTab === "feed" && (
              <div className="flex-1 flex flex-col min-h-0 w-full sm:max-w-[640px] sm:mx-auto">
                <FeedView
                  reports={reports}
                  onView={handleView}
                  trustScores={trustScores}
                  onResolve={handleResolve}
                  showSeen={false}
                  error={actionError}
                />
              </div>
            )}
            {staffTab === "you" && <div className="flex-1 flex flex-col min-h-0 w-full sm:max-w-[640px] sm:mx-auto lg:rounded-[28px] lg:overflow-hidden lg:shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_40px_80px_rgba(0,0,0,0.25)]"><YouView role={role} name={userName} email={viewer?.email ?? null} onLeave={() => setShowLeave(true)} reports={reports} trustScore={myTrustScore} eventName={eventName} venue={eventVenue} date={eventDate} joinedAt={activeMembership?.joinedAt ?? null} reviewedToday={reviewedToday}
              event={activeEvent ?? null} onOpenEvents={() => { resetWorkspaceUi(); setMyEventsError(null); setScreen("my-events"); }} onEndEvent={handleEndEvent} /></div>}
            <div className="contents lg:hidden">
              <IslandNav items={staffNav} active={staffTab} onChange={setStaffTab} />
            </div>
            </div>
            {/* Laptop right panel: the reports queue, always visible. */}
            <aside className="hidden lg:flex lg:flex-col lg:flex-1 lg:min-w-0 lg:max-w-[720px] lg:min-h-0 lg:rounded-[28px] lg:overflow-hidden lg:bg-[#f5f1ea] lg:shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_40px_80px_rgba(0,0,0,0.25)]">
              <StaffReportsView
                reports={staffReports}
                onApprove={handleApprove}
                onReject={handleReject}
                onBan={handleBan}
                onSetPriority={handleSetPriority}
                onSetCritical={handleSetCritical}
                error={actionError}
              />
            </aside>
            {showReport && <ReportModal onClose={() => { setShowReport(false); setPins([]); }} onSubmit={(desc) => handleReport(desc)} pin={pins[0] ?? null} />}
            {showLeave && <LeaveModal onConfirm={() => { void handleLeave(); }} onCancel={() => setShowLeave(false)} isOrganizer={role === "organizer"} />}
            {selectedReport && (
              <ReportPinDetailSheet report={selectedReport} onClose={() => setSelectedReportId(null)}
                moderation={{ onApprove: handleApprove, onReject: handleReject, onSetPriority: handleSetPriority, onSetCritical: handleSetCritical }} />
            )}
          </div>
        );
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center" style={{ background: bg }}>
      {/* app-frame: sized by index.css -- the full screen on phone, the full
          window from 640px. Always the `cream` token behind simple screens,
          which sit straight on it. The two workspaces switch to the `bg`
          token from 640px so their map and panel cards stand out. */}
      <div className={`relative flex flex-col overflow-hidden app-frame ${screen === "app" || screen === "staff-app" ? "bg-[#f5f1ea] sm:bg-[#e8e4dc]" : "bg-[#f5f1ea]"}`}>
        {/* Critical statement modal — rendered at root so it's never clipped */}
        {criticalStatementFor && (
          <CriticalStatementModal
            report={criticalStatementFor}
            onClose={() => setCriticalStatementFor(null)}
            onConfirm={handleCriticalConfirm}
          />
        )}
        {/* App name. Replaces the mock clock/signal/wifi/battery row: on a real
            phone that duplicated the device status bar. Same box as before --
            px-6, pb-1, and an 11px line that was already the tallest item in
            the row -- so nothing below shifts on either platform. paddingTop
            adds the notch inset; env() is 0 where there is none, so desktop is
            unchanged, and if env() were unsupported the calc drops and pt-3
            still applies. */}
        <div className="flex items-center justify-between px-6 pt-3 pb-1 z-20 relative shrink-0"
          style={{ color: "#6b6456", paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}>
          {/* The row stays on every screen for the notch inset; only the
              label is hidden on the login screen, whose own title names the app. */}
          {screen !== "login" && <span className="text-[11px] font-mono font-medium">EventPulse</span>}
        </div>
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 relative">
          {screen === "app" || screen === "staff-app" ? renderContent() : (
            // Simple screens. On phone these two wrappers are transparent:
            // the same flex column the screen always had. From 640px they
            // centre the screen's content on the cream window in a column
            // 560px wide (440px from 1024px) and up to 812px tall -- the phone
            // frame's content height -- so every screen keeps its internal
            // layout. No card: no radius, shadow or surround.
            <div className="flex-1 flex flex-col min-h-0 sm:items-center sm:justify-center sm:p-6">
              <div className="flex-1 flex flex-col min-h-0 w-full sm:flex-none sm:h-[812px] sm:max-h-full sm:max-w-[560px] lg:max-w-[440px]">
                {renderContent()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
