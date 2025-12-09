# Social Manager – Build & Versioning Guide

## Overview
- **Stack:** Vanilla HTML, CSS (`styles.css`), and JavaScript (`app.js`)
- **App type:** Progressive Web App with offline support via `service-worker.js`
- **Goal:** Provide a multi-network social inbox with optional AI drafting powered by GitHub Models

## Architecture Snapshot
| Layer | File(s) | Notes |
| --- | --- | --- |
| UI Shell | `index.html`, `styles.css` | Static markup + responsive styling optimized for GitHub Pages. |
| Application Logic | `app.js` | Manages provider integrations, local storage, and PWA install prompt. |
| Offline & Caching | `service-worker.js` | Pre-caches versioned assets and performs stale-while-revalidate fetches. |
| Manifest & Assets | `manifest.webmanifest`, `icon.svg` | Enable install hints, theming, and icons. |

## Build Process
1. **Version template:** Source files refer to the placeholder `__APP_VERSION__` (e.g., `./app.js?v=__APP_VERSION__`).
2. **Commit-aware build:** `scripts/set-version.js` resolves the version in this priority order:
   1. `APP_VERSION` environment variable
   2. `GITHUB_SHA` (first 7 chars)
   3. `git rev-parse --short HEAD`
3. **Artifact layout:** The script copies key assets into `dist/`, replacing every `__APP_VERSION__` placeholder with the resolved commit identifier.

> 🔁 **Result:** Each deployment produces cache-busting URLs (`app.js?v=abcd123`) and unique service-worker cache names (`social-manager-abcd123`).

## GitHub Pages Pipeline
The updated `.github/workflows/static.yml` performs the following steps on `main`:
1. Checkout sources
2. Install Node.js 20 using `actions/setup-node@v4`
3. Run `node scripts/set-version.js` to generate `dist/`
4. Upload `dist/` via `actions/upload-pages-artifact@v3`
5. Publish with `actions/deploy-pages@v4`

> ✨ No bundler is required; the build is repeatable and fast, relying solely on the version script for cache-busting.

## Local Development
```bash
npm install  # (optional, no dependencies required today)
node scripts/set-version.js
python3 -m http.server 8001 --directory dist
```
Open `http://localhost:8001` to preview the production-ready output with commit-based versions.

## Notes for Agents
- **Adding new static assets?** Update `SOURCE_FILES` in `scripts/set-version.js` so they’re copied into `dist/`.
- **Changing version strategy?** Modify `resolveVersion()` to match your requirements (e.g., tag names, semantic versioning).
- **Extending deployment?** Reuse the `dist/` folder for any host that expects pre-built assets; only the placeholder replacement step is essential.

Happy shipping! 🚀
