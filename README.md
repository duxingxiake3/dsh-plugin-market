# Plugin Market

Plugin Market adds a **Market** page to DeepSeek Harness: it discovers DSH plugins from the
npm registry and GitHub, shows what each one does, screenshots where the author provides
them, and reviews a plugin with a model before anything is installed.

Open it from either entry:

- the **Plugin Market** icon in the sidebar (next to the shipped **Plugins** button)
- **Settings → Built-in plugins → Market** tab

Once a plugin is installed, the shipped **Plugins** page owns it — enabling, configuring and
removing all happen there, and the Market links you straight to it.

![The Market list](dsh-market/screenshots/market-list.png)

<p align="center">
  <img src="dsh-market/screenshots/market-detail.png" width="49%" alt="A plugin detail page">
  <img src="dsh-market/screenshots/risk-review.png" width="49%" alt="The pre-install risk review">
</p>

## Install

**From DSH itself.** Open **Plugins → Add plugin**, enter the package name, and approve it:

```
dsh-plugin-market
```

Or point straight at the repository, which works before any npm release:

```
github:OWNER/dsh-plugin-market
```

**Manually**, by adding two entries to your profile's `package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-plugin-market"] } },
  "dependencies": { "dsh-plugin-market": "link:/path/to/dsh-plugin-market" }
}
```

then reinstall the profile's dependencies and restart DSH.

The host half is loaded at startup, so **a restart is required**; the browser half reloads on
its own while DSH is running.

---

## For plugin authors

You do not have to do anything for your plugin to appear in the Market. It is discovered
from the `dsh-plugin` keyword on npm and from GitHub, and the Market falls back to your
`README.md` for screenshots and to your `package.json` for the name and description.

Everything below is optional. It is how you make your listing **accurate** — the correct
logo, a description that says what the plugin actually does, and screenshots of the real UI.

### Create one folder: `dsh-market/`

Put everything the Market shows into a single folder at the root of your repository:

```text
your-plugin/
├─ package.json          ← point "icon" at the logo inside the folder
├─ README.md
└─ dsh-market/
   ├─ market.json        ← the description, developer and screenshot list
   ├─ logo.svg           ← your logo
   └─ screenshots/
      ├─ dashboard.png
      └─ settings.png
```

One folder keeps your repository root clean, and deleting it removes your listing metadata
in one step. A root-level `dsh-market.json` also still works if you prefer a single file;
if both exist, `dsh-market/market.json` wins.

### Where each thing goes

Three things describe your plugin, and each is declared in a different place. This table is
the whole convention; the sections below give the rules for each one.

| What the reader sees | You put it in | Declared by |
|---|---|---|
| The long description, developer line, homepage, licence | `dsh-market/market.json` | the `description`, `developer`, `homepage`, `license` fields |
| The one-line summary under the title | `dsh-market/market.json` | `summary` |
| Screenshots of your UI | `dsh-market/screenshots/` | the `screenshots[].url` list in `market.json` |
| Your logo | `dsh-market/logo.svg` | `icon` in `package.json` (optionally `logo` in `market.json`) |

### A worked example: this plugin's own folder

This repository is listed in the Market by the same convention it documents. Its own
`dsh-market/` folder is the reference — copy its shape:

```text
dsh-plugin-market/
├─ package.json                  "icon": "./dsh-market/logo.svg"
└─ dsh-market/
   ├─ market.json                displayName, developer, logo, summary, description,
   │                             screenshots[] with per-language captions, license
   ├─ logo.svg                   the logo, referenced by package.json `icon`
   └─ screenshots/
      ├─ market-list.png
      ├─ market-detail.png
      └─ risk-review.png
```

Nothing outside this folder is needed for the listing, and deleting the folder removes the
whole thing without touching the plugin.

### Relative paths: two rules, and they differ

This is the one thing that trips people up, so it is worth reading twice. A path in
`package.json` is resolved as a **file inside your package**; a path in `market.json` is
resolved as a **file in your repository**. The same logo therefore needs two spellings:

| Field | Resolved as | Write |
|---|---|---|
| `package.json` → `icon` | a file on disk, relative to `package.json` | `./dsh-market/logo.svg` |
| `market.json` → `logo` | a repository path, appended to `raw.githubusercontent.com/<owner>/<repo>/<branch>/` | `dsh-market/logo.svg` |
| `market.json` → `screenshots[].url` | the same repository path | `dsh-market/screenshots/dashboard.png` |

A descriptor path may also be a full `https://` URL on an allowed host (`raw.githubusercontent.com`,
`user-images.githubusercontent.com`, `objects.githubusercontent.com`, `avatars.githubusercontent.com`);
any other host is refused, because rendering it would reveal every reader's IP address to that
server. Package-relative paths such as `./dsh-market/logo.svg` do **not** work as repository
paths — the leading `./` is stripped, so the resulting URL 404s and the logo silently falls
back to the letter tile.

### 1. The logo

The logo is declared through `icon`, the standard manifest field. The shipped Plugins page
reads it too, so one declaration serves both surfaces:

```json
{
  "icon": "./dsh-market/logo.svg"
}
```

| Rule | Value |
|---|---|
| Formats | `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp` |
| Maximum size | 256 KiB |
| Location | must resolve inside your package directory |
| Shape | square, drawn to a 36×36 canvas — it is rendered at 36px inside a 48px tile |

If you would rather keep the manifest untouched, put `"logo": "dsh-market/logo.svg"` in
`market.json` instead. It overrides `icon` **for the Market only** — the shipped Plugins page
still reads `icon`, so with that arrangement the two pages can show different logos.

The shipped icons are **solid filled paths with a `userSpaceOnUse` linear gradient**, and the
glyph fills roughly 50–58% of the canvas. An outline drawing with a thin `stroke` looks
visibly lighter than everything around it. If you want yours to sit naturally in the list,
copy one of the icons out of the DSH installation and match its construction.

### 2. `dsh-market/market.json`

Every field is optional, and every text field accepts either a plain string or a
per-language object (`{"zh": "…", "en": "…"}`). Omitted fields fall back to your
`package.json` and `README.md`.

```json
{
  "schemaVersion": 1,
  "displayName": { "zh": "上下文面板", "en": "Context Panel" },
  "developer": { "name": "Your Name", "url": "https://github.com/you" },
  "summary": {
    "zh": "在会话里查看上下文占用与工具调用细节。",
    "en": "Inspect context usage and tool-call detail inside a session."
  },
  "description": {
    "zh": "较长的一段介绍，显示在详情页的正文位置。",
    "en": "The longer introduction, shown as the detail page body."
  },
  "homepage": "https://example.com",
  "license": "MIT",
  "screenshots": [
    { "url": "dsh-market/screenshots/dashboard.png", "caption": { "zh": "主面板", "en": "Dashboard" } },
    { "url": "dsh-market/screenshots/settings.png", "caption": { "zh": "设置页", "en": "Settings" } }
  ]
}
```

| Field | Effect |
|---|---|
| `displayName` | the title on the card and detail page (default: your package name) |
| `developer.name` / `developer.url` | the developer line (default: `package.json` author, then the repo owner) |
| `summary` | the one or two lines shown under the title |
| `description` | the long text on the detail page |
| `homepage`, `license` | metadata rows on the detail page |
| `screenshots[].url` | repository-relative path, or an absolute URL on an allowed host |
| `screenshots[].caption` | the caption under the image and in the full-screen viewer |
| `logo` | optional; a repository-relative path or allowed URL — overrides the `package.json` `icon` for the Market only |

### 3. Screenshots

Point `url` at a file in your repository. A path relative to the repository root is easiest,
and note the spelling: no leading `./`, because the path is appended to the repository's raw
URL rather than resolved against your package:

```json
"screenshots": [
  { "url": "dsh-market/screenshots/dashboard.png", "caption": { "zh": "主面板", "en": "Dashboard" } },
  { "url": "dsh-market/screenshots/settings.png",  "caption": { "zh": "设置页", "en": "Settings" } }
]
```

Listed screenshots win over anything found in your README, and they keep the order you give
them. A caption is optional but worth adding: it is shown under the image and in the
full-screen viewer, and it is the only text a reader sees next to the picture.

**If you ship no descriptor at all**, the Market reads the images you already embedded in
your `README.md`, in markdown or HTML form, and uses those. Keeping the best screenshots
near the top of the README helps, because earlier images rank higher.

What the Market checks before showing an image:

| Rule | Why |
|---|---|
| Host must be `raw.githubusercontent.com`, `user-images.githubusercontent.com`, `objects.githubusercontent.com` or `avatars.githubusercontent.com`, over https | Showing an image hosted elsewhere would reveal every reader's IP address to that server |
| The file must actually decode as PNG, JPEG, GIF, WebP or SVG | A URL that returns `200` is not proof of a picture — error pages and tracking pixels do too |
| Shortest edge ≥ 240px, longest ≤ 5000px, at most 6 MiB | Keeps out icons, banners and dead weight |
| At most 6 images are shown | A listing is a summary, not a gallery |
| Badges, logos, QR codes, group-chat posters and social-preview cards are filtered out by name | They are never a picture of the UI |

In the README path an `.svg` is only considered when its file name or alt text names a UI
surface (`preview-en.svg` yes, `logo-en.svg` and `architecture.svg` no), because a vector
next to a README is usually a logo or a diagram.

Screenshots open in a full-screen viewer: click one to enlarge, and again to switch between
fit-to-window and actual size.

### 4. Language

Write your `summary` and `description` in the language you are comfortable with. When the
reader's language differs, the Market translates it once with a model and caches the result,
keyed by the text — so editing your description is what triggers a new translation, and
nothing else does. The translated line is always labelled as machine-translated, and your
original stays available in the tooltip.

You can supply the translation yourself instead, per field, which always wins:

```json
"summary": { "zh": "……", "en": "……" }
```

Your `README.md` is shown as written and is never machine-translated.

---

## Configuration

| Variable | Effect |
|---|---|
| `DSH_MARKET_GITHUB_TOKEN` | GitHub token used for search. Without it, GitHub search is limited to 10 requests per minute (unauthenticated). `GITHUB_TOKEN` and `GH_TOKEN` are also read. |
| `DSH_MARKET_CACHE_DIR` | Where the translation cache is written. Defaults to `<DSH_HOME>/cache/dsh-market`. |

## Privacy and safety

- **Every request is authenticated.** The page reaches the plugin through an exact route on
  the `/api` channel, which the connection layer wraps in its Host/Origin fence and
  browser-cookie authentication. An unauthenticated request is answered `401`.
- **Images are loaded from the code host only**, so viewing a listing does not announce the
  reader to a third party. Images are rendered with `referrerPolicy="no-referrer"`.
- **Nothing installs without a review.** Clicking install runs a deterministic rule scan
  plus a model review over the plugin's manifest and entry code, shows the findings, and
  requires an explicit confirmation. The confirmation is a single-use ticket issued by the
  review, so the check cannot be skipped by calling the route directly.
- **Third-party code is treated as untrusted data.** A review never follows instructions
  found inside a plugin's source, and a plugin claiming to be safe does not lower its own
  result.
- **Build scripts are never auto-approved.** When pnpm blocks `postinstall` and friends, the
  names are shown and you approve them explicitly or not at all.
- **Translations are cached locally** and never sent anywhere except the configured model.

## Licence

[MIT](LICENSE).
