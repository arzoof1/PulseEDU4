---
name: Kiosk activation code surfaces (on-screen + self-service)
description: Rules for any surface that emits a kiosk activation QR/code, and for teacher self-service token rotation.
---

# Kiosk activation code surfaces

**Any QR that should activate a kiosk must encode the SAME payload the
kiosk's camera parser expects:** `${kioskUrl}?enroll=<encodeURIComponent(token)>`
(the format the printed card uses). The kiosk's `extractToken` accepts a
full URL with `?enroll=` or a bare token ≥16 chars; emit the URL form so
phone-camera and kiosk-camera both work. Code128 of the bare token covers
1D scanners.

**Why:** a teacher's phone scanning the QR opens the URL *on the phone*
(activates the wrong device). The working zero-typing path is the KIOSK
camera reading the code off the phone — so the on-screen code is for the
kiosk to read, or for the teacher to read the PIN and type. Label it
"hold up to the kiosk camera, or type the code," never "scan with your
phone to send it."

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
