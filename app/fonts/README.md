# Fonts (not shipped)

The original self-hosted woff2 files are intentionally **not** included in this
repo snapshot:

- `plus-jakarta-sans-latin-200800.woff2`
- `ibm-plex-mono-latin-400.woff2`
- `ibm-plex-mono-latin-500.woff2`
- `ibm-plex-mono-latin-600.woff2`

`app/layout.tsx` currently falls back to system font stacks (defined as
`--font-jakarta` / `--font-plex-mono` in `app/globals.css`), so the app builds
and runs fine without them.

To restore the original fonts: drop the four woff2 files into this directory
and switch `app/layout.tsx` back to `next/font/local`.
