# 漫画 Reader

A manga reader for iPad that streams your collection straight from a Google Drive folder. Nothing is stored on the iPad except small cover thumbnails and your reading progress.

- Library of series with cover art, sorted by title, recently read or recently added, with search and filters
- Volumes in order (第1巻, 第2巻 …), with progress bars and a "Continue reading" shelf
- Reads ZIP/CBZ volumes and folders of images. ZIPs are read page by page with HTTP range requests, so a 100 MB volume is never downloaded in full
- Right-to-left by default, two-page spreads in landscape, swipe or tap to turn, pinch or double-tap to zoom
- Remembers your page in every volume and offers the next volume at the end
- Read-only Google Drive access. It never changes anything in your Drive

## One-time setup: Google sign-in key

1. Go to <https://console.cloud.google.com/projectcreate> and create a project (any name, e.g. `manga-reader`).
2. Enable the Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com> → **Enable**.
3. Set up the consent screen: <https://console.cloud.google.com/auth/overview> → **Get started**. App name `漫画 Reader`, your email as support and contact email, Audience **External**. Then on **Audience**, under **Test users**, add your own Gmail address.
4. On **Data access** → **Add or remove scopes**, add `https://www.googleapis.com/auth/drive.readonly` and save.
5. Create the key: **Clients** → **Create client** → type **Web application**.
   - Authorized JavaScript origins: `https://ken13hockey-eng.github.io`
   - Authorized redirect URIs: `https://ken13hockey-eng.github.io/manga-reader/`
6. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and either put it in `config.js` or paste it into the app's setup screen.

Because the app stays in "Testing" mode, Google shows a "Google hasn't verified this app" screen when you sign in. Tap **Continue**. That is expected for a personal app.

## On the iPad

1. Open <https://ken13hockey-eng.github.io/manga-reader/> in Safari and sign in.
2. Tap the Share button → **Add to Home Screen**. It now opens full screen like an app.

Google sign-ins last one hour. When it runs out, a "Reconnect" button appears, and you come back to the same page.

## Reading controls

| Action | Right-to-left (default) |
| --- | --- |
| Next page | Tap the left side, or swipe right |
| Previous page | Tap the right side, or swipe left |
| Menu, page slider, settings | Tap the middle |
| Zoom | Pinch, or double-tap the middle |
| Mark read/unread | Press and hold a volume cover |

## Notes

- RAR/CBR and PDF volumes are listed but cannot be opened yet.
- When a volume exists both as a folder and a ZIP, the folder is used.
- The Drive folder name (default `漫画`) can be changed in Settings.
