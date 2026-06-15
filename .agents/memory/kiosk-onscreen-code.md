---
name: Kiosk activation code surfaces (on-screen + self-service)
description: Rules for any surface that emits a kiosk activation QR/code, and for teacher self-service token rotation.
---

# Kiosk activation code surfaces

**Two-step QR pattern (staff-app QR → phone mirror → kiosk activation
QR).** There are TWO different QR payloads, do not conflate them:
- The QR the **kiosk camera** reads must encode the kiosk parser payload:
  `${kioskUrl}?enroll=<encodeURIComponent(token)>` (same format the
  printed card uses). `extractToken` (Kiosk.tsx) accepts a full `?enroll=`
  URL or a bare token ≥16 chars; Code128 of the bare token covers 1D
  scanners.
- The QR the **staff app shows on a computer** must NOT encode `?enroll=`
  directly. It encodes the phone "carry over" mirror page URL
  `${origin}${BASE_URL}kiosk-code#t=<token>&p=<pin>` (route =
  `KioskCodeMirror.tsx`, dispatched in main.tsx BEFORE `/kiosk`). The
  mirror page is public, does no server call/activation, and just renders
  the real activation QR (`?enroll=`) + PIN + barcode from the hash.

**Why:** opening `?enroll=` on ANY device auto-activates (Kiosk.tsx calls
`beginEnrollActivation` from the URL param). So if the computer QR encoded
`?enroll=` and a teacher scanned it WITH A PHONE, the phone would activate
the kiosk (wrong device). The teacher's phone must instead carry the code
so they can hold the PHONE up to the kiosk camera. Token+PIN ride in the
URL **hash fragment** (not query) so they are never sent to the server /
Referer.

**How to label:** the computer card says "scan this with your phone to
carry the code over, then hold your phone up to the kiosk camera."  The
phone mirror says "hold this screen up to the kiosk camera."

**Self-service rotation is self-scoped, no staffId param.** Teacher
"generate a new code" = `POST /kiosk/my-code/regenerate` (requireStaff),
identity derived only from `req.staff` (schoolId+id). It reuses the same
`issueEnrollToken` engine admins use (atomic revoke-old + mint-new +
audit), tagged reason `self_regenerate` so admins keep visibility.
Rotating kills the old code for FUTURE activations but does NOT drop a
live kiosk session — ending live sessions is the separate self-scoped
`POST /kiosk/my-active/revoke-all`.

**How to apply:** when adding any student/teacher-facing activation-code
surface (on-screen, email, PDF), reuse the `?enroll=` URL format and the
existing issue/revoke endpoints; never invent a new token payload or an
admin-only path for a self-service action.
