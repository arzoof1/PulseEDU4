# Using the Pulse-style logo in another app

You have three artifacts per brand variant:

- `<brand>-animated.svg` — animated EKG sweep (use in the app header)
- `<brand>-static.svg` — same look, no animation (PDF, print, email)
- `<brand>-favicon.svg` / `<brand>-favicon.png` — 180×180 / 512×512 app icon

All three are self-contained: no external CSS, no font downloads, no JS.
Just drop the file into the new app and reference it.

## Web (vanilla HTML)

```html
<!-- Header logo -->
<header style="display:flex;align-items:center;padding:16px 24px;
               background:#0f172a;color:white;">
  <img src="./pulsetv-animated.svg" alt="PulseTV" height="40">
</header>

<!-- Browser tab + iOS icon -->
<link rel="icon" type="image/svg+xml" href="./pulsetv-favicon.svg">
<link rel="apple-touch-icon" href="./pulsetv-favicon.png">
```

## Web (React + Vite)

Drop the SVG into `src/assets/` and import it:

```tsx
import logo from "./assets/pulsetv-animated.svg";

export function Header() {
  return (
    <header className="app-header">
      <img src={logo} alt="PulseTV" height={40} />
    </header>
  );
}
```

## Web (Next.js)

Put the SVG in `public/` and reference by absolute path:

```tsx
<img src="/pulsetv-animated.svg" alt="PulseTV" height={40} />
```

> Don't use `next/image` for the animated SVG — Next will rasterize it
> and you'll lose the animation. Plain `<img>` keeps the SVG live.

## iOS / Android / PWA

Use `<brand>-favicon.png` (512×512). For PWA `manifest.json`:

```json
{
  "name": "PulseTV",
  "icons": [
    { "src": "/pulsetv-favicon.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

## Slides, docs, social

Use the static SVG or PNG — the animated SVG won't render in PowerPoint,
Google Slides, Word, or PDF exports.

## To match PulseEDU's exact header layout

The PulseEDU app header puts the logo to the left, then the
notification bell, then header controls. Minimum CSS to mimic:

```css
.app-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  background: var(--surface, #0f172a);
  border-bottom: 1px solid var(--border, #1e293b);
}
.app-header img { height: 40px; }
```

That's it — the SVG handles the wordmark gradient, the EKG track, the
animated pulse, and the soft glow internally.

## Changing the brand later

Open `pulse-logo-generator.html` (the local generator) — or, inside
PulseEDU, go to **Settings → Brand Logo Generator** (admin/SuperUser
only). Type a new name, pick new gradient stops, hit download.
