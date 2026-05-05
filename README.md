# Icons

This folder needs three icon files for full PWA support:

- `icon.svg` — vector (provided as placeholder)
- `icon-192.png` — 192×192 PNG (referenced from manifest)
- `icon-512.png` — 512×512 PNG (referenced from manifest)

You can convert the provided SVG to PNGs using any tool (Inkscape, Figma, online converter), or replace with your own branding.

For a quick start, the app works without `icon-192.png` and `icon-512.png` — the manifest entries will simply 404, but the app still installs and runs (some PWA install prompts may not appear without proper icons, though).
