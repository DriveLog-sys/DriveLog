# DriveLog — app.js Module Split (reference)

`app.js` (formerly one 7,845-line file) is now split into 26 files under `js/`,
grouped by feature. **Nothing about how the site runs has changed** — no ES
modules, no bundler magic. `build.sh` concatenates these files in a fixed
order into `app.combined.js`, then minifies that into `app.min.js` exactly
like before. `index.html` is untouched: it still loads `data.min.js` →
`db.min.js` → `app.min.js`, same three `<script>` tags, same load order.

This was verified three ways before shipping:
1. Reassembling all 26 files in original file order reproduces `app.js`
   byte-for-byte.
2. The concatenated bundle, run in a stubbed browser environment, executes
   top-to-bottom with no reference errors.
3. Minifying the new bundle with esbuild produces a file **exactly the same
   byte size** as minifying your original `app.js` directly (237,776 bytes —
   matches your currently-deployed `app_min.js`).

## File map

| File | Contents |
|---|---|
| `core.js` | `S` state object, `_avCache`, boot-time prefetch helpers, `save()`/cache persistence, avatar helpers, generic utils (`el`, `esc`, `toast`, `fmtDate`, `timeAgo`, `accountAge`, `compressImage`, etc.) |
| `nav.js` | `goTo()`, header, mobile nav drawer, URL routing, page loader, SEO meta tags |
| `auth.js` | Sign in/up/out, Google sign-in, onboarding modal |
| `home.js` | Stats counters, Build of the Week, Hot Right Now slider |
| `search.js` | Header search + full search overlay |
| `post-form.js` | Post/edit build form, image & video upload |
| `car-detail.js` | Legacy car modal, full car detail page, comments, timeline, cost tracker |
| `notifications.js` | Notification bell, page, and list rendering |
| `follow.js` | Follow/unfollow |
| `feed.js` | Main feed, filters, cards, infinite scroll |
| `categories.js` | Categories grid page |
| `leaderboard.js` | Leaderboard tabs, Build of the Month voting |
| `events.js` | Events page |
| `members.js` | Members directory |
| `profile.js` | Public/own profile pages |
| `garage.js` | Garage (liked/saved/shared/parts/socials) |
| `messages.js` | Direct messages |
| `reactions.js` | Post reactions (fire/clean/wow/laugh) |
| `reports.js` | Report modal |
| `awards.js` | Award grant/revoke/render |
| `compare.js` | Build comparison tool |
| `challenges.js` | Weekly challenges |
| `admin.js` | Admin panel |
| `theme.js` | Light/dark toggle |
| `social.js` | Car Spotting: composer, blur editor, social feed |
| `boot.js` | The actual boot sequence — `_initSb()`/`startPrefetch()` call, the two `DOMContentLoaded` handlers, `popstate`/`storage`/`visibilitychange`/`pageshow` listeners. **Loads last** in the bundle so everything it wires up is already defined. |

## Editing workflow going forward

1. Find the right file in `js/` using the table above (or `grep -rn functionName js/`).
2. Edit it directly — it's a normal, if still substantial, JS file (biggest is
   `car-detail.js` at ~1,170 lines, vs. the old 7,845-line single file).
3. Run `bash build.sh` as always. It now builds `app.min.js` from `js/*.js`
   instead of from a single `app.js`.
4. Commit `js/`, `build.sh`, `app.min.js`, `db.min.js`, `data.min.js`,
   `main.min.css`, and `index.html`. `app.combined.js` is a build artifact —
   fine to `.gitignore` it, or commit it, your call.

## Things to double check on your end

- **Delete or archive the old monolithic `app.js`** once you've confirmed
  the split works — `build.sh` no longer reads it, and leaving both around
  risks someone editing the stale one by mistake.
- **Run `bash build.sh` and load the site locally before deploying** — I
  validated syntax, execution-without-throwing, and minified byte-size
  parity, but I can't load the actual page in a browser from here, so a
  real smoke test on your end (open the site, click through feed → post →
  car page → messages → admin) is the last mile.
- **`main.css` was intentionally left untouched** in this pass — same file,
  same "one mobile block" question flagged separately. Splitting CSS is a
  reasonable next step but a separate piece of work; didn't want to change
  JS and CSS structure in the same pass.

## One pre-existing quirk I found while splitting (not something I changed)

`app.js` defines `avColor()` **twice**: once implicitly via `data.js`
(colorful per-letter palette), and again inside `app.js` itself at the old
line 872, which simply does `return '#6b7280'` (flat gray) for every user.
Because `app.js` loads after `data.js`, **the gray version silently wins for
the entire site** — the colorful `AV_COLORS` palette in `data.js` is dead
code. I preserved this exactly as-is (kept the override in `core.js`) since
the instruction was "don't break anything," but flagging it in case it's
not intentional — if you want the colorful avatars back, it's a one-line
delete of the override in `core.js`.
