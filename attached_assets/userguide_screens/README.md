# PulseEDU User Guide — Screenshot Checklist

Drop each PNG in this folder with the exact filename listed.
The PDF generator (`pnpm --filter @workspace/scripts run user-guide`)
will pick them up automatically. Missing files render a placeholder
box, so you can ship partial and iterate.

**Capture tips:**
- Use a desktop browser window ~1400px wide (matches the in-product design).
- Crop to the main content area (drop the global header/sidebar unless it's
  the subject) — final layout targets a 16:10 frame at ~6.5" wide.
- Use realistic data; avoid empty states.
- For role-gated screens, log in as the role listed.

**Top 12** entries are tagged so they get a badge in the PDF and lead
the table of contents.

| # | Filename | Top 12 | Role | Where to find it | What to show |
|---|---|---|---|---|---|
| 1 | `01-hallpass-queue.png` | ★ | Teacher | Sidebar → Hall Passes | Active queue with 2–3 students out, timer running |
| 2 | `02-hallpass-create.png` | ★ | Teacher | Hall Passes → "+ New pass" | New-pass dialog with destination list (restrooms grouped left) |
| 3 | `03-hallpass-tardy.png` | ★ | Teacher | Hall Passes → "Tardy" tab/button | Tardy pass creation form |
| 4 | `04-pbis-hub.png` | ★ | Teacher | Sidebar → PBIS Hub | Class roster with point chips + house badges |
| 5 | `05-pbis-spotlight.png` |  | Teacher | PBIS Hub → Spotlight button | Spotlight reveal modal (1–10 points) |
| 6 | `06-pbis-houses.png` | ★ | Any | PBIS Hub → House standings | Leaderboard with 4 houses + totals |
| 7 | `07-school-store.png` | ★ | Admin | Sidebar → School Store | Catalog grid with images + costs |
| 8 | `08-classroom-store.png` |  | Teacher | Sidebar → Classroom Store | Teacher's personal redeemable list |
| 9 | `09-pickup-curb.png` | ★ | Front office | Browser: `/pickup/curb` | Curb keypad with one car in queue |
| 10 | `10-pickup-walkers.png` |  | Front office | Browser: `/pickup/walkers` | Walker gate with bell-window banner |
| 11 | `11-pickup-tags.png` |  | Admin | Sidebar → Settings → Pickup Tags | Tag issuer table with QR-printable rows |
| 12 | `12-pickup-still-on-campus.png` |  | Admin | Admin Hub → Still on campus tile | Reconciliation tile post-cutoff |
| 13 | `13-safety-plans-list.png` | ★ | Counselor | Sidebar → Safety Plans | List of student safety plans |
| 14 | `14-safety-plans-edit.png` |  | Counselor | Safety Plans → open one → Edit | Checklist editor with library items |
| 15 | `15-mtss-plans.png` | ★ | MTSS Coord | Sidebar → MTSS Plans | Tier 2/3 plan list with goal + progress |
| 16 | `16-mtss-progress.png` |  | MTSS Coord | MTSS Plans → open → progress tab | Weekly progress monitoring chart |
| 17 | `17-teacher-roster.png` | ★ | Teacher | Sidebar → Roster | Roster with FAST scores + ESE/504/ELL flags |
| 18 | `18-display-playlists.png` | ★ | Admin | Sidebar → Displays | Playlist editor with image/video/PDF items |
| 19 | `19-display-signage-tile.png` |  | Any | Browser: `/signage/<playlistId>` | Live signage TV view with PBIS standings tile |
| 20 | `20-parent-portal.png` | ★ | Parent | Browser: `/parent` (logged in as parent) | Parent dashboard with HeartBEAT data |
| 21 | `21-parent-invite-admin.png` |  | Admin | Settings → Parent invites | Admin invite issuer table |
| 22 | `22-insights-engagement.png` | ★ | Admin | Sidebar → Insights → Engagement | Engagement dashboard with charts |
| 23 | `23-insights-behavior.png` |  | Admin | Insights → Behavior | Behavior dashboard with trends |
| 24 | `24-insights-early-warning.png` |  | Admin | Insights → Early Warning | Early warning list with risk flags |
| 25 | `25-data-importer.png` |  | Admin | Settings → Data Importer | CSV upload + preview + commit step |

**Capture order suggestion (saves login switching):**
1. Admin role: 7, 11, 12, 18, 21, 22, 23, 24, 25
2. Teacher role: 1, 2, 3, 4, 5, 6, 8, 13, 14, 17
3. MTSS Coord / Counselor (or admin if you wear those hats): 15, 16
4. Front office: 9, 10 (or admin — curb/walkers are unauth in your seed)
5. Parent: 20
6. Public signage: 19

When you've dropped them all in, run `pnpm --filter @workspace/scripts run user-guide` (or just tell me) and I'll regenerate the PDF.
