// Public, no-auth digital-signage cycler.
//
// Mounted by App.tsx when window.location.pathname matches
// /^\/display\/(\d+)\/?$/. We deliberately render *outside* the
// auth shell so a smart TV / kiosk that hits this URL just works
// without ever seeing a login screen.
//
// Item rules:
//   - image → <img> shown for `durationSeconds`
//             (or playlist defaultDurationSeconds)
//   - video → <video autoplay muted playsInline> advance on onEnded
//   - audio → colored card with track title, advance on onEnded
//   - pdf   → render each page with pdfjs-dist; advance per page
//             using `durationSeconds` (default applies)
//
// PBIS Houses slide:
//   - When showPbisHousePage is true, we inject a synthetic slide at
//     the start of every loop showing house point totals + the most
//     recent positive recognitions.
//
// Resilience:
//   - Reload the playlist meta every 60s so admin edits land without
//     requiring a TV reboot.
//   - Empty playlists show a friendly "no items yet" placeholder.
//   - We never crash the cycler on a single bad item; we log + skip.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
// pdfjs-dist 5.x ships ESM. Import the worker as a URL so Vite
// bundles it correctly for production.
import * as pdfjsLib from "pdfjs-dist";
// eslint-disable-next-line import/no-unresolved
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

// Wire the worker once per page-load. Doing it at module scope
// avoids a race where the first PDF render hits the worker check
// before our setup runs.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface PublicItem {
  id: number;
  kind: "image" | "video" | "audio" | "pdf" | "url";
  mimeType: string | null;
  durationSeconds: number | null;
  orderIndex: number;
  mediaUrl: string;
  // Only set for kind=url; the page to embed in an iframe.
  url: string | null;
}

// Live remote-control state for this playlist, polled every ~2s from
// the public live endpoint. `mode === "auto"` (or a missing row) means
// the normal cycler runs. "manual" steps THIS playlist's items at the
// presenter-chosen position; "presentation" temporarily shows a deck
// playlist or a single live URL. `revision` lets us cheaply ignore
// unchanged polls (every server-side change bumps it).
interface LiveControl {
  mode: "auto" | "manual" | "presentation";
  itemIndex: number;
  pageIndex: number;
  presentationPlaylistId: number | null;
  presentationUrl: string | null;
  revision: number;
}

interface HouseTotals {
  id: number;
  name: string;
  color: string;
  motto: string | null;
  totalPoints: number;
}

interface RecentRecognition {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  points: number;
  note: string | null;
  createdAt: string;
  houseName: string | null;
  houseColor: string | null;
}

interface ActivePass {
  id: number;
  studentLabel: string;
  destination: string;
  originRoom: string;
  maxDurationMinutes: number;
  minutesOpen: number;
  isOverdue: boolean;
}

interface HallPassData {
  passes: ActivePass[];
  generatedAt: string;
}

interface PublicPlaylist {
  playlist: {
    id: number;
    // schoolId is needed to build the per-school Heartbeat iframe URL
    // (`/signage/heartbeat?schoolId=N`). The server returns this on
    // the public endpoint — see `routes/displays.ts`.
    schoolId: number;
    name: string;
    defaultDurationSeconds: number;
    showPbisHousePage: boolean;
    showActiveHallPasses: boolean;
    showPickupQueue: boolean;
    showHeartbeat: boolean;
    scheduleEnabled: boolean;
    scheduleStartTime: string | null;
    scheduleEndTime: string | null;
    scheduleDaysOfWeek: string | null;
  };
  items: PublicItem[];
  // Per-display schedule overrides. When the current local time falls
  // inside an override window, we play that override's items instead
  // of the base loop. Server pre-resolves items so we don't need a
  // second fetch per override target.
  overrides: PublicOverride[];
  houseData: {
    houses: HouseTotals[];
    recent: RecentRecognition[];
  } | null;
  hallPassData: HallPassData | null;
  pickupQueueData: PickupQueueData | null;
}

interface PickupQueueEntry {
  position: number;
  studentLabel: string;
  grade: number | null;
  addedAt: string;
  status: "in_queue" | "walking_out";
}

interface PickupQueueData {
  queue: PickupQueueEntry[];
  ownerFiltered: boolean;
  generatedAt: string;
}

interface PublicOverride {
  id: number;
  playlistId: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  // Date-range gating (YYYY-MM-DD). Both null = recurs every matching
  // dayOfWeek forever. Either set = the row only fires on a date that
  // falls within [effectiveFrom, effectiveUntil] inclusive.
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  items: PublicItem[];
}

// Local YYYY-MM-DD for the given Date (used to compare against the
// override's date bounds, which are stored as strings without TZ).
function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Returns the override that should be playing right now, or null for
// the base loop. Tie-breaker: lowest startTime wins (matches the API's
// ORDER BY day_of_week, start_time).
function pickActiveOverride(
  overrides: PublicOverride[],
  now: Date = new Date(),
): PublicOverride | null {
  const today = now.getDay();
  const cur = now.getHours() * 60 + now.getMinutes();
  const todayISO = toLocalISODate(now);
  let best: { ov: PublicOverride; startMin: number } | null = null;
  for (const ov of overrides) {
    if (ov.dayOfWeek !== today) continue;
    if (ov.effectiveFrom && todayISO < ov.effectiveFrom) continue;
    if (ov.effectiveUntil && todayISO > ov.effectiveUntil) continue;
    const [sh, sm] = ov.startTime.split(":").map((n) => Number.parseInt(n, 10));
    const [eh, em] = ov.endTime.split(":").map((n) => Number.parseInt(n, 10));
    if (
      !Number.isFinite(sh) ||
      !Number.isFinite(sm) ||
      !Number.isFinite(eh) ||
      !Number.isFinite(em)
    ) {
      continue;
    }
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (cur >= startMin && cur < endMin) {
      if (!best || startMin < best.startMin) {
        best = { ov, startMin };
      }
    }
  }
  return best?.ov ?? null;
}

// A "slide" is what the cycler actually displays. We expand the
// playlist into slides by injecting an optional house card + an
// optional active-hall-passes card + an optional heartbeat embed at
// the front of each loop.
type Slide =
  | { kind: "house"; data: PublicPlaylist["houseData"] }
  | { kind: "passes"; data: HallPassData }
  | { kind: "pickup"; data: PickupQueueData }
  | { kind: "heartbeat"; schoolId: number }
  | { kind: "item"; item: PublicItem };

// Schedule helpers — keep this client-side so the TV's local clock is
// the source of truth (the lobby doesn't care about server timezones).

function parseDaysCsv(s: string | null): Set<number> {
  if (!s) return new Set();
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return out;
}

// Returns true when the current local time is inside the configured
// window. If the schedule is malformed (only one of start/end is set)
// we fall back to "always on" rather than blanking the screen, since a
// dark TV is worse than an over-eager TV.
function isInSchedule(
  meta: PublicPlaylist["playlist"],
  now: Date = new Date(),
): boolean {
  if (!meta.scheduleEnabled) return true;
  const start = meta.scheduleStartTime;
  const end = meta.scheduleEndTime;
  // Time fields not set yet → fail open. (A blank screen is worse than
  // an over-eager one when the admin half-configured a schedule.)
  if (!start || !end) {
    const days = parseDaysCsv(meta.scheduleDaysOfWeek);
    if (days.size > 0 && !days.has(now.getDay())) return false;
    return true;
  }
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map((n) => Number.parseInt(n, 10));
  const [eh, em] = end.split(":").map((n) => Number.parseInt(n, 10));
  if (
    !Number.isFinite(sh) ||
    !Number.isFinite(sm) ||
    !Number.isFinite(eh) ||
    !Number.isFinite(em)
  ) {
    return true;
  }
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const days = parseDaysCsv(meta.scheduleDaysOfWeek);
  const today = now.getDay();
  // Yesterday wraps via modulo so Sunday(0) → Saturday(6).
  const yesterday = (today + 6) % 7;
  if (endMin <= startMin) {
    // Overnight wrap (e.g. 22:00 → 06:00). The window OPENS on the day
    // the schedule names. So if we're after `startMin`, today must be a
    // configured day; if we're before `endMin`, *yesterday* must be a
    // configured day (the window opened yesterday).
    if (cur >= startMin) {
      return days.size === 0 || days.has(today);
    }
    if (cur < endMin) {
      return days.size === 0 || days.has(yesterday);
    }
    return false;
  }
  // Same-day window — day filter must match today.
  if (days.size > 0 && !days.has(today)) return false;
  return cur >= startMin && cur < endMin;
}

const fullBleed: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "black",
  color: "white",
  overflow: "hidden",
};

export default function DisplayShow({ playlistId }: { playlistId: number }) {
  const [playlist, setPlaylist] = useState<PublicPlaylist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [live, setLive] = useState<LiveControl | null>(null);

  // Poll the live remote-control state fast (~2s) so a presenter's
  // clicks land on every TV near-instantly. We keep the last known
  // state on a failed poll (a transient blip shouldn't blank the wall)
  // and only re-render when `revision` actually changed — every
  // server-side change bumps it, and the "no row" default holds at 0,
  // so an idle auto-mode TV never churns.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`/api/displays/public/live/${playlistId}`);
        if (!r.ok) return;
        const j = (await r.json()) as LiveControl;
        if (cancelled) return;
        setLive((prev) => (prev && prev.revision === j.revision ? prev : j));
      } catch {
        // Keep the last known live state on a network blip.
      }
    }
    void poll();
    const t = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [playlistId]);

  // Refresh the playlist on first render and every 60s thereafter,
  // so admin edits show up without bouncing the TV.
  useEffect(() => {
    let cancelled = false;
    async function fetchOnce() {
      try {
        const r = await fetch(
          `/api/displays/public/playlists/${playlistId}`,
        );
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const j = (await r.json()) as PublicPlaylist;
        if (cancelled) return;
        setPlaylist(j);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Network error");
        }
      }
    }
    void fetchOnce();
    const t = window.setInterval(fetchOnce, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [playlistId]);

  // Tick once a minute so the off-air check + override scope re-evaluates
  // without waiting on the next 60s playlist poll. The state is also used
  // by `currentScope` below so a brand-new override window starts on the
  // minute boundary.
  const [minuteTick, setMinuteTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setMinuteTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Determine which scope is active right now: "base" or "override:<id>".
  // Recomputed every minuteTick and on playlist refetch.
  const activeOverride = useMemo(
    () =>
      playlist
        ? pickActiveOverride(playlist.overrides ?? [])
        : null,
    // minuteTick is intentional — we want a fresh time check every minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playlist, minuteTick],
  );
  const currentScope = activeOverride ? `override:${activeOverride.id}` : "base";

  const slides = useMemo<Slide[]>(() => {
    if (!playlist) return [];
    const list: Slide[] = [];
    if (activeOverride) {
      // Override scope: play ONLY the override playlist's items. We
      // intentionally skip house / hall-pass / heartbeat injections
      // here so a "fire drill" or assembly-time override is exactly
      // what the admin uploaded — no surprises.
      for (const item of activeOverride.items) {
        list.push({ kind: "item", item });
      }
      return list;
    }
    if (playlist.playlist.showPbisHousePage && playlist.houseData) {
      list.push({ kind: "house", data: playlist.houseData });
    }
    if (playlist.playlist.showActiveHallPasses && playlist.hallPassData) {
      list.push({ kind: "passes", data: playlist.hallPassData });
    }
    if (playlist.playlist.showPickupQueue && playlist.pickupQueueData) {
      list.push({ kind: "pickup", data: playlist.pickupQueueData });
    }
    if (playlist.playlist.showHeartbeat) {
      // Heartbeat is rendered as an iframe of the existing /signage/heartbeat
      // page, which polls /api/pulse/* for itself. We just need to know
      // which school to scope it to.
      list.push({ kind: "heartbeat", schoolId: playlist.playlist.schoolId });
    }
    for (const item of playlist.items) {
      list.push({ kind: "item", item });
    }
    return list;
  }, [playlist, activeOverride]);

  // Hard-reset to slide 0 whenever the scope changes (base ↔ override, or
  // override A ↔ override B). Otherwise a 30-min override starting at
  // 8:30 would resume at "wherever the base loop happened to be" and an
  // admin couldn't reason about what staff are seeing.
  const lastScopeRef = useRef<string>(currentScope);
  useEffect(() => {
    if (lastScopeRef.current !== currentScope) {
      lastScopeRef.current = currentScope;
      setSlideIdx(0);
    }
  }, [currentScope]);

  // Whenever the slide list changes (admin reorder, item add/remove)
  // and the current index falls off the end, snap back to 0 so the
  // cycler doesn't wedge on a now-deleted slide.
  useEffect(() => {
    if (slides.length === 0) {
      setSlideIdx(0);
      return;
    }
    if (slideIdx >= slides.length) setSlideIdx(0);
  }, [slides, slideIdx]);

  const advance = useCallback(() => {
    setSlideIdx((i) => {
      if (slides.length === 0) return 0;
      return (i + 1) % slides.length;
    });
  }, [slides.length]);

  if (error) {
    return (
      <div style={{ ...fullBleed, padding: 32 }}>
        <div style={{ fontSize: 24, opacity: 0.85 }}>
          Couldn't load this display.
        </div>
        <div style={{ marginTop: 12, opacity: 0.6, fontSize: 14 }}>
          {error}
        </div>
      </div>
    );
  }
  if (!playlist) {
    return (
      <div style={{ ...fullBleed, padding: 32, opacity: 0.7 }}>Loading…</div>
    );
  }

  // Live remote-control short-circuit. When a presenter is driving this
  // playlist (manual) or running a presentation session, bypass the
  // normal cycler entirely: no timers, no synthetic slides, no schedule
  // gate, no overrides — just the exact slide the controller selected.
  if (live && live.mode !== "auto") {
    return (
      <LiveControlledView
        live={live}
        baseItems={playlist.items}
        playlistName={playlist.playlist.name}
      />
    );
  }

  if (slides.length === 0) {
    return (
      <div
        style={{
          ...fullBleed,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 28, opacity: 0.85 }}>
          {playlist.playlist.name}
        </div>
        <div style={{ opacity: 0.6 }}>
          No items in this playlist yet.
        </div>
      </div>
    );
  }

  // Schedule gate. The minute-tick state above re-runs this on every
  // minute boundary so a TV that left "Off-air" at 7:59 flips to live
  // content at 8:00 without a manual refresh.
  if (!isInSchedule(playlist.playlist)) {
    return (
      <div
        style={{
          ...fullBleed,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 16,
          color: "#9ca3af",
        }}
      >
        <div style={{ fontSize: 48, fontWeight: 700, opacity: 0.85 }}>
          {playlist.playlist.name}
        </div>
        <div style={{ fontSize: 22 }}>Off-air</div>
        <div style={{ fontSize: 14, opacity: 0.7 }}>
          This display is outside its scheduled play window.
        </div>
      </div>
    );
  }

  // Guard against the brief render where slides has just been
  // recomputed (e.g. an override window opened or closed) and
  // slideIdx still points past the end. The reset effect runs after
  // render, so without this we'd crash on `slide.kind`.
  const safeIdx = slideIdx < slides.length ? slideIdx : 0;
  const slide = slides[safeIdx];
  if (!slide) return null;
  const defaultDuration = playlist.playlist.defaultDurationSeconds;

  return (
    <div style={fullBleed}>
      {slide.kind === "house" && slide.data ? (
        <HouseSlide
          data={slide.data}
          // The houses slide always uses the playlist default since it
          // has no per-item duration. We pad by a couple seconds so a
          // lobby crowd has time to scan the totals.
          durationSeconds={Math.max(defaultDuration, 12)}
          onDone={advance}
        />
      ) : slide.kind === "passes" ? (
        <HallPassesSlide
          data={slide.data}
          durationSeconds={Math.max(defaultDuration, 12)}
          onDone={advance}
          // key forces a fresh mount when the slide changes so the
          // useTimer inside cleans up correctly.
          key={`passes-${slideIdx}`}
        />
      ) : slide.kind === "pickup" ? (
        <PickupQueueSlide
          data={slide.data}
          durationSeconds={Math.max(defaultDuration, 12)}
          onDone={advance}
          key={`pickup-${slideIdx}`}
        />
      ) : slide.kind === "heartbeat" ? (
        <HeartbeatSlide
          schoolId={slide.schoolId}
          // Heartbeat is a "live page" with no natural end, so the
          // playlist default governs how long it stays up. Pad to 15s
          // so visitors have time to read at least one row.
          durationSeconds={Math.max(defaultDuration, 15)}
          onDone={advance}
          key={`heartbeat-${slideIdx}`}
        />
      ) : slide.kind === "item" ? (
        <ItemSlide
          item={slide.item}
          defaultDuration={defaultDuration}
          onDone={advance}
          // key forces a fresh mount when we move to a new item, so
          // <video onEnded> + setTimeout cleanup happen automatically.
          key={`${slide.item.id}-${slideIdx}`}
        />
      ) : null}
    </div>
  );
}

// ===================================================================
// One playlist item.
// ===================================================================

function ItemSlide({
  item,
  defaultDuration,
  onDone,
}: {
  item: PublicItem;
  defaultDuration: number;
  onDone: () => void;
}) {
  if (item.kind === "image") {
    return <ImageSlide item={item} defaultDuration={defaultDuration} onDone={onDone} />;
  }
  if (item.kind === "video") {
    return <VideoSlide item={item} onDone={onDone} />;
  }
  if (item.kind === "audio") {
    return <AudioSlide item={item} onDone={onDone} />;
  }
  if (item.kind === "pdf") {
    return <PdfSlide item={item} defaultDuration={defaultDuration} onDone={onDone} />;
  }
  if (item.kind === "url") {
    return <UrlSlide item={item} defaultDuration={defaultDuration} onDone={onDone} />;
  }
  return null;
}

// ===================================================================
// Live remote-control rendering.
//
// When a presenter is driving the wall, we render exactly the slide the
// controller picked — no timers, no auto-advance. This same view backs
// both the TV (DisplayShow) and the controller's live preview, so the
// presenter sees precisely what the room sees.
// ===================================================================

const liveCentered: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection: "column",
  gap: 12,
  background: "black",
  color: "white",
  textAlign: "center",
  padding: 24,
  boxSizing: "border-box",
};

// Resolves the live mode into a single controlled slide. Used by the TV
// short-circuit above. Handles fetching a presentation deck and the
// ad-hoc-URL presentation case.
function LiveControlledView({
  live,
  baseItems,
  playlistName,
}: {
  live: LiveControl;
  baseItems: PublicItem[];
  playlistName: string;
}) {
  const [deck, setDeck] = useState<PublicItem[] | null>(null);
  const [deckError, setDeckError] = useState(false);

  const deckId =
    live.mode === "presentation" ? live.presentationPlaylistId : null;

  // Fetch the presentation deck's items when presenting a deck playlist.
  useEffect(() => {
    if (deckId == null) {
      setDeck(null);
      setDeckError(false);
      return;
    }
    let cancelled = false;
    setDeck(null);
    setDeckError(false);
    (async () => {
      try {
        const r = await fetch(`/api/displays/public/playlists/${deckId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as PublicPlaylist;
        if (!cancelled) setDeck(j.items);
      } catch {
        if (!cancelled) setDeckError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  // Presentation via a single live URL (e.g. Google Slides / Canva
  // present link). One slide, no paging.
  if (live.mode === "presentation" && live.presentationUrl) {
    return (
      <div style={fullBleed}>
        <iframe
          src={live.presentationUrl}
          title="Presentation"
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          referrerPolicy="no-referrer"
          style={{ width: "100%", height: "100%", border: 0, background: "white" }}
        />
      </div>
    );
  }

  if (deckId != null && deckError) {
    return (
      <div style={fullBleed}>
        <div style={liveCentered}>
          <div style={{ fontSize: 24, opacity: 0.85 }}>
            Couldn't load the presentation.
          </div>
        </div>
      </div>
    );
  }

  if (deckId != null && deck === null) {
    return (
      <div style={fullBleed}>
        <div style={{ ...liveCentered, opacity: 0.7 }}>Loading…</div>
      </div>
    );
  }

  const items = live.mode === "manual" ? baseItems : deck ?? [];

  if (items.length === 0) {
    return (
      <div style={fullBleed}>
        <div style={liveCentered}>
          <div style={{ fontSize: 28, opacity: 0.85 }}>{playlistName}</div>
          <div style={{ opacity: 0.6 }}>Nothing to present yet.</div>
        </div>
      </div>
    );
  }

  const idx = Math.max(0, Math.min(live.itemIndex, items.length - 1));
  const item = items[idx];

  return (
    <div style={fullBleed}>
      <ControlledItemSlide
        item={item}
        pageIndex={live.pageIndex}
        // Remount on item change so video/audio/pdf reset cleanly.
        key={`${item.id}-${idx}`}
      />
    </div>
  );
}

// A single item rendered statically at a fixed position (no
// auto-advance). PDFs render the controller-selected page and report
// their page count via `onPdfMeta` so the controller can offer per-page
// navigation. Exported so the controller's live preview reuses it.
export function ControlledItemSlide({
  item,
  pageIndex,
  onPdfMeta,
}: {
  item: PublicItem;
  pageIndex: number;
  onPdfMeta?: (numPages: number) => void;
}) {
  if (item.kind === "image") {
    return (
      <img
        src={item.mediaUrl}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          background: "black",
        }}
      />
    );
  }
  if (item.kind === "video") {
    return (
      <video
        src={item.mediaUrl}
        autoPlay
        muted
        playsInline
        loop
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          background: "black",
        }}
      />
    );
  }
  if (item.kind === "audio") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 24,
          color: "white",
        }}
      >
        <div style={{ fontSize: 96 }}>🔊</div>
        <div style={{ fontSize: 28, opacity: 0.85 }}>Now playing</div>
        <audio src={item.mediaUrl} autoPlay loop />
      </div>
    );
  }
  if (item.kind === "url") {
    if (!item.url) return null;
    return (
      <iframe
        src={item.url}
        title="Embedded URL slide"
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height: "100%", border: 0, background: "white" }}
      />
    );
  }
  if (item.kind === "pdf") {
    return (
      <ControlledPdfSlide
        item={item}
        pageIndex={pageIndex}
        onPdfMeta={onPdfMeta}
      />
    );
  }
  return null;
}

// PDF rendered at an externally-controlled page. Loads the doc once,
// reports its page count, and renders the clamped `pageIndex`.
function ControlledPdfSlide({
  item,
  pageIndex,
  onPdfMeta,
}: {
  item: PublicItem;
  pageIndex: number;
  onPdfMeta?: (numPages: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const docRef = useRef<unknown>(null);
  const [loadError, setLoadError] = useState(false);
  // Keep the latest callback in a ref so the load effect doesn't depend
  // on its identity (avoids re-fetching the doc when the parent
  // re-renders with a fresh closure).
  const onPdfMetaRef = useRef(onPdfMeta);
  onPdfMetaRef.current = onPdfMeta;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const task = pdfjsLib.getDocument({ url: item.mediaUrl });
        const doc = await task.promise;
        if (cancelled) {
          await doc.destroy?.();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        onPdfMetaRef.current?.(doc.numPages);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[display] controlled pdf load failed", e);
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
      const d = docRef.current as { destroy?: () => Promise<void> } | null;
      void d?.destroy?.();
      docRef.current = null;
    };
  }, [item.mediaUrl]);

  useEffect(() => {
    if (pageCount === null) return;
    const doc = docRef.current as {
      getPage?: (n: number) => Promise<unknown>;
    } | null;
    const canvas = canvasRef.current;
    if (!doc || !canvas || !doc.getPage) return;
    const getPage = doc.getPage;
    const clamped = Math.max(0, Math.min(pageIndex, pageCount - 1));
    let cancelled = false;
    (async () => {
      try {
        const page = (await getPage(clamped + 1)) as {
          getViewport: (opts: { scale: number }) => {
            width: number;
            height: number;
          };
          render: (opts: {
            canvasContext: CanvasRenderingContext2D;
            viewport: unknown;
            canvas: HTMLCanvasElement;
          }) => { promise: Promise<void> };
        };
        const baseViewport = page.getViewport({ scale: 1 });
        const targetW = window.innerWidth;
        const targetH = window.innerHeight;
        const scale = Math.min(
          targetW / baseViewport.width,
          targetH / baseViewport.height,
        );
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const renderTask = page.render({ canvasContext: ctx, viewport, canvas });
        await renderTask.promise;
        if (cancelled) return;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[display] controlled pdf render failed", e);
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageIndex, pageCount]);

  if (loadError) {
    return (
      <div style={liveCentered}>
        <div style={{ fontSize: 22, opacity: 0.85 }}>Couldn't load this PDF.</div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "black",
      }}
    >
      <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "100%" }} />
    </div>
  );
}

// URL slide — embeds the page in a sandboxed iframe and advances after
// `durationSeconds` (or playlist default). We can't observe load state
// for cross-origin frames, so the timer starts immediately.
function UrlSlide({
  item,
  defaultDuration,
  onDone,
}: {
  item: PublicItem;
  defaultDuration: number;
  onDone: () => void;
}) {
  // If the server somehow shipped a url-kind without a url, advance
  // immediately (capped at 1s) instead of holding the loop hostage.
  // Calling useTimer unconditionally keeps the hook order stable.
  useTimer(
    item.url ? item.durationSeconds ?? defaultDuration : 1,
    onDone,
  );
  if (!item.url) return null;
  return (
    <iframe
      src={item.url}
      title="Embedded URL slide"
      // Deliberately omit `allow-same-origin` — combining it with
      // `allow-scripts` lets a same-origin embed remove the sandbox
      // entirely. Most public dashboards, weather widgets, and news
      // sites still render fine without it; if a particular page
      // refuses to load (cookies / login) the admin should pick a
      // different URL or upload a screenshot instead.
      sandbox="allow-scripts allow-forms allow-popups"
      referrerPolicy="no-referrer"
      style={{
        width: "100%",
        height: "100%",
        border: 0,
        background: "white",
      }}
    />
  );
}

function useTimer(durationSeconds: number, onDone: () => void) {
  useEffect(() => {
    const t = window.setTimeout(onDone, durationSeconds * 1000);
    return () => window.clearTimeout(t);
  }, [durationSeconds, onDone]);
}

function ImageSlide({
  item,
  defaultDuration,
  onDone,
}: {
  item: PublicItem;
  defaultDuration: number;
  onDone: () => void;
}) {
  useTimer(item.durationSeconds ?? defaultDuration, onDone);
  return (
    <img
      src={item.mediaUrl}
      alt=""
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        background: "black",
      }}
      onError={onDone}
    />
  );
}

function VideoSlide({
  item,
  onDone,
}: {
  item: PublicItem;
  onDone: () => void;
}) {
  return (
    <video
      src={item.mediaUrl}
      autoPlay
      muted
      playsInline
      onEnded={onDone}
      onError={onDone}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        background: "black",
      }}
    />
  );
}

function AudioSlide({
  item,
  onDone,
}: {
  item: PublicItem;
  onDone: () => void;
}) {
  // Audio plays full-length over a colored card so the screen isn't
  // blank while the sound runs. Smart TVs usually allow audio
  // autoplay even when video autoplay is restricted.
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        color: "white",
      }}
    >
      <div style={{ fontSize: 96 }}>🔊</div>
      <div style={{ fontSize: 28, opacity: 0.85, textAlign: "center", padding: "0 24px" }}>
        Now playing
      </div>
      <audio
        src={item.mediaUrl}
        autoPlay
        onEnded={onDone}
        onError={onDone}
      />
    </div>
  );
}

function PdfSlide({
  item,
  defaultDuration,
  onDone,
}: {
  item: PublicItem;
  defaultDuration: number;
  onDone: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  // Hold the loaded pdf doc across page renders so we don't re-fetch
  // for every page tick.
  const docRef = useRef<unknown>(null);
  const [loadError, setLoadError] = useState(false);

  // Load doc once per item.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const task = pdfjsLib.getDocument({ url: item.mediaUrl });
        const doc = await task.promise;
        if (cancelled) {
          await doc.destroy?.();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setPageIdx(0);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[display] pdf load failed", e);
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
      const d = docRef.current as { destroy?: () => Promise<void> } | null;
      void d?.destroy?.();
      docRef.current = null;
    };
  }, [item.mediaUrl]);

  // Render the current page into the canvas whenever pageIdx changes.
  useEffect(() => {
    if (pageCount === null) return;
    const doc = docRef.current as {
      getPage?: (n: number) => Promise<unknown>;
    } | null;
    const canvas = canvasRef.current;
    if (!doc || !canvas || !doc.getPage) return;
    // Capture into a local so the async IIFE can't lose the narrowing.
    const getPage = doc.getPage;
    let cancelled = false;
    (async () => {
      try {
        const page = (await getPage(pageIdx + 1)) as {
          getViewport: (opts: { scale: number }) => {
            width: number;
            height: number;
          };
          render: (opts: {
            canvasContext: CanvasRenderingContext2D;
            viewport: unknown;
            canvas: HTMLCanvasElement;
          }) => { promise: Promise<void> };
        };
        // Compute a scale that makes the page fit the viewport while
        // keeping high resolution on large 4K displays.
        const baseViewport = page.getViewport({ scale: 1 });
        const targetW = window.innerWidth;
        const targetH = window.innerHeight;
        const scale = Math.min(
          targetW / baseViewport.width,
          targetH / baseViewport.height,
        );
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        });
        await renderTask.promise;
        if (cancelled) return;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[display] pdf page render failed", e);
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageIdx, pageCount]);

  // Per-page timer. Once we run off the last page, hand back to the
  // outer cycler so the next item plays.
  useEffect(() => {
    if (pageCount === null || loadError) return;
    const dur = (item.durationSeconds ?? defaultDuration) * 1000;
    const t = window.setTimeout(() => {
      if (pageIdx + 1 >= pageCount) {
        onDone();
      } else {
        setPageIdx((i) => i + 1);
      }
    }, dur);
    return () => window.clearTimeout(t);
  }, [pageIdx, pageCount, item.durationSeconds, defaultDuration, onDone, loadError]);

  // If the PDF fails to load, skip to the next slide instead of
  // freezing the cycler.
  useEffect(() => {
    if (!loadError) return;
    const t = window.setTimeout(onDone, 1000);
    return () => window.clearTimeout(t);
  }, [loadError, onDone]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "black",
      }}
    >
      <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "100%" }} />
    </div>
  );
}

// ===================================================================
// PBIS Houses slide
// ===================================================================

function HouseSlide({
  data,
  durationSeconds,
  onDone,
}: {
  data: NonNullable<PublicPlaylist["houseData"]>;
  durationSeconds: number;
  onDone: () => void;
}) {
  useTimer(durationSeconds, onDone);

  const max = Math.max(1, ...data.houses.map((h) => h.totalPoints));

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateColumns: "1.2fr 1fr",
        gap: 24,
        padding: 40,
        boxSizing: "border-box",
        background: "linear-gradient(135deg, #0f172a 0%, #111827 100%)",
        color: "white",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ fontSize: 48, fontWeight: 800, marginBottom: 12 }}>
          🏆 PBIS Houses
        </div>
        <div style={{ opacity: 0.7, fontSize: 18, marginBottom: 24 }}>
          Standings this school year
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          {data.houses.map((h) => {
            const pct = (h.totalPoints / max) * 100;
            return (
              <div key={h.id}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 22,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontWeight: 700 }}>{h.name}</span>
                  <span style={{ fontWeight: 700, color: h.color }}>
                    {h.totalPoints.toLocaleString()}
                  </span>
                </div>
                <div
                  style={{
                    height: 18,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.08)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: h.color,
                      borderRadius: 999,
                      transition: "width 600ms ease",
                    }}
                  />
                </div>
                {h.motto && (
                  <div style={{ opacity: 0.55, fontSize: 13, marginTop: 4 }}>
                    {h.motto}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>
          Recent shoutouts
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {data.recent.slice(0, 8).map((r) => (
            <div
              key={r.id}
              style={{
                background: "rgba(255,255,255,0.06)",
                borderLeft: `4px solid ${r.houseColor ?? "#94a3b8"}`,
                borderRadius: 8,
                padding: "10px 12px",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 17 }}>
                {r.firstName} {r.lastName}{" "}
                <span style={{ color: "#fbbf24" }}>+{r.points}</span>
              </div>
              {r.note && (
                <div
                  style={{
                    opacity: 0.7,
                    fontSize: 13,
                    marginTop: 2,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {r.note}
                </div>
              )}
            </div>
          ))}
          {data.recent.length === 0 && (
            <div style={{ opacity: 0.5 }}>No recognitions yet this week.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ===================================================================
// Active hall passes slide. Same advance contract as HouseSlide:
// auto-advances after `durationSeconds` via the shared useTimer.
// ===================================================================

function HallPassesSlide({
  data,
  durationSeconds,
  onDone,
}: {
  data: HallPassData;
  durationSeconds: number;
  onDone: () => void;
}) {
  useTimer(durationSeconds, onDone);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(135deg, #0b1220 0%, #111827 100%)",
        color: "white",
        padding: "48px 56px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
        <div style={{ fontSize: 48, fontWeight: 800 }}>🚪 Active Hall Passes</div>
        <div style={{ fontSize: 18, opacity: 0.7 }}>
          {data.passes.length} student{data.passes.length === 1 ? "" : "s"} out
        </div>
      </div>
      {data.passes.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 28,
            opacity: 0.55,
          }}
        >
          No active hall passes right now.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
            gap: 14,
            overflow: "hidden",
          }}
        >
          {data.passes.slice(0, 12).map((p) => (
            <ActivePassCard key={p.id} pass={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// ===================================================================
// Pickup queue slide. Mirrors HallPassesSlide's contract — auto-
// advances after `durationSeconds`. Server already filtered to the
// playlist owner's roster (when set), so we just render what arrives.
// Read-only on purpose: TVs aren't authenticated, so the teacher's
// "released to walk" action lives in the staff curb page, not here.
// ===================================================================
function PickupQueueSlide({
  data,
  durationSeconds,
  onDone,
}: {
  data: PickupQueueData;
  durationSeconds: number;
  onDone: () => void;
}) {
  useTimer(durationSeconds, onDone);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(135deg, #042f2e 0%, #134e4a 100%)",
        color: "white",
        padding: "48px 56px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
        <div style={{ fontSize: 48, fontWeight: 800 }}>🚗 Pick-Up Line</div>
        <div style={{ fontSize: 18, opacity: 0.7 }}>
          {data.queue.length} waiting
          {data.ownerFiltered ? " · your students" : " · school-wide"}
        </div>
      </div>
      {data.queue.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 28,
            opacity: 0.55,
          }}
        >
          No students in the pick-up line right now.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 14,
            overflow: "hidden",
          }}
        >
          {data.queue.slice(0, 12).map((e) => {
            const accent = e.status === "walking_out" ? "#22c55e" : "#fbbf24";
            return (
              <div
                key={`${e.position}-${e.studentLabel}`}
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: `1px solid ${accent}`,
                  borderLeft: `5px solid ${accent}`,
                  borderRadius: 10,
                  padding: "12px 16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 22 }}>
                    {e.studentLabel}
                  </div>
                  <div
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 700,
                      color: accent,
                      fontSize: 20,
                    }}
                  >
                    #{e.position}
                  </div>
                </div>
                <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
                  {e.grade !== null ? `Grade ${e.grade} · ` : ""}
                  {e.status === "walking_out"
                    ? "Released — walking out"
                    : "In line"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivePassCard({ pass }: { pass: ActivePass }) {
  const accent = pass.isOverdue ? "#ef4444" : "#3b82f6";
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.05)",
        border: `1px solid ${accent}`,
        borderLeft: `5px solid ${accent}`,
        borderRadius: 10,
        padding: "12px 16px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 22 }}>{pass.studentLabel}</div>
        <div
          style={{
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
            color: accent,
            fontSize: 20,
          }}
        >
          {pass.minutesOpen}m
          {pass.isOverdue ? " ⚠" : ""}
        </div>
      </div>
      <div style={{ fontSize: 16, opacity: 0.85, marginTop: 4 }}>
        {pass.originRoom} → {pass.destination}
      </div>
      <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4 }}>
        Limit {pass.maxDurationMinutes}m
      </div>
    </div>
  );
}

// ===================================================================
// Standalone "/display/passes/<schoolId>" page. Same full-bleed shell
// as the cycler, but only ever shows the active-passes view and polls
// every 15s so a hallway TV that opens this URL stays near-realtime.
// ===================================================================

export function HallPassDisplay({ schoolId }: { schoolId: number }) {
  const [data, setData] = useState<HallPassData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchOnce() {
      try {
        const r = await fetch(`/api/displays/public/passes/${schoolId}`);
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const j = (await r.json()) as HallPassData;
        if (cancelled) return;
        setData(j);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Network error");
        }
      }
    }
    void fetchOnce();
    const t = window.setInterval(fetchOnce, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [schoolId]);

  // Re-render once a minute so the elapsed-minutes column ticks up
  // even between full refetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (error) {
    return (
      <div style={{ ...fullBleed, padding: 32 }}>
        <div style={{ fontSize: 24, opacity: 0.85 }}>
          Couldn't load active hall passes.
        </div>
        <div style={{ marginTop: 12, opacity: 0.6, fontSize: 14 }}>{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ ...fullBleed, padding: 32, opacity: 0.7 }}>Loading…</div>
    );
  }
  return (
    <div style={fullBleed}>
      <HallPassesSlide
        data={data}
        // Standalone page — no cycler, so the timer is irrelevant.
        // Pass a giant duration so the no-op onDone never fires.
        durationSeconds={3600}
        onDone={() => {}}
      />
    </div>
  );
}

// ===================================================================
// Heartbeat embed slide.
//
// We render the existing /signage/heartbeat?schoolId=N kiosk page in
// an iframe — it polls /api/pulse/* for itself and already handles
// the "no schoolId" case, so the cycler doesn't need its own data
// path. The slide advances on a timer like the other synthetic slides.
// ===================================================================

function HeartbeatSlide({
  schoolId,
  durationSeconds,
  onDone,
}: {
  schoolId: number;
  durationSeconds: number;
  onDone: () => void;
}) {
  useTimer(durationSeconds, onDone);
  // The heartbeat page is a full-bleed dark UI of its own — no extra
  // chrome needed here. Sandbox blocks navigation away just in case
  // the embedded page ever tries to follow a link (it shouldn't).
  return (
    <iframe
      src={`/signage/heartbeat?schoolId=${encodeURIComponent(String(schoolId))}`}
      title="Today's Heartbeat"
      sandbox="allow-scripts allow-same-origin"
      style={{
        width: "100%",
        height: "100%",
        border: 0,
        display: "block",
        background: "black",
      }}
    />
  );
}
