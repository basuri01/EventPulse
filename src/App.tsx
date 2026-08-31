import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import jsQR from "jsqr";
import qrcodeGenerator from "qrcode-generator";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import campusMap from "@/imports/image-7.png";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type Screen = "login" | "home" | "create-1" | "create-2" | "create-3" | "create-done" | "join-scan" | "staff-scan" | "staff-code" | "app" | "staff-app";
type Role = "organizer" | "attendee" | "staff";
type Tab = "map" | "feed" | "you";
type StaffTab = "map" | "poi" | "reports" | "feed" | "you";
type Priority = "critical" | "high" | "medium" | "low";

interface POI { id: string; x: number; y: number; emoji: string; label: string; }

interface EventData {
  name: string; venue: string; date: string;
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

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_STYLE: Record<Priority, { bg: string; text: string; label: string }> = {
  critical: { bg: "rgba(220,38,38,0.12)", text: "#dc2626", label: "🔴 Critical" },
  high:     { bg: "rgba(234,88,12,0.12)", text: "#ea580c", label: "🟠 High" },
  medium:   { bg: "rgba(217,119,6,0.12)", text: "#d97706", label: "🟡 Medium" },
  low:      { bg: "rgba(22,163,74,0.12)", text: "#16a34a", label: "🟢 Low" },
};

const cream = "#f5f1ea", bg = "#e8e4dc", ink = "#1a1917", muted = "#8a7f6e";
const dimmed = "#a09585", accent = "#5b3ff8", border = "rgba(0,0,0,0.08)";
const card = "rgba(255,255,255,0.75)";

function inferLocation(x: number, y: number): string {
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
function ReportPinDetailSheet({ report, onClose }: { report: Report; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-end" style={{ background: "rgba(26,25,23,0.4)", backdropFilter: "blur(5px)" }} onClick={onClose}>
      <div className="w-full p-5 pb-8" style={{ background: "#faf8f5", borderRadius: "28px 28px 0 0", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {report.priority && (
              <div className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                style={{ background: PRIORITY_STYLE[report.priority].bg, color: PRIORITY_STYLE[report.priority].text }}>
                {PRIORITY_STYLE[report.priority].label}
              </div>
            )}
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: "rgba(22,163,74,0.12)", color: "#15803d" }}>Verified</span>
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
    <div className="absolute inset-0 z-50 flex items-end" style={{ background: "rgba(26,25,23,0.5)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full p-5 pb-8" style={{ background: "#faf8f5", borderRadius: "28px 28px 0 0", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
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
    <div className="absolute inset-0 z-50 flex flex-col" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="flex-1" />
      <div className="w-full flex flex-col" style={{ background: "#faf8f5", borderRadius: "28px 28px 0 0", border: `1px solid ${border}`, maxHeight: "70%" }} onClick={(e) => e.stopPropagation()}>
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
  pins, onPin, approvedReports, headerContent, belowMapContent, allowPin, pois = [],
  onReportPinTap, pinpointMode, notifCount = 0, onNotifOpen, onPinpointToggle, mapUrl = null,
}: {
  mapUrl?: string | null;
  pins: Pin[];
  onPin?: (p: Pin) => void;
  approvedReports: Report[];
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
          <img src={mapUrl ?? campusMap} alt="IIT Delhi campus map" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} draggable={false} />

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
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="7.5" r="3" stroke={pinpointMode ? "white" : accent} strokeWidth="1.5" />
            <path d="M9 10.5v6" stroke={pinpointMode ? "white" : accent} strokeWidth="1.5" strokeLinecap="round" />
            <path d="M6.5 16.5h5" stroke={pinpointMode ? "white" : accent} strokeWidth="1.5" strokeLinecap="round" />
          </svg>
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

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-between px-6 py-10" style={{ background: cream }}>
      <div />
      <div className="flex flex-col items-center gap-6 w-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ background: `linear-gradient(135deg, ${accent} 0%, #8b74fc 100%)`, boxShadow: "0 8px 24px rgba(91,63,248,0.3)" }}>
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
              <circle cx="15" cy="15" r="10" stroke="white" strokeWidth="2" />
              <path d="M15 8v7l4 4" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold" style={{ color: ink, letterSpacing: "-0.02em" }}>Event Pulse</h1>
            <p className="text-sm mt-1" style={{ color: muted }}>Smart event incident management</p>
          </div>
        </div>
        <div className="w-full flex flex-col gap-3 mt-4">
          <button onClick={onLogin}
            className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl font-semibold text-sm"
            style={{ background: "white", border: `1px solid ${border}`, color: ink, boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>
            <GmailIcon />Continue with Google
          </button>
        </div>
        <p className="text-[11px] text-center" style={{ color: dimmed }}>By continuing you agree to our Terms &amp; Privacy Policy</p>
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: dimmed }}>Powered by</p>
        <p className="text-xs font-semibold" style={{ color: muted }}>Event Pulse · 2026</p>
      </div>
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
function HomeScreen({ userName, onCreateEvent, onJoinEvent, onJoinAsStaff, onLogout }: { userName: string; onCreateEvent: () => void; onJoinEvent: () => void; onJoinAsStaff: () => void; onLogout: () => void }) {
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
    { label: "Create an Event", sub: "Organizer · Upload floor plan, manage staff", color: accent, action: onCreateEvent,
      icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="4" y="6" width="20" height="16" rx="3" stroke="white" strokeWidth="1.5" /><path d="M14 10v8M10 14h8" stroke="white" strokeWidth="1.5" strokeLinecap="round" /></svg> },
    { label: "Join an Event", sub: "Attendee · Scan QR to enter", color: "#0ea5e9", action: onJoinEvent,
      icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="4" y="4" width="8" height="8" rx="2" stroke="white" strokeWidth="1.5" /><rect x="16" y="4" width="8" height="8" rx="2" stroke="white" strokeWidth="1.5" /><rect x="4" y="16" width="8" height="8" rx="2" stroke="white" strokeWidth="1.5" /><path d="M16 16h4M20 16v4M16 20h8" stroke="white" strokeWidth="1.5" strokeLinecap="round" /></svg> },
    { label: "Join as Staff", sub: "Staff · Scan QR + enter staff code", color: "#10b981", action: onJoinAsStaff,
      icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="10" r="4" stroke="white" strokeWidth="1.5" /><path d="M6 24c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="white" strokeWidth="1.5" strokeLinecap="round" /><circle cx="22" cy="20" r="4" fill="white" fillOpacity="0.2" stroke="white" strokeWidth="1.5" /><path d="M20.5 20l1 1 2-2" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  ];
  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-10" style={{ background: cream }}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Welcome back</p>
          <h1 className="text-xl font-bold mt-0.5" style={{ color: ink, letterSpacing: "-0.02em" }}>{userName.split(" ")[0]}</h1>
        </div>
        <div className="relative" ref={menuRef}>
          <button onClick={() => setShowMenu((v) => !v)}
            className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm"
            style={{ background: "#e8e3f0", color: accent }}>{initials}</button>
          {showMenu && (
              <div className="absolute right-0 top-12 z-50 rounded-2xl overflow-hidden shadow-xl"
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
      <h2 className="text-base font-semibold mb-4 text-center" style={{ color: ink }}>What would you like to do?</h2>
      <div className="flex flex-col gap-3">
        {options.map((opt) => (
          <button key={opt.label} onClick={opt.action}
            className="flex items-center gap-4 p-4 rounded-2xl text-left active:scale-[0.98] transition-all"
            style={{ background: card, border: `1px solid ${border}`, boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
              style={{ background: `linear-gradient(135deg, ${opt.color} 0%, ${opt.color}bb 100%)` }}>{opt.icon}</div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-base" style={{ color: ink }}>{opt.label}</p>
              <p className="text-xs mt-0.5" style={{ color: muted }}>{opt.sub}</p>
            </div>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M7 5l4 4-4 4" stroke={dimmed} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Event steps
// ─────────────────────────────────────────────────────────────────────────────
function CreateStep1({ eventData, onChange, onNext, onBack }: { eventData: Partial<EventData>; onChange: (d: Partial<EventData>) => void; onNext: () => void; onBack: () => void }) {
  const valid = !!(eventData.name?.trim() && eventData.venue?.trim() && eventData.date);
  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-8 overflow-y-auto" style={{ background: cream }}>
      <BackBtn onBack={onBack} />
      <div className="mt-4 mb-6">
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: muted }}>Step 1 of 3</p>
        <h2 className="text-xl font-bold mt-1" style={{ color: ink, letterSpacing: "-0.02em" }}>Event Details</h2>
      </div>
      <div className="flex flex-col gap-4 flex-1">
        {[{ label: "Event Name", key: "name", placeholder: "Event Pulse '26", type: "text" },
          { label: "Venue", key: "venue", placeholder: "IIT Delhi, New Delhi", type: "text" },
          { label: "Date", key: "date", placeholder: "", type: "date" }].map(({ label, key, placeholder, type }) => (
          <div key={key}>
            <label className="text-[10px] font-mono uppercase tracking-widest block mb-1.5" style={{ color: muted }}>{label}</label>
            <input type={type} value={(eventData as Record<string, string>)[key] ?? ""} onChange={(e) => onChange({ ...eventData, [key]: e.target.value })}
              placeholder={placeholder} className="w-full rounded-xl px-4 py-3.5 text-sm outline-none"
              style={{ background: card, border: `1px solid ${border}`, color: ink, fontFamily: "'Outfit', sans-serif" }} />
          </div>
        ))}
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
function ScanScreen({ title, sub, accentColor, onJoin, onBack, extraContent, onDecode, busy = false }: { title: string; sub: string; accentColor: string; onJoin: () => void; onBack: () => void; extraContent?: React.ReactNode; onDecode?: (code: string) => void; busy?: boolean }) {
  const [uploaded, setUploaded] = useState(false);
  const [mode, setMode] = useState<"scan" | "upload">("scan");
  const [decoded, setDecoded] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
          {extraContent}
          <button onClick={onJoin} disabled={busy} className="w-full py-4 rounded-2xl font-semibold text-sm text-white" style={{ background: accentColor, opacity: busy ? 0.4 : 1, cursor: busy ? "not-allowed" : "pointer" }}>Simulate Scan (Demo)</button>
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
          {uploaded && !decodeError && <button onClick={onJoin} disabled={busy} className="w-full py-4 rounded-2xl font-semibold text-sm text-white" style={{ background: accentColor, opacity: busy ? 0.4 : 1, cursor: busy ? "not-allowed" : "pointer" }}>Join Event</button>}
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
        <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: "#10b981" }}>QR Verified ✓</p>
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
      <p className="text-xs font-medium" style={{ color: "#6b6456" }}>{venue} · Campus Event</p>
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
  const approved = [...reports.filter((r) => r.status === "approved" && !r.banned && !r.resolved)]
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
          <div key={item.id} className="rounded-2xl p-4" style={{ background: card, border: `1px solid ${border}` }}>
            {item.priority && (
              <div className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold mb-2"
                style={{ background: PRIORITY_STYLE[item.priority].bg, color: PRIORITY_STYLE[item.priority].text }}>
                {PRIORITY_STYLE[item.priority].label}
              </div>
            )}
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-[11px] font-mono" style={{ color: muted }}>{item.location}</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full shrink-0" style={{ background: "rgba(22,163,74,0.12)", color: "#15803d" }}>Verified</span>
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
    <div className="absolute inset-0 z-50 flex items-end" style={{ background: "rgba(26,25,23,0.4)", backdropFilter: "blur(5px)" }} onClick={onClose}>
      <div className="w-full flex flex-col" style={{ background: "#faf8f5", borderRadius: "28px 28px 0 0", border: `1px solid ${border}`, maxHeight: "75%" }} onClick={(e) => e.stopPropagation()}>
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
// You View
// ─────────────────────────────────────────────────────────────────────────────
function YouView({ role, name, onLeave, reports, trustScore, eventName, joinedAt, reviewedToday }: {
  role: Role; name: string; onLeave: () => void; reports: Report[]; trustScore: number;
  eventName: string; joinedAt: number | null; reviewedToday: number;
}) {
  const [showMyReports, setShowMyReports] = useState(false);
  const initials = name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  const myReports = reports.filter((r) => r.isMine);
  const checkIn = joinedAt === null
    ? "—"
    : `Verified · ${new Date(joinedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

  const attendeeRows = [
    { label: "Check-in", value: checkIn },
    { label: "Reports Filed (Lifetime)", value: String(myReports.length) },
  ];
  const staffRows = [
    { label: "Zone", value: "Hall A & Lobby" },
    { label: "Shift", value: "12:00 — 22:00" },
    { label: "Reports Reviewed", value: `${reviewedToday} today` },
    { label: "Check-in", value: checkIn },
  ];

  return (
    <>
      <div className="flex-1 overflow-y-auto" style={{ background: cream }}>
        <div className="sticky top-0 z-10 px-5 pt-4 pb-2" style={{ background: `linear-gradient(to bottom, ${cream} 80%, transparent)` }}>
          <h2 className="text-xl font-bold text-center" style={{ color: ink, letterSpacing: "-0.02em" }}>You</h2>
        </div>
        <div className="flex flex-col items-center gap-3 px-5 pt-2 pb-4">
          <div className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold"
            style={{ background: "#e8e3f0", color: accent, border: "3px solid white", boxShadow: "0 4px 20px rgba(91,63,248,0.15)" }}>{initials}</div>
          <div className="text-center">
            <p className="font-bold text-lg" style={{ color: ink }}>{name}</p>
            <p className="text-xs font-mono mt-0.5 uppercase tracking-widest" style={{ color: muted }}>{role} · {eventName}</p>
          </div>
        </div>

        {role === "attendee" && (
          <div className="mx-4 rounded-3xl p-5 flex flex-col items-center mb-3" style={{ background: card, border: `1px solid ${border}` }}>
            <p className="text-xs font-mono uppercase tracking-widest mb-4" style={{ color: muted }}>Trust Score</p>
            <TrustScoreCircle score={trustScore} />
            <p className="text-xs text-center mt-4 leading-relaxed" style={{ color: muted }}>Based on your reports, check-ins, and community interactions.</p>
          </div>
        )}

        <div className="px-4 flex flex-col gap-2 pb-32">
          {(role === "attendee" ? attendeeRows : staffRows).map(({ label, value }) => (
            <div key={label} className="rounded-2xl px-4 py-3.5 flex justify-between items-center" style={{ background: card, border: `1px solid ${border}` }}>
              <span className="text-xs font-mono" style={{ color: muted }}>{label}</span>
              <span className="text-sm font-semibold" style={{ color: ink }}>{value}</span>
            </div>
          ))}

          {role === "attendee" && (
            <button onClick={() => setShowMyReports(true)}
              className="rounded-2xl px-4 py-3.5 flex items-center justify-between w-full"
              style={{ background: `rgba(91,63,248,0.06)`, border: `1px solid rgba(91,63,248,0.15)` }}>
              <div className="flex items-center gap-2.5">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke={accent} strokeWidth="1.3" />
                  <path d="M5 6h6M5 9h4" stroke={accent} strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span className="text-sm font-semibold" style={{ color: accent }}>My Reports</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6 5l4 3-4 3" stroke={accent} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}

          <button onClick={onLeave}
            className="w-full py-4 rounded-2xl font-semibold text-sm mt-1 flex items-center justify-center gap-2"
            style={{ background: "rgba(239,68,68,0.08)", color: "#dc2626", border: "1px solid rgba(239,68,68,0.18)" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6" stroke="#dc2626" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Leave Event
          </button>
        </div>
      </div>

      {showMyReports && <MyReportsSheet reports={reports} userName={name} onClose={() => setShowMyReports(false)} />}
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
    <div className="absolute inset-0 z-50 flex items-end" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full p-6 pb-8" style={{ background: "#faf8f5", borderRadius: "28px 28px 0 0", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
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
    <div className="absolute inset-0 z-50 flex items-end" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onCancel}>
      <div className="w-full p-6 pb-8" style={{ background: "#faf8f5", borderRadius: "28px 28px 0 0", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
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
    <div className="absolute bottom-5 left-1/2 z-30" style={{ transform: "translateX(-50%)" }}>
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
    <div className="absolute inset-0 z-50 flex items-end" style={{ background: "rgba(26,25,23,0.45)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full p-5 pb-8" style={{ background: "#faf8f5", borderRadius: "28px 28px 0 0", border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
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

  const isModerator = activeMembership?.role === "ORGANIZER" || activeMembership?.role === "STAFF";
  const reportRows = useQuery(api.reports.listForEvent, activeEventId ? { eventId: activeEventId } : "skip");
  const staffReportRows = useQuery(api.reports.listForStaff, activeEventId && isModerator ? { eventId: activeEventId } : "skip");
  const poiRows = useQuery(api.mapPins.listForEvent, activeEventId ? { eventId: activeEventId } : "skip");

  const createEventMutation = useMutation(api.events.create);
  const updateFloorMapMutation = useMutation(api.events.updateFloorMap);
  const joinByCodeMutation = useMutation(api.events.joinByCode);
  const leaveMutation = useMutation(api.memberships.leave);
  const createReportMutation = useMutation(api.reports.create);
  const updateStatusMutation = useMutation(api.reports.updateStatus);
  const setPriorityMutation = useMutation(api.reports.setPriority);
  const setCriticalMutation = useMutation(api.reports.setCritical);
  const markViewedMutation = useMutation(api.reports.markViewed);
  const banReporterMutation = useMutation(api.reports.banReporter);
  const createMapPinMutation = useMutation(api.mapPins.create);
  const removeMapPinMutation = useMutation(api.mapPins.remove);

  const [screen, setScreen] = useState<Screen>("login");
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
  const [staffCodeStep, setStaffCodeStep] = useState(false);
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
      .filter((r) => r.priority === "critical" && !!r.officialStatement && r.status === "approved" && !r.resolved && !dismissedNotifs.has(r.id))
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
    setStaffCodeStep(false);
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
    if (activeMembership) {
      setScreen(activeMembership.role === "ATTENDEE" ? "app" : "staff-app");
    } else {
      setScreen("home");
    }
  }, [isLoading, isAuthenticated, membershipsLoading, restored, activeMembership]);

  const approvedReports = reports.filter((r) => r.status === "approved" && !r.banned);
  const eventName = activeEvent?.name ?? ((eventData.name?.trim()) || "Event Pulse '26");
  const eventVenue = activeEvent?.venue ?? ((eventData.venue?.trim()) || "IIT Delhi");
  const mapUrl = activeEvent?.mapUrl ?? null;
  const reviewedToday = useMemo(() => {
    const midnight = new Date().setHours(0, 0, 0, 0);
    return staffReports.filter((r) => r.reviewedByMe && (r.reviewedAt ?? 0) >= midnight).length;
  }, [staffReports]);
  const myTrustScore = activeMembership?.trustScore ?? trustScores[userName] ?? 60;

  const selectedReport = selectedReportId !== null ? approvedReports.find((r) => r.id === selectedReportId) ?? null : null;

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
      const created = await createEventMutation({
        name: eventData.name ?? "", venue: eventData.venue ?? "", date: eventData.date ?? "",
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
      setStaffCodeStep(false);
      setPendingRole(joined.role === "ATTENDEE" ? "attendee" : joined.role === "STAFF" ? "staff" : "organizer");
      setScreen(joined.role === "ATTENDEE" ? "app" : "staff-app");
    } catch (err) {
      setJoinError(errorMessage(err));
    } finally {
      setJoinBusy(false);
    }
  };

  const handleLeave = async () => {
    // An organizer cannot leave — that would orphan the event, its members and
    // its reports. Leave is the only route out of a workspace in this UI, so for
    // them it navigates Home and keeps the membership intact.
    if (role !== "organizer" && activeEventId) {
      try {
        await leaveMutation({ eventId: activeEventId });
      } catch (err) {
        // Keep the modal open rather than pretending the leave succeeded.
        console.error("Leaving the event failed:", err);
        return;
      }
    }
    setScreen("home"); setPins([]); setTab("map"); setStaffTab("map"); setShowLeave(false); setShowReport(false); setStaffCodeStep(false); setPinpointMode(false); setStaffPinpointMode(false);
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
    switch (screen) {
      case "login":
        return <LoginScreen onLogin={() => { void signIn("google"); }} />;

      case "home":
        return <HomeScreen userName={userName} onCreateEvent={() => setScreen("create-1")} onJoinEvent={() => setScreen("join-scan")} onJoinAsStaff={() => setScreen("staff-scan")} onLogout={() => { void signOut(); }} />;

      case "create-1": return <CreateStep1 eventData={eventData} onChange={setEventData} onNext={() => setScreen("create-2")} onBack={() => setScreen("home")} />;
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
            onJoin={() => { void handleJoin(joinCode); }}
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

      case "staff-scan":
        if (staffCodeStep) return <StaffCodeScreen onJoin={(code) => { void handleJoin(code); }} onBack={() => { setJoinError(null); setStaffCodeStep(false); }} error={joinError} busy={joinBusy} />;
        return <ScanScreen title="Join as Staff" sub="First scan the attendee QR for the event" accentColor="#10b981" onJoin={() => { setJoinError(null); setStaffCodeStep(true); }} onBack={() => setScreen("home")} />;

      case "app":
        return (
          <>
            {tab === "map" && (
              <>
                <PannableMap
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
                          <p className="text-xs text-center font-medium" style={{ color: "#6b6456" }}>Tap a pin to view · use the 📍 button to report</p>
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
              <FeedView
                reports={reports}
                onView={handleView}
                trustScores={trustScores}
                seenIds={seenIds}
                notifications={notifications}
                error={actionError}
              />
            )}
            {tab === "you" && <YouView role={role} name={userName} onLeave={() => setShowLeave(true)} reports={reports} trustScore={myTrustScore} eventName={eventName} joinedAt={activeMembership?.joinedAt ?? null} reviewedToday={reviewedToday} />}
            <IslandNav items={attendeeNav} active={tab} onChange={(t) => { setTab(t); if (t !== "map") setPinpointMode(false); }} />
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
          </>
        );

      case "staff-app":
        return (
          <>
            {staffTab === "map" && (
              <PannableMap mapUrl={mapUrl} pins={pins} onPin={(p) => { if (staffPinpointMode) setPins([p]); }} approvedReports={approvedReports} allowPin={staffPinpointMode} pois={pois}
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
                        <p className="text-xs text-center font-medium" style={{ color: "#6b6456" }}>Tap a pin to view · use the 📍 button to report</p>
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
                <PannableMap
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
              <StaffReportsView
                reports={staffReports}
                onApprove={handleApprove}
                onReject={handleReject}
                onBan={handleBan}
                onSetPriority={handleSetPriority}
                onSetCritical={handleSetCritical}
                error={actionError}
              />
            )}
            {staffTab === "feed" && (
              <FeedView
                reports={reports}
                onView={handleView}
                trustScores={trustScores}
                onResolve={handleResolve}
                showSeen={false}
                error={actionError}
              />
            )}
            {staffTab === "you" && <YouView role={role} name={userName} onLeave={() => setShowLeave(true)} reports={reports} trustScore={myTrustScore} eventName={eventName} joinedAt={activeMembership?.joinedAt ?? null} reviewedToday={reviewedToday} />}
            <IslandNav items={staffNav} active={staffTab} onChange={setStaffTab} />
            {showReport && <ReportModal onClose={() => { setShowReport(false); setPins([]); }} onSubmit={(desc) => handleReport(desc)} pin={pins[0] ?? null} />}
            {showLeave && <LeaveModal onConfirm={() => { void handleLeave(); }} onCancel={() => setShowLeave(false)} isOrganizer={role === "organizer"} />}
            {selectedReport && (
              <ReportPinDetailSheet report={selectedReport} onClose={() => setSelectedReportId(null)} />
            )}
          </>
        );
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center" style={{ background: bg }}>
      <div className="relative flex flex-col overflow-hidden"
        style={{ width: "min(390px, 100vw)", height: "min(844px, 100vh)", borderRadius: "clamp(0px, 3vw, 44px)", boxShadow: "0 0 0 1px rgba(0,0,0,0.12), 0 40px 80px rgba(0,0,0,0.25)", background: cream }}>
        {/* Status bar */}
        {/* Critical statement modal — rendered at root so it's never clipped */}
        {criticalStatementFor && (
          <CriticalStatementModal
            report={criticalStatementFor}
            onClose={() => setCriticalStatementFor(null)}
            onConfirm={handleCriticalConfirm}
          />
        )}
        <div className="flex items-center justify-between px-6 pt-3 pb-1 z-20 relative shrink-0" style={{ color: "#6b6456" }}>
          <span className="text-[11px] font-mono font-medium">9:41</span>
          <div className="flex items-center gap-2">
            <div className="flex gap-[3px] items-end h-3">
              {[4, 6, 8, 10].map((h, i) => <div key={i} style={{ height: h, width: 3, background: "#6b6456", borderRadius: 1 }} />)}
            </div>
            <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
              <path d="M1 9C3 6 5.2 4.5 8 4.5S13 6 15 9" stroke="#6b6456" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M3.5 9C5 7 6.4 6.5 8 6.5s3 .5 4.5 2.5" stroke="#6b6456" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="8" cy="10.5" r="1" fill="#6b6456" />
            </svg>
            <svg width="26" height="13" viewBox="0 0 26 13" fill="none">
              <rect x="0.5" y="0.5" width="22" height="12" rx="3.5" stroke="#6b6456" strokeWidth="1" />
              <rect x="2" y="2" width="17" height="9" rx="2" fill="#1a1917" />
              <path d="M24 4.5v4a2 2 0 000-4z" fill="#6b6456" />
            </svg>
          </div>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 relative">{renderContent()}</div>
      </div>
    </div>
  );
}
