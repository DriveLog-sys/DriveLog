/* ============================================================
   DRIVELOG — APP.JS
   ─────────────────────────────────────────────────────────────
   Main application file. All UI logic lives here.
   Load order in index.html: data.js → db.js → app.js
   data.js   : constants (CATS, AWARDS_DEF, seed data helpers)
   db.js     : all Supabase calls — never call _sb directly here
   app.js    : everything else (this file)

   Key globals:
     S            — single app state object (see below)
     _avCache     — in-memory Map of username → avatar URL
     DB.*         — all database calls (defined in db.js)
     goTo(page)   — navigate between pages
     el(id)       — shorthand for getElementById
     esc(str)     — HTML-escape a string before injecting into DOM

   Boot sequence:
     1. _initSb() + startPrefetch() fire immediately on script load
        (before DOMContentLoaded) to overlap network latency with parsing
     2. DOMContentLoaded: init all UI modules, loadFromCache(), renderAll()
     3. loadStorage() fires async: fetches posts + session from Supabase,
        re-renders feed as soon as posts arrive
     4. Background: profiles, events, following, notifications (parallel)

   localStorage keys used:
     dl_posts_cache      — cached posts array (JSON)
     dl_cache_ts         — timestamp of last posts cache write
     dl_users_cache      — cached users/profiles array (JSON)
     dl_profile_cache_ts — timestamp of last profile cache write
     dl_user_cache       — cached logged-in user object (JSON)
     dl_user             — legacy alias for dl_user_cache
     dl_avatar_url       — own avatar URL (set after upload)
     dl_avatar_cache     — JSON map of username → avatar URL
     dl_following_*      — following list per username
     dl_prefs            — theme, accent color, font size
     dl_nudge_dismissed  — whether signup nudge was closed
     dl_featured_users   — array of featured usernames (admin-set)
   ============================================================ */
'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────
// MIN_ACCOUNT_AGE_DAYS: how old an account must be before it can like/comment/post.
// Currently 0 (off) — set to e.g. 3 to require 3 days before interacting.
const MIN_ACCOUNT_AGE_DAYS = 0;

// BOTW_WINDOW_MS: window for Build Of The Week. Posts within this window
// get priority in the BOTW slider. Currently 7 days.
const BOTW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// FEED_PAGE_SIZE: how many cards to show per page before "load more"
const FEED_PAGE_SIZE = 12;

// ─── STATE ────────────────────────────────────────────────────
// S is the single source of truth for the entire app.
// All pages read from S — never store page-local state elsewhere.
// When Supabase returns new data, write it here, then call renderX().
const S = {
  user: null,          // logged-in user object (null = guest)
  posts: [],           // all loaded posts (from cache + Supabase)
  users: [],           // all loaded profiles (from cache + Supabase)
  events: [],          // community events
  page: 'home',        // current active page name (matches data-page)
  filter: 'All',       // active category filter on feed
  sort: 'newest',      // feed sort: 'newest' | 'liked' | 'comments'
  visibleCount: FEED_PAGE_SIZE, // how many feed cards are showing
  evtFilter: 'All',    // event type filter
  memberSort: 'likes', // members page sort
  openPost: null,      // post open in the OLD car modal (legacy — use openCarPost)
  galleryIdx: 0,       // current gallery image index in car modal
  lbImages: [], lbIdx: 0, // lightbox images + current index
  following: [],       // array of usernames the logged-in user follows
  blockedUsers: [],    // array of usernames the logged-in user has blocked
  notifs: [],          // notification objects for current user
  filters: { categories:[], make:"", yearMin:1900, yearMax:new Date().getFullYear()+1, hp:0, likes:0, colors:[], bodyTypes:[], engines:[], drivetrains:[], transmissions:[], fuelTypes:[] },
  dms: {},             // { otherUsername: [{from,text,ts},...] }
  openDm: null,        // username of active DM conversation
  openCarPost: null,   // post currently shown on the full car detail page
  compareA: null, compareB: null, // posts being compared
  infiniteScrollObserver: null,   // IntersectionObserver for infinite scroll
  _editingPostId: null, // set when editing an existing post (not creating new)
};

// ─── PREFETCH — start Supabase fetch immediately on script load ──
// This fires BEFORE DOMContentLoaded so network latency overlaps
// with HTML/CSS parsing. Result is stored and consumed in loadStorage.
let _prefetchPostsPromise = null;
let _prefetchSessionPromise = null;
// ─── AVATAR CACHE ────────────────────────────────────────────
// IMPORTANT: _avCache MUST be declared here at the top of the file.
// loadFromCache() (line ~123) calls _avCache.set() immediately on boot,
// before most of the file has been parsed. JavaScript const declarations
// are NOT hoisted, so if _avCache was declared anywhere below loadFromCache,
// it would be undefined when loadFromCache runs, causing a silent crash
// that broke all avatar loading. Do not move this block down the file.
//
// _avCache is a Map<username, avatarUrl> that lives in memory for the
// duration of the page session. It is seeded from localStorage at boot
// (via _initAvCache) and updated whenever a new URL is discovered.
// Using a Map here instead of reading localStorage on every lookup gives
// O(1) access and avoids repeated JSON.parse calls during feed renders.
const _avCache = new Map();

// Seed _avCache from localStorage dl_avatar_cache on startup.
// Called once at the top of loadFromCache().
function _initAvCache() {
  try {
    const stored = JSON.parse(localStorage.getItem('dl_avatar_cache') || '{}');
    Object.entries(stored).forEach(([u, url]) => { if (url?.startsWith('http')) _avCache.set(u, url); });
  } catch(_) {}
}

// Get the best available avatar URL for a username.
// Priority: in-memory cache → S.users array → own user object → dl_avatar_url key.
// Returns null if no URL found (caller should show default grey SVG).
function getAvatarUrl(username) {
  if (!username) return null;
  if (_avCache.has(username)) return _avCache.get(username);
  const u = S.users.find(x => x.username === username);
  if (u?.avatarUrl?.startsWith('http')) { _avCache.set(username, u.avatarUrl); return u.avatarUrl; }
  if (S.user?.username === username && S.user.avatarUrl?.startsWith('http')) {
    _avCache.set(username, S.user.avatarUrl); return S.user.avatarUrl;
  }
  if (S.user?.username === username) {
    const local = localStorage.getItem('dl_avatar_url');
    if (local?.startsWith('http')) { _avCache.set(username, local); return local; }
  }
  return null;
}
function cacheAvatarUrl(username, url) {
  if (!username || !url?.startsWith('http')) return;
  _avCache.set(username, url);
  try {
    const stored = JSON.parse(localStorage.getItem('dl_avatar_cache') || '{}');
    stored[username] = url;
    localStorage.setItem('dl_avatar_cache', JSON.stringify(stored));
  } catch(_) {}
}


// startPrefetch() fires immediately when the script loads — BEFORE
// DOMContentLoaded. This means the Supabase network requests for the
// session and posts start while the browser is still parsing the HTML
// and CSS. By the time DOMContentLoaded fires and loadStorage() runs,
// the requests may already have responses ready, making the initial
// render appear nearly instant.
//
// The promises are stored in _prefetchPostsPromise and
// _prefetchSessionPromise. loadStorage() awaits these instead of
// making new requests, consuming whatever arrived during parsing.
//
// If Supabase isn't ready yet (_sbOk() is false), startPrefetch()
// returns early. loadStorage() will retry and make its own requests.
function startPrefetch() {
  // Skip posts prefetch if we have a cache less than 5 minutes old —
  // the cached data is fresh enough to show immediately
  const cacheAge = Date.now() - (parseInt(localStorage.getItem('dl_cache_ts')||'0'));
  const hasFreshCache = cacheAge < 300000 && !!localStorage.getItem('dl_posts_cache'); // 5 min

  if (!_sbOk()) { _initSb(); }
  if (!_sbOk()) return; // Supabase CDN not ready yet — loadStorage will retry

  // Always prefetch session (small, fast)
  _prefetchSessionPromise = _sb.auth.getSession()
    .then(({ data }) => {
      if (!data?.session) return null;
      const meta = data.session.user.user_metadata || {};
      return { ...data.session.user, username: meta.username || data.session.user.email?.split('@')[0] || 'User' };
    })
    .catch(() => null);

  // Only prefetch posts if cache is stale
  if (!hasFreshCache) {
    _prefetchPostsPromise = DB.getPosts({ limit: 60 }).catch(() => null);
  }
}

// Fire immediately when script executes
try { _initSb(); startPrefetch(); } catch(_) {}

// ─── BOOT SEQUENCE ────────────────────────────────────────────
// The site renders in two phases:
//
// Phase 1 (synchronous, instant):
//   - Apply theme so there's no flash of wrong colors
//   - Init all UI modules (wire event listeners)
//   - loadFromCache() — read posts/users/user from localStorage into S
//   - renderAll() — paint the entire UI from cached data
//   The site is now fully visible and interactive.
//
// Phase 2 (async, background):
//   - loadStorage() awaits the prefetch promises (or starts fresh requests)
//   - Posts arrive → renderFeed() re-paints cards with fresh data
//   - Session confirmed → updateAuthUI() shows correct login state
//   - Profiles/events/notifs arrive → update in place
//
// This means a returning user sees their feed in <100ms from cached data,
// and fresh data updates it within ~1-2s as Supabase responds.
document.addEventListener('DOMContentLoaded', () => {
  // Apply theme first — prevents flash of wrong colors before CSS loads
  applyPrefs();

  // Wire all UI modules. Each init() attaches event listeners.
  // Wrapped in try/catch so one broken module doesn't prevent others.
  const inits = [initHeader, initMobileNav, initSearch, initAuth,
    initPostModal, initCarModal, initLightbox, initGarage, initEvents,
    initMembers, initNavLinks, initFilterSidebar, initMessages, initCarPage,
    initReactions, initReport, initCompare, initInfiniteScroll,
    initSocialPage, initThemeToggle, initDiscussions, initSpotMap, initFollowListModal];
  for (const fn of inits) {
    try { fn(); } catch(e) { console.warn('Init failed:', fn.name, e); }
  }

  // ── Phase 1: Render from localStorage cache IMMEDIATELY ──────
  // Page is visible and interactive before any network requests finish
  loadFromCache();
  updateAuthUI();
  updateNotifBadge();
  renderAll();

  // ── Phase 2: Load fresh data from Supabase — completely non-blocking ──
  // Fire and forget — the site is already rendered from cache above.
  // loadStorage() calls renderFeed() internally as soon as posts arrive.
  loadStorage().catch(e => console.warn('Supabase load error:', e));

  // Handle ?user= and ?post= URL params after a brief delay
  // so S.posts has a chance to populate from cache first
  setTimeout(handleURLRouting, 100);
});

// loadFromCache() — Phase 1 data hydration.
// Reads everything from localStorage into S so the UI can render
// immediately without waiting for Supabase. Called synchronously
// before renderAll() in the boot sequence.
//
// After this runs, S.posts, S.users, S.user, S.following, and
// _avCache are all populated from the last known good state.
// The subsequent loadStorage() call will overwrite these with
// fresh Supabase data once it arrives.
function loadFromCache() {
  // Seed the in-memory avatar URL Map first so getAvatarUrl()
  // works correctly for any render that happens in this phase
  _initAvCache();
  try {
    const cp = localStorage.getItem('dl_posts_cache');
    const cu = localStorage.getItem('dl_users_cache');
    const uu = localStorage.getItem('dl_user_cache');
    const ac = localStorage.getItem('dl_avatar_cache');
    if (cp) S.posts = JSON.parse(cp);
    if (cu) {
      S.users = JSON.parse(cu);
      // Populate in-memory avatar cache from S.users immediately
      S.users.forEach(u => {
        if (u.avatarUrl?.startsWith('http')) _avCache.set(u.username, u.avatarUrl);
      });
    }
    // Also load per-user avatar_url from the avatar cache
    // (set after upload — most up-to-date URL)
    if (ac) {
      try {
        const avMap = JSON.parse(ac);
        Object.entries(avMap).forEach(([username, url]) => {
          const u = S.users.find(x => x.username === username);
          if (u && url?.startsWith('http')) u.avatarUrl = url;
        });
      } catch(_) {}
    }
    if (uu) {
      const cachedUser = JSON.parse(uu);
      S.user = cachedUser;
      if (S.user?.username) {
        const fl = localStorage.getItem('dl_following_'+S.user.username);
        if (fl) S.following = JSON.parse(fl);
        // Own avatar
        const ownAvUrl = localStorage.getItem('dl_avatar_url');
        if (ownAvUrl?.startsWith('http')) {
          S.user.avatarUrl = ownAvUrl;
          cacheAvatarUrl(S.user.username, ownAvUrl);
        }
      }
    }
    if (!cp) S._loading = true;
    try {
      const featuredList = JSON.parse(localStorage.getItem('dl_featured_users') || '[]');
      S.users.forEach(u => { if (featuredList.includes(u.username)) u.isFeatured = true; });
    } catch(_) {}
  } catch(_) {}
}

// renderAll() — paint the entire site from current S state.
// Called after loadFromCache() for the initial render, and can be
// called again after major data changes. Most re-renders use targeted
// functions (renderFeed, updateAuthUI, etc.) rather than renderAll
// to avoid unnecessary work. renderAll is the nuclear option.
function renderAll() {
  renderFeed(); renderSidebar(); renderBOTW(); renderTicker();
  renderCategories(); renderLeaderboard(); renderEventsGrid();
  renderSidebarEvents(); renderMembers(); updateProfilePage();
  animateStats();
}

// ─── ACCOUNT AGE GATE ─────────────────────────────────────────
function canInteract() {
  if (!S.user) return false;
  const joined = new Date(S.user.joinedFull || (S.user.joined + '-01')).getTime();
  return (Date.now() - joined) >= MIN_ACCOUNT_AGE_DAYS * 86400000;
}
function daysRemaining() {
  if (!S.user) return MIN_ACCOUNT_AGE_DAYS;
  const joined = new Date(S.user.joinedFull || (S.user.joined + '-01')).getTime();
  return Math.max(0, MIN_ACCOUNT_AGE_DAYS - Math.floor((Date.now() - joined) / 86400000));
}
function gateMsg() {
  const d = daysRemaining();
  return `Your account must be ${MIN_ACCOUNT_AGE_DAYS} days old to do that. ${d} day${d===1?'':'s'} remaining.`;
}

// ─── STORAGE — SUPABASE BACKED ────────────────────────────────
// Strategy: show cached data instantly, then refresh from Supabase in background.
// This makes the site feel instant on repeat visits.

async function loadStorage() {
  // Ensure Supabase is initialized — one attempt, then move on
  if (!_sbOk()) _initSb();
  if (!_sbOk()) {
    console.warn('Supabase unavailable — showing cached data only');
    S._loading = false;
    renderFeed();
    return;
  }

  const cachedUser = (() => {
    try { return JSON.parse(localStorage.getItem('dl_user_cache') || localStorage.getItem('dl_user') || 'null'); } catch(_) { return null; }
  })();

  // ── Only await CRITICAL: session + posts ─────────────────────
  // Use prefetch results — they started before DOMContentLoaded
  const sessionFetch = _prefetchSessionPromise
    || _sb.auth.getSession().then(({ data }) => {
      if (!data?.session) return null;
      const meta = data.session.user.user_metadata || {};
      return { ...data.session.user, username: meta.username || data.session.user.email?.split('@')[0] || 'User' };
    }).catch(() => null);

  const postsFetch = _prefetchPostsPromise
    || DB.getPosts({ limit: 60 }).catch(() => []);

  _prefetchPostsPromise = null;
  _prefetchSessionPromise = null;

  const [sessionResult, postsResult] = await Promise.allSettled([
    sessionFetch,
    postsFetch.then(rows => {
      if (!rows?.length) console.warn('DriveLog: 0 posts returned. Check Supabase RLS policies.');
      const freshPosts = (rows||[]).map(dbPostToApp).filter(Boolean);
      // Preserve local like/save state over stale Supabase state
      freshPosts.forEach(fp => {
        const local = S.posts.find(p => p.id === fp.id);
        if (local) {
          if ((local.likedBy||[]).length > (fp.likedBy||[]).length) fp.likedBy = local.likedBy;
          if ((local.savedBy||[]).length > (fp.savedBy||[]).length) fp.savedBy = local.savedBy;
        }
      });
      S.posts = freshPosts;
      S._loading = false;
      // Persist to cache so next load is instant
      try {
        localStorage.setItem('dl_posts_cache', JSON.stringify(S.posts));
        localStorage.setItem('dl_cache_ts', String(Date.now()));
      } catch(_) {}
      // ── Render immediately as soon as posts arrive ──────────
      // No waiting — paint the feed right now
      renderFeed(); renderSidebar(); renderBOTW(); renderHotPanel(); animateStats();
      if (S.user?.username) requestAnimationFrame(() => refreshLikedStates());
      // Comment counts — fire after a delay so they don't compete with
      // the initial posts render. 2s delay means feed is already painted.
      setTimeout(() => {
        DB.getCommentCounts(freshPosts.map(p => p.id)).then(counts => {
          let changed = false;
          S.posts.forEach(p => {
            const c = counts[p.id] || 0;
            if (p.comments?.length !== c) {
              p.comments = Array(c).fill(null);
              changed = true;
            }
          });
          if (changed) renderFeed();
        }).catch(() => {});
      }, 2000);
      return rows;
    }).catch(() => []),
  ]);

  // Process session
  if (sessionResult.value) {
    // Supabase confirmed a live session — use it, merge with cache.
    const authUser = dbUserToApp(sessionResult.value);
    S.user = (cachedUser?.id && cachedUser.id === authUser.id)
      // IMPORTANT: username is deliberately taken from authUser (fresh),
      // not cachedUser (stale). This used to spread cachedUser last,
      // which meant once a stale username got written to localStorage
      // even a single time, it would win over the real one on every
      // future load forever — with nothing to ever break the cycle.
      // That's exactly what happened here: an old auth-metadata username
      // got cached once and then silently overrode the correct one
      // indefinitely, no matter what Supabase actually returned.
      // Other cached fields (bio, socials, etc.) still take priority
      // over authUser so local edits aren't lost, just not username.
      ? { ...authUser, ...cachedUser, id: authUser.id, username: authUser.username }
      : authUser;
    localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
    localStorage.setItem('dl_user', JSON.stringify(S.user));
    // Self-correcting fetch: authUser.username comes from Supabase Auth's
    // user_metadata, which is set once at signup and can drift out of sync
    // with the actual profiles.username column (exactly what happened here
    // — metadata still said an old username after a rename). Fetching the
    // real profile by the immutable user id (never by username) and
    // re-applying it closes that gap permanently instead of just once.
    DB.getProfile(S.user.id).then(profile => {
      if (profile?.username && profile.username !== S.user.username) {
        S.user = { ...S.user, ...profile };
        localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
        localStorage.setItem('dl_user', JSON.stringify(S.user));
        updateAuthUI();
      }
    }).catch(() => {});
  } else if (sessionResult.status === 'fulfilled' && !sessionResult.value) {
    // Supabase returned null session. This can happen if:
    // 1. User genuinely logged out
    // 2. Supabase CDN wasn't fully ready when prefetch fired (race condition)
    // 3. Token refresh is in progress
    //
    // Strategy: if we have a cached user, KEEP them — don't log them out
    // based on a potentially-stale prefetch result.
    // Instead, attempt a fresh token refresh. If that fails, THEN log out.
    if (cachedUser?.username) {
      try {
        const { data: refreshed } = await _sb.auth.refreshSession();
        if (refreshed?.session) {
          // Token refreshed — user is still logged in
          const meta = refreshed.session.user.user_metadata || {};
          const authUser = dbUserToApp({ ...refreshed.session.user,
            username: meta.username || refreshed.session.user.email?.split('@')[0] || cachedUser.username
          });
          S.user = { ...authUser, ...cachedUser, id: authUser.id };
          localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
          localStorage.setItem('dl_user', JSON.stringify(S.user));
        } else {
          // Refresh came back with no session. This used to be treated as
          // definitive proof of logout and wiped everything — but that's
          // also exactly what a fast reload / timing race looks like (e.g.
          // right after returning from settings.html), which was silently
          // signing people out. A real, explicit sign-out already clears
          // storage directly via logout() — so here we just keep showing
          // the cached user and try again next load, instead of nuking a
          // possibly-still-valid session on an ambiguous signal.
          S.user = cachedUser;
        }
      } catch(_) {
        // Network error during refresh — keep cached user, try again next load
        S.user = S.user || cachedUser;
      }
    }
    // No cached user and no session — already logged out, nothing to do
  }
  updateAuthUI(); updateNotifBadge();
  // Wire realtime now that we have confirmed session
  if (S.user?.id) setupRealtimeSubscriptions();
  setupPublicRealtimeSubscriptions(); // new posts/spots/discussions — works signed in or out

  // ── Fire non-critical in background without blocking ──────────
  // Profiles: only re-fetch if cache is stale. Was 10 minutes — that's why
  // an updated avatar could take up to 10 min to show up for other people
  // viewing your posts/profile. Shortened substantially; see also the
  // per-user on-demand fallback in setAvEl() for the "never fetched them
  // at all yet" case, which this TTL alone doesn't cover.
  const profileCacheAge = Date.now() - (parseInt(localStorage.getItem('dl_profile_cache_ts')||'0'));
  const profilesStale   = profileCacheAge > 90 * 1000; // 90 seconds
  const profilesFetch   = profilesStale ? DB.getAllProfiles().catch(() => []) : Promise.resolve(S.users.length ? null : []);

  Promise.all([
    profilesFetch,
    DB.getEvents().catch(() => []),
    // Only fetch following from DB if we don't have it locally already
    (S.user?.id && !S.following.length) ? DB.getFollowing(S.user.id).catch(() => []) : Promise.resolve(null),
    S.user?.id ? DB.getNotifications(S.user.id).catch(() => []) : Promise.resolve([]),
    S.user?.id ? DB.getBlockedUsers(S.user.id).catch(() => []) : Promise.resolve([]),
    DB.getRecentSpotters().catch(() => []),
  ]).then(([profiles, evts, following, notifs, blocked, spotters]) => {
    // Story ring data — independent of the profiles-cache-is-fresh skip
    // below, since this needs to work on every page, not just when the
    // profile cache happens to be stale.
    S._activeSpotters = new Set((spotters||[]).map(s => s.username).filter(Boolean));
    document.querySelectorAll('[data-user]').forEach(node => {
      const uname = node.dataset.user;
      if (!uname) return;
      const active = S._activeSpotters.has(uname);
      node.classList.toggle('has-story-ring', active);
      node.style.overflow = active ? 'visible' : '';
    });
    if (profiles === null) return; // cache is fresh — skip profile processing
    // Profiles + avatars
    if (profiles?.length) {
      S.users = profiles.map(dbUserToApp).filter(Boolean);
      // Cache avatar URLs immediately — on next load they'll show from cache
      S.users.forEach(u => {
        if (u.avatarUrl?.startsWith('http')) cacheAvatarUrl(u.username, u.avatarUrl);
      });
      // Persist full user list (with avatarUrls) to users_cache
      try {
        const fl = JSON.parse(localStorage.getItem('dl_featured_users') || '[]');
        S.users.forEach(u => { if (fl.includes(u.username)) u.isFeatured = true; });
        localStorage.setItem('dl_users_cache', JSON.stringify(S.users));
        localStorage.setItem('dl_profile_cache_ts', String(Date.now()));
      } catch(_) {}
      if (S.user) {
        const fresh = S.users.find(u => u.username === S.user.username);
        if (fresh) {
          const localAvatar = localStorage.getItem('dl_avatar_url') || S.user.avatarUrl || null;
          const localBanner = localStorage.getItem('dl_banner_'+S.user.username) || S.user.bannerUrl || null;
          S.user = { ...fresh, ...S.user,
            avatarUrl: localAvatar || fresh.avatarUrl || null,
            bannerUrl: localBanner || fresh.bannerUrl || null,
            bio: S.user.bio || fresh.bio || '',
            instagram: S.user.instagram || fresh.instagram || '',
            tiktok: S.user.tiktok || fresh.tiktok || '',
            youtube: S.user.youtube || fresh.youtube || '',
            website: S.user.website || fresh.website || '',
            location: S.user.location || fresh.location || '',
            id: fresh.id || S.user.id,
            isAdmin: fresh.isAdmin || S.user.isAdmin || false,
            awards: (fresh.awards||[]).length ? fresh.awards : (S.user.awards||[]),
          };
          localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
          localStorage.setItem('dl_user', JSON.stringify(S.user));
        }
      }
      updateAuthUI(); renderFeaturedMembers(); renderMembers();
      if (S.page === 'profile') updateProfilePage();
      // Update ALL currently visible avatars in one pass
      requestAnimationFrame(() => {
        document.querySelectorAll('[data-user]').forEach(node => {
          const uname = node.dataset.user; if (!uname) return;
          const cls = node.className || '';
          if (cls.includes('av-circle') || cls.includes('msg-conv-av') ||
              cls.includes('card-av') || cls.includes('member-av') ||
              cls.includes('profile-av') || cls.includes('fm-av') ||
              cls.includes('social-wtf-av') || cls.includes('notif-av') ||
              cls.includes('hsr-av')) {
            setAvEl(node, uname);
          }
        });
      });
    }

    // Events
    if (evts?.length) {
      S.events = evts.map(e => ({
        id:e.id, title:e.title, type:e.type, location:e.location,
        date:e.date, time:e.time||'', description:e.description||'',
        host:e.host_username, capacity:e.capacity||null, attendees:e.attendees||[]
      }));
    }

    // Following (null = already had it from cache)
    if (following?.length) { S.following = following; save(); }

    // Blocked users (usernames the current user has blocked)
    if (blocked?.length) { S.blockedUsers = blocked.map(b => b.username).filter(Boolean); }

    // Notifications
    if (notifs?.length) {
      S.notifs = notifs.map(n => ({
        id:n.id, type:n.type, from:n.from_username, msg:n.message,
        link:n.link||null, time:new Date(n.created_at).getTime(), read:n.read
      }));
      updateNotifBadge();
    }

    if (S.user?.id) setupRealtimeSubscriptions();
  });
} // end loadStorage


// save() — debounced local cache write + Supabase profile sync.
// LEGACY: most Supabase writes now happen via specific DB.* calls
// (DB.toggleLike, DB.addComment, DB.updateProfile, etc.) at the
// point of the action. save() is kept for places that still need
// to persist the full S.posts/S.users cache to localStorage.
// The 300ms debounce prevents rapid successive calls from hammering
// localStorage during things like rapid like-button clicking.
let _saveTimer;
function save() { clearTimeout(_saveTimer); _saveTimer = setTimeout(_doSave, 300); }
function _doSave() {
  // Write changed posts/users back to Supabase if user is logged in
  // Full sync happens via the specific DB.* calls (toggleLike, addComment, etc.)
  // This just keeps the local cache fresh
  try {
    localStorage.setItem('dl_posts_cache', JSON.stringify(S.posts));
    localStorage.setItem('dl_users_cache', JSON.stringify(S.users));
  } catch(_) {}
  // Sync current user profile changes to Supabase
  if (S.user) {
    const profileUpdates = {
      bio:          S.user.bio||'',
      instagram:    S.user.instagram||'',
      tiktok:       S.user.tiktok||'',
      youtube:      S.user.youtube||'',
      website:      S.user.website||'',
      avatar_color: S.user.avatarColor||'',
    };
    // Include avatar URL if it's a remote URL (not base64)
    if (S.user.avatarUrl && !S.user.avatarUrl.startsWith('data:')) {
      profileUpdates.avatar_url = S.user.avatarUrl;
    }
    DB.updateProfile(S.user.id, profileUpdates).catch(()=>{});
  }
}

function applyPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('dl_prefs') || '{}');
    // Accent color is no longer user-customizable — always the site default
    // blue (set in main.css :root). Intentionally ignoring any stored
    // p.accent value here, including old ones from before this was locked.
    // Default theme is now LIGHT — only go dark when explicitly set
    const theme = p.theme || 'dark';
    if (theme === 'dark') document.body.classList.add('dark');
    else document.body.classList.remove('dark');
    if (p.fontSize) document.documentElement.style.fontSize = p.fontSize + 'px';
  } catch(e) {}
}
function setAccent(c) {
  const r = document.documentElement.style;
  r.setProperty('--accent', c); r.setProperty('--accent-dim', c+'bb');
  r.setProperty('--accent-glow', c+'30'); r.setProperty('--accent-soft', c+'15');
}

// ─── BOOT LOADER ──────────────────────────────────────────────
// Boot loader functions removed — site renders immediately from cache

// ─── REALTIME SUBSCRIPTIONS ────────────────────────────────────
let _realtimeSubs = [];
// setupRealtimeSubscriptions() — wire Supabase Realtime for live updates.
// Called after session is confirmed in loadStorage(), and again after login.
// Subscribes to two channels:
//   1. messages: new DMs arrive in real-time without page refresh
//   2. notifications: likes, follows, comments appear instantly
//
// IMPORTANT: Supabase Realtime must be enabled for these tables in the
// Supabase Dashboard → Database → Replication → tables enabled for realtime.
// If messages or notifications don't arrive live, check that setting first.
//
// We clean up old subscriptions before creating new ones to avoid
// duplicate listeners if the user logs out and back in during a session.
function setupRealtimeSubscriptions() {
  // Remove any existing subscriptions before re-subscribing
  // (prevents duplicate handlers if called multiple times)
  _realtimeSubs.forEach(sub => { try { sub.unsubscribe?.(); } catch(_) {} });
  _realtimeSubs = [];
  if (!S.user) return; // only subscribe when logged in
  // New messages — update conv list and open thread
  const msgSub = DB.subscribeToMessages(S.user.id, payload => {
    if (!payload.new) return;
    const msg = payload.new;
    const fromUser = S.users.find(u=>u.id===msg.from_user_id);
    const from = fromUser?.username || msg.from_username || 'Someone';
    if (from === S.user.username) return; // skip own messages
    // Store in local thread
    const thread = loadDmThread(from);
    const newMsg = { from, text: msg.text||'', image: msg.image_url||null, ts: new Date(msg.created_at).getTime(), read: S.openDm === from };
    if (!thread.find(m => Math.abs(m.ts - newMsg.ts) < 2000 && m.from === newMsg.from))
      thread.push(newMsg);
    thread.sort((a,b) => a.ts - b.ts);
    saveDmThread(from, thread);
    // Update open conversation immediately
    if (S.openDm === from && S.page === 'messages') {
      renderDmMessages(from);
      DB.markMessagesRead(msg.from_user_id, S.user.id).catch(()=>{});
    } else {
      updateDmBadge();
      renderMessages();
      showPushNotif(from, msg.text || '📷 Image', 'message');
    }
  });
  // New notifications
  const notifSub = DB.subscribeToNotifications(S.user.id, payload => {
    if (payload.new) {
      const n = payload.new;
      if (!isNotifTypeEnabled(n.type)) return; // this type is muted in Notification settings
      S.notifs.unshift({ id:n.id, type:n.type, from:n.from_username, msg:n.message, link:n.link||null, time:new Date(n.created_at).getTime(), read:false });
      updateNotifBadge();
      renderNotifList();
      showPushNotif(n.from_username, n.message, n.type);
    }
  });
  _realtimeSubs.push(msgSub, notifSub);
}

// Public content (new builds, spotting posts, discussions) — runs once at
// boot regardless of sign-in state, unlike setupRealtimeSubscriptions()
// above which only covers private content (messages/notifications) and
// only for signed-in users. Without this, new content posted from another
// device or by another user never appeared until you manually reloaded —
// this is what makes it show up live instead.
let _publicRealtimeSubs = [];
function setupPublicRealtimeSubscriptions() {
  if (_publicRealtimeSubs.length) return; // already wired, don't double-subscribe
  if (!_sbOk()) return;

  const postsSub = DB.subscribeToNewPosts(payload => {
    if (!payload.new) return;
    const post = dbPostToApp(payload.new);
    if (!post || S.posts.find(p => p.id === post.id)) return; // skip our own optimistic add
    S.posts.unshift(post);
    if (S.page === 'home') { renderFeed(); renderSidebar(); }
  });

  const socialSub = DB.subscribeToNewSocialPosts(payload => {
    if (!payload.new) return;
    const post = dbSocialToApp(payload.new);
    if (!post || (S._socialPosts||[]).find(p => p.id === post.id)) return;
    S._socialPosts = [post, ...(S._socialPosts||[])];
    if (S.page === 'social') { renderSocialFeed(); }
    renderStoryBar(); // keep story bubbles live everywhere, not just on the Spotting page
  });

  const discSub = DB.subscribeToNewDiscussions(payload => {
    if (!payload.new) return;
    const d = dbDiscussionToApp(payload.new);
    if (!d || (S._discussions||[]).find(x => x.id === d.id)) return;
    S._discussions = [d, ...(S._discussions||[])];
    if (S.page === 'discussions') renderDiscussions();
  });

  _publicRealtimeSubs.push(postsSub, socialSub, discSub);
}

// ─── PUSH NOTIFICATION TOAST ──────────────────────────────────
function showPushNotif(from, message, type) {
  if (type === 'message' && S.page === 'messages') return;
  let pn = document.getElementById('pushNotif');
  if (!pn) {
    pn = document.createElement('div');
    pn.id = 'pushNotif'; pn.className = 'push-notif';
    pn.innerHTML = `<div class="push-notif-av" id="pushNotifAv"></div>
      <div class="push-notif-body"><div class="push-notif-text" id="pushNotifText"></div></div>
      <button class="push-notif-close" id="pushNotifClose"><i class="fas fa-times"></i></button>`;
    document.body.appendChild(pn);
    document.getElementById('pushNotifClose').addEventListener('click', () => pn.classList.remove('show'));
  }
  const av = document.getElementById('pushNotifAv');
  const url = getAvatarUrl(from);
  if (url) { av.innerHTML=`<img src="${url}" alt="" class="av-photo"/>`; av.style.background='transparent'; }
  else { av.innerHTML=(from||'?')[0].toUpperCase(); av.style.background=avColor(from||'?'); }
  document.getElementById('pushNotifText').innerHTML = `<b>${esc(from||'Someone')}</b> ${(message||'').replace(/<[^>]*>/g,'')}`;
  pn.classList.add('show');
  clearTimeout(pn._t); pn._t = setTimeout(() => pn.classList.remove('show'), 5000);
}

// ─── NAVIGATION ───────────────────────────────────────────────
function initNavLinks() {
  document.querySelectorAll('.nav-link[data-page],.mob-link[data-page]').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); goTo(a.dataset.page); }));
  el('logoBtn')?.addEventListener('click', ()=>goTo('home'));
  el('heroPostBtn')?.addEventListener('click', openPostModal);
  el('heroExploreBtn')?.addEventListener('click', ()=>el('filterBar').scrollIntoView({behavior:'smooth'}));
  el('ddProfile')?.addEventListener('click', ()=>goTo('profile'));
  el('ddGarage')?.addEventListener('click',  ()=>goTo('garage'));
  // Events nav removed from HTML
  el('ddMembers')?.addEventListener('click', ()=>goTo('members'));
  el('ddLogout')?.addEventListener('click',  logout);
  const ddMsgs = el('ddMessages'); if(ddMsgs) ddMsgs.addEventListener('click', ()=>goTo('messages'));
  const ddChal = el('ddEvents'); if(ddChal) ddChal.addEventListener('click', ()=>goTo('events'));
  const ddCmp = el('ddCompare'); if(ddCmp) ddCmp.addEventListener('click', ()=>goTo('compare'));
  const ddAdm = el('ddAdmin'); if(ddAdm) ddAdm.addEventListener('click', ()=>goTo('admin'));
  el('profileSignInBtn')?.addEventListener('click', ()=>el('authModal').classList.add('open'));
  el('profilePostBtn')?.addEventListener('click', openPostModal);
  const wl = document.querySelector('.widget-link[data-page="events"]');
  if (wl) wl.addEventListener('click', e=>{e.preventDefault();goTo('events');});

  // Footer links — simple page routes
  document.querySelectorAll('[data-footer-page]').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); goTo(a.dataset.footerPage); })
  );
  // Footer category links — route to Categories page filtered to that category
  document.querySelectorAll('[data-footer-cat]').forEach(a =>
    a.addEventListener('click', e => {
      e.preventDefault();
      S.filter = a.dataset.footerCat;
      S.filters.category = a.dataset.footerCat;
      goTo('categories');
    })
  );
}

// goTo(page) — the main navigation function.
// All page navigation goes through here. Page IDs in HTML match
// the page name: id="page-home", id="page-profile", etc.
// Each page section has class="page" and is display:none by default.
// Adding class="active" makes it display:block (see main.css .page.active).
//
// Some pages need special handling when activated:
//   - messages: needs display:flex (not block) — set explicitly below
//   - profile: re-renders with current user data
//   - leaderboard: sorts on every visit (rankings change)
//   - social (Car Spotting): resets feed pagination
//
// URL hash is updated so mobile back button and bookmarks work.
function goTo(page) {
  S.page = page;
  // If the Car Spotting detail modal is open (e.g. user tapped a username
  // inside it), close it and restore scrolling — otherwise the modal stays
  // stuck over the new page with body scroll locked.
  if (typeof closeSocialDetail === 'function') closeSocialDetail();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = el('page-'+page);
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-link,.mob-link').forEach(a => a.classList.toggle('active', a.dataset.page===page));
  window.scrollTo({top:0, behavior:'auto'});
  closeMobNav();
  // Push state so mobile back button works
  try {
    // Build clean shareable URL
    const url = new URL(window.location.href);
    url.hash = page;
    url.searchParams.delete('user'); // clear profile param when navigating away
    url.searchParams.delete('post');
    window.history.pushState({ page }, '', url.toString());
  } catch(_) {}
  if (page==='profile')     updateProfilePage();
  if (page==='leaderboard') renderLeaderboard();
  if (page==='garage')      renderGarage();
  if (page==='events')      renderEventsGrid();
  if (page==='members')     { renderMembers(); renderMembersStatsBar(); renderMembersBotm(); }
  if (page==='social')      { renderSocialFeed(true); renderTrendingTags(); }
  if (page==='discussions') renderDiscussions(true);
  if (page==='spotpost') {
    if (!S.user) { toast('Sign in to post','err'); el('authModal').classList.add('open'); goTo('social'); return; }
    resetSpotComposer();
  }
  if (page==='notifications') renderNotifPage();
  if (page==='messages') {
    // Messages page needs display:flex, not the default block from .page.active
    const mp = el('page-messages');
    if (mp) { mp.style.display = 'flex'; mp.style.flexDirection = 'column'; }
    renderMessages();
  }
  // Always reset messages UI state on page nav
  if (page !== 'messages') {
    const cw = el('msgChatWrap');
    if (cw) { cw.style.display = 'none'; cw.style.flexDirection = ''; }
    const ms = el('msgNoneSelected');
    if (ms) { ms.style.display = 'flex'; }
    el('msgChatCol')?.classList.remove('active');
    el('msgListCol')?.classList.remove('msg-hide-list');
    S.openDm = null;
  }
  if (page==='whatsnew')    goTo('explore'); // whatsnew replaced by explore/more
  if (page==='explore')     renderExplorePage();
  if (page==='compare')     renderComparePage();
  if (page==='admin')       renderAdmin();
  updateDmBadge();
  // Sync bottom tab bar active state
  document.querySelectorAll('.mob-bottom-tab[data-page]').forEach(t =>
    t.classList.toggle('active', t.dataset.page === page)
  );
}

// ─── SHAREABLE URL ROUTING ────────────────────────────────────
// Enables deep-linking into the app via URL parameters.
// Called 100ms after DOMContentLoaded so S.posts has a chance to
// populate from cache before we try to find a post by ID.
//
// Supported URL formats:
//   ?user=nolanburkdoll  → opens that user's public profile
//   ?post=abc123         → opens that build page
//   #leaderboard         → navigates to the leaderboard page
//   #home (default)      → no action needed
//
// If a ?post= ID is not found in S.posts (cache miss), we fetch
// it directly from Supabase so shared links always work even if
// the post wasn't in the initial 60-post feed load.
function handleURLRouting() {
  const params = new URLSearchParams(window.location.search);
  const hashPage = window.location.hash.slice(1);

  if (params.get('user')) {
    // ?user=Username → open that profile
    const username = params.get('user');
    setTimeout(() => viewPublicProfile(username), 100);
    return;
  }
  if (params.get('post')) {
    // ?post=postId → open that build page
    const postId = params.get('post');
    setTimeout(() => {
      const post = S.posts.find(p => p.id === postId);
      if (post) { openCarPage(post); return; }
      // Fetch from Supabase if not in local cache
      DB.getPost(postId).then(row => {
        if (row) { const p = dbPostToApp(row); if(p) openCarPage(p); }
      }).catch(()=>{});
    }, 200);
    return;
  }
  if (hashPage && hashPage !== 'home') {
    setTimeout(() => goTo(hashPage), 50);
  }
}

// Mobile/browser back button
window.addEventListener('popstate', e => {
  const page = e.state?.page;
  if (page) {
    S.page = page;
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    el('page-'+page)?.classList.add('active');
    document.querySelectorAll('.nav-link,.mob-link').forEach(a=>a.classList.toggle('active',a.dataset.page===page));
    closeMobNav();
    updateDmBadge();
  }
});

function showPageLoader() {
  let l = el('pageLoader');
  if (!l) {
    l = document.createElement('div');
    l.id = 'pageLoader';
    l.innerHTML = '<span></span><span></span><span></span>';
    document.body.appendChild(l);
  }
  l.classList.add('active');
}
function hidePageLoader() {
  const l = el('pageLoader');
  if (l) l.classList.remove('active');
}

// ─── HEADER ───────────────────────────────────────────────────
function initHeader() {
  window.addEventListener('scroll', ()=>el('siteHeader').classList.toggle('scrolled',scrollY>40), {passive:true});
  // Global delegated handler for any element with data-user — opens that user's profile
  document.addEventListener('click', e => {
    const el2 = e.target.closest('[data-user]');
    if (!el2) return;
    const username = el2.dataset.user;
    if (!username) return;
    // Don't intercept avatar dropdowns, header chip, DM areas
    if (el2.id === 'avChip' || el2.id === 'avCircle' || el2.id === 'avWrap' ||
        el2.closest('#avChip') || el2.closest('.av-drop') ||
        el2.closest('.msg-chat-head') || el2.closest('.msg-conv-item') ||
        el2.closest('.msg-new-result') || el2.closest('#signupNudge')) return;
    e.stopPropagation();
    viewPublicProfile(username);
  });
  el('avChip')?.addEventListener('click', e=>{
    e.stopPropagation();
    if (window.innerWidth <= 768) { goTo('profile'); return; }
    el('avDrop').classList.toggle('open'); el('notifDrop').classList.remove('open');
  });
  el('notifBtn')?.addEventListener('click', e=>{e.stopPropagation(); el('notifDrop').classList.toggle('open'); el('avDrop').classList.remove('open'); renderNotifList();});
  document.addEventListener('click', ()=>{el('avDrop').classList.remove('open'); el('notifDrop').classList.remove('open');});
  el('avDrop')?.addEventListener('click',    e=>e.stopPropagation());
  el('notifDrop')?.addEventListener('click', e=>e.stopPropagation());
  el('notifClear')?.addEventListener('click', () => {
    S.notifs.forEach(n => n.read = true);
    save();
    updateNotifBadge();
    // Clear the visible list immediately — all are read, show empty state
    if(el('notifList'))el('notifList').innerHTML = '<div class="notif-empty"><i class="fas fa-check-circle" style="color:var(--green);font-size:1.4rem"></i><p>All caught up!</p></div>';
  });
}

function avColor(username) { return '#6b7280'; }

// ─── IMAGE COMPRESSION ────────────────────────────────────────
async function compressBase64(dataUrl, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1400; // max dimension
      let {width: w, height: h} = img;
      if (w > MAX || h > MAX) {
        const scale = MAX / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // fallback: return original
    img.src = dataUrl;
  });
}


// Render a default grey person SVG
function _defaultAvSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" style="width:100%;height:100%;display:block">
    <circle cx="20" cy="20" r="20" fill="#6b7280"/>
    <circle cx="20" cy="16" r="7" fill="#d1d5db"/>
    <ellipse cx="20" cy="34" rx="11" ry="9" fill="#d1d5db"/>
  </svg>`;
}

// setAvEl(domEl, username) — set a DOM avatar element to show the
// correct photo (or default grey SVG if no photo is available).
//
// This is the primary way to render avatars throughout the app.
// It checks _avCache first for an instant result, then falls back
// to S.users, S.user, and localStorage — all without network calls.
//
// The "skip if same URL" check prevents unnecessary DOM mutations
// during re-renders (e.g. when renderFeed() runs after a like update).
//
// fetchPriority="high" is set on the logged-in user's own avatar
// so the browser downloads it first — it appears in the header on
// every page so it should load as fast as possible.
//
// onerror falls back to the default grey SVG if the image URL 404s
// (e.g. if a user deleted their avatar from Supabase Storage).
function setAvEl(domEl, username) {
  if (!domEl || !username) return;
  domEl.dataset.user = username; // store for the global data-user click handler
  const url = getAvatarUrl(username);
  // Skip DOM write if the element already shows this exact image URL
  // — avoids flicker and unnecessary repaints during feed re-renders
  const existing = domEl.querySelector('img');
  if (url && existing && existing.src === url) return;
  if (url) {
    const isOwn = S.user?.username === username;
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.className = 'av-photo';
    img.loading = isOwn ? 'eager' : 'lazy';
    if (isOwn) img.fetchPriority = 'high';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block';
    img.onerror = () => { domEl.innerHTML = _defaultAvSVG(); };
    domEl.innerHTML = '';
    domEl.appendChild(img);
    domEl.style.background = 'transparent';
  } else {
    // Only write SVG if not already showing it
    if (!domEl.querySelector('svg')) {
      domEl.innerHTML = _defaultAvSVG();
      domEl.style.background = 'transparent';
    }
    // We don't have this user in S.users at all yet (e.g. they posted
    // after our last profile fetch, or joined very recently) — the normal
    // 90-second cache refresh eventually catches this, but for a post
    // that's visible RIGHT NOW, fetch just this one avatar directly
    // instead of waiting on the bulk refresh.
    if (!S.users.find(u => u.username === username) && !_avFetchInFlight.has(username)) {
      _avFetchInFlight.add(username);
      DB.getProfileByUsername(username).then(row => {
        _avFetchInFlight.delete(username);
        if (row?.avatar_url?.startsWith('http')) {
          cacheAvatarUrl(username, row.avatar_url);
          // Re-apply to every currently-visible element for this user,
          // not just the one that triggered the fetch
          document.querySelectorAll(`[data-user="${CSS.escape(username)}"]`).forEach(node => {
            if (node.querySelector('svg') || !node.querySelector('img')) setAvEl(node, username);
          });
        }
      }).catch(() => { _avFetchInFlight.delete(username); });
    }
  }
  setStoryRing(domEl, username);
}
const _avFetchInFlight = new Set();

// Return avatar HTML string — shows photo or default grey SVG, with the
// 24hr "active Car Spotting story" ring auto-applied where relevant.
// Skips the ring for story-bar bubbles themselves, which already have
// their own dedicated ring wrapper — this avoids a doubled-up ring there.
function renderAv(username, size, extraClass) {
  const url = getAvatarUrl(username);
  const cls = [extraClass||''].filter(Boolean).join(' ');
  const s = size || 40;
  const isStoryBubbleInner = cls.includes('story-bubble-av-inner');
  const ringClass = (!isStoryBubbleInner && hasActiveSpotStory(username)) ? ' has-story-ring' : '';
  const inner = url
    ? `<div class="has-photo" style="width:100%;height:100%;border-radius:50%;overflow:hidden"><img src="${url}" alt="" class="av-photo" style="width:100%;height:100%;object-fit:cover;display:block"/></div>`
    : `<div style="width:100%;height:100%;border-radius:50%;overflow:hidden;background:transparent">${_defaultAvSVG()}</div>`;
  // overflow:visible is forced here (not left to CSS) because some callers'
  // classes — msg-conv-av, msg-bubble-av — define their own overflow:hidden
  // elsewhere in the stylesheet, which would silently clip the ring off
  // entirely. The inner div above still clips the photo/SVG into a circle
  // on its own, so relaxing overflow on this outer wrapper is safe.
  const outerOverflow = ringClass ? ';overflow:visible' : '';
  return `<div class="${cls}${ringClass}" style="width:${s}px;height:${s}px;flex-shrink:0;position:relative${outerOverflow}">${inner}</div>`;
}

function updateAuthUI() {
  updateDmBadge();
  if (S.user) {
    el('openAuthBtn') && (el('openAuthBtn').style.display='none');
    el('avWrap') && (el('avWrap').style.display='block');
    const avCircleEl = el('avCircle');
    const avatarUrl = getAvatarUrl(S.user.username);
    if (avCircleEl) setAvEl(avCircleEl, S.user.username);
    if(el('avName'))el('avName').textContent = S.user.username;
    const ddAdm = el('ddAdmin');
    if (ddAdm) ddAdm.style.display = S.user.isAdmin ? '' : 'none';
    const mobAdm = document.querySelector('.mob-link[data-page="admin"]');
    if (mobAdm) mobAdm.style.display = S.user.isAdmin ? '' : 'none';
    hideSignupNudge();
  } else {
    el('openAuthBtn') && (el('openAuthBtn').style.display='');
    el('avWrap') && (el('avWrap').style.display='none');
    const ddAdm = el('ddAdmin');
    if (ddAdm) ddAdm.style.display = 'none';
    setTimeout(showSignupNudge, 2500);
  }
}

function showSignupNudge() {
  if (S.user) return;
  const nudge = el('signupNudge');
  if (!nudge || localStorage.getItem('dl_nudge_dismissed') === '1') return;
  nudge.style.display = 'block';
  requestAnimationFrame(() => requestAnimationFrame(() => nudge.classList.add('show')));
}
function hideSignupNudge() {
  const nudge = el('signupNudge');
  if (!nudge) return;
  nudge.classList.remove('show');
  setTimeout(() => { if (nudge) nudge.style.display = 'none'; }, 400);
}

// ─── MOBILE NAV ───────────────────────────────────────────────
function initMobileNav() {
  function openMobNav() {
    el('mobNav')?.classList.add('open');
    el('mobOverlay')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  window.openMobNav = openMobNav;

  function closeMobNav() {
    el('mobNav')?.classList.remove('open');
    el('mobOverlay')?.classList.remove('open');
    document.body.style.overflow = '';
  }
  window.closeMobNav = closeMobNav;

  el('hamburger')?.addEventListener('click', openMobNav);
  el('mobNavClose')?.addEventListener('click', closeMobNav);
  el('mobOverlay')?.addEventListener('click', closeMobNav);

  // Theme toggle (in drawer)
  el('mobThemeToggle')?.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    try {
      const p = JSON.parse(localStorage.getItem('dl_prefs')||'{}');
      p.theme = isDark ? 'dark' : 'light';
      localStorage.setItem('dl_prefs', JSON.stringify(p));
    } catch(_) {}
    el('mobThemeToggle').innerHTML = isDark ? '<i class="fas fa-sun"></i> Light Mode' : '<i class="fas fa-moon"></i> Dark Mode';
    if (el('themeToggleBtn')) el('themeToggleBtn').innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
  });

  // Drawer nav links
  document.querySelectorAll('.mob-link[data-page]').forEach(link => {
    link.addEventListener('click', () => { closeMobNav(); goTo(link.dataset.page); });
  });

  // Post build in drawer
  el('mobPostBuildBtn')?.addEventListener('click', () => { closeMobNav(); openPostModal(); });

  // ── Bottom tab bar ──────────────────────────────────────────
  document.querySelectorAll('.mob-bottom-tab[data-page]').forEach(tab => {
    tab.addEventListener('click', () => goTo(tab.dataset.page));
  });
  el('mobBottomPost')?.addEventListener('click', openPostModal);
}

function closeMobNav() {
  el('mobNav')?.classList.remove('open');
  el('mobOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}

// ─── ANIMATED STATS ───────────────────────────────────────────
function animateStats() {
  const tl = S.posts.reduce((a,p)=>a+(p.likes||0),0);
  countUp('sideStatBuilds',  S.posts.length, 900);
  countUp('sideStatMembers', S.users.length, 1100);
  countUp('sideStatLikes',   tl,             1300);
  // Hidden legacy spans
  countUp('statBuilds',  S.posts.length, 900);
  countUp('statMembers', S.users.length, 1100);
  countUp('statLikes',   tl,             1300);
  renderFeaturedMembers();
}

function renderFeaturedMembers() {
  const strip     = el('featuredMembersStrip');
  const avatarsEl = el('featuredMembersAvatars');
  if (!strip || !avatarsEl) return;
  const featured = S.users.filter(u => u.isFeatured);
  // This span is a hidden legacy placeholder (real featured members UI
  // now lives in the sidebar). Never make it visible.
  strip.style.display = 'none';
  if (!featured.length) { avatarsEl.innerHTML = ''; return; }
  const MAX_SHOW = 5;
  const shown = featured.slice(0, MAX_SHOW);
  const extra = featured.length - MAX_SHOW;
  avatarsEl.innerHTML = shown.map(u => {
    const url = getAvatarUrl(u.username);
    const bg  = url ? 'transparent' : '#6b7280';
    const img = url
      ? `<img src="${url}" alt="" class="av-photo"/>`
      : _defaultAvSVG();
    const ring = hasActiveSpotStory(u.username) ? ' has-story-ring' : '';
    return `<div class="fm-av clickable-user${ring}" data-user="${u.username}" title="${esc(u.username)}" style="background:${bg}${ring?';overflow:visible':''}">${img}</div>`;
  }).join('') + (extra > 0
    ? `<div class="fm-av fm-av-more" onclick="goTo('members')">+${Math.min(extra,9)}${extra>=9?'+':''}</div>`
    : '');
}
function countUp(id,target,dur) {
  const node=el(id); if(!node)return;
  const s=performance.now();
  const tick=now=>{const t=Math.min((now-s)/dur,1); node.textContent=Math.floor(target*(1-Math.pow(1-t,3))).toLocaleString(); if(t<1)requestAnimationFrame(tick);};
  requestAnimationFrame(tick);
}

// ─── BUILD OF THE WEEK (BOTW) ─────────────────────────────────
// The BOTW carousel on the home page shows the top 5 posts.
// Ranking priority:
//   1. Posts within the last 7 days (BOTW_WINDOW_MS) come first
//      — rewards fresh content and encourages regular posting
//   2. Within each group, sorted by total likes descending
//      — most-loved builds rise to the top
//
// This means a brand-new post with 2 likes appears above a 6-month-old
// post with 200 likes. Once the new post is >7 days old, the classic
// reclaims its position. This keeps the carousel fresh.
//
// NOTE: This is different from the Hot Right Now slider (renderHotPanel),
// which ranks purely by likes with no recency weighting.
function getBotwPosts() {
  const cutoff = Date.now() - BOTW_WINDOW_MS;
  return [...S.posts].sort((a,b)=>{
    const aNew = new Date(a.date).getTime() >= cutoff;
    const bNew = new Date(b.date).getTime() >= cutoff;
    if (aNew!==bNew) return aNew?-1:1;
    return b.likes - a.likes;
  }).slice(0,5);
}

function renderBOTW() {
  const top5 = getBotwPosts();
  // Render hero2 recent list (always runs)
  renderHero2Recent();
  if (!top5.length) {
    // No posts yet — show placeholder
    const imgEl = el('hero2Img');
    if (imgEl) imgEl.innerHTML = '<div class="hero2-skeleton"></div>';
    if (el('hero2Title')) el('hero2Title').textContent = 'No builds yet';
    if (el('hero2Meta'))  el('hero2Meta').innerHTML = '';
    return;
  }

  let cur = 0, timer;

  function renderSlide(idx) {
    const p   = top5[idx];
    const img = p.images?.[0];
    const imgEl  = el('hero2Img');
    const titleEl= el('hero2Title');
    const metaEl = el('hero2Meta');
    const dotsEl = el('hero2Dots');
    const viewBtn= el('hero2ViewBtn');

    if (imgEl) {
      imgEl.innerHTML = img
        ? `<img src="${img}" alt="${esc(p.title)}" class="hero2-slide-img"/>`
        : `<div class="hero2-slide-ph" style="background:${phBg(p.id)}"></div>`;
    }
    if (titleEl) titleEl.textContent = p.title;
    if (metaEl)  metaEl.innerHTML = `
      <span>by <span class="clickable-user hero2-user" data-user="${p.user}">${esc(p.user)}</span></span>
      ${p.year ? `<span>${p.year}</span>` : ''}
      ${p.hp   ? `<span>${esc(p.hp)}</span>` : ''}
      <span class="hero2-likes">♥ ${p.likes.toLocaleString()}</span>`;
    if (dotsEl) dotsEl.innerHTML = top5.map((_,i)=>`<button class="hero2-dot${i===idx?' active':''}" data-i="${i}" aria-label="Slide ${i+1}"></button>`).join('');
    if (viewBtn) viewBtn.onclick = () => openCarPage(top5[cur]);

    // Re-wire dots
    el('hero2Dots')?.querySelectorAll('.hero2-dot').forEach(d =>
      d.addEventListener('click', () => go(+d.dataset.i))
    );
    // Wire user links
    el('hero2Meta')?.querySelectorAll('.clickable-user').forEach(u =>
      u.addEventListener('click', () => viewPublicProfile(u.dataset.user))
    );
  }

  function go(idx) {
    cur = ((idx % top5.length) + top5.length) % top5.length;
    renderSlide(cur);
    clearInterval(timer);
    timer = setInterval(() => go(cur + 1), 5500);
  }

  // Wire feature panel click
  el('hero2Feature')?.addEventListener('click', e => {
    if (e.target.closest('button') || e.target.closest('.clickable-user') || e.target.closest('.hero2-dot')) return;
    openCarPage(top5[cur]);
  });
  el('hero2Prev')?.addEventListener('click', e => { e.stopPropagation(); go(cur - 1); });
  el('hero2Next')?.addEventListener('click', e => { e.stopPropagation(); go(cur + 1); });
  // Touch swipe on feature panel
  let _h2tx = 0;
  el('hero2Feature')?.addEventListener('touchstart', e => { _h2tx = e.touches[0].clientX; }, {passive:true});
  el('hero2Feature')?.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - _h2tx;
    if (Math.abs(dx) > 40) go(dx < 0 ? cur+1 : cur-1);
  }, {passive:true});

  go(0);
  timer = setInterval(() => go(cur + 1), 5500);
}

function renderHero2Recent() {
  const listEl = el('hero2RecentList');
  if (!listEl) return;
  const recent = [...S.posts].sort((a,b) => new Date(b.createdAt||b.date) - new Date(a.createdAt||a.date)).slice(0, 4);
  if (!recent.length) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:.8rem;padding:8px 0">No builds yet — be the first!</p>';
    return;
  }
  listEl.innerHTML = recent.map(p => {
    const img = p.images?.[0];
    return `<div class="hero2-recent-item" data-id="${p.id}">
      <div class="hero2-recent-thumb" style="${img?'':'background:'+phBg(p.id)}">
        ${img ? `<img src="${img}" alt="" loading="lazy"/>` : ''}
      </div>
      <div class="hero2-recent-info">
        <div class="hero2-recent-title">${esc(p.title)}</div>
        <div class="hero2-recent-meta">${esc(p.user)} · ♥ ${p.likes}</div>
      </div>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.hero2-recent-item').forEach(item =>
    item.addEventListener('click', () => {
      const p = S.posts.find(x => x.id === item.dataset.id);
      if (p) openCarPage(p);
    })
  );
}

// ─── HOT RIGHT NOW SLIDER ─────────────────────────────────────
// Shows the top 10 most-liked posts in a full-width cinematic slider.
// Unlike BOTW, this ranks purely by total likes — no recency weighting.
// Slides auto-advance every HOT_SLIDE_DURATION ms with a progress bar.
// On mobile: arrow buttons are hidden, swipe left/right to navigate.
//
// The "Hot Right Now" label that used to appear above the slider was
// removed from HTML — the rank badge on each slide ("#1 Hottest Build")
// makes the section self-explanatory without a redundant heading.
//
// renderTicker() is a legacy alias kept because boot calls renderTicker().
function renderTicker() { renderHotPanel(); } // alias — called during renderAll()
// ─── HOT RIGHT NOW — Cinematic Slider ─────────────────────────
let _hotSliderIdx  = 0;          // currently visible slide index
let _hotSliderAuto = null;       // setInterval handle for auto-advance
const HOT_SLIDE_DURATION = 8000; // ms between automatic slide advances

function renderHotPanel() {
  const slider = el('hotSlider'); if (!slider) return;
  // Exactly the top 5 hottest posts by likes — no more, no less
  const top    = [...S.posts].sort((a,b) => b.likes - a.likes).slice(0, 5);

  // Clear previous state
  slider.querySelectorAll('.hot-slide').forEach(s => s.remove());
  if (_hotSliderAuto) { clearInterval(_hotSliderAuto); _hotSliderAuto = null; }

  if (!top.length) {
    el('hotEmpty').style.display  = 'flex';
    el('hotControls').style.display = 'none';
    return;
  }
  el('hotEmpty').style.display    = 'none';
  el('hotControls').style.display = 'flex';

  // Build slides
  top.forEach((p, i) => {
    const img    = p.images?.[0];
    const imgs   = (p.images||[]).slice(1, 3); // up to 2 strip thumbs
    const slide  = document.createElement('div');
    slide.className = 'hot-slide' + (i === 0 ? ' active' : '');
    slide.dataset.id = p.id;
    slide.innerHTML = `
      <div class="hot-slide-img">
        ${img
          ? `<img src="${img}" alt="${esc(p.title)}" loading="${i < 2 ? 'eager' : 'lazy'}"/>`
          : `<div class="hot-slide-img-ph" style="background:${phBg(p.id)}">${esc(p.make.toUpperCase())}</div>`}
      </div>
      <div class="hot-slide-rank">
        <span class="hot-slide-rank-num">#${i+1}</span>
        <span>${i===0?'Hottest Build':'Hot Right Now'}</span>
      </div>
      <div class="hot-slide-info">
        <div class="hot-slide-title">${esc(p.title)}</div>
        <div class="hot-slide-sub">
          ${p.hp ? `<span><i class="fas fa-bolt"></i> ${esc(p.hp)}</span>` : ''}
          ${p.year ? `<span>${esc(p.year)}</span>` : ''}
          <span><i class="fas fa-heart"></i> ${p.likes.toLocaleString()}</span>
          <span class="hot-item-user clickable-user" data-user="${p.user}" style="margin-left:auto;color:rgba(255,255,255,.7)">by ${esc(p.user)}</span>
        </div>
      </div>
      <div class="hot-slide-strip">
        ${imgs.map(src=>`<div class="hot-strip-thumb"><img src="${src}" alt="" loading="lazy"/></div>`).join('')}
        ${imgs.length < 2 ? `<div class="hot-strip-thumb" style="background:#111"></div>`.repeat(2-imgs.length) : ''}
      </div>`;
    // Click on main image/info → open post
    slide.addEventListener('click', e => {
      if (e.target.closest('.clickable-user')) return;
      openCarPage(p);
    });
    slider.insertBefore(slide, el('hotControls'));
  });

  // Dots
  const dotsEl = el('hotDots');
  dotsEl.innerHTML = top.map((_, i) =>
    `<div class="hot-ctrl-dot${i===0?' active':''}" data-i="${i}"></div>`
  ).join('');
  dotsEl.querySelectorAll('.hot-ctrl-dot').forEach(d =>
    d.addEventListener('click', () => hotGoTo(+d.dataset.i))
  );

  // Arrows
  el('hotPrev').onclick = () => hotGoTo((_hotSliderIdx - 1 + top.length) % top.length);
  el('hotNext').onclick = () => hotGoTo((_hotSliderIdx + 1) % top.length);
  // Touch swipe on hot slider for mobile
  const _hs = el('hotSlider');
  if (_hs && !_hs._swipeWired) {
    _hs._swipeWired = true;
    let _hsTx = 0;
    _hs.addEventListener('touchstart', e => { _hsTx = e.touches[0].clientX; }, {passive:true});
    _hs.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - _hsTx;
      if (Math.abs(dx) > 40) hotGoTo(dx < 0
        ? (_hotSliderIdx + 1) % top.length
        : (_hotSliderIdx - 1 + top.length) % top.length
      );
    }, {passive:true});
  }

  // Auto-advance
  _hotSliderIdx = 0;
  startHotProgress(HOT_SLIDE_DURATION);
  _hotSliderAuto = setInterval(() => {
    hotGoTo((_hotSliderIdx + 1) % top.length);
  }, HOT_SLIDE_DURATION);
}

function hotGoTo(idx) {
  const slides = el('hotSlider')?.querySelectorAll('.hot-slide');
  const dots   = el('hotDots')?.querySelectorAll('.hot-ctrl-dot');
  if (!slides?.length) return;
  slides.forEach((s,i)  => s.classList.toggle('active', i === idx));
  dots?.forEach((d,i)   => d.classList.toggle('active', i === idx));
  _hotSliderIdx = idx;
  // Restart progress bar
  if (_hotSliderAuto) { clearInterval(_hotSliderAuto); }
  startHotProgress(HOT_SLIDE_DURATION);
  _hotSliderAuto = setInterval(() => {
    const top = [...S.posts].sort((a,b)=>b.likes-a.likes).slice(0,10);
    hotGoTo((_hotSliderIdx + 1) % top.length);
  }, HOT_SLIDE_DURATION);
}

function startHotProgress(dur) {
  const fill = el('hotProgressFill'); if (!fill) return;
  fill.style.transition = 'none';
  fill.style.width = '0%';
  // Force reflow
  fill.getBoundingClientRect();
  fill.style.transition = `width ${dur}ms linear`;
  fill.style.width = '100%';
}

// ─── SEARCH ───────────────────────────────────────────────────
// Two search modes:
//
// 1. Desktop (≥769px): a static, always-visible search bar in the header.
//    Results appear in a dropdown below the bar as you type. Pressing
//    Enter jumps to the fullscreen overlay for a full results page.
//
// 2. FULLSCREEN overlay (mobile, ≤768px):
//    Tapping the persistent mobile search bar opens a full-page search
//    overlay immediately. The keyboard pops up on mobile right away
//    (double focus trick for iOS Safari which ignores the first .focus()
//    in a click handler).
//
// Both modes search the local S.posts and S.users arrays first (instant),
// then fire Supabase FTS (full-text search) queries in the background
// and merge any new results that weren't in the local cache.
let _searchTimer;
function initSearch() {
  const wrap     = el('headerSearchWrap');
  const input    = el('headerSearchInput');
  const results  = el('headerSearchResults');
  const clearBtn = el('headerSearchClear');
  let _searchTimer = null;

  function hideInlineResults() {
    if (input) input.value = '';
    if (results) { results.innerHTML = ''; results.style.display = 'none'; }
    if (clearBtn) clearBtn.style.display = 'none';
  }
  // Kept for other code that dismisses the search dropdown after navigating
  window._closeInlineSearch = hideInlineResults;

  // Mobile persistent search bar — tap opens fullscreen search
  el('mobSearchBar')?.addEventListener('click', () => {
    openSearch();
    setTimeout(() => el('searchInput')?.focus(), 50);
  });
  el('mobSearchInput')?.addEventListener('focus', (e) => {
    e.target.blur(); // prevent native keyboard on the readonly input
    openSearch();
    setTimeout(() => el('searchInput')?.focus(), 80);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideInlineResults(); closeSearch(); }
  });
  el('searchClose')?.addEventListener('click', closeSearch);
  el('searchOverlay')?.addEventListener('click', e => { if(e.target===el('searchOverlay')) closeSearch(); });
  el('searchInput')?.addEventListener('input', () => { clearTimeout(_searchTimer); _searchTimer=setTimeout(doSearch,120); });
  document.querySelectorAll('.stag').forEach(t => t.addEventListener('click',()=>{el('searchInput').value=t.dataset.q; doSearch();}));

  input?.addEventListener('input', () => {
    const q = input.value.trim();
    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';
    if (!q) { if(results){results.innerHTML='';results.style.display='none';} return; }
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => runInlineSearch(q), 150);
  });
  input?.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideInlineResults();
    if (e.key === 'Enter' && input.value.trim()) {
      el('searchInput').value = input.value;
      hideInlineResults(); openSearch(); doSearch();
    }
  });
  clearBtn?.addEventListener('click', () => { hideInlineResults(); input?.focus(); });
  document.addEventListener('click', e => {
    if (results && results.style.display!=='none' && wrap && !wrap.contains(e.target)) {
      results.style.display = 'none';
    }
  });
}

async function runInlineSearch(q) {
  const results = el('headerSearchResults'); if (!results) return;
  const lq = q.toLowerCase();
  const postMatches = S.posts.filter(p =>
    p.title?.toLowerCase().includes(lq) || p.make?.toLowerCase().includes(lq) ||
    p.model?.toLowerCase().includes(lq) || (p.year||'').includes(lq)
  ).slice(0,4);
  const userMatches = S.users.filter(u => u.username?.toLowerCase().includes(lq)).slice(0,3);

  results.style.display = 'block';
  if (!postMatches.length && !userMatches.length) {
    results.innerHTML = `<div class="hsr-empty">No results for "<b>${esc(q)}</b>"</div>`; return;
  }
  const avSVG = _defaultAvSVG();
  results.innerHTML = [
    userMatches.length ? `<div class="hsr-section">People</div>${userMatches.map(u => {
      const url = getAvatarUrl(u.username);
      const ring = hasActiveSpotStory(u.username) ? ' has-story-ring' : '';
      return `<div class="hsr-item hsr-user" data-user="${esc(u.username)}">
        ${url?`<img src="${url}" class="hsr-av${ring}" alt="" style="${ring?'overflow:visible':''}"/>`:`<div class="hsr-av${ring}" style="${ring?'overflow:visible':''}">${avSVG}</div>`}
        <div class="hsr-info"><div class="hsr-name">${esc(u.username)}</div><div class="hsr-sub">${u.posts||0} builds</div></div>
      </div>`; }).join('')}` : '',
    postMatches.length ? `<div class="hsr-section">${userMatches.length?'Builds':'Results'}</div>${postMatches.map(p => {
      const img = p.images?.[0];
      return `<div class="hsr-item hsr-post" data-id="${esc(p.id)}">
        <div class="hsr-thumb"${img?'':` style="background:${phBg(p.id)}"`}>${img?`<img src="${img}" alt="" loading="lazy"/>`:''}
        </div>
        <div class="hsr-info"><div class="hsr-name">${esc(p.title)}</div><div class="hsr-sub">${esc(p.user)} · ♥ ${p.likes}</div></div>
      </div>`; }).join('')}` : '',
  ].join('');
  results.querySelectorAll('.hsr-user').forEach(item =>
    item.addEventListener('click', () => { window._closeInlineSearch?.(); viewPublicProfile(item.dataset.user); })
  );
  results.querySelectorAll('.hsr-post').forEach(item =>
    item.addEventListener('click', () => {
      window._closeInlineSearch?.();
      const p = S.posts.find(x=>x.id===item.dataset.id); if(p) openCarPage(p);
    })
  );
  if (_sbOk() && q.length > 1) {
    Promise.all([DB.searchPostsFTS(q,8).catch(()=>[]), DB.searchUsers(q,4).catch(()=>[])]).then(([sbP,sbU]) => {
      let changed = false;
      sbP.forEach(r=>{const p=dbPostToApp(r);if(p&&!S.posts.find(x=>x.id===p.id)){S.posts.push(p);changed=true;}});
      sbU.forEach(r=>{const u=dbUserToApp(r);if(u&&!S.users.find(x=>x.username===u.username)){S.users.push(u);changed=true;}});
      if(changed && el('headerSearchInput')?.value.trim()===q) runInlineSearch(q);
    });
  }
}
function openSearch(){
  el('searchOverlay').classList.add('open');
  // Focus immediately — critical for keyboard to appear on mobile
  const inp = el('searchInput');
  if (inp) {
    inp.focus();
    // Belt-and-suspenders: try again after a frame (iOS Safari needs this)
    requestAnimationFrame(() => inp.focus());
  }
}
function closeSearch(){ el('searchOverlay').classList.remove('open'); if(el('searchInput'))el('searchInput').value=''; if(el('searchResults'))el('searchResults').innerHTML=''; }

async function doSearch() {
  const q   = el('searchInput').value.trim();
  const res = el('searchResults');
  if (!q) { res.innerHTML = ''; return; }
  const lq = q.toLowerCase();

  // Fire Supabase search in background — merges new results into S.posts/S.users
  if (_sbOk()) {
    Promise.all([
      DB.searchPostsFTS(q, 20).catch(()=>[]),
      DB.searchUsers(q, 10).catch(()=>[]),
    ]).then(([sbPosts, sbUsers]) => {
      let changed = false;
      sbPosts.forEach(row => { const p=dbPostToApp(row); if(p&&!S.posts.find(x=>x.id===p.id)){S.posts.push(p);changed=true;} });
      sbUsers.forEach(row => { const u=dbUserToApp(row); if(u&&!S.users.find(x=>x.username===u.username)){S.users.push(u);changed=true;} });
      if (changed) doSearch(); // re-render with expanded results
    });
  }

  // Local results first (instant)
  let allPosts = S.posts.filter(p => {
    const modsFlat = p.modsDetail ? Object.values(p.modsDetail).flat().join(' ') : '';
    const cats     = (Array.isArray(p.categories)?p.categories:[p.category]).join(' ').toLowerCase();
    return p.title?.toLowerCase().includes(lq)  ||
      p.make?.toLowerCase().includes(lq)         ||
      p.model?.toLowerCase().includes(lq)        ||
      (p.year||'').includes(lq)                  ||
      cats.includes(lq)                          ||
      p.user?.toLowerCase().includes(lq)         ||
      (p.mods||'').toLowerCase().includes(lq)    ||
      modsFlat.toLowerCase().includes(lq)        ||
      (p.desc||'').toLowerCase().includes(lq);
  });

  let memberHits = S.users.filter(u =>
    u.username?.toLowerCase().includes(lq) ||
    (u.bio||'').toLowerCase().includes(lq)
  ).slice(0, 3);

  // Render local results immediately
  renderSearchResults(allPosts, memberHits, q);

  // Then query Supabase for broader results
  try {
    const [sbPosts, sbUsers] = await Promise.all([
      DB.searchPosts(q),
      DB.searchUsers(q),
    ]);
    if (sbPosts?.length) {
      sbPosts.map(dbPostToApp).filter(Boolean).forEach(p => {
        if (!allPosts.find(x=>x.id===p.id)) allPosts.push(p);
      });
    }
    if (sbUsers?.length) {
      sbUsers.map(dbUserToApp).filter(Boolean).forEach(u => {
        if (!memberHits.find(x=>x.username===u.username)) memberHits.push(u);
      });
      memberHits = memberHits.slice(0,3);
    }
    renderSearchResults(allPosts, memberHits, q);
  } catch(e) {}
}

function renderSearchResults(allPosts, memberHits, q) {
  const res = el('searchResults'); if (!res) return;
  const hits = allPosts.slice(0, 8);

  if (!hits.length && !memberHits.length) {
    res.innerHTML = `<p class="search-none">No results for "<b>${esc(q)}</b>"</p>`;
    return;
  }

  res.innerHTML =
    (allPosts.length ? `<div class="sr-count">${allPosts.length} build${allPosts.length!==1?'s':''} found</div>` : '') +
    hits.map(p => {
      const cats  = Array.isArray(p.categories)&&p.categories.length ? p.categories : [p.category].filter(Boolean);
      const img   = p.images?.[0];
      const thumb = img ? `<img class="sr-thumb" src="${img}" alt=""/>` : `<div class="sr-thumb" style="background:${phBg(p.id)}"></div>`;
      return `<div class="sr-item" data-id="${p.id}">${thumb}<div>
        <div class="sr-title">${esc(p.title)} ${cats.slice(0,2).map(c=>`<span class="cat-badge ${catCfg(c).badge}" style="position:static;font-size:.6rem">${c}</span>`).join(' ')}</div>
        <div class="sr-meta">by ${esc(p.user)} · ♥ ${p.likes}${p.hp?' · '+p.hp:''}</div>
      </div></div>`;
    }).join('') +
    (memberHits.length ? `<div class="sr-section-label">Members</div>` + memberHits.map(u => `
      <div class="sr-user-item" data-user="${u.username}">
        <div class="sr-user-av" style="background:#6b7280">${u.username[0].toUpperCase()}</div>
        <div><div class="sr-title">${esc(u.username)}</div><div class="sr-meta">${u.posts||0} builds${u.bio?' · '+(u.bio.slice(0,36))+(u.bio.length>36?'…':''):''}</div></div>
      </div>`).join('') : '');

  res.querySelectorAll('.sr-item').forEach(it => it.addEventListener('click', () => {
    closeSearch(); const p=S.posts.find(x=>x.id===it.dataset.id)||allPosts.find(x=>x.id===it.dataset.id); if(p) openCarPage(p);
  }));
  res.querySelectorAll('.sr-user-item').forEach(it => it.addEventListener('click', () => {
    closeSearch(); viewPublicProfile(it.dataset.user);
  }));
}

// ─── AUTH ─────────────────────────────────────────────────────
// Email validation — checks format is valid and domain has a dot after @
// We cannot do real DNS lookups from a static site, so we validate format strictly
// and flag clearly that the email must be real when creating an account.
function isValidEmailFormat(email) {
  // RFC-5321 simplified: something@something.tld
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function setAuthErr(id, msg) {
  const e = el(id); if (!e) return;
  e.textContent = msg;
  e.style.display = msg ? 'block' : 'none';
}
function clearAuthErrs() {
  ['loginEmailErr','loginPasswordErr','regUserErr','regEmailErr','regPasswordErr']
    .forEach(id => setAuthErr(id, ''));
}

function initAuth() {
  el('openAuthBtn')?.addEventListener('click', ()=>{ clearAuthErrs(); el('authModal').classList.add('open'); });
  el('openPostBtn')?.addEventListener('click', openPostModal);
  // Mobile: Post Build also in burger menu
  el('mobThemeToggle')?.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    try {
      const p = JSON.parse(localStorage.getItem('dl_prefs')||'{}');
      p.theme = isDark ? 'dark' : 'light';
      localStorage.setItem('dl_prefs', JSON.stringify(p));
    } catch(_) {}
    el('mobThemeToggle').innerHTML = isDark ? '<i class="fas fa-sun"></i> Light Mode' : '<i class="fas fa-moon"></i> Dark Mode';
  });
  el('mobPostBuildBtn')?.addEventListener('click', () => {
    closeMobNav();
    openPostModal();
  });
  el('authClose')?.addEventListener('click',  ()=>el('authModal').classList.remove('open'));
  // Signup nudge banner buttons
  el('signupNudgeBtn')?.addEventListener('click', () => {
    hideSignupNudge();
    el('authModal')?.classList.add('open');
    setTimeout(() => document.querySelector('.auth-tab[data-tab="register"]')?.click(), 50);
  });
  el('signupNudgeSignIn')?.addEventListener('click', () => {
    hideSignupNudge();
    el('authModal')?.classList.add('open');
    setTimeout(() => document.querySelector('.auth-tab[data-tab="login"]')?.click(), 50);
  });
  el('signupNudgeClose')?.addEventListener('click', () => {
    hideSignupNudge();
    localStorage.setItem('dl_nudge_dismissed', '1');
  });
  el('authModal')?.addEventListener('click',  e=>{if(e.target===el('authModal'))el('authModal').classList.remove('open');});

  // Tab switching
  document.querySelectorAll('.mtab').forEach(t=>t.addEventListener('click',()=>{
    clearAuthErrs();
    document.querySelectorAll('.mtab,.mform').forEach(x=>x.classList.remove('active'));
    t.classList.add('active'); el(t.dataset.tab+'Form').classList.add('active');
  }));
  document.querySelectorAll('.switch-tab').forEach(a=>a.addEventListener('click',e=>{
    e.preventDefault(); clearAuthErrs();
    document.querySelectorAll('.mtab').forEach(t=>t.classList.toggle('active',t.dataset.tab===a.dataset.target));
    document.querySelectorAll('.mform').forEach(x=>x.classList.remove('active'));
    el(a.dataset.target+'Form').classList.add('active');
  }));

  // Enter key support
  el('loginEmail')?.addEventListener('keydown',    e=>{if(e.key==='Enter')el('doLogin').click();});
  el('loginPassword')?.addEventListener('keydown', e=>{if(e.key==='Enter')el('doLogin').click();});
  el('regEmail')?.addEventListener('keydown',      e=>{if(e.key==='Enter')el('doRegister').click();});
  el('regPassword')?.addEventListener('keydown',   e=>{if(e.key==='Enter')el('doRegister').click();});

  // ── Google Sign-In ──────────────────────────────────────────
  function handleGoogleSignIn(response) {
    try {
      // Decode the JWT credential to get user info
      const payload = JSON.parse(atob(response.credential.split('.')[1]));
      const email   = payload.email;
      const name    = payload.name || '';
      const gid     = payload.sub; // unique Google ID
      if (!email) { toast('Google sign-in failed — no email returned', 'err'); return; }
      // Find existing user by Google ID or email
      let user = S.users.find(u => u.googleId === gid) || S.users.find(u => u.email === email);
      if (user) {
        // Existing user — sign in
        user.googleId = gid; // ensure it's stored
        loginUser(user.username);
      } else {
        // New user — create account using name as base username
        let baseUsername = name.replace(/[^a-zA-Z0-9_]/g,'').slice(0,18) || 'user';
        let username     = baseUsername;
        let suffix       = 1;
        while (S.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
          username = baseUsername + suffix++;
        }
        registerUser(username, email, null, gid);
      }
      el('authModal').classList.remove('open');
    } catch(e) {
      toast('Google sign-in error — try email instead', 'err');
    }
  }

  // Wire Google buttons — use a simple OAuth popup approach
  function openGoogleSignIn() {
    // Check if Google library loaded
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.initialize({
        client_id: '575055658940-placeholder.apps.googleusercontent.com', // Replace with your Google Client ID
        callback: handleGoogleSignIn,
        auto_select: true,
        cancel_on_tap_outside: true,
      });
      google.accounts.id.prompt();
    } else {
      toast('Google sign-in is not available in offline mode. Use email/password.', 'err');
    }
  }

  const gBtn1 = el('googleSignInBtn');
  const gBtn2 = el('googleRegisterBtn');
  if (gBtn1) gBtn1.addEventListener('click', openGoogleSignIn);
  if (gBtn2) gBtn2.addEventListener('click', openGoogleSignIn);

  // Clear inline errors on input
  ['loginEmail','loginPassword','regUser','regEmail','regPassword'].forEach(id=>{
    const inp = el(id); if(inp) inp.addEventListener('input', ()=>setAuthErr(id+'Err',''));
  });

  // ── SIGN IN ──
  el('doLogin')?.addEventListener('click', async () => {
    clearAuthErrs();
    const email    = el('loginEmail').value.trim();
    const password = el('loginPassword').value;
    let valid = true;

    if (!email) {
      setAuthErr('loginEmailErr', 'Please enter your email address.'); valid = false;
    } else if (!isValidEmailFormat(email)) {
      setAuthErr('loginEmailErr', 'Please enter a valid email address.'); valid = false;
    }
    if (!password) {
      setAuthErr('loginPasswordErr', 'Please enter your password.'); valid = false;
    }
    if (!valid) return;

    // Sign in via Supabase
    const signInBtn = el('doLogin');
    if (signInBtn) { signInBtn.textContent = 'Signing in…'; signInBtn.disabled = true; }
    const { data, error } = await DB.signIn(email, password);
    if (signInBtn) { signInBtn.textContent = 'Sign In'; signInBtn.disabled = false; }
    if (error) {
      if (error.message?.includes('Invalid') || error.message?.includes('credentials')) {
        setAuthErr('loginPasswordErr', 'Error: Incorrect email or password.');
      } else if (error.message?.includes('Email not confirmed')) {
        setAuthErr('loginEmailErr', 'Please check your email to confirm your account first.');
      } else {
        setAuthErr('loginEmailErr', error.message || 'Sign in failed. Please try again.');
      }
      return;
    }

    // Check whether this account has 2FA enabled and needs a second factor
    // before the session is fully trusted.
    const authLevel = await DB.mfaGetAuthLevel();
    if (authLevel.nextLevel === 'aal2' && authLevel.currentLevel !== 'aal2') {
      const { factors } = await DB.mfaListFactors();
      const factor = factors.find(f => f.status === 'verified');
      if (factor) {
        el('authModal').classList.remove('open');
        _pendingMfaLoginData = data;
        _pendingMfaFactorId = factor.id;
        el('mfaCodeInput').value = '';
        el('mfaCodeErr').textContent = '';
        el('mfaModal').classList.add('open');
        setTimeout(() => el('mfaCodeInput')?.focus(), 100);
        return;
      }
    }

    await completeSuccessfulLogin(data);
  });

  // ── MFA (2FA) verification, shown mid-login when required ──
  let _pendingMfaLoginData = null;
  let _pendingMfaFactorId = null;
  el('mfaModalClose')?.addEventListener('click', () => {
    el('mfaModal').classList.remove('open');
    _pendingMfaLoginData = null; _pendingMfaFactorId = null;
    toast('Sign-in cancelled','');
  });
  el('mfaVerifyBtn')?.addEventListener('click', async () => {
    const code = el('mfaCodeInput').value.trim();
    if (!/^\d{6}$/.test(code)) { el('mfaCodeErr').textContent = 'Enter the 6-digit code'; return; }
    const btn = el('mfaVerifyBtn');
    btn.disabled = true; btn.textContent = 'Verifying…';
    const { error } = await DB.mfaChallengeAndVerify(_pendingMfaFactorId, code);
    btn.disabled = false; btn.textContent = 'Verify';
    if (error) { el('mfaCodeErr').textContent = 'Incorrect code — try again'; return; }
    el('mfaModal').classList.remove('open');
    const data = _pendingMfaLoginData;
    _pendingMfaLoginData = null; _pendingMfaFactorId = null;
    await completeSuccessfulLogin(data);
  });
  el('mfaCodeInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') el('mfaVerifyBtn').click(); });

  async function completeSuccessfulLogin(data) {
    S.user = dbUserToApp(data);
    // Refresh users list
    try {
    const profiles = await DB.getAllProfiles();
    S.users = profiles.map(dbUserToApp).filter(Boolean);
    // Pre-cache all avatar URLs so they're available immediately on render
    S.users.forEach(u => {
      if (u.avatarUrl?.startsWith('http')) cacheAvatarUrl(u.username, u.avatarUrl);
    });
    // Re-render with real avatars now that we have them
    requestAnimationFrame(() => {
      document.querySelectorAll('[data-user]').forEach(el2 => {
        const uname = el2.dataset.user;
        if (!uname) return;
        if (el2.classList.contains('av-circle') || el2.classList.contains('msg-conv-av') ||
            el2.classList.contains('card-av') || el2.classList.contains('cp-av') ||
            el2.classList.contains('profile-av') || el2.classList.contains('member-av')) {
          setAvEl(el2, uname);
        }
      });
    });
  } catch(e) { console.warn('getAllProfiles failed:', e); }
    el('authModal').classList.remove('open');
    document.body.classList.remove('modal-open');
    loginUser(S.user.username);
  }

  // ── REGISTER ──
  el('doRegister')?.addEventListener('click', async () => {
    clearAuthErrs();
    const username = el('regUser').value.trim();
    const email    = el('regEmail').value.trim();
    const password = el('regPassword').value;
    let valid = true;

    // Username validation
    if (!username) {
      setAuthErr('regUserErr', 'Please choose a username.'); valid = false;
    } else if (username.length < 3) {
      setAuthErr('regUserErr', 'Username must be at least 3 characters.'); valid = false;
    } else if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      setAuthErr('regUserErr', 'Username: letters, numbers, and underscores only.'); valid = false;
    } else if (S.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      setAuthErr('regUserErr', 'Error: Username already taken.'); valid = false;
    }

    // Email validation
    if (!email) {
      setAuthErr('regEmailErr', 'Please enter your email address.'); valid = false;
    } else if (!isValidEmailFormat(email)) {
      setAuthErr('regEmailErr', 'Error: Email does not appear valid. Please check and try again.'); valid = false;
    } else if (S.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase())) {
      setAuthErr('regEmailErr', 'Error: Account already exists with this email. Try signing in.'); valid = false;
    }

    // Password validation
    if (!password) {
      setAuthErr('regPasswordErr', 'Please create a password.'); valid = false;
    } else if (password.length < 8) {
      setAuthErr('regPasswordErr', 'Password must be at least 8 characters.'); valid = false;
    }

    if (!valid) return;

    const regBtn = el('doRegister');
    if (regBtn) { regBtn.textContent = 'Creating account…'; regBtn.disabled = true; }
    await registerUser(username, email, password);
    if (regBtn) { regBtn.textContent = 'Create Account'; regBtn.disabled = false; }
    if (S.user) el('authModal').classList.remove('open');
  });
}

// loginUser — called after successful Supabase auth, sets local state
function loginUser(username) {
  const user = S.users.find(u => u.username === username);
  if (user) {
    S.user = user;
  } else {
    S.user = { username, posts:0, totalLikes:0, joined:new Date().toISOString().slice(0,7), joinedFull:new Date().toISOString(), bio:'', awards:[] };
  }
  // Persist immediately — settings.html is a separate page and reads
  // the session from localStorage. Without this, opening Settings
  // right after signing in says "not signed in" until a reload.
  try {
    localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
    localStorage.setItem('dl_user', JSON.stringify(S.user));
    localStorage.setItem('dl_last_user', username);
  } catch(_) {}
  // Always force-close auth modal
  el('authModal') && el('authModal').classList.remove('open');
  updateAuthUI(); updateProfilePage(); updateDmBadge();
  setupRealtimeSubscriptions();
  toast(`Welcome back, ${username}!`, 'ok');
}

async function registerUser(username, email, password, googleId) {
  const { data, error } = await DB.signUp(email, password||'', username);
  if (error) {
    if (error.message === 'USERNAME_TAKEN') { setAuthErr('regUserErr','Error: Username already taken.'); return; }
    setAuthErr('regEmailErr', error.message || 'Sign up failed. Please try again.'); return;
  }
  S.user = dbUserToApp(data) || { username, posts:0, totalLikes:0, joined:new Date().toISOString().slice(0,7), joinedFull:new Date().toISOString(), bio:'', awards:[] };
  S.users.push(S.user);
  localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
  localStorage.setItem('dl_user', JSON.stringify(S.user));
  localStorage.setItem('dl_last_user', username);
  el('authModal').classList.remove('open');
  updateAuthUI(); updateProfilePage(); updateNotifBadge();
  // Reload from Supabase so posts appear immediately for new account
  loadStorage().catch(()=>{});
  // Show onboarding modal
  showOnboarding(username);
}

function showOnboarding(username) {
  const existing = el('onboardingModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'onboardingModal';
  modal.className = 'upload-success-overlay open';
  modal.innerHTML = `
    <div class="upload-success-box onboarding-box">
      <div class="onboarding-header">
        <div class="onboarding-logo">DRIVE<span>LOG</span></div>
        <h2 class="upload-success-title">Welcome, ${esc(username)}! 👋</h2>
        <p class="upload-success-sub">You're now part of the DriveLog community. Here's how to get started:</p>
      </div>
      <div class="onboarding-steps">
        <div class="onboarding-step">
          <div class="onboarding-step-icon"><i class="fas fa-camera"></i></div>
          <div>
            <div class="onboarding-step-title">Post Your Build</div>
            <div class="onboarding-step-desc">Share your car with the community — photos, specs, and mods.</div>
          </div>
        </div>
        <div class="onboarding-step">
          <div class="onboarding-step-icon"><i class="fas fa-users"></i></div>
          <div>
            <div class="onboarding-step-title">Follow Enthusiasts</div>
            <div class="onboarding-step-desc">Find members with builds you love and follow their journey.</div>
          </div>
        </div>
        <div class="onboarding-step">
          <div class="onboarding-step-icon"><i class="fas fa-trophy"></i></div>
          <div>
            <div class="onboarding-step-title">Climb the Leaderboard</div>
            <div class="onboarding-step-desc">Get likes on your builds to rise through the Top Builds ranking.</div>
          </div>
        </div>
      </div>
      <div class="upload-success-actions" style="margin-top:20px">
        <button class="btn-primary" id="onboardPostBtn"><i class="fas fa-plus"></i> Post My First Build</button>
        <button class="btn-ghost" id="onboardExploreBtn">Explore the Feed</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  el('onboardPostBtn')?.addEventListener('click', () => {
    modal.remove(); openPostModal();
  });
  el('onboardExploreBtn')?.addEventListener('click', () => {
    modal.remove(); goTo('home');
  });
}

function makeNewUser(username) {
  const now=new Date();
  return {username,posts:0,totalLikes:0,joined:now.toISOString().slice(0,7),joinedFull:now.toISOString(),bio:'',instagram:'',tiktok:'',youtube:'',website:'',awards:[]};
}

async function logout() {
  await DB.signOut().catch(()=>{});
  // Clear ALL user data from localStorage so it doesn't reappear
  S.user=null; S.following=[]; S.notifs=[];
  localStorage.removeItem('dl_user_cache');
  localStorage.removeItem('dl_user');
  localStorage.removeItem('dl_avatar_url');
  // Clear any cached user-specific data
  const username = localStorage.getItem('dl_last_user');
  if (username) localStorage.removeItem('dl_following_' + username);
  localStorage.removeItem('dl_last_user');
  updateAuthUI(); updateProfilePage(); updateDmBadge();
  toast('Signed out','');
  goTo('home');
}

// ─── POST BUILD PAGE ─────────────────────────────────────────
let pendingImages=[];
let pendingVideos=[];
function initPostModal() {
  // Upload zone
  el('uploadZone')?.addEventListener('click', ()=>el('fileInput').click());
  el('uploadZone')?.addEventListener('dragover',  e=>{e.preventDefault(); el('uploadZone').classList.add('drag-over');});
  el('uploadZone')?.addEventListener('dragleave', ()=>el('uploadZone').classList.remove('drag-over'));
  el('uploadZone')?.addEventListener('drop', e=>{e.preventDefault(); el('uploadZone').classList.remove('drag-over'); addFiles(Array.from(e.dataTransfer.files));});
  el('fileInput')?.addEventListener('change', ()=>addFiles(Array.from(el('fileInput').files)));
  el('addMoreBtn')?.addEventListener('click', ()=>el('fileInput').click());
  el('submitPost')?.addEventListener('click', submitPost);

  // ── Video upload ──────────────────────────────────────────
  el('videoUploadZone')?.addEventListener('click', ()=>el('videoFileInput').click());
  el('videoUploadZone')?.addEventListener('dragover', e=>{e.preventDefault(); el('videoUploadZone').classList.add('drag-over');});
  el('videoUploadZone')?.addEventListener('dragleave', ()=>el('videoUploadZone').classList.remove('drag-over'));
  el('videoUploadZone')?.addEventListener('drop', e=>{
    e.preventDefault(); el('videoUploadZone').classList.remove('drag-over');
    addVideos(Array.from(e.dataTransfer.files));
  });
  el('videoFileInput')?.addEventListener('change', ()=>addVideos(Array.from(el('videoFileInput').files)));
  el('postPageBack')?.addEventListener('click', ()=>{ S._editingPostId=null; const btn=el('submitPost'); if(btn){btn.innerHTML='<i class="fas fa-upload"></i> Publish Build';delete btn.dataset.editing;} goTo(S._prevPage||'home'); });
  // ── Social links toggle ──────────────────────────────────
  function updateSocialPreview() {
    const preview = el('postSocialPreview'); if (!preview) return;
    const checked = el('postShowSocials')?.checked;
    const u = S.user;
    if (!checked || !u || (!u.instagram && !u.tiktok && !u.youtube && !u.website)) {
      preview.innerHTML = ''; return;
    }
    const links = [
      u.instagram ? `<span class="post-soc-chip"><i class="fab fa-instagram"></i> @${esc(u.instagram)}</span>` : '',
      u.tiktok    ? `<span class="post-soc-chip"><i class="fab fa-tiktok"></i> @${esc(u.tiktok)}</span>`    : '',
      u.youtube   ? `<span class="post-soc-chip"><i class="fab fa-youtube"></i> @${esc(u.youtube)}</span>`   : '',
      u.website   ? `<span class="post-soc-chip"><i class="fas fa-globe"></i> Website</span>`               : '',
    ].filter(Boolean).join('');
    preview.innerHTML = links
      ? `<div class="post-soc-preview-label">Will appear on listing:</div><div class="post-soc-chips">${links}</div>`
      : `<div class="post-soc-preview-label" style="color:var(--muted)">No social links saved yet — add them in <a href="settings.html" style="color:var(--accent)">Settings</a>.</div>`;
  }
  const socialToggle = el('postShowSocials');
  if (socialToggle) {
    socialToggle.addEventListener('change', updateSocialPreview);
    // Show preview on page open
    setTimeout(updateSocialPreview, 50);
  }

  // Multi-select category pills on post page
  document.querySelectorAll('.post-cat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      pill.classList.toggle('active');
      const selected = [...document.querySelectorAll('.post-cat-pill.active')].map(b=>b.dataset.cat);
      el('postCategory').value = selected[0] || '';
    });
  });
  // Mod list entry — each card with data-modkey
  document.querySelectorAll('.mod-cat-card[data-modkey]').forEach(card => {
    const key        = card.dataset.modkey;
    const inp        = card.querySelector('.mod-item-input');
    const linkInp    = card.querySelector('.mod-link-input');
    const linkToggle = card.querySelector('.mod-link-toggle');
    const btn        = card.querySelector('.mod-add-btn');
    const list       = card.querySelector('.mod-item-list');
    if (!inp || !btn || !list) return;

    // Toggle link input visibility
    if (linkToggle && linkInp) {
      linkToggle.addEventListener('click', () => {
        const showing = linkInp.style.display !== 'none';
        linkInp.style.display = showing ? 'none' : '';
        linkToggle.classList.toggle('active', !showing);
        if (!showing) linkInp.focus();
      });
    }

    function addItem() {
      const text = inp.value.trim(); if (!text) return;
      const url  = linkInp?.value.trim() || '';
      const itemEl = document.createElement('div');
      itemEl.className = 'mod-item-row';
      // Store as JSON so URL survives form serialization
      const dataVal = JSON.stringify({ text, url });
      itemEl.innerHTML = `
        <div class="mod-item-preview-wrap">
          ${url ? `<div class="mod-item-link-thumb" data-url="${escHtml(url)}">
            <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=32" alt="" class="mod-item-favicon" loading="lazy" onerror="this.style.display='none'"/>
          </div>` : '<div class="mod-item-bullet">—</div>'}
        </div>
        <div class="mod-item-body">
          <span class="mod-item-text-display">${escHtml(text)}</span>
          ${url ? `<a class="mod-item-link-label" href="${escHtml(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="fas fa-external-link-alt"></i> View Part</a>` : ''}
        </div>
        <input type="hidden" class="mod-item-text" value="${escHtml(dataVal)}"/>
        <button type="button" class="mod-item-rm" aria-label="Remove"><i class="fas fa-times"></i></button>`;
      itemEl.querySelector('.mod-item-rm').addEventListener('click', () => itemEl.remove());
      list.appendChild(itemEl);
      inp.value = '';
      if (linkInp) { linkInp.value = ''; linkInp.style.display = 'none'; }
      if (linkToggle) linkToggle.classList.remove('active');
      inp.focus();
    }
    btn.addEventListener('click', addItem);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function openPostModal() {
  if(!S.user){toast('Sign in to post a build','err'); el('authModal').classList.add('open'); return;}

  S._prevPage = S.page;
  goTo('post');
}
async function addFiles(files) {
  const rem  = 50 - pendingImages.length;
  const imgs = files.filter(f => f.type.startsWith('image/')).slice(0, rem);
  if (!imgs.length) return;

  // Progress bar — appended to body so it's never clipped by overflow containers
  let progressBar = el('uploadProgressBar');
  if (!progressBar) {
    progressBar = document.createElement('div');
    progressBar.id        = 'uploadProgressBar';
    progressBar.className = 'upload-progress-wrap';
    progressBar.innerHTML = `
      <div class="upload-progress-inner">
        <div class="upload-progress-track"><div class="upload-progress-fill" id="uploadProgressFill"></div></div>
        <div class="upload-progress-label" id="uploadProgressLabel">Preparing…</div>
      </div>`;
    document.body.appendChild(progressBar); // body-level so never hidden by overflow
  }
  progressBar.style.display = 'flex';

  for (let i = 0; i < imgs.length; i++) {
    const fill  = el('uploadProgressFill');
    const label = el('uploadProgressLabel');
    const pct   = Math.round((i / imgs.length) * 100);
    if (fill)  fill.style.width  = pct + '%';
    if (label) label.textContent = `Optimising photo ${i+1} of ${imgs.length}…`;

    const compressed = await compressImage(imgs[i]);
    pendingImages.push(compressed);
    renderPreviews();
  }

  // Complete
  const fill  = el('uploadProgressFill');
  const label = el('uploadProgressLabel');
  if (fill)  fill.style.width  = '100%';
  if (label) label.textContent = `✓ ${imgs.length} photo${imgs.length!==1?'s':''} ready`;
  setTimeout(() => { progressBar.style.display = 'none'; }, 1200);
}
function renderPreviews() {
  if(!pendingImages.length){el('previewStrip').style.display='none'; el('uploadZone').style.display=''; return;}
  el('previewStrip').style.display='block'; el('uploadZone').style.display='none';
  el('previewThumbs').innerHTML=pendingImages.map((src,i)=>`
    <div class="prev-wrap">
      <img class="prev-thumb${i===0?' cover':''}" src="${src}" data-i="${i}" title="${i===0?'Cover photo':'Click to set as cover'}"/>
      <button class="prev-rm" data-i="${i}"><i class="fas fa-times"></i></button>
      ${i===0?'<div class="prev-cover-tag">Cover</div>':''}
    </div>`).join('');
  el('previewThumbs').querySelectorAll('.prev-thumb').forEach(t=>t.addEventListener('click',()=>{
    const i=+t.dataset.i; if(i===0)return; pendingImages.unshift(pendingImages.splice(i,1)[0]); renderPreviews();
  }));
  el('previewThumbs').querySelectorAll('.prev-rm').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation(); pendingImages.splice(+b.dataset.i,1); renderPreviews();
  }));
}

// ═══════════════════════════════════════════════════════════════
// ─── EDIT POST ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function openEditPost(post) {
  if (!S.user || S.user.username !== post.user) {
    toast('You can only edit your own builds', 'err'); return;
  }
  S._editingPostId = post.id;
  S._prevPage = S.page;
  goTo('post');

  // Populate all form fields with existing data
  setTimeout(() => {
    const setVal = (id, v) => { const e = el(id); if (e) e.value = v || ''; };
    setVal('postTitle', post.title);
    setVal('postMake',  post.make);
    setVal('postModel', post.model);
    setVal('postYear',  post.year);
    setVal('postHP',    post.hp);
    setVal('postDesc',  post.desc);

    // Categories
    const cats = Array.isArray(post.categories) ? post.categories : [post.category].filter(Boolean);
    document.querySelectorAll('.post-cat-pill').forEach(pill => {
      pill.classList.toggle('active', cats.includes(pill.dataset.cat));
    });
    el('postCategory').value = cats[0] || '';

    // Mods detail — restore with URL support
    if (post.modsDetail) {
      ['engine','drivetrain','suspension','wheels','exterior','interior','other'].forEach(key => {
        const list  = el('modList-' + key);
        const items = post.modsDetail[key];
        const arr   = Array.isArray(items) ? items : (items||'').split(',').map(s=>s.trim()).filter(Boolean);
        if (!list || !arr.length) return;
        list.innerHTML = '';
        arr.forEach(rawItem => {
          const text = typeof rawItem === 'object' ? (rawItem.text||'') : String(rawItem);
          const url  = typeof rawItem === 'object' ? (rawItem.url||'')  : '';
          if (!text) return;
          const dataVal = JSON.stringify({ text, url });
          const itemEl = document.createElement('div');
          itemEl.className = 'mod-item-row';
          let thumbHTML = '';
          try {
            thumbHTML = url ? `<div class="mod-item-link-thumb"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=32" alt="" class="mod-item-favicon" loading="lazy" onerror="this.style.display='none'"/></div>` : '<div class="mod-item-bullet">—</div>';
          } catch(_) { thumbHTML = '<div class="mod-item-bullet">—</div>'; }
          itemEl.innerHTML = `
            <div class="mod-item-preview-wrap">${thumbHTML}</div>
            <div class="mod-item-body">
              <span class="mod-item-text-display">${escHtml(text)}</span>
              ${url ? `<a class="mod-item-link-label" href="${escHtml(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="fas fa-external-link-alt"></i> View Part</a>` : ''}
            </div>
            <input type="hidden" class="mod-item-text" value="${escHtml(dataVal)}"/>
            <button type="button" class="mod-item-rm" aria-label="Remove"><i class="fas fa-times"></i></button>`;
          itemEl.querySelector('.mod-item-rm').addEventListener('click', () => itemEl.remove());
          list.appendChild(itemEl);
        });
      });
    }

    // Existing images — load into pendingImages
    pendingImages = [...(post.images || [])];
    renderPreviews();
    pendingVideos = (post.videos||[]).map((url,i)=>({dataUrl:url,name:'video_'+(i+1)+'.mp4',type:'video/mp4',size:0}));
    renderVideoPreviews();
    const st = el('postShowSocials'); if(st) st.checked = post.showSocials !== false;
    const tr = el('postTransmission'); if(tr) tr.value = post.transmission||'';
    const stEl = el('postState'); if(stEl) stEl.value = post.buildState||'';
    const ml = el('postMileage'); if(ml) ml.value = post.mileage||'';
    const z60 = el('postZeroSixty'); if(z60) z60.value = post.zeroSixty||'';
    const qm  = el('postQuarterMile'); if(qm) qm.value = post.quarterMile||'';
    const ts  = el('postTopSpeed'); if(ts) ts.value = post.topSpeed||'';
    setTimeout(updateSocialPreview, 60);

    // Update submit button to say "Save Changes"
    const btn = el('submitPost');
    if (btn) {
      btn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
      btn.dataset.editing = '1';
    }
    const backBtn = el('postPageBack');
    if (backBtn) backBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Cancel Edit';

    toast('Edit mode — make your changes and save', 'ok');
  }, 150);
}

function isEditing() { return !!S._editingPostId; }

// ─── VIDEO UPLOAD HANDLING ────────────────────────────────────
const MAX_VIDEO_SIZE_MB = 50;
const MAX_VIDEOS = 8;

function addVideos(files) {
  const rem = MAX_VIDEOS - pendingVideos.length;
  const valid = files.filter(f => f.type.startsWith('video/')).slice(0, rem);
  for (const file of valid) {
    if (file.size > MAX_VIDEO_SIZE_MB * 1024 * 1024) {
      toast(`"${file.name}" exceeds ${MAX_VIDEO_SIZE_MB}MB limit — skipped`, 'err');
      continue;
    }
    const reader = new FileReader();
    reader.onload = e => {
      pendingVideos.push({ dataUrl: e.target.result, name: file.name, type: file.type, size: file.size });
      renderVideoPreviews();
    };
    reader.readAsDataURL(file);
  }
  if (files.length > 0 && pendingVideos.length >= MAX_VIDEOS) {
    toast(`Maximum ${MAX_VIDEOS} videos per post`, 'err');
  }
}

function renderVideoPreviews() {
  const list = el('videoPreviewList');
  const zone = el('videoUploadZone');
  if (!pendingVideos.length) {
    list.style.display = 'none';
    zone.style.display = '';
    return;
  }
  list.style.display = 'block';
  if (pendingVideos.length >= MAX_VIDEOS) zone.style.display = 'none';
  else zone.style.display = '';

  list.innerHTML = pendingVideos.map((v, i) => `
    <div class="video-preview-item" data-i="${i}">
      <div class="video-preview-thumb" id="vthumb-${i}">
        <div class="vthumb-loading"><i class="fas fa-spinner fa-spin"></i></div>
      </div>
      <div class="video-preview-info">
        <div class="video-preview-name">${esc(v.name)}</div>
        <div class="video-preview-size">${v.size > 0 ? (v.size/1024/1024).toFixed(1)+' MB' : 'Video'}</div>
        <div class="video-preview-dur" id="vdur-${i}"></div>
      </div>
      <button class="video-preview-rm" data-i="${i}" aria-label="Remove video"><i class="fas fa-times"></i></button>
    </div>`).join('');

  // Generate real thumbnails from video frames
  pendingVideos.forEach((v, i) => {
    const thumbEl = el('vthumb-'+i);
    const durEl   = el('vdur-'+i);
    if (!thumbEl || !v.dataUrl) return;
    const video = document.createElement('video');
    video.src = v.dataUrl;
    video.muted = true;
    video.preload = 'metadata';
    video.style.display = 'none';
    document.body.appendChild(video);
    video.addEventListener('loadedmetadata', () => {
      // Show duration
      if (durEl) {
        const d = Math.floor(video.duration);
        const m = Math.floor(d/60), s = d%60;
        durEl.textContent = `${m}:${s.toString().padStart(2,'0')}`;
      }
      // Seek to 10% in for a better frame
      video.currentTime = Math.min(video.duration * 0.1, 2);
    });
    video.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas');
      canvas.width  = 160;
      canvas.height = 90;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 160, 90);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      thumbEl.innerHTML = `
        <img src="${dataUrl}" class="vthumb-img" alt="Video thumbnail"/>
        <div class="vthumb-play-icon"><i class="fas fa-play"></i></div>`;
      video.remove();
    });
    video.addEventListener('error', () => {
      thumbEl.innerHTML = `<div class="vthumb-fallback"><i class="fas fa-film"></i></div>`;
      video.remove();
    });
  });

  list.querySelectorAll('.video-preview-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingVideos.splice(+btn.dataset.i, 1);
      renderVideoPreviews();
      el('videoFileInput').value = '';
    });
  });
}

async function submitPost() {
  // Guard: prevent submit while images are still being compressed
  const progressBar = el('uploadProgressBar');
  if (progressBar && progressBar.style.display !== 'none') {
    toast('Please wait — photos are still being optimised', 'err'); return;
  }
  const title=val('postTitle'), make=val('postMake'), model=val('postModel'), year=val('postYear'),
        hp=val('postHP'), desc=val('postDesc');
  const transmission = el('postTransmission')?.value || '';
  const mileage      = val('postMileage') || '';
  const buildState   = el('postState')?.value || '';
  const zeroSixty    = val('postZeroSixty') || '';
  const quarterMile  = val('postQuarterMile') || '';
  const topSpeed     = val('postTopSpeed') || '';
  const selectedCats = [...document.querySelectorAll('.post-cat-pill.active')].map(b=>b.dataset.cat);
  const cat = selectedCats[0] || '';

  if(!title){ showPostError('Please add a title for your build.'); return; }
  if(!make)  { showPostError('Please enter the make of your car.'); return; }
  if(!model) { showPostError('Please enter the model.'); return; }
  if(!selectedCats.length){ showPostError('Please select at least one category.'); return; }

  // Collect structured mods — each item is {text, url} or legacy plain string
  function collectModItems(id) {
    const card = document.querySelector(`.mod-cat-card[data-modkey="${id}"]`);
    if (!card) return [];
    return [...card.querySelectorAll('.mod-item-text')]
      .map(i => {
        const raw = i.value.trim();
        if (!raw) return null;
        // Try to parse as JSON {text, url}
        try { return JSON.parse(raw); } catch(_) { return { text: raw, url: '' }; }
      }).filter(Boolean);
  }
  const modsDetail = {
    engine:     collectModItems('engine'),
    drivetrain: collectModItems('drivetrain'),
    suspension: collectModItems('suspension'),
    wheels:     collectModItems('wheels'),
    exterior:   collectModItems('exterior'),
    interior:   collectModItems('interior'),
    other:      collectModItems('other'),
  };
  // Legacy mods string: flat list of all item texts for search/filter compat
  const mods = Object.values(modsDetail).flat()
    .map(item => (typeof item === 'object' ? item.text : item))
    .join(', ');

  if (isEditing()) {
    // ── UPDATE existing post ──────────────────────────────────
    const existing = S.posts.find(p => p.id === S._editingPostId);
    if (existing) {
      existing.title        = title;
      existing.make         = make;
      existing.model        = model;
      existing.year         = year;
      existing.category     = cat;
      existing.categories   = selectedCats;
      existing.hp           = hp;
      existing.mods         = mods;
      existing.modsDetail   = modsDetail;
      existing.desc         = desc;
      existing.transmission = transmission;
      existing.mileage      = mileage;
      existing.buildState   = buildState;
      existing.zeroSixty    = zeroSixty;
      existing.quarterMile  = quarterMile;
      existing.topSpeed     = topSpeed;
      // Upload any NEWLY ADDED media before saving. When editing,
      // pendingImages/pendingVideos contain a mix of existing Storage
      // URLs (https://...) and freshly added base64 (data:...).
      // The base64 ones must be uploaded — raw base64 stored in the
      // posts table gets downloaded by every visitor on every load.
      const editImageUrls = [];
      let editFailed = 0;
      for (let i = 0; i < pendingImages.length; i++) {
        const img = pendingImages[i];
        if (typeof img === 'string' && img.startsWith('data:')) {
          try {
            const res = await DB.uploadBase64(S.user.id, img, i);
            if (res && res.url) editImageUrls.push(res.url);
            else editFailed++;
          } catch(_) { editFailed++; }
        } else {
          editImageUrls.push(img); // already a Storage URL
        }
      }
      const editVideoUrls = [];
      for (let i = 0; i < pendingVideos.length; i++) {
        const v = pendingVideos[i].dataUrl;
        if (typeof v === 'string' && v.startsWith('data:')) {
          try {
            const res = await DB.uploadVideo(S.user.id, v, i);
            if (res && res.url) editVideoUrls.push(res.url);
            else editFailed++;
          } catch(_) { editFailed++; }
        } else {
          editVideoUrls.push(v); // already a Storage URL
        }
      }
      if (editFailed) toast(`${editFailed} file(s) failed to upload and were skipped`, 'err');
      existing.images       = editImageUrls;
      existing.videos       = editVideoUrls;
      existing.showSocials  = el('postShowSocials')?.checked ?? true;
      existing.editedAt     = new Date().toISOString();
      // Save to Supabase
      DB.updatePost(existing.id, S.user.id, appPostToDb(existing)).catch(e => console.warn('Update failed', e));
    }
    const editedPost = existing;
    S._editingPostId = null;
    pendingImages = []; pendingVideos = []; renderPreviews(); renderVideoPreviews(); resetPostForm(); save();
    renderFeed(); renderSidebar(); renderBOTW(); renderTicker(); updateProfilePage();
    toast('Build updated!', 'ok');
    if (editedPost) { setTimeout(() => openCarPage(editedPost), 200); }
    else goTo('home');
  } else {
    // ── CREATE new post via Supabase ──────────────────────────
    const submitBtn = el('submitPost');
    if (submitBtn) { submitBtn.disabled=true; submitBtn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Uploading…'; }

    // Upload images to Supabase Storage.
    // NEVER push the raw base64 on failure — a base64 image stored in
    // the posts table gets downloaded by every visitor on every page
    // load (this caused 30-second load times). Skip + warn instead.
    const imageUrls = [];
    let failedImages = 0;
    for (let i=0; i<pendingImages.length; i++) {
      try {
        const res = await DB.uploadBase64(S.user.id, pendingImages[i], i);
        if (res && res.url) imageUrls.push(res.url);
        else failedImages++;
      } catch(_) { failedImages++; }
    }
    if (failedImages) toast(`${failedImages} photo(s) failed to upload and were skipped`, 'err');

    // Upload videos to Supabase Storage — same rule: Storage URL or skip.
    // Base64 video in a post row is ~9MB of text per video.
    const videoUrls = [];
    let failedVideos = 0;
    for (let i=0; i<pendingVideos.length; i++) {
      try {
        const res = await DB.uploadVideo(S.user.id, pendingVideos[i].dataUrl, i);
        if (res && res.url) videoUrls.push(res.url);
        else failedVideos++;
      } catch(_) { failedVideos++; }
    }
    if (failedVideos) toast(`${failedVideos} video(s) failed to upload and were skipped`, 'err');

    const postData = appPostToDb({
      title, make, model, year, category:cat, categories:selectedCats,
      hp, mods, modsDetail, desc, transmission, mileage, buildState, zeroSixty, quarterMile, topSpeed,
      images: imageUrls,
      videos: videoUrls,
      liked_by:[], saved_by:[], reactions:{},
      showSocials: el('postShowSocials')?.checked ?? true,
      state: el('postState')?.value || '',
    });

    const { data: newPost, error: postErr } = await DB.createPost(S.user.id, S.user.username, postData);
    if (submitBtn) { submitBtn.disabled=false; submitBtn.innerHTML='<i class="fas fa-upload"></i> Publish Build'; }
    if (postErr) { toast('Failed to post — please try again','err'); return; }

    const localPost = dbPostToApp(newPost) || {
      id:newPost?.id||'u'+Date.now(), title, make, model, year,
      category:cat, categories:selectedCats, hp, mods, modsDetail, desc, transmission, mileage,
      user:S.user.username, likes:0, comments:[], images:imageUrls,
      videos:videoUrls, likedBy:[], savedBy:[], reactions:{},
      date:new Date().toISOString().slice(0,10),
    };
    S.posts.unshift(localPost);
    S.user.posts = (S.user.posts||0)+1;
    save(); // persist to cache
    pendingImages=[]; pendingVideos=[]; renderPreviews(); renderVideoPreviews(); resetPostForm();
    renderFeed(); renderSidebar(); renderBOTW(); renderTicker(); updateProfilePage();
    showUploadSuccess(localPost || newPost);
    goTo('home');
  }
}

function showPostError(msg) {
  const info = el('postSubmitInfo');
  if (info) { info.textContent = msg; info.className = 'post-error-msg'; setTimeout(()=>info.textContent='', 3500); }
  toast(msg, 'err');
}

function resetPostForm() {
  ['postTitle','postMake','postModel','postYear','postHP','postDesc',
   'modEngine','modDrivetrain','modSuspension','modWheels','modExterior','modInterior','modOther']
    .forEach(id=>{ const e=el(id); if(e) e.value=''; });
  // postCategory doesn't exist — categories use pills
  el('fileInput').value='';
  document.querySelectorAll('.post-cat-pill.active').forEach(p=>p.classList.remove('active'));
  // Clear all mod list items and input fields
  document.querySelectorAll('.mod-item-list').forEach(l=>l.innerHTML='');
  document.querySelectorAll('.mod-item-input').forEach(i=>i.value='');
  pendingVideos=[]; renderVideoPreviews();
  el('videoFileInput').value='';
  const sToggle=el('postShowSocials'); if(sToggle){sToggle.checked=true;} el('postSocialPreview')&&(el('postSocialPreview').innerHTML='');
  const trEl=el('postTransmission'); if(trEl) trEl.value='';
  const bsEl=el('postState'); if(bsEl) bsEl.value='';
  const mlEl=el('postMileage'); if(mlEl) mlEl.value='';
  const z60El=el('postZeroSixty'); if(z60El) z60El.value='';
  const qmEl=el('postQuarterMile'); if(qmEl) qmEl.value='';
  const tsEl=el('postTopSpeed'); if(tsEl) tsEl.value='';
  pendingImages=[]; renderPreviews();
}

// ─── CAR DETAIL MODAL ─────────────────────────────────────────
function initCarModal() {
  el('carClose')?.addEventListener('click', closeCarModal);
  el('carModal')?.addEventListener('click', e=>{if(e.target===el('carModal'))closeCarModal();});
  el('carLike')?.addEventListener('click',  handleLike);
  el('carSave')?.addEventListener('click',  handleSave);
  el('carShare')?.addEventListener('click', handleShare);
  el('submitComment')?.addEventListener('click', submitComment);
  el('commentInput')?.addEventListener('keydown', e=>{if(e.key==='Enter')submitComment();});
  document.querySelectorAll('.dtab').forEach(t=>t.addEventListener('click',()=>switchDetailTab(t.dataset.dtab)));
}
function openCarModal(post) {
  S.openPost=post; S.galleryIdx=0;
  el('carModal').classList.add('open'); document.body.style.overflow='hidden';
  renderCarGallery(post);
  const cfg=catCfg(post.category);
  el('carCatBar').innerHTML=`<span class="cat-badge ${cfg.badge}">${post.category}</span>`;
  const usr=S.users.find(u=>u.username===post.user)||{};
  setAvEl(el('carPosterAv'), post.user);
  el('carPosterName').textContent=post.user; el('carPosterDate').textContent=fmtDate(post.date);
  el('carPosterSocials').innerHTML=[
    usr.instagram?`<a class="soc-btn ig" href="https://instagram.com/${usr.instagram}" target="_blank" rel="noopener"><i class="fab fa-instagram"></i></a>`:'',
    usr.tiktok   ?`<a class="soc-btn tt" href="https://tiktok.com/@${usr.tiktok}"      target="_blank" rel="noopener"><i class="fab fa-tiktok"></i></a>`:'',
    usr.youtube  ?`<a class="soc-btn yt" href="https://youtube.com/@${usr.youtube}"    target="_blank" rel="noopener"><i class="fab fa-youtube"></i></a>`:'',
    usr.website  ?`<a class="soc-btn wb" href="${usr.website}"                         target="_blank" rel="noopener"><i class="fas fa-globe"></i></a>`:'',
  ].join('');
  el('carTitle').textContent=post.title;
  el('carChips').innerHTML=[
    post.year ?`<span class="chip"><i class="fas fa-calendar-alt chip-icon"></i>${post.year}</span>`:'',
    post.make ?`<span class="chip"><i class="fas fa-industry chip-icon"></i>${post.make}</span>`:'',
    post.model?`<span class="chip"><i class="fas fa-car chip-icon"></i>${post.model}</span>`:'',
    post.hp   ?`<span class="chip chip-hp"><i class="fas fa-bolt chip-icon"></i>${post.hp}</span>`:'',
  ].filter(Boolean).join('');
  el('carMods').innerHTML=post.mods?`<span class="mods-label">Mods: </span>${esc(post.mods)}`:'';
  el('carDesc').textContent=post.desc||'No description provided.';
  const liked=post.likedBy.includes(voterId());
  const saved=S.user&&post.savedBy.includes(S.user.username);
  el('carLike').className='act-btn like-btn'+(liked?' liked':'');
  el('carLikeCount').textContent=post.likes;
  el('carSave').className='act-btn save-btn'+(saved?' saved':'');
  el('carSave').innerHTML=saved?'<i class="fas fa-bookmark"></i> Saved':'<i class="fas fa-bookmark"></i> Save';
  renderComments(post); renderTimeline(post); switchDetailTab('comments');
}
function closeCarModal(){el('carModal').classList.remove('open'); document.body.style.overflow=''; S.openPost=null;}

function renderCarGallery(post) {
  const imgs   = post.images||[];
  const vids   = post.videos||[];
  const mainEl = el('carGallMain');
  const stripEl = el('carGallStrip');
  const media  = [...imgs.map(s=>({type:'image',src:s})), ...vids.map(s=>({type:'video',src:s}))];

  if (!media.length) {
    mainEl.innerHTML=`<div class="gallery-ph" style="background:${phBg(post.id)}"><span>${post.make.toUpperCase()}</span><small>${post.year||''}</small></div>`;
    stripEl.innerHTML=''; return;
  }
  function setMain(idx) {
    S.galleryIdx=idx;
    const item=media[idx];
    const nav=media.length>1?`<button class="gal-nav gal-prev" id="galPrev"><i class="fas fa-chevron-left"></i></button>
      <button class="gal-nav gal-next" id="galNext"><i class="fas fa-chevron-right"></i></button>
      <div class="gal-count">${idx+1}/${media.length}</div>`:'';
    if(item.type==='video'){
      mainEl.innerHTML=`<video id="mainGallVideo" class="gallery-video" controls preload="metadata" playsinline><source src="${item.src}" type="video/mp4"/></video>${nav}`;
    } else {
      mainEl.innerHTML=`<img src="${item.src}" alt="${post.title}" style="cursor:zoom-in" id="mainGallImg" loading="eager"/>${nav}`;
      el('mainGallImg')?.addEventListener('click',()=>openLightbox(imgs,imgs.findIndex(s=>s===item.src)));
    }
    if(media.length>1){
      el('galPrev')?.addEventListener('click',e=>{e.stopPropagation();setMain((idx-1+media.length)%media.length);updateStrip();});
      el('galNext')?.addEventListener('click',e=>{e.stopPropagation();setMain((idx+1)%media.length);updateStrip();});
    }
    updateStrip();
  }
  function updateStrip(){stripEl.querySelectorAll('.strip-thumb-wrap').forEach((t,i)=>t.classList.toggle('active',i===S.galleryIdx));}
  stripEl.innerHTML=media.map((item,i)=>item.type==='video'
    ?`<div class="strip-thumb-wrap video-thumb-wrap${i===0?' active':''}" data-i="${i}"><i class="fas fa-play"></i></div>`
    :`<div class="strip-thumb-wrap${i===0?' active':''}" data-i="${i}"><img class="strip-thumb" src="${item.src}" data-i="${i}" alt="" loading="lazy"/></div>`
  ).join('');
  stripEl.querySelectorAll('.strip-thumb-wrap').forEach(t=>t.addEventListener('click',()=>setMain(+t.dataset.i)));
  setMain(0);
}

function switchDetailTab(tab) {
  document.querySelectorAll('.dtab').forEach(t=>t.classList.toggle('active',t.dataset.dtab===tab));
  el('dtab-comments').style.display=tab==='comments'?'':'none';
  el('dtab-timeline').style.display=tab==='timeline'?'':'none';
}

function handleLike() {
  if(!S.user){toast('Sign in to like builds','err'); el('authModal').classList.add('open'); return;}
  if(!canInteract()){toast(gateMsg(),'err'); return;}
  const post=S.posts.find(x=>x.id===S.openPost.id); if(!post)return;
  const idx=post.likedBy.indexOf(S.user.username);
  if(idx>=0){post.likes=Math.max(0,post.likes-1); post.likedBy.splice(idx,1); el('carLike')?.classList.remove('liked');}
  else{post.likes++; post.likedBy.push(S.user.username); el('carLike')?.classList.add('liked'); pushNotif('like',S.user.username,`liked your build <b>${post.title}</b>`,'post:'+post.id);}
  el('carLikeCount').textContent=post.likes;
  // Update feed cards in-place — no full re-render needed
  document.querySelectorAll(`.card-likes[data-id="${post.id}"]`).forEach(btn => {
    btn.classList.toggle('liked', post.likedBy.includes(S.user.username));
    const span = btn.querySelector('span,.card-like-count');
    if (span) span.textContent = post.likes;
  });
  save(); DB.toggleLike(post.id, S.user.username).catch(()=>{});
}
function handleSave() {
  if(!S.user){toast('Sign in to save builds','err'); el('authModal').classList.add('open'); return;}
  const post=S.posts.find(x=>x.id===S.openPost.id); if(!post)return;
  const idx=post.savedBy.indexOf(S.user.username);
  if(idx>=0){post.savedBy.splice(idx,1); el('carSave').classList.remove('saved'); el('carSave').innerHTML='<i class="fas fa-bookmark"></i> Save'; toast('Removed from garage','');}
  else{post.savedBy.push(S.user.username); el('carSave').classList.add('saved'); el('carSave').innerHTML='<i class="fas fa-bookmark"></i> Saved'; toast('Saved to garage ✓','ok');}
  save();
}
function handleShare() {
  const p=S.openPost; if(!p)return;
  if(navigator.share){navigator.share({title:p.title,text:`Check out this build on DriveLog: ${p.title}`});}
  else{navigator.clipboard.writeText(`DriveLog — ${p.title} by ${p.user}`).then(()=>toast('Copied to clipboard','ok'));}
}
function renderComments(post) {
  const c=post.comments||[];
  const list=el('dtab-comments').querySelector('.comments-list');
  list.innerHTML=c.length
    ?c.map(cm=>`<div class="comment">
        <div class="comment-av" style="background:${avColor(cm.user)}">${cm.user[0].toUpperCase()}</div>
        <div><b class="comment-author">${esc(cm.user)}</b> <span class="comment-text">${esc(cm.text)}</span>
        <span class="comment-time">${timeAgo(new Date(cm.date).getTime())}</span></div>
      </div>`).join('')
    :'<p class="no-comments">No comments yet. Be the first!</p>';
  list.scrollTop=list.scrollHeight;
}
function submitComment() {
  if(!S.user){toast('Sign in to comment','err'); el('authModal').classList.add('open'); return;}
  if(!canInteract()){toast(gateMsg(),'err'); return;}
  const txt=el('commentInput').value.trim(); if(!txt)return;
  const post=S.posts.find(p=>p.id===S.openPost.id); if(!post)return;
  post.comments.push({user:S.user.username,text:txt,date:new Date().toISOString()});
  el('commentInput').value=''; renderComments(post);
  pushNotif('comment',S.user.username,`commented on <b>${post.title}</b>`,'post:'+post.id); save();
}
function renderTimeline(post) {
  const wrap = el('cpTimelineContent') || el('timelineContent');
  if (!wrap) return;
  wrap.innerHTML = '<p class="no-timeline" style="color:var(--muted);font-size:.85rem">Loading timeline…</p>';

  // Load from both localStorage and Supabase
  loadTimeline(post).then(all => {
    const seedEntries = SEED_TIMELINES[post.id] || [];
    const combined = [...seedEntries, ...all].sort((a,b) => new Date(a.date)-new Date(b.date));
    if (!combined.length) {
      wrap.innerHTML = `<p class="no-timeline">No build timeline yet.${S.user&&post.user===S.user.username?' Click <b>Add Update</b> to document your build journey.':''}</p>
        ${S.user&&post.user===S.user.username?`<button class="btn-ghost small add-tl-btn" id="addTlBtn" style="margin-top:12px"><i class="fas fa-plus"></i> Add Update</button>`:''}`;
    } else {
      wrap.innerHTML = `<div class="timeline">${combined.map((e,i) => `
        <div class="tl-item${i===combined.length-1?' last':''}">
          <div class="tl-left">
            <div class="tl-dot" style="background:${e.color||'#555'}"><i class="${e.icon||'fas fa-circle'}" style="font-size:.5rem"></i></div>
            ${i<combined.length-1?'<div class="tl-line"></div>':''}
          </div>
          <div class="tl-right">
            <div class="tl-date">${e.date}</div>
            <div class="tl-title">${esc(e.title)}</div>
            ${e.body?`<p class="tl-body">${esc(e.body)}</p>`:''}
          </div>
        </div>`).join('')}</div>
        ${S.user&&post.user===S.user.username?`<button class="btn-ghost small add-tl-btn" id="addTlBtn" style="margin-top:12px"><i class="fas fa-plus"></i> Add Update</button>`:''}`;
    }
    const btn = el('addTlBtn');
    if (btn) btn.addEventListener('click', () => addTimelineEntry(post.id));
  });
}
function addTimelineEntry(postId) {
  if (!S.user) { toast('Sign in to add timeline entries','err'); return; }
  // Check ownership
  const post = S.posts.find(p=>p.id===postId);
  if (!post || post.user !== S.user.username) { toast('You can only edit your own timeline','err'); return; }

  // Use a clean inline form instead of browser prompt()
  const content = el('cpTimelineContent') || el('timelineContent');
  if (!content) return;

  // If form already open, close it
  if (el('tl-add-form')) { el('tl-add-form').remove(); return; }

  const form = document.createElement('div');
  form.id = 'tl-add-form';
  form.className = 'tl-add-form';
  form.innerHTML = `
    <div class="tl-add-inner">
      <h4 class="tl-add-title">Add Build Update</h4>
      <input id="tl-add-title-inp" class="tl-add-inp" placeholder="Update title (e.g. Turbo installed)" maxlength="80"/>
      <textarea id="tl-add-body-inp" class="tl-add-inp tl-add-body" placeholder="Describe what changed, cost, notes…" rows="3"></textarea>
      <input id="tl-add-date-inp" class="tl-add-inp" type="date" value="${new Date().toISOString().slice(0,10)}"/>
      <div class="tl-add-actions">
        <button class="btn-primary small" id="tl-add-save"><i class="fas fa-plus"></i> Add Update</button>
        <button class="btn-ghost small" id="tl-add-cancel">Cancel</button>
      </div>
    </div>`;
  content.insertBefore(form, content.firstChild);

  el('tl-add-cancel').addEventListener('click', () => form.remove());
  el('tl-add-save').addEventListener('click', async () => {
    const title = el('tl-add-title-inp').value.trim();
    const body  = el('tl-add-body-inp').value.trim();
    const date  = el('tl-add-date-inp').value || new Date().toISOString().slice(0,10);
    if (!title) { toast('Add a title','err'); return; }

    const entry = { date, title, body, icon:'fas fa-wrench', color:'#a855f7' };

    // Save to localStorage immediately
    const stored = JSON.parse(localStorage.getItem('dl_tl_'+postId)||'[]');
    stored.push(entry);
    localStorage.setItem('dl_tl_'+postId, JSON.stringify(stored));

    // Sync to Supabase in background
    DB.addTimelineEntry(postId, title, body, date, entry.icon, entry.color)
      .then(res => {
        if (res?.error) console.warn('Timeline Supabase sync failed:', res.error);
      }).catch(()=>{});

    form.remove();
    renderTimeline(post);
    toast('Build update added ✓','ok');
  });

  // Focus title
  setTimeout(() => el('tl-add-title-inp')?.focus(), 50);
}

// Load timeline from BOTH localStorage and Supabase
async function loadTimeline(post) {
  const local = JSON.parse(localStorage.getItem('dl_tl_'+post.id)||'[]');
  // Fetch from Supabase
  try {
    const sbEntries = await DB.getTimeline(post.id);
    if (sbEntries?.length) {
      // Merge — avoid duplicates by title+date
      sbEntries.forEach(se => {
        const exists = local.find(l => l.date === se.date && l.title === se.title);
        if (!exists) local.push({ date:se.date, title:se.title, body:se.body, icon:se.icon||'fas fa-wrench', color:se.color||'#a855f7' });
      });
      local.sort((a,b) => new Date(a.date) - new Date(b.date));
      localStorage.setItem('dl_tl_'+post.id, JSON.stringify(local));
    }
  } catch(_) {}
  return local;
}

// ─── LIGHTBOX ─────────────────────────────────────────────────
function initLightbox() {
  el('lbClose')?.addEventListener('click',    closeLightbox);
  el('lbBackdrop')?.addEventListener('click', closeLightbox);
  el('lbPrev')?.addEventListener('click',     ()=>lbGo(S.lbIdx-1));
  el('lbNext')?.addEventListener('click',     ()=>lbGo(S.lbIdx+1));
  document.addEventListener('keydown', e=>{
    if(!el('lightbox').classList.contains('open'))return;
    if(e.key==='Escape')    closeLightbox();
    if(e.key==='ArrowLeft') lbGo(S.lbIdx-1);
    if(e.key==='ArrowRight')lbGo(S.lbIdx+1);
  });
  // Touch swipe for mobile
  let _lbTouchX = 0;
  el('lightbox')?.addEventListener('touchstart', e => { _lbTouchX = e.touches[0].clientX; }, {passive:true});
  el('lightbox')?.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - _lbTouchX;
    if (Math.abs(dx) > 40) lbGo(dx < 0 ? S.lbIdx+1 : S.lbIdx-1);
  }, {passive:true});
}
function openLightbox(imgs,idx){S.lbImages=imgs; el('lightbox').classList.add('open'); document.body.style.overflow='hidden'; lbGo(idx||0);}
function closeLightbox(){el('lightbox').classList.remove('open'); document.body.style.overflow='';}
function lbGo(idx){
  S.lbIdx=(idx+S.lbImages.length)%S.lbImages.length;
  el('lbImg').src=S.lbImages[S.lbIdx];
  el('lbCounter').textContent=S.lbImages.length>1?`${S.lbIdx+1} / ${S.lbImages.length}`:'';
  const show=S.lbImages.length>1?'':'none';
  el('lbPrev').style.display=show; el('lbNext').style.display=show;
}

// ─── NOTIFICATIONS ────────────────────────────────────────────
function seedNotifs() {
  return [
    {id:'n1',type:'like',   from:'twojz_god', msg:'liked your build <b>1993 Honda NSX</b>',  time:Date.now()-840000,   read:false},
    {id:'n2',type:'comment',from:'euro_grrl', msg:'commented: "Absolute weapon 🔥"',           time:Date.now()-7200000,  read:false},
    {id:'n3',type:'follow', from:'rotary_rick',msg:'started following you',                    time:Date.now()-18000000, read:true },
    {id:'n4',type:'event',  from:'DriveLog',  msg:'Build of the Week is live!',             time:Date.now()-86400000, read:true },
  ];
}
// Maps a notification's `type` to the settings toggle that controls it.
// Types with no matching toggle (award, message, report) are always shown —
// these are account/security-relevant and intentionally not silenceable.
// 'botw' and 'announcements' toggles exist in settings but nothing in the
// app currently generates those notification types yet, so they're stored
// but have no effect until that feature exists.
function isNotifTypeEnabled(type) {
  try {
    const notifs = (JSON.parse(localStorage.getItem('dl_prefs') || '{}').notifs) || {};
    switch (type) {
      case 'like':
      case 'reaction': return notifs.likes !== false;
      case 'comment':  return notifs.comments !== false;
      case 'follow':   return notifs.followers !== false;
      case 'event':    return notifs.events !== false;
      default: return true; // award, message, report, unknown types — always on
    }
  } catch(_) { return true; }
}
function pushNotif(type,from,msg,link,targetUserId){
  // Always push to current user's local state
  S.notifs.unshift({id:'n'+Date.now(),type,from,msg,link:link||null,time:Date.now(),read:false});
  S.notifs=S.notifs.slice(0,30);
  updateNotifBadge();
  // If targetUserId provided, push to that user's Supabase notifications
  if (targetUserId) {
    DB.pushNotification(targetUserId, type, from, msg, link||'').catch(()=>{});
  }
  save();
}
function updateNotifBadge() {
  const unread = S.notifs.filter(n=>!n.read && isNotifTypeEnabled(n.type)).length;
  const badge = el('notifBadge');
  const mobBadge = el('mobTabNotifBadge');
  if (badge) {
    if (unread > 0) { badge.textContent = unread > 9 ? '9+' : unread; badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  }
  if (mobBadge) {
    if (unread > 0) { mobBadge.textContent = unread > 9 ? '9+' : unread; mobBadge.style.display = 'inline-flex'; }
    else mobBadge.style.display = 'none';
  }
}
// renderNotifPage — full-page notification list for mobile Alerts tab
// This is a dedicated page (page-notifications) rather than a dropdown,
// giving mobile users more space to read and interact with notifications.
function renderNotifPage() {
  const list = el('notifPageList');
  const clearBtn = el('notifPageClear');
  if (!list) return;

  // Wire clear button
  if (clearBtn) {
    clearBtn.onclick = () => {
      S.notifs.forEach(n => n.read = true);
      updateNotifBadge();
      renderNotifPage();
    };
  }

  const visibleNotifs = S.notifs.filter(n => isNotifTypeEnabled(n.type));

  if (!visibleNotifs.length) {
    list.innerHTML = '<div class="notif-empty" style="padding:40px 20px;text-align:center"><i class="fas fa-bell" style="font-size:2rem;opacity:.3;display:block;margin-bottom:12px"></i>No notifications yet</div>';
    return;
  }

  const icons  = { like:'fas fa-heart', comment:'fas fa-comment', follow:'fas fa-user-plus', event:'fas fa-calendar', welcome:'fas fa-star', reaction:'fas fa-fire', award:'fas fa-medal', dm:'fas fa-envelope', default:'fas fa-bell' };
  const colors = { like:'#ef4444', comment:'#3b82f6', follow:'#22c55e', event:'#a855f7', welcome:'#f0a030', reaction:'#f0a030', award:'#c9a84c', dm:'#14b8a6', default:'#555' };

  list.innerHTML = visibleNotifs.slice(0, 50).map(n => {
    const icon  = icons[n.type]  || icons.default;
    const color = colors[n.type] || colors.default;
    return `<div class="notif-item${n.read?'':' unread'}" data-link="${n.link||''}">
      <div class="notif-icon-wrap" style="background:${color}22;border-color:${color}44">
        <i class="${icon}" style="color:${color}"></i>
      </div>
      <div class="notif-item-body">
        <div class="notif-item-msg">${n.msg||''}</div>
        <div class="notif-item-time">${timeAgo(n.time)}</div>
      </div>
      ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
    </div>`;
  }).join('');

  // Mark as read + navigate on tap
  list.querySelectorAll('.notif-item').forEach((item, i) => {
    item.addEventListener('click', () => {
      if (visibleNotifs[i]) visibleNotifs[i].read = true;
      updateNotifBadge();
      item.classList.remove('unread');
      item.querySelector('.notif-unread-dot')?.remove();
      const link = item.dataset.link;
      if (link?.startsWith('post:')) {
        const post = S.posts.find(p => p.id === link.replace('post:',''));
        if (post) openCarPage(post);
      } else if (link?.startsWith('user:')) {
        viewPublicProfile(link.replace('user:',''));
      } else if (link?.startsWith('page:')) {
        goTo(link.replace('page:',''));
      }
    });
  });
}

function renderNotifList() {
  const icons  = {like:'fas fa-heart',comment:'fas fa-comment',follow:'fas fa-user-plus',event:'fas fa-calendar',welcome:'fas fa-star',reaction:'fas fa-fire',award:'fas fa-medal',badge:'fas fa-medal',dm:'fas fa-envelope',default:'fas fa-bell'};
  const colors = {like:'#e84242',comment:'#3b82f6',follow:'#22c55e',event:'#a855f7',welcome:'#f0a030',reaction:'#f0a030',award:'#c9a84c',badge:'#c9a84c',dm:'#14b8a6',default:'#555'};
  const list   = el('notifList');
  if (!S.notifs.length) { list.innerHTML='<div class="notif-empty">No notifications yet</div>'; return; }

  // Group by category for the filter bar
  const cats = ['all','like','comment','follow','event','dm','award'];
  const active = list._activeCat || 'all';

  // Only show unread notifications — read ones are dismissed. Also
  // exclude any type the user has muted in Notification settings.
  const unreadNotifs = S.notifs.filter(n => !n.read && isNotifTypeEnabled(n.type));
  const filtered = active === 'all' ? unreadNotifs : unreadNotifs.filter(n => n.type === active);

  if (!unreadNotifs.length) {
    list.innerHTML = '<div class="notif-empty"><i class="fas fa-check-circle" style="color:var(--green);font-size:1.4rem;display:block;margin-bottom:6px"></i><p>All caught up!</p></div>';
    return;
  }

  list.innerHTML = `
    <div class="notif-cats">
      ${cats.map(c=>`<button class="notif-cat-btn${active===c?' active':''}" data-cat="${c}">${c==='all'?'All':c.charAt(0).toUpperCase()+c.slice(1)}</button>`).join('')}
    </div>
    ${filtered.slice(0,25).map(n=>`
    <div class="notif-item unread" data-id="${n.id}" ${n.link?`data-link="${n.link}"`:''}  style="cursor:${n.link?'pointer':'default'}">
      <div class="notif-av" style="background:${colors[n.type]||colors.default}"><i class="${icons[n.type]||icons.default}"></i></div>
      <div class="notif-body">
        <div class="notif-msg">${n.from&&n.from!=='DriveLog'?`<b>${n.from}</b> `:''}${n.msg}</div>
        <div class="notif-time">${timeAgo(n.time)}</div>
      </div>
      <div class="notif-actions">
        ${!n.read?`<button class="notif-mark-btn" data-id="${n.id}" title="Mark read"><i class="fas fa-check"></i></button>`:''}
      </div>
    </div>`).join('')}
    ${!filtered.length?'<div class="notif-empty">No '+active+' notifications</div>':''}`;

  list.querySelectorAll('.notif-cat-btn').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation(); list._activeCat=b.dataset.cat; renderNotifList();
  }));
  list.querySelectorAll('.notif-item').forEach(it => it.addEventListener('click', e => {
    if (e.target.closest('.notif-mark-btn')) return;
    const nid  = it.dataset.id;
    const link = it.dataset.link; // read from DOM before any re-render
    const n    = S.notifs.find(x => x.id === nid);
    if (n) { n.read = true; save(); updateNotifBadge(); }
    el('notifDrop').classList.remove('open');
    renderNotifList(); // re-render after closing
    // Navigate — use DOM attribute as source of truth
    if (link) handleNotifLink(link);
  }));
  list.querySelectorAll('.notif-mark-btn').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation();
    const n=S.notifs.find(x=>x.id===b.dataset.id); if(n){n.read=true;save();updateNotifBadge();renderNotifList();}
  }));
}

function handleNotifLink(link) {
  if (!link) return;
  // Close notification dropdown first
  const drop = el('notifDrop');
  if (drop) drop.classList.remove('open');
  // Navigate
  if (link.startsWith('post:')) {
    const pid = link.slice(5);
    const p = S.posts.find(x=>x.id===pid);
    if (p) openCarPage(p);
    else { toast('Build not found','err'); }
  } else if (link.startsWith('user:')) {
    viewPublicProfile(link.slice(5));
  } else if (link.startsWith('page:')) {
    goTo(link.slice(5));
  }
}

// ─── FOLLOW ───────────────────────────────────────────────────
function isFollowing(u){return S.following.includes(u);}
function toggleFollow(username) {
  if(!S.user){toast('Sign in to follow members','err'); el('authModal').classList.add('open'); return;}
  if(username===S.user.username){return;} // can't follow yourself, regardless of how this got triggered
  const idx=S.following.indexOf(username);
  const isNowFollowing = idx < 0;
  if(idx>=0){
    S.following.splice(idx,1);
    toast(`Unfollowed ${username}`,'');
  } else {
    S.following.push(username);
    toast(`Now following ${username}`,'ok');
    const otherUser = S.users.find(u=>u.username===username);
    // Push real notification
    pushNotif('follow', S.user.username, `<b>${S.user.username}</b> started following you`, 'user:'+S.user.username, otherUser?.id);
  }
  // Save per-user following list for follower counting
  try { localStorage.setItem('dl_following_'+S.user.username, JSON.stringify(S.following)); } catch(_) {}
  // Persist to Supabase
  const other = S.users.find(u=>u.username===username);
  if (other?.id && S.user?.id) DB.toggleFollow(S.user.id, other.id).catch(()=>{});
  save(); renderMembers(); updateFollowBtn(username);
  // Re-render profile if viewing the followed user
  if (S.page==='profile') viewMemberProfile(username);
}
function updateFollowBtn(username) {
  const fb=el('followBtn'); if(!fb)return;
  if(!S.user||username?.trim().toLowerCase()===S.user.username?.trim().toLowerCase()){fb.style.display='none';return;}
  fb.style.display='inline-flex';
  const f=isFollowing(username);
  fb.textContent=f?'Following ✓':'Follow'; fb.className=f?'btn-ghost small':'btn-primary small';
}

// ─── FEED ─────────────────────────────────────────────────────
// ─── FILTER HELPERS ───────────────────────────────────────────
function applyFiltersToPost(p) {
  if (S.blockedUsers.includes(p.user)) return false; // hide posts from blocked users
  const f = S.filters;
  // Multi-category: post must match at least one selected category
  if (f.categories.length > 0) {
    const postCats = Array.isArray(p.categories) ? p.categories : [p.category].filter(Boolean);
    if (!f.categories.some(fc => postCats.includes(fc))) return false;
  }
  if (f.make && p.make.toLowerCase() !== f.make.toLowerCase()) return false;
  const yr = parseInt(p.year) || 0;
  if (yr && (yr < f.yearMin || yr > f.yearMax)) return false;
  if (f.hp > 0) {
    // Same first-number-only parsing as computeRanges() — see the note
    // there about why a naive strip-all-non-digits regex is a real bug.
    const hpNum = parseInt((p.hp||'').match(/\d+/)?.[0]||'0', 10);
    if (!hpNum || hpNum < f.hp) return false;
  }
  if (f.likes > 0  && p.likes < f.likes) return false;

  // CarGurus-style filters — these fields don't exist on posts yet (the
  // upload form doesn't collect them), so these checks are no-ops until
  // that's added; harmless in the meantime, ready to go once it is.
  if (f.colors?.length        && !f.colors.includes(p.color))            return false;
  if (f.bodyTypes?.length     && !f.bodyTypes.includes(p.bodyType))       return false;
  if (f.engines?.length       && !f.engines.includes(p.engine))          return false;
  if (f.drivetrains?.length   && !f.drivetrains.includes(p.drivetrain))  return false;
  if (f.transmissions?.length && !f.transmissions.includes(p.transmission)) return false;
  if (f.fuelTypes?.length     && !f.fuelTypes.includes(p.fuelType))      return false;

  return true;
}

function countActiveFilters() {
  const f = S.filters; let n = 0;
  if (f.categories.length > 0) n++; if (f.make) n++; if (f.hp > 0) n++;
  if (f.likes > 0) n++;
  if (f.colors?.length) n++; if (f.bodyTypes?.length) n++; if (f.engines?.length) n++;
  if (f.drivetrains?.length) n++; if (f.transmissions?.length) n++; if (f.fuelTypes?.length) n++;
  if (f.yearMin > 1900 || f.yearMax < new Date().getFullYear()+1) n++;
  return n;
}

function renderFeed() {
  let posts = [...S.posts];
  // Sync top filter bar pill into sidebar categories
  if (S.filter !== 'All') {
    // A specific category pill is active — filter to just that category
    S.filters.categories = [S.filter];
  } else {
    // "All Builds" clicked — clear category filter completely
    S.filters.categories = [];
    S.filters.category = '';
  }
  posts = posts.filter(p => applyFiltersToPost(p));
  if (S.sort==='popular')    posts.sort((a,b)=>b.likes-a.likes);
  else if (S.sort==='discussed') posts.sort((a,b)=>(b.comments||[]).length-(a.comments||[]).length);
  else posts.sort((a,b)=>{
    // Use full ISO timestamp if available (from Supabase), fall back to date string
    const da = a.createdAt || a.date || '';
    const db2 = b.createdAt || b.date || '';
    return new Date(db2) - new Date(da);
  });
  const total = posts.length;
  const vis   = posts.slice(0, S.visibleCount);
  // Show results info when filters active
  const activeCount = countActiveFilters();
  const infoEl = el('feedResultsInfo');
  if (infoEl) { infoEl.style.display = activeCount>0 ? 'block':'none'; if(activeCount>0) infoEl.innerHTML=`Showing <b>${total}</b> build${total!==1?'s':''} · ${activeCount} filter${activeCount!==1?'s':''} active`; }
  if (!vis.length) {
    // Show skeletons if still loading from Supabase
    if (S._loading) {
      el('feedGrid').innerHTML = Array(6).fill(0).map(()=>`
        <div class="skeleton-card">
          <div class="skeleton skeleton-card-img"></div>
          <div class="skeleton-card-body">
            <div class="skeleton skeleton-card-title"></div>
            <div class="skeleton skeleton-card-meta"></div>
            <div class="skeleton skeleton-card-foot"></div>
          </div>
        </div>`).join('');
    } else {
      el('feedGrid').innerHTML = `<div class="feed-empty-state">
        <i class="fas fa-car feed-empty-icon"></i>
        <h3>No builds yet</h3>
        <p>Be the first to post your build.</p>
        ${S.user ? '<button class="btn-primary" onclick="openPostModal()"><i class="fas fa-plus"></i> Post Your Build</button>' : '<button class="btn-primary" onclick="el(\'authModal\').classList.add(\'open\')">Create Account to Post</button>'}
      </div>`;
    }
  } else {
    el('feedGrid').innerHTML = vis.map((p,i)=>cardHTML(p,i)).join('');
  }
  attachCardEvents(el('feedGrid'));
  el('loadMoreBtn').style.display = posts.length > S.visibleCount ? '' : 'none';
  el('loadMoreBtn').onclick = () => { S.visibleCount+=8; renderFeed(); };
  document.querySelectorAll('.fpill[data-cat]').forEach(pill=>pill.onclick=()=>{
    document.querySelectorAll('.fpill[data-cat]').forEach(p=>p.classList.remove('active'));
    pill.classList.add('active'); S.filter=pill.dataset.cat; S.filters.category=pill.dataset.cat==='All'?'':pill.dataset.cat;
    S.visibleCount=FEED_PAGE_SIZE; renderFeed();
  });
  document.querySelectorAll('.sort-btn[data-sort]').forEach(btn=>btn.onclick=()=>{
    document.querySelectorAll('.sort-btn[data-sort]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); S.sort=btn.dataset.sort; renderFeed();
  });
  // Sync filter trigger badge
  const tc = el('filterTriggerCount');
  if (tc) { if(activeCount>0){tc.textContent=activeCount;tc.style.display='inline';}else tc.style.display='none'; }
}

// ─── FILTER SIDEBAR ───────────────────────────────────────────
function initFilterSidebar() {
  const btn  = el('openFilterBtn');
  const side = el('filterSidebar');
  const over = el('filterOverlay');
  if (!btn || !side) return;

  // ── Build real data ranges from posts ──────────────────────
  function computeRanges() {
    const posts = S.posts;

    // Makes: sorted alphabetically, deduplicated
    const makes = [...new Set(posts.map(p=>p.make).filter(Boolean))].sort();

    // Years: floor is always 1900, ceiling is always at least next year
    // (accommodates next model-year cars) — both extend further only if
    // an actual post falls outside that range, per your spec.
    const thisYear = new Date().getFullYear();
    const defaultYearMin = 1900, defaultYearMax = thisYear + 1;
    const years = posts.map(p=>parseInt(p.year)).filter(y=>y>1800&&y<=2200);
    const yearMin = years.length ? Math.min(defaultYearMin, ...years) : defaultYearMin;
    const yearMax = years.length ? Math.max(defaultYearMax, ...years) : defaultYearMax;

    // HP: extract the FIRST number found, e.g. "450whp"→450, "355 hp"→355.
    // Previously this stripped ALL non-digit characters before parsing,
    // which meant a hyphenated value like "450-500hp" got concatenated
    // into "450500" — a single bad post could blow the slider out to a
    // huge, meaningless max. Matching the first digit run avoids that.
    const hps = posts.map(p=>parseInt((p.hp||'').match(/\d+/)?.[0]||'0',10)).filter(v=>v>0&&v<=3000);
    const hpMax = hps.length ? Math.ceil(Math.max(...hps) / 50) * 50 : 500; // round up to nearest 50

    // Likes: highest like count across all posts
    const likesMax = posts.length ? Math.max(...posts.map(p=>p.likes)) : 500;
    // Round up to a nice step
    const likesStep = likesMax > 500 ? 50 : likesMax > 200 ? 25 : 10;
    const likesMaxRounded = Math.ceil(likesMax / likesStep) * likesStep;

    return { makes, yearMin, yearMax, hpMax, hpStep: 25, likesMax: likesMaxRounded, likesStep };
  }

  // ── Populate dynamic controls ──────────────────────────────
  function populateControls() {
    const r = computeRanges();

    // Make dropdown — only makes that actually appear in posts
    const makeSelect = el('fsMake');
    const currentMake = makeSelect.value;
    makeSelect.innerHTML = '<option value="">All Makes</option>' +
      r.makes.map(m => `<option value="${esc(m)}"${m===currentMake?'selected':''}>${esc(m)}</option>`).join('');

    // Year sliders
    const yminEl = el('fsYearMin'), ymaxEl = el('fsYearMax');
    yminEl.min = ymaxEl.min = r.yearMin;
    yminEl.max = ymaxEl.max = r.yearMax;
    if (+yminEl.value < r.yearMin) yminEl.value = r.yearMin;
    if (+ymaxEl.value > r.yearMax || +ymaxEl.value === 1900) ymaxEl.value = r.yearMax;
    // Update default state if filters are at initial values
    if (S.filters.yearMin <= 1900) S.filters.yearMin = r.yearMin;
    if (S.filters.yearMax >= new Date().getFullYear()+1) S.filters.yearMax = r.yearMax;

    // HP slider
    const hpEl = el('fsHP');
    hpEl.max  = r.hpMax;
    hpEl.step = r.hpStep;
    if (+hpEl.value > r.hpMax) hpEl.value = 0;

    // Likes slider
    const lkEl = el('fsLikes');
    lkEl.max  = r.likesMaxRounded || r.likesMax;
    lkEl.step = r.likesStep;
    if (+lkEl.value > lkEl.max) lkEl.value = 0;

    // Store ranges so reset knows the real defaults
    side._ranges = r;
  }

  btn.addEventListener('click', () => { side._context = 'feed'; openFilter(); });
  el('openGarageFilterBtn')?.addEventListener('click', () => { side._context = 'garage'; openFilter(); });
  el('filterClose')?.addEventListener('click', closeFilter);
  over.addEventListener('click', closeFilter);

  function openFilter() {
    populateControls(); // re-derive from current posts (may have grown)
    syncFilterUI();
    side.classList.add('open'); over.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeFilter() {
    side.classList.remove('open'); over.classList.remove('open');
    document.body.style.overflow = '';
  }

  // Category pills — multi-select (previously this replaced the .active
  // class on ALL pills like a single-select, and wrote to S.filters.category
  // — singular — which applyFiltersToPost() never actually read. The real
  // field is the plural S.filters.categories array, so category filtering
  // was silently doing nothing at all.
  side.querySelectorAll('.fs-pill[data-fc]').forEach(p=>p.addEventListener('click',()=>{
    p.classList.toggle('active');
    const cat = p.dataset.fc, idx = S.filters.categories.indexOf(cat);
    if (p.classList.contains('active')) { if (idx===-1) S.filters.categories.push(cat); }
    else if (idx!==-1) S.filters.categories.splice(idx,1);
  }));

  // Shared multi-select toggle helper for the 6 new filter groups below
  function wireMultiSelectPills(selector, datasetKey, filterKey) {
    side.querySelectorAll(selector).forEach(p=>p.addEventListener('click',()=>{
      p.classList.toggle('active');
      const val = p.dataset[datasetKey];
      const arr = S.filters[filterKey];
      const idx = arr.indexOf(val);
      if (p.classList.contains('active')) { if (idx===-1) arr.push(val); }
      else if (idx!==-1) arr.splice(idx,1);
    }));
  }
  wireMultiSelectPills('.fs-pill[data-fcolor]', 'fcolor', 'colors');
  wireMultiSelectPills('.fs-pill[data-fbody]',  'fbody',  'bodyTypes');
  wireMultiSelectPills('.fs-pill[data-fengine]','fengine','engines');
  wireMultiSelectPills('.fs-pill[data-fdrive]', 'fdrive', 'drivetrains');
  wireMultiSelectPills('.fs-pill[data-ftrans]', 'ftrans', 'transmissions');
  wireMultiSelectPills('.fs-pill[data-ffuel]',  'ffuel',  'fuelTypes');

  // Make select
  el('fsMake')?.addEventListener('change', ()=>{ S.filters.make = el('fsMake').value; });

  // Year sliders — clamp each other, display real year value
  el('fsYearMin')?.addEventListener('input', ()=>{
    let v = +el('fsYearMin').value;
    if (v > S.filters.yearMax) { v = S.filters.yearMax; el('fsYearMin').value = v; }
    S.filters.yearMin = v;
    el('fsYearMinVal').textContent = v;
  });
  el('fsYearMax')?.addEventListener('input', ()=>{
    let v = +el('fsYearMax').value;
    if (v < S.filters.yearMin) { v = S.filters.yearMin; el('fsYearMax').value = v; }
    S.filters.yearMax = v;
    el('fsYearMaxVal').textContent = v;
  });

  // HP slider — shows real hp value extracted from post data range
  el('fsHP')?.addEventListener('input', ()=>{
    const v = +el('fsHP').value;
    S.filters.hp = v;
    el('fsHPVal').textContent = v > 0 ? v + '+ hp' : 'Any';
  });

  // Likes slider — shows real like counts from posts
  el('fsLikes')?.addEventListener('input', ()=>{
    const v = +el('fsLikes').value;
    S.filters.likes = v;
    el('fsLikesVal').textContent = v > 0 ? v + '+' : 'Any';
  });

  // Apply
  el('filterApply')?.addEventListener('click', ()=>{
    if (side._context === 'garage') {
      renderGarage();
      closeFilter();
      return;
    }
    // sidebar categories take over, reset top pill to All
    S.filter = 'All';
    document.querySelectorAll('.fpill[data-cat]').forEach(p=>p.classList.toggle('active', p.dataset.cat==='All'));
    S.visibleCount = FEED_PAGE_SIZE;
    renderFeed();
    closeFilter();
  });

  // Reset — resets to real data defaults (not hardcoded values)
  el('filterReset')?.addEventListener('click', ()=>{
    const r = side._ranges || computeRanges();
    S.filters = { categories:[], make:'', yearMin:r.yearMin, yearMax:r.yearMax, hp:0, likes:0, colors:[], bodyTypes:[], engines:[], drivetrains:[], transmissions:[], fuelTypes:[] };
    S.visibleCount = FEED_PAGE_SIZE;
    syncFilterUI();
    if (side._context === 'garage') {
      renderGarage();
      return;
    }
    S.filter = 'All';
    document.querySelectorAll('.fpill[data-cat]').forEach(p=>p.classList.toggle('active',p.dataset.cat==='All'));
    renderFeed();
  });

  // Sync UI controls to current S.filters state
  function syncFilterUI() {
    const f = S.filters;
    side.querySelectorAll('.fs-pill[data-fc]').forEach(p=>p.classList.toggle('active', (f.categories||[]).includes(p.dataset.fc)));
    side.querySelectorAll('.fs-pill[data-fcolor]').forEach(p=>p.classList.toggle('active', (f.colors||[]).includes(p.dataset.fcolor)));
    side.querySelectorAll('.fs-pill[data-fbody]').forEach(p=>p.classList.toggle('active', (f.bodyTypes||[]).includes(p.dataset.fbody)));
    side.querySelectorAll('.fs-pill[data-fengine]').forEach(p=>p.classList.toggle('active', (f.engines||[]).includes(p.dataset.fengine)));
    side.querySelectorAll('.fs-pill[data-fdrive]').forEach(p=>p.classList.toggle('active', (f.drivetrains||[]).includes(p.dataset.fdrive)));
    side.querySelectorAll('.fs-pill[data-ftrans]').forEach(p=>p.classList.toggle('active', (f.transmissions||[]).includes(p.dataset.ftrans)));
    side.querySelectorAll('.fs-pill[data-ffuel]').forEach(p=>p.classList.toggle('active', (f.fuelTypes||[]).includes(p.dataset.ffuel)));
    el('fsMake').value = f.make;
    const ymin = el('fsYearMin'), ymax = el('fsYearMax');
    ymin.value = f.yearMin; el('fsYearMinVal').textContent = f.yearMin;
    ymax.value = f.yearMax; el('fsYearMaxVal').textContent = f.yearMax;
    el('fsHP').value    = f.hp;    el('fsHPVal').textContent    = f.hp    > 0 ? f.hp    + '+ hp' : 'Any';
    el('fsLikes').value = f.likes; el('fsLikesVal').textContent = f.likes > 0 ? f.likes + '+'    : 'Any';
  }

  // Initialise with real defaults on first load
  const r0 = computeRanges();
  S.filters.yearMin = r0.yearMin;
  S.filters.yearMax = r0.yearMax;
  side._ranges = r0;
}


// ─── REACTION OVERLAY ON CARDS ─────────────────────────────────
function renderCardReactionOverlay(post) {
  const reactions = post.reactions || {};
  const active = REACTION_TYPES.filter(r => (reactions[r.key]||[]).length > 0)
    .sort((a,b) => (reactions[b.key]||[]).length - (reactions[a.key]||[]).length)
    .slice(0, 3);
  if (!active.length) return '';
  const total = active.reduce((s,r) => s + (reactions[r.key]||[]).length, 0);
  return `<div class="card-reaction-overlay">
    ${active.map(r => `<span class="cro-icon" style="background:${r.color}22;border-color:${r.color}44"><i class="${r.icon}" style="color:${r.color}"></i></span>`).join('')}
    <span class="cro-count">${total}</span>
  </div>`;
}

function cardHTML(post,animIdx) {
  const cfg=catCfg(post.category), imgs=post.images||[];
  const liked=S.user&&(post.likedBy||[]).includes(S.user.username);
  const multi=imgs.length>1?`<div class="card-multi"><i class="fas fa-images"></i> ${imgs.length}</div>`:'';
  const imgHTML=imgs.length
    ?`<img class="card-img" src="${imgs[0]}" alt="${esc(post.title)}" loading="lazy"/>`
    :`<div class="card-img card-img-ph" style="background:${phBg(post.id)}"><span>${esc((post.make||'?').toUpperCase())}</span></div>`;
  return `<div class="card" data-id="${post.id}" style="animation-delay:${animIdx*.04}s">
    <div class="card-img-wrap">${imgHTML}<span class="cat-badge ${cfg.badge}">${post.category}</span>${multi}</div>
    <div class="card-body">
      <div class="card-title">${esc(post.title)}</div>
      <div class="card-sub">${post.year?post.year+' · ':''}${post.hp?post.hp+' · ':''}by ${esc(post.user)}</div>
      <div class="card-foot">
        <div class="card-av-row"><div class="card-av av-circle clickable-user" data-user="${post.user}" id="cav-${post.id}">${_defaultAvSVG()}</div> <span class="card-poster clickable-user" data-user="${post.user}">${esc(post.user)}</span></div>
        <div class="card-stats">
          <span class="card-comments"><i class="fas fa-comment"></i> ${(post.comments||[]).length}</span>
          <span class="card-likes${liked?' liked':''}" data-id="${post.id}"><i class="fas fa-heart"></i> ${post.likes}</span>
          <span class="card-views" data-id="${post.id}"><i class="fas fa-eye"></i> ${formatCount(post.views||0)}</span>
        </div>
      </div>
    </div></div>`;
}

function attachCardEvents(container) {
  // Set real avatars for all cards in this container
  container.querySelectorAll('.card-av.av-circle[data-user]').forEach(av => {
    setAvEl(av, av.dataset.user);
  });
  container.querySelectorAll('.card').forEach(card=>{
    let clickTimer=null, lastTap=0;
    const imgWrap = card.querySelector('.card-img-wrap');

    function likePostViaDouble() {
      // Heart burst on the image (IG-style)
      if (imgWrap) {
        const h=document.createElement('div');
        h.className='soc-heart-burst';
        h.innerHTML='<i class="fas fa-heart"></i>';
        imgWrap.appendChild(h);
        setTimeout(()=>h.remove(),900);
      }
      if(!S.user){ toast('Sign in to like','err'); el('authModal').classList.add('open'); return; }
      // Double-tap only ever LIKES, never unlikes
      const likeBtn=card.querySelector('.card-likes');
      if(likeBtn && !likeBtn.classList.contains('liked')) likeBtn.click();
    }

    card.addEventListener('dblclick',e=>{
      if(!e.target.closest('.card-img-wrap'))return;
      e.preventDefault();
      if(clickTimer){clearTimeout(clickTimer);clickTimer=null;}
      likePostViaDouble();
    });
    card.addEventListener('click',e=>{
      if(e.target.closest('.card-likes'))return;
      const p=S.posts.find(x=>x.id===card.dataset.id); if(!p)return;
      // Clicks on the image get a short delay so a double-tap can like
      // instead of navigating. Clicks anywhere else open instantly.
      if(e.target.closest('.card-img-wrap')){
        const now=Date.now();
        if(now-lastTap<300){
          lastTap=0;
          if(clickTimer){clearTimeout(clickTimer);clickTimer=null;}
          likePostViaDouble();
          return;
        }
        lastTap=now;
        if(clickTimer)clearTimeout(clickTimer);
        clickTimer=setTimeout(()=>{clickTimer=null;openCarPage(p);},260);
      } else {
        openCarPage(p);
      }
    });
  });
  container.querySelectorAll('.card-likes').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();
    if (!S.user) { toast('Sign in to like', 'err'); el('authModal').classList.add('open'); return; }
    const vid  = S.user.username; // always use username for consistency
    const post = S.posts.find(p=>p.id===btn.dataset.id); if(!post) return;
    const idx  = post.likedBy.indexOf(vid);
    // Update local state immediately
    if(idx>=0){ post.likes=Math.max(0,post.likes-1); post.likedBy.splice(idx,1); }
    else { post.likes++; post.likedBy.push(vid); }
    // Update button immediately without full re-render
    btn.classList.toggle('liked', post.likedBy.includes(vid));
    const countEl = btn.querySelector('span, .card-like-count');
    if (countEl) countEl.textContent = post.likes;
    // Fire DB in background
    DB.toggleLike(post.id, vid).catch(()=>{});
    save();
  }));
}


// Re-apply liked/saved visual states to all card buttons
// Called after Supabase refreshes the feed to prevent stale icons
function refreshLikedStates() {
  if (!S.user?.username) return;
  const vid = S.user.username;
  document.querySelectorAll('.card-likes[data-id]').forEach(btn => {
    const post = S.posts.find(p => p.id === btn.dataset.id);
    if (!post) return;
    const liked = post.likedBy.includes(vid);
    btn.classList.toggle('liked', liked);
    const span = btn.querySelector('span,.card-like-count');
    if (span) span.textContent = post.likes;
  });
  document.querySelectorAll('.card-save[data-id]').forEach(btn => {
    const post = S.posts.find(p => p.id === btn.dataset.id);
    if (!post) return;
    btn.classList.toggle('saved', post.savedBy.includes(vid));
  });
}

// ─── SIDEBAR ──────────────────────────────────────────────────
function renderSidebar() {
  const top5=[...S.posts].sort((a,b)=>b.likes-a.likes).slice(0,5);
  el('trendingList').innerHTML=top5.map((p,i)=>{
    const img=p.images?.[0];
    return `<div class="trend-item" data-id="${p.id}">
      <span class="trend-rank${i<3?' top':''}">${i+1}</span>
      <div class="trend-thumb" style="background:${phBg(p.id)}">${img?`<img src="${img}" alt="" loading="lazy"/>`:`<span>${p.make.slice(0,3).toUpperCase()}</span>`}</div>
      <div><div class="trend-title">${p.title.length>26?p.title.slice(0,26)+'…':p.title}</div><div class="trend-likes">♥ ${p.likes.toLocaleString()}</div></div>
    </div>`;
  }).join('');
  el('trendingList').querySelectorAll('.trend-item').forEach(it=>it.addEventListener('click',()=>{const p=S.posts.find(x=>x.id===it.dataset.id);if(p)openCarPage(p);}));

  const topM=[...S.users].sort((a,b)=>(b.totalLikes||0)-(a.totalLikes||0)).slice(0,5);
  const badges=['gold','silver','bronze'];
  el('topMembersList').innerHTML=topM.map((u,i)=>`
    <div class="top-member">
      <div class="tm-av clickable-user" data-user="${u.username}">${renderAv(u.username, 36, 'clickable-user')}</div>
      <div class="tm-info clickable-user" data-user="${u.username}" style="cursor:pointer">
        <div class="tm-name">${esc(u.username)}</div>
        <div class="tm-sub">${u.posts||0} builds · ${(u.totalLikes||0).toLocaleString()} likes</div>
      </div>
      ${i<3?`<span class="tm-badge ${badges[i]}">#${i+1}</span>`:''}
    </div>`).join('');
  // Wire name clicks too
  el('topMembersList').querySelectorAll('.tm-info.clickable-user').forEach(el2 =>
    el2.addEventListener('click', () => viewPublicProfile(el2.dataset.user))
  );

  const pick=[...S.posts].sort((a,b)=>b.likes-a.likes)[2];
  if(pick){
    const img=pick.images?.[0];
    el('dailyPick').innerHTML=`<div class="dp-item" data-id="${pick.id}">
      <div class="dp-img" style="background:${phBg(pick.id)}">${img?`<img src="${img}" alt="" loading="lazy"/>`:''}</div>
      <div class="dp-title">${esc(pick.title)}</div><div class="dp-meta">by ${esc(pick.user)} · ♥ ${pick.likes.toLocaleString()}</div>
    </div>`;
    el('dailyPick').querySelector('.dp-item').addEventListener('click',()=>openCarPage(pick));
  }

  const tmap={};
  S.posts.forEach(p=>[p.category,p.make].filter(Boolean).forEach(t=>{tmap[t]=(tmap[t]||0)+1;}));
  el('tagCloud').innerHTML=Object.entries(tmap).sort((a,b)=>b[1]-a[1]).slice(0,18).map(([t])=>`<span class="tag">${esc(t)}</span>`).join('');
  el('tagCloud').querySelectorAll('.tag').forEach(t=>t.addEventListener('click',()=>{el('searchInput').value=t.textContent; openSearch(); doSearch();}));
}


// ─── EXPLORE PAGE ─────────────────────────────────────────────
function renderExplorePage() {
  // Wire FAQ accordion
  document.querySelectorAll('.exp-faq-item').forEach(item => {
    const q = item.querySelector('.exp-faq-q');
    const a = item.querySelector('.exp-faq-a');
    if (!q || !a) return;
    if (!item._faqWired) {
      item._faqWired = true;
      q.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        document.querySelectorAll('.exp-faq-item.open').forEach(other => other.classList.remove('open'));
        if (!isOpen) item.classList.add('open');
      });
    }
  });

  // Wire merch shop link (update this URL when store is live)
  const shopLink = el('merchShopLink');
  if (shopLink && shopLink.href === '#') {
    shopLink.href = '#'; // replace with real store URL
    shopLink.onclick = e => { e.preventDefault(); toast('Merch store coming soon! 🔥','ok'); };
  }
}

// ─── CATEGORIES ───────────────────────────────────────────────
function renderCategories() {
  el('catGrid').innerHTML=CATS.map(c=>{
    // Count posts that include this category (supports multi-category posts)
    const count=S.posts.filter(p=>{
      const cats=Array.isArray(p.categories)&&p.categories.length?p.categories:[p.category].filter(Boolean);
      return cats.includes(c.name);
    }).length;
    return `<div class="cat-card" data-cat="${c.name}" style="--cc:${c.color}">
      <div class="cat-accent-bar"></div>
      <span class="cat-icon-wrap" style="background:${c.color}18;color:${c.color}"><i class="${c.fa||c.icon}"></i></span>
      <div class="cat-name">${c.name}</div>
      <div class="cat-post-count">
        <span class="cat-post-num" style="color:${c.color}">${count}</span>
        <span class="cat-post-label">${count===1?'Build':'Builds'}</span>
      </div>
    </div>`;
  }).join('');
  el('catGrid').querySelectorAll('.cat-card').forEach(card=>card.addEventListener('click',()=>{
    el('catGrid').style.display='none'; el('catFeedWrap').style.display='block';
    el('catFeedTitle').textContent=card.dataset.cat;
    // Filter by multi-category too
    const posts=S.posts.filter(p=>{
      const cats=Array.isArray(p.categories)&&p.categories.length?p.categories:[p.category].filter(Boolean);
      return cats.includes(card.dataset.cat);
    });
    // Stats bar
    const totalLikes = posts.reduce((a,p)=>a+p.likes,0);
    const catStatsEl = el('catFeedStats') || (() => {
      const d = document.createElement('div'); d.id = 'catFeedStats'; d.className = 'cat-feed-stats';
      el('catFeedWrap').insertBefore(d, el('catFeedGrid'));
      return d;
    })();
    catStatsEl.innerHTML = `
      <div class="cat-feed-stat"><span class="cat-feed-stat-n">${posts.length}</span><span class="cat-feed-stat-l">Builds</span></div>
      <div class="cat-feed-stat-div"></div>
      <div class="cat-feed-stat"><span class="cat-feed-stat-n">${totalLikes.toLocaleString()}</span><span class="cat-feed-stat-l">Total Likes</span></div>
    `;
    // Top 3 featured builds
    const top3 = [...posts].sort((a,b)=>b.likes-a.likes).slice(0,3);
    const top3El = el('catFeedTop3') || (() => {
      const d = document.createElement('div'); d.id = 'catFeedTop3'; d.className = 'cat-feed-top3';
      el('catFeedWrap').insertBefore(d, el('catFeedGrid'));
      return d;
    })();
    top3El.innerHTML = top3.map(p => {
      const img = p.images?.[0];
      return `<div class="cat-top3-item" data-id="${p.id}">
        ${img?`<img src="${img}" alt="${esc(p.title)}" loading="lazy"/>`:`<div style="width:100%;height:100%;background:${phBg(p.id)}"></div>`}
        <div class="cat-top3-overlay"></div>
        <div class="cat-top3-info">
          <div class="cat-top3-title">${esc(p.title)}</div>
          <div class="cat-top3-meta">by ${esc(p.user)} · ♥ ${p.likes}</div>
        </div>
      </div>`;
    }).join('');
    top3El.querySelectorAll('.cat-top3-item').forEach(item =>
      item.addEventListener('click', () => {
        const p = posts.find(x=>x.id===item.dataset.id); if(p) openCarPage(p);
      })
    );
    el('catFeedGrid').innerHTML=posts.length?posts.map((p,i)=>cardHTML(p,i)).join(''):'<p class="cat-empty">No builds yet in this category.</p>';
    attachCardEvents(el('catFeedGrid'));
  }));
  el('backToCats')?.addEventListener('click',()=>{el('catGrid').style.display=''; el('catFeedWrap').style.display='none';});
}

// ─── LEADERBOARD ──────────────────────────────────────────────
function renderLeaderboard() {
  // Users who've opted out of "Show on Leaderboard" are excluded from every
  // member-based leaderboard list below (they still appear in build
  // leaderboards under their own posts — this only hides them from the
  // "who's the top member" style rankings).
  const leaderboardUsers = S.users.filter(u => u.privacyLeaderboard !== false);
  const top=[...S.posts].sort((a,b)=>b.likes-a.likes).slice(0,10);
  el('lbBuilds').innerHTML=`<div class="lb-list">${top.map((p,i)=>{
    const img=p.images?.[0];
    return `<div class="lb-row${i===0?' gold':i===1?' silver':i===2?' bronze':''}" data-id="${p.id}">
      <div class="lb-pos${i===0?' p1':i===1?' p2':i===2?' p3':' pn'}">${i+1}</div>
      <div class="lb-thumb" style="background:${phBg(p.id)}">${img?`<img src="${img}" alt="" loading="lazy"/>`:''}</div>
      <div class="lb-info"><div class="lb-title">${esc(p.title)}</div><div class="lb-meta">by ${esc(p.user)} · ${p.category}${p.hp?' · '+p.hp:''}</div></div>
      <div class="lb-score"><div class="lb-num">♥ ${p.likes.toLocaleString()}</div><div class="lb-lbl">Likes</div></div>
    </div>`;
  }).join('')}</div>`;
  el('lbBuilds').querySelectorAll('.lb-row[data-id]').forEach(r=>r.addEventListener('click',()=>{const p=S.posts.find(x=>x.id===r.dataset.id);if(p)openCarPage(p);}));

  const topM=[...leaderboardUsers].sort((a,b)=>(b.totalLikes||0)-(a.totalLikes||0)).slice(0,10);
  el('lbMembers').innerHTML=`<div class="lb-list">${topM.map((u,i)=>`
    <div class="lb-row${i===0?' gold':i===1?' silver':i===2?' bronze':''}">
      <div class="lb-pos${i===0?' p1':i===1?' p2':i===2?' p3':' pn'}">${i+1}</div>
      <div class="lb-thumb lb-av-th clickable-user" data-user="${u.username}" style="background:#6b7280">${u.username[0].toUpperCase()}</div>
      <div class="lb-info"><div class="lb-title">${esc(u.username)}</div><div class="lb-meta">${u.posts||0} builds · Joined ${u.joined}</div></div>
      <div class="lb-score"><div class="lb-num">${(u.totalLikes||0).toLocaleString()}</div><div class="lb-lbl">Likes</div></div>
    </div>`).join('')}</div>`;

  el('lbCats').innerHTML=CATS.map(c=>{
    const cp=[...S.posts].filter(p=>p.category===c.name).sort((a,b)=>b.likes-a.likes).slice(0,3);
    return `<div class="lb-cat-card" style="border-top:2px solid ${c.color}40">
      <div class="lb-cat-head">${c.icon} ${c.name}</div>
      ${cp.length?cp.map((p,i)=>`<div class="lb-cat-row" data-id="${p.id}">
        <span class="lb-cat-rank" style="${i===0?'color:'+c.color:''}">${i+1}</span>
        <div><div class="lb-cat-title">${p.title.length>26?p.title.slice(0,26)+'…':p.title}</div><div class="lb-cat-meta">♥ ${p.likes.toLocaleString()}</div></div>
      </div>`).join(''):'<p class="lb-cat-empty">No builds yet</p>'}
    </div>`;
  }).join('');
  el('lbCats').querySelectorAll('.lb-cat-row[data-id]').forEach(r=>r.addEventListener('click',()=>{const p=S.posts.find(x=>x.id===r.dataset.id);if(p)openCarPage(p);}));

  const topPosts=[...leaderboardUsers].sort((a,b)=>{
    const ap=S.posts.filter(p=>p.user===a.username).length;
    const bp=S.posts.filter(p=>p.user===b.username).length;
    return bp-ap;
  }).slice(0,10);
  el('lbPosts').innerHTML=`<div class="lb-list">${topPosts.map((u,i)=>{
    const pCount=S.posts.filter(p=>p.user===u.username).length;
    return `<div class="lb-row${i===0?' gold':i===1?' silver':i===2?' bronze':''}">
      <div class="lb-pos${i===0?' p1':i===1?' p2':i===2?' p3':' pn'}">${i+1}</div>
      <div class="lb-thumb lb-av-th clickable-user" data-user="${u.username}" style="background:#6b7280">${u.username[0].toUpperCase()}</div>
      <div class="lb-info"><div class="lb-title">${esc(u.username)}</div><div class="lb-meta">Member since ${u.joined} · ${pCount} builds posted</div></div>
      <div class="lb-score"><div class="lb-num">${pCount}</div><div class="lb-lbl">Posts</div></div>
    </div>`;
  }).join('')}</div>`;

  const oldestUsers=[...leaderboardUsers].filter(u=>u.joinedFull||u.joined).sort((a,b)=>{
    const aT=new Date(a.joinedFull||a.joined+'-01').getTime();
    const bT=new Date(b.joinedFull||b.joined+'-01').getTime();
    return aT-bT;
  }).slice(0,10);
  el('lbOldest').innerHTML=`<div class="lb-list">${oldestUsers.map((u,i)=>{
    const age=accountAge(u);
    return `<div class="lb-row${i===0?' gold':i===1?' silver':i===2?' bronze':''}">
      <div class="lb-pos${i===0?' p1':i===1?' p2':i===2?' p3':' pn'}">${i+1}</div>
      <div class="lb-thumb lb-av-th clickable-user" data-user="${u.username}" style="background:#6b7280">${u.username[0].toUpperCase()}</div>
      <div class="lb-info"><div class="lb-title">${esc(u.username)}</div><div class="lb-meta">Joined ${fmtDate(u.joinedFull||u.joined+'-01')}</div></div>
      <div class="lb-score"><div class="lb-num">${age.short}</div><div class="lb-lbl">Account Age</div></div>
    </div>`;
  }).join('')}</div>`;

  // BOTM
  renderLbBotm();
  // ATG
  renderLbAtg();

  // Remove old listeners before adding new ones to prevent stacking
  document.querySelectorAll('.lbtab').forEach(t=>{
    const clone = t.cloneNode(true);
    t.parentNode.replaceChild(clone, t);
  });
  document.querySelectorAll('.lbtab').forEach(t=>t.addEventListener('click',()=>{
    document.querySelectorAll('.lbtab,.lb-panel').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    const panel = el('lb-'+t.dataset.lb);
    if (panel) panel.classList.add('active');
  }));
}


// ─── BOTM COMMUNITY VOTING ────────────────────────────────────
// Voting window: 1st - 25th of each month. Top voted post wins.
function getBotmVoteKey() {
  const now = new Date();
  return `dl_botm_votes_${now.getFullYear()}_${now.getMonth()}`;
}

// The Supabase-side vote key format (year_month, zero-padded) — shared by
// castBotmVote() and the tally/winner logic so they can never drift apart.
function getBotmSupabaseVoteKey() {
  const now = new Date();
  return `botm_${now.getFullYear()}_${String(now.getMonth()+1).padStart(2,'0')}`;
}

function getUserBotmVote() {
  try { return JSON.parse(localStorage.getItem(getBotmVoteKey()) || 'null'); } catch(_) { return null; }
}

async function castBotmVote(postId) {
  if (!S.user) { toast('Sign in to vote for BOTM','err'); el('authModal')?.classList.add('open'); return; }
  const now = new Date();
  if (now.getDate() > 25) { toast(`Voting closed on the 25th — check back for this month's winner`,''); return; }
  const existing = getUserBotmVote();
  if (existing === postId) { toast('Already your nomination this month ✓','ok'); return; }
  const voteKey = getBotmSupabaseVoteKey();
  // Save locally first for instant feedback
  localStorage.setItem(getBotmVoteKey(), postId);
  renderBotmVoteBtn(postId);
  // Persist to Supabase — upsert means this also correctly REPLACES an
  // existing vote from earlier in the month, so people can change their mind
  const { error } = await DB.castBotmVote(postId, S.user.id, voteKey);
  if (error) {
    console.warn('BOTM vote save failed:', error);
    toast('Vote counted locally — will sync when connection is restored','');
  } else {
    toast(existing ? 'Nomination changed 🏆' : 'Your vote has been cast! 🏆','ok');
  }
  // Refresh the live tally on the Members page, if it's rendered
  if (el('memBotmCandidates')) renderMembersBotm();
}

function renderBotmVoteBtn(postId) {
  const btns = document.querySelectorAll(`.botm-vote-btn[data-id="${postId}"]`);
  const voted = getUserBotmVote();
  btns.forEach(btn => {
    btn.classList.toggle('voted', voted === postId);
    btn.innerHTML = voted === postId
      ? '<i class="fas fa-check"></i> Voted'
      : '<i class="fas fa-crown"></i> Nominate for BOTM';
  });
}

// Tallies community votes for the current month into { postId: count },
// sorted descending. This is the piece that was missing — DB.getBotmVotes()
// already existed to fetch the raw vote rows, but nothing ever called it or
// counted them, so there was no way to actually determine a winner from
// community votes at all (only a manual admin pick).
async function getBotmTally() {
  const voteKey = getBotmSupabaseVoteKey();
  const votes = await DB.getBotmVotes(voteKey).catch(() => []);
  const counts = {};
  votes.forEach(v => { counts[v.post_id] = (counts[v.post_id]||0) + 1; });
  return Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([postId,count]) => ({ postId, count }));
}

// Get current month's BOTM winner — admin override takes priority (if set),
// otherwise the community's most-voted build wins automatically.
async function getBotmWinner() {
  const adminPick = JSON.parse(localStorage.getItem('dl_botm') || 'null');
  if (adminPick?.postId) {
    const post = S.posts.find(p => p.id === adminPick.postId);
    if (post) return { post, isAdminPick: true, voteCount: null };
  }
  const tally = await getBotmTally();
  if (!tally.length) return null;
  const post = S.posts.find(p => p.id === tally[0].postId);
  if (!post) return null;
  return { post, isAdminPick: false, voteCount: tally[0].count };
}

// Community stats bar at the top of the Members page
function renderMembersStatsBar() {
  const wrap = el('memStatsBar'); if (!wrap) return;
  const totalMembers = S.users.length;
  const totalBuilds = S.posts.length;
  const totalLikes = S.posts.reduce((sum,p) => sum + (p.likes||0), 0);
  wrap.innerHTML = `
    <div class="mem-stat-card"><span class="mem-stat-num">${totalMembers.toLocaleString()}</span><span class="mem-stat-label">Members</span></div>
    <div class="mem-stat-card"><span class="mem-stat-num">${totalBuilds.toLocaleString()}</span><span class="mem-stat-label">Builds Posted</span></div>
    <div class="mem-stat-card"><span class="mem-stat-num">${totalLikes.toLocaleString()}</span><span class="mem-stat-label">Total Likes</span></div>
  `;
}

// Full Build of the Month section on the Members page — winner cinematic
// (auto-determined from community votes, or admin override) plus a live
// nomination panel so people can actually cast/change their vote here.
async function renderMembersBotm() {
  const winnerWrap = el('memBotmWinner');
  const candWrap = el('memBotmCandidates');
  const subEl = el('memBotmSub');
  if (!winnerWrap || !candWrap) return;

  const [winnerResult, tally] = await Promise.all([getBotmWinner(), getBotmTally()]);

  // Winner cinematic
  if (!winnerResult) {
    winnerWrap.innerHTML = `<div class="lb-special-empty">
      <i class="fas fa-calendar-star"></i>
      <p>No votes yet this month — nominate a build below to get things started.</p>
    </div>`;
  } else {
    const { post, isAdminPick, voteCount } = winnerResult;
    const cfg = catCfg(post.category);
    winnerWrap.innerHTML = `
      <div class="botm-cinematic" data-id="${post.id}">
        <div class="botm-cinematic-img">
          ${post.images?.[0]
            ? `<img src="${post.images[0]}" alt="${esc(post.title)}"/>`
            : `<div class="botm-cinematic-ph" style="background:${phBg(post.id)}"></div>`}
          <div class="botm-cinematic-grad"></div>
        </div>
        <div class="botm-cinematic-info">
          <div class="botm-cinematic-badge"><i class="fas fa-calendar-star"></i> Build of the Month${isAdminPick ? '' : ' — Community Pick'}</div>
          <h2 class="botm-cinematic-title">${esc(post.title)}</h2>
          <div class="botm-cinematic-meta">
            <span class="cat-badge ${cfg.badge}" style="position:static">${post.category}</span>
            <span>by <b>${esc(post.user)}</b></span>
            ${post.year ? `<span>${post.year}</span>` : ''}
            ${post.hp   ? `<span>${esc(post.hp)}</span>` : ''}
            <span>♥ ${post.likes.toLocaleString()} likes</span>
            ${!isAdminPick && voteCount ? `<span><i class="fas fa-crown" style="color:#d97706"></i> ${voteCount} vote${voteCount===1?'':'s'}</span>` : ''}
          </div>
          ${post.desc ? `<p class="botm-cinematic-desc">${esc(post.desc.slice(0,220))}${post.desc.length>220?'…':''}</p>` : ''}
          <button class="btn-primary botm-cinematic-btn"><i class="fas fa-eye"></i> View Full Build</button>
        </div>
      </div>`;
    const card = winnerWrap.querySelector('.botm-cinematic');
    winnerWrap.querySelector('.botm-cinematic-btn').addEventListener('click', e => { e.stopPropagation(); openCarPage(post); });
    card.addEventListener('click', () => openCarPage(post));
  }

  if (subEl) {
    const now = new Date();
    subEl.textContent = now.getDate() <= 25
      ? `Vote now through the 25th — ${now.toLocaleString('default',{month:'long'})}'s winner is decided by the community`
      : `Voting closed on the 25th — this is ${now.toLocaleString('default',{month:'long'})}'s winner`;
  }

  // Nomination candidates — top 6 most-liked builds posted this calendar
  // month (falls back to top 6 overall if nothing's been posted yet this
  // month), each showing its live vote count.
  const now = new Date();
  const thisMonthPosts = S.posts.filter(p => {
    const d = new Date(p.createdAt || p.date || 0);
    return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
  });
  const pool = (thisMonthPosts.length ? thisMonthPosts : S.posts);
  const candidates = [...pool].sort((a,b)=>b.likes-a.likes).slice(0,6);
  const tallyMap = Object.fromEntries(tally.map(t => [t.postId, t.count]));
  const myVote = getUserBotmVote();

  if (!candidates.length) {
    candWrap.innerHTML = '<div class="mem-botm-empty">No builds to nominate yet — post one to get the ball rolling.</div>';
    return;
  }
  candWrap.innerHTML = candidates.map(p => {
    const count = tallyMap[p.id] || 0;
    const voted = myVote === p.id;
    return `<div class="mem-botm-candidate" data-open-id="${p.id}">
      <div class="mem-botm-cand-img">${p.images?.[0] ? `<img src="${p.images[0]}" alt="" loading="lazy"/>` : `<div style="width:100%;height:100%;background:${phBg(p.id)}"></div>`}</div>
      <div class="mem-botm-cand-body">
        <div class="mem-botm-cand-title">${esc(p.title)}</div>
        <div class="mem-botm-cand-user">by ${esc(p.user)}</div>
        <div class="mem-botm-cand-footer">
          <span class="mem-botm-vote-count"><i class="fas fa-crown"></i> ${count}</span>
          <button class="botm-vote-btn${voted?' voted':''}" data-id="${p.id}">${voted?'<i class="fas fa-check"></i> Voted':'<i class="fas fa-crown"></i> Nominate'}</button>
        </div>
      </div>
    </div>`;
  }).join('');

  candWrap.querySelectorAll('.botm-vote-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); castBotmVote(btn.dataset.id); });
  });
  candWrap.querySelectorAll('.mem-botm-candidate').forEach(card => {
    card.addEventListener('click', () => {
      const post = S.posts.find(p => p.id === card.dataset.openId);
      if (post) openCarPage(post);
    });
  });
}

// ─── BUILD OF THE MONTH ────────────────────────────────────────
function renderLbBotm() {
  const wrap = el('lbBotm'); if (!wrap) return;
  const stored = JSON.parse(localStorage.getItem('dl_botm')||'null');
  const post   = stored ? S.posts.find(p=>p.id===stored.postId) : null;

  if (!post) {
    wrap.innerHTML = `<div class="lb-special-empty">
      <i class="fas fa-calendar-star"></i>
      <p>No Build of the Month selected yet.</p>
      ${S.user?.isAdmin ? '<p style="color:var(--muted);font-size:.8rem">Go to Admin → Posts to select one</p>' : ''}
    </div>`;
    return;
  }

  const cfg = catCfg(post.category);
  wrap.innerHTML = `
    <div class="botm-cinematic" data-id="${post.id}">
      <div class="botm-cinematic-img">
        ${post.images?.[0]
          ? `<img src="${post.images[0]}" alt="${esc(post.title)}"/>`
          : `<div class="botm-cinematic-ph" style="background:${phBg(post.id)}"></div>`}
        <div class="botm-cinematic-grad"></div>
      </div>
      <div class="botm-cinematic-info">
        <div class="botm-cinematic-badge"><i class="fas fa-calendar-star"></i> Build of the Month</div>
        <h2 class="botm-cinematic-title">${esc(post.title)}</h2>
        <div class="botm-cinematic-meta">
          <span class="cat-badge ${cfg.badge}" style="position:static">${post.category}</span>
          <span>by <b>${esc(post.user)}</b></span>
          ${post.year ? `<span>${post.year}</span>` : ''}
          ${post.hp   ? `<span>${esc(post.hp)}</span>` : ''}
          <span>♥ ${post.likes.toLocaleString()} likes</span>
        </div>
        ${post.desc ? `<p class="botm-cinematic-desc">${esc(post.desc.slice(0,220))}${post.desc.length>220?'…':''}</p>` : ''}
        <button class="btn-primary botm-cinematic-btn">
          <i class="fas fa-eye"></i> View Full Build
        </button>
      </div>
    </div>`;

  const card = wrap.querySelector('.botm-cinematic');
  wrap.querySelector('.botm-cinematic-btn').addEventListener('click', e => {
    e.stopPropagation();
    openCarPage(post);
  });
  card.addEventListener('click', () => openCarPage(post));
}

// ─── ALL TIME GREATS ───────────────────────────────────────────
function renderLbAtg() {
  const wrap = el('lbAtg'); if (!wrap) return;
  const stored = JSON.parse(localStorage.getItem('dl_atg')||'[]');
  const posts  = stored.map(id => S.posts.find(p=>p.id===id)).filter(Boolean);

  if (!posts.length) {
    wrap.innerHTML = `<div class="lb-special-empty">
      <i class="fas fa-medal"></i>
      <p>No All Time Greats selected yet.</p>
      ${S.user?.isAdmin ? '<p style="color:var(--muted);font-size:.8rem">Go to Admin → Posts to add builds</p>' : ''}
    </div>`;
    return;
  }

  wrap.innerHTML = `<div class="atg-grid">${posts.map(p => `
    <div class="atg-card" data-id="${p.id}">
      <div class="atg-card-img">
        ${p.images?.[0]
          ? `<img src="${p.images[0]}" alt="${esc(p.title)}" loading="lazy"/>`
          : `<div class="atg-card-ph" style="background:${phBg(p.id)}"></div>`}
        <div class="atg-card-badge"><i class="fas fa-medal"></i></div>
        <div class="atg-card-overlay">
          <span class="cat-badge ${catCfg(p.category).badge}" style="position:static">${p.category}</span>
        </div>
      </div>
      <div class="atg-card-info">
        <div class="atg-card-title">${esc(p.title)}</div>
        <div class="atg-card-meta">by ${esc(p.user)} · ♥ ${p.likes.toLocaleString()}</div>
      </div>
    </div>`).join('')}
  </div>`;

  wrap.querySelectorAll('.atg-card').forEach(card => {
    card.addEventListener('click', () => {
      const p = posts.find(x=>x.id===card.dataset.id); if(p) openCarPage(p);
    });
  });
}

// ─── EVENTS ───────────────────────────────────────────────────
function initEvents() {
  el('createEvtBtn')?.addEventListener('click',()=>{
    if(!S.user){toast('Sign in to create events','err');return;}
    el('createEvtForm').style.display=el('createEvtForm').style.display==='none'?'block':'none';
  });
  el('createEvtClose')?.addEventListener('click',()=>el('createEvtForm').style.display='none');
  el('submitEvt')?.addEventListener('click',()=>{
    const title=val('evtTitle'),type=el('evtType').value,loc=val('evtLocation'),date=val('evtDate');
    if(!title||!type||!loc||!date){toast('Fill in title, type, location, and date','err');return;}
    const evt={id:'ev'+Date.now(),title,type,location:loc,date,time:val('evtTime'),desc:val('evtDesc'),cap:val('evtCap'),host:S.user.username,attendees:[S.user.username]};
    S.events.unshift(evt); save();
    el('createEvtForm').style.display='none';
    ['evtTitle','evtLocation','evtDate','evtTime','evtCap','evtDesc'].forEach(id=>{const e=el(id);if(e)e.value='';});
    el('evtType').value='';
    renderEventsGrid(); renderSidebarEvents();
    toast('Event created!','ok');
    pushNotif('event',S.user.username,`created a new event: <b>${title}</b>`,'page:events');
  });
  document.querySelectorAll('.fpill[data-ecat]').forEach(pill=>pill.addEventListener('click',()=>{
    document.querySelectorAll('.fpill[data-ecat]').forEach(p=>p.classList.remove('active'));
    pill.classList.add('active'); S.evtFilter=pill.dataset.ecat; renderEventsGrid();
  }));
}

function renderEventsGrid() {
  let evts=[...S.events];
  if(S.evtFilter!=='All') evts=evts.filter(e=>e.type===S.evtFilter);
  evts.sort((a,b)=>new Date(a.date)-new Date(b.date));
  const typeColor={'Car Meet':'#3b82f6','Track Day':'#e8392a','Car Show':'#f0a030','Cruise':'#22c55e','Cars & Coffee':'#c9a84c','Drag Event':'#a855f7'};
  const grid=el('evtGrid');
  if(!evts.length){grid.innerHTML='<div class="evt-empty"><i class="fas fa-calendar-times"></i><h3>No events found</h3><p>Be the first to create one!</p></div>';return;}
  grid.innerHTML=evts.map(e=>{
    const past=new Date(e.date)<new Date(), attending=e.attendees.includes(S.user?.username);
    const d=new Date(e.date), mon=d.toLocaleDateString('en-US',{month:'short'}).toUpperCase(), day=d.getDate();
    const color=typeColor[e.type]||'#555';
    return `<div class="evt-card${past?' past':''}">
      <div class="evt-accent" style="background:${color}"></div>
      <div class="evt-date-pill"><span class="evt-mon">${mon}</span><span class="evt-day">${day}</span></div>
      <div class="evt-body">
        <div class="evt-type" style="color:${color};border-color:${color}40;background:${color}12">${e.type}</div>
        <div class="evt-title">${esc(e.title)}</div>
        <div class="evt-meta">
          <span><i class="fas fa-map-marker-alt"></i> ${esc(e.location)}</span>
          ${e.time?`<span><i class="fas fa-clock"></i> ${e.time}</span>`:''}
          <span><i class="fas fa-users"></i> ${e.attendees.length}${e.cap?'/'+e.cap:''}</span>
        </div>
        ${e.desc?`<p class="evt-desc">${esc(e.desc).slice(0,120)}${e.desc.length>120?'…':''}</p>`:''}
        <div class="evt-host"><div class="evt-host-av" style="background:${avColor(e.host)}">${e.host[0].toUpperCase()}</div><span>by <b>${esc(e.host)}</b></span></div>
      </div>
      <div class="evt-foot">
        ${!past?`<button class="evt-rsvp${attending?' attending':''}" data-id="${e.id}">${attending?'✓ Attending':e.cap&&e.attendees.length>=+e.cap?'Full':'RSVP'}</button>`:`<span class="evt-past">Past Event</span>`}
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.evt-rsvp').forEach(btn=>btn.addEventListener('click',()=>{
    if(!S.user){toast('Sign in to RSVP','err');return;}
    const evt=S.events.find(x=>x.id===btn.dataset.id); if(!evt)return;
    const idx=evt.attendees.indexOf(S.user.username);
    if(idx>=0){evt.attendees.splice(idx,1);toast('RSVP cancelled','');}
    else{if(evt.cap&&evt.attendees.length>=+evt.cap){toast('This event is full','err');return;} evt.attendees.push(S.user.username);toast("You're in! RSVP confirmed.",'ok');pushNotif('event',S.user.username,`RSVP'd to <b>${evt.title}</b>`,'page:events');}
    save(); renderEventsGrid(); renderSidebarEvents();
  }));
}

function renderSidebarEvents() {
  const node=el('sidebarEvents'); if(!node)return;
  const upcoming=S.events.filter(e=>new Date(e.date)>=new Date()).sort((a,b)=>new Date(a.date)-new Date(b.date)).slice(0,3);
  if(!upcoming.length){node.innerHTML='<p class="sei-empty">No upcoming events</p>';return;}
  node.innerHTML=upcoming.map(e=>{
    const d=new Date(e.date);
    return `<div class="sei">
      <div class="sei-date"><span class="sei-mon">${d.toLocaleDateString('en-US',{month:'short'}).toUpperCase()}</span><span class="sei-day">${d.getDate()}</span></div>
      <div><div class="sei-title">${esc(e.title)}</div><div class="sei-loc"><i class="fas fa-map-marker-alt"></i> ${esc(e.location)}</div></div>
    </div>`;
  }).join('');
}

// ─── MEMBERS ──────────────────────────────────────────────────
function initMembers() {
  el('membersSearch')?.addEventListener('input', renderMembers);
  document.querySelectorAll('.sort-btn[data-msort]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('.sort-btn[data-msort]').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); S.memberSort=b.dataset.msort; renderMembers();
  }));
}
function renderMembers() {
  const searchEl = el('membersSearch');
  const q = searchEl ? searchEl.value.toLowerCase() : '';
  let members=[...S.users].filter(u=>!S.blockedUsers.includes(u.username) && (!q||u.username.toLowerCase().includes(q)||(u.bio||'').toLowerCase().includes(q)));
  if(S.memberSort==='likes')  members.sort((a,b)=>(b.totalLikes||0)-(a.totalLikes||0));
  else if(S.memberSort==='builds') members.sort((a,b)=>(b.posts||0)-(a.posts||0));
  else members.sort((a,b)=>b.joined>a.joined?1:-1);
  const grid=el('membersGrid');
  if (!grid) return;
  if(!members.length){
    // If no users yet, show skeleton — they'll arrive from Supabase shortly
    grid.innerHTML = S._loading
      ? Array(6).fill(0).map(()=>`<div class="skeleton-card"><div class="skeleton" style="height:120px;width:100%"></div><div style="padding:14px;display:flex;flex-direction:column;gap:8px"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:12px;width:40%"></div></div></div>`).join('')
      : '<div class="members-empty"><i class="fas fa-users"></i><p>No members found</p></div>';
    return;
  }
  grid.innerHTML=members.map((u,rank)=>{
    const posts=S.posts.filter(p=>p.user===u.username);
    const topPost=[...posts].sort((a,b)=>b.likes-a.likes)[0];
    const img=topPost?.images?.[0], following=isFollowing(u.username);
    const isSelf=S.user?.username===u.username;
    return `<div class="member-card">
      <div class="member-cover" style="background:${phBg(u.username)}">
        ${img?`<img src="${img}" alt="" loading="lazy"/>`:''}<div class="member-cover-ov"></div>
        ${rank<3?`<div class="member-rank rank${rank+1}">#${rank+1}</div>`:''}
      </div>
      <div class="member-body">
        <div class="member-av${hasActiveSpotStory(u.username)?' has-story-ring':''}" style="background:transparent">${ u.avatarUrl ? `<img src="${u.avatarUrl}" alt="" class="av-photo"/>`
            : u.username[0].toUpperCase()
        }</div>
        <div class="member-info">
          <div class="member-name">${esc(u.username)}</div>
          <div class="member-bio">${u.bio?(u.bio.length>60?u.bio.slice(0,60)+'…':u.bio):'DriveLog member'}</div>
          <div class="member-stats"><span><b>${u.posts||0}</b> builds</span><span><b>${(u.totalLikes||0).toLocaleString()}</b> likes</span></div>
          ${(u.instagram||u.tiktok||u.youtube)?`<div class="member-socials">
            ${u.instagram?`<a class="msoc ig" href="https://instagram.com/${u.instagram}" target="_blank" rel="noopener"><i class="fab fa-instagram"></i></a>`:''}
            ${u.tiktok?`<a class="msoc tt" href="https://tiktok.com/@${u.tiktok}" target="_blank" rel="noopener"><i class="fab fa-tiktok"></i></a>`:''}
            ${u.youtube?`<a class="msoc yt" href="https://youtube.com/@${u.youtube}" target="_blank" rel="noopener"><i class="fab fa-youtube"></i></a>`:''}
          </div>`:''}
        </div>
        ${!isSelf&&S.user?`<button class="member-follow-btn${following?' following':''}" data-un="${u.username}">${following?'<i class="fas fa-check"></i> Following':'+ Follow'}</button>`:''}
      </div>
      <div class="member-foot"><button class="member-view-btn" data-un="${u.username}">View Builds</button></div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.member-follow-btn').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();toggleFollow(b.dataset.un);}));
  grid.querySelectorAll('.member-view-btn').forEach(b=>b.addEventListener('click',()=>viewMemberProfile(b.dataset.un)));
}

// Minimal page-switch used by viewMemberProfile() — shows the profile page
// section without goTo()'s "page===profile → always render as ME" hook,
// and without goTo() deleting the ?user= URL param viewMemberProfile just
// set. Using the full goTo('profile') here was the cause of a serious bug:
// clicking ANY other user's profile (story bar, members grid, search,
// notifications — anywhere) would render YOUR OWN profile instead, because
// goTo() always calls updateProfilePage() (which renders S.user, not
// whoever was actually requested) the instant the page becomes 'profile'.
function switchToProfilePageSection() {
  S.page = 'profile';
  if (typeof closeSocialDetail === 'function') closeSocialDetail();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = el('page-profile');
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-link,.mob-link').forEach(a => a.classList.toggle('active', a.dataset.page==='profile'));
  window.scrollTo({top:0, behavior:'auto'});
  closeMobNav();
}

async function viewMemberProfile(username) {
  S._editingPostId = null;
  if (!username) return;

  // Update URL so this profile is shareable
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('user', username);
    url.hash = 'profile';
    window.history.pushState({ page:'profile', user:username }, '', url.toString());
  } catch(_) {}

  // Find user — try local first, then Supabase
  let u = S.users.find(x => x.username === username);
  if (!u) {
    try {
      const profile = await DB.getProfileByUsername(username);
      if (profile) { u = dbUserToApp(profile); S.users.push(u); }
    } catch(e) { console.warn('Profile fetch failed:', e); }
  }

  if (!u) {
    switchToProfilePageSection();
    const noMsg = el('noLoginMsg');
    if (noMsg) {
      noMsg.style.display = 'block';
      noMsg.innerHTML = `<div class="profile-not-found" style="text-align:center;padding:40px 20px">
        <i class="fas fa-user-slash" style="font-size:3rem;opacity:.3;display:block;margin-bottom:16px"></i>
        <h2>Profile Not Found</h2>
        <p>This user may not exist or was removed.</p>
        <button class="btn-ghost small" onclick="goTo('home')" style="margin-top:12px">
          <i class="fas fa-home"></i> Go Home
        </button>
      </div>`;
    }
    el('profilePostsWrap').style.display = 'none';
    el('profileActions').style.display = 'none';
    return;
  }

  const isOwnProfile = S.user?.username === username;
  if (u.privacyPublic === false && !isOwnProfile && !S.user?.isAdmin) {
    switchToProfilePageSection();
    const privMsg = el('noLoginMsg');
    if (privMsg) {
      privMsg.style.display = 'block';
      privMsg.innerHTML = `<div class="profile-not-found" style="text-align:center;padding:40px 20px">
        <i class="fas fa-lock" style="font-size:3rem;opacity:.3;display:block;margin-bottom:16px"></i>
        <h2>This Profile is Private</h2>
        <p>${esc(username)} has chosen to keep their profile private.</p>
        <button class="btn-ghost small" onclick="goTo('home')" style="margin-top:12px">
          <i class="fas fa-home"></i> Go Home
        </button>
      </div>`;
    }
    el('profilePostsWrap').style.display = 'none';
    el('profileActions').style.display = 'none';
    return;
  }

  switchToProfilePageSection();

  // Get posts — from local cache + fetch any missing ones from Supabase
  let posts = S.posts.filter(p => p.user === username);
  if (!posts.length && _sbOk()) {
    // Profile shared via URL — posts may not be in local cache yet
    try {
      const rows = await DB.getPosts({ limit:50 });
      const fresh = rows.map(dbPostToApp).filter(Boolean);
      fresh.forEach(fp => { if (!S.posts.find(p => p.id === fp.id)) S.posts.push(fp); });
      posts = S.posts.filter(p => p.user === username);
    } catch(_) {}
  }

  const likes = posts.reduce((a,p) => a+(p.likes||0), 0);

  // Follower count — from Supabase follows table
  let followers = 0;
  if (_sbOk() && u.id) {
    try {
      const { count } = await _sb.from('follows').select('id', {count:'exact',head:true}).eq('following_id', u.id);
      followers = count || 0;
    } catch(_) {
      // Fallback: count from local
      followers = S.users.reduce((cnt, su) => {
        const fl = JSON.parse(localStorage.getItem('dl_following_'+su.username)||'[]');
        return cnt + (fl.includes(username) ? 1 : 0);
      }, 0);
    }
  }

  const followingCount = await DB.getFollowingCount(u.id).catch(() => 0);

  // Banner
  const savedBanner = localStorage.getItem('dl_banner_'+username) || u.bannerUrl || null;
  const coverEl = el('profileCover');
  if (coverEl) {
    coverEl.style.backgroundImage = savedBanner ? `url(${savedBanner})` : '';
    coverEl.style.backgroundSize = 'cover';
    coverEl.style.backgroundPosition = 'center';
  }
  const bannerBtn = el('profileBannerUploadBtn');
  if (bannerBtn) bannerBtn.style.display = S.user?.username === username ? 'flex' : 'none';

  // Avatar
  setAvEl(el('profileAv'), u.username);

  // Name + awards
  el('profileName').textContent = u.username;
  const awardsEl2 = el('profileAwards');
  if (awardsEl2) awardsEl2.innerHTML = renderAwards(u, true);

  // Bio
  el('profileBio').textContent = truncateBio(u.bio||'');

  // Specialties
  const specEl = el('profileSpecialties');
  if (specEl) {
    const catCounts = {};
    posts.forEach(p => {
      const pc = Array.isArray(p.categories)&&p.categories.length ? p.categories : [p.category].filter(Boolean);
      pc.forEach(c => { catCounts[c]=(catCounts[c]||0)+1; });
    });
    const topCats = Object.entries(catCounts).sort((a,b)=>b[1]-a[1]).slice(0,4);
    specEl.innerHTML = topCats.map(([c]) =>
      `<span class="profile-specialty-tag cat-badge ${catCfg(c).badge}" style="position:static;font-size:.7rem">${c}</span>`
    ).join('');
  }

  // Joined date
  const ageInfo = accountAge(u);
  el('profileJoined').innerHTML = `Member since ${u.joined} &nbsp;<span class="acct-age-badge"><i class="fas fa-clock"></i> ${ageInfo.full}</span>`;

  // Social links
  el('profileSocials').innerHTML = buildSocialLinks(u);

  // Stats
  const stEl = el('profileStats');
  if (stEl) stEl.innerHTML = `
    <div class="pstat"><span class="pstat-n">${posts.length}</span><span class="pstat-l">Builds</span></div>
    <div class="pstat"><span class="pstat-n">${likes.toLocaleString()}</span><span class="pstat-l">Likes</span></div>
    <div class="pstat clickable" id="profileFollowersStat"><span class="pstat-n">${followers.toLocaleString()}</span><span class="pstat-l">Followers</span></div>
    <div class="pstat clickable" id="profileFollowingStat"><span class="pstat-n">${followingCount.toLocaleString()}</span><span class="pstat-l">Following</span></div>
  `;
  el('profileFollowersStat')?.addEventListener('click', () => openFollowList(u.id, 'followers'));
  el('profileFollowingStat')?.addEventListener('click', () => openFollowList(u.id, 'following'));

  // Action buttons
  el('profileActions').style.display = 'flex';
  el('noLoginMsg').style.display = 'none';
  el('profilePostsWrap').style.display = 'block';
  el('profileBuildsLabel').textContent = `${u.username}'s Builds`;

  const isOwn = S.user?.username?.trim().toLowerCase() === username?.trim().toLowerCase();
  const editProfBtn = el('editProfileBtn');
  const profDmBtn   = el('profileDmBtn');
  const shareBtn    = el('profileShareBtn');

  if (editProfBtn) editProfBtn.style.display = isOwn ? 'inline-flex' : 'none';
  if (profDmBtn) {
    profDmBtn.style.display = (!isOwn && S.user) ? 'inline-flex' : 'none';
    profDmBtn.onclick = () => openDmWith(username);
  }
  // Share button — copies profile URL to clipboard
  if (shareBtn) {
    shareBtn.style.display = 'inline-flex';
    shareBtn.onclick = () => {
      const profileUrl = `${window.location.origin}${window.location.pathname}?user=${encodeURIComponent(username)}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(profileUrl).then(() => toast('Profile link copied! 🔗','ok'));
      } else {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = profileUrl; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        toast('Profile link copied! 🔗','ok');
      }
    };
  }

  // Follow button — show even when signed out (will prompt sign-in)
  updateFollowBtn(username);
  const followBtnEl = el('followBtn');
  if (followBtnEl) {
    followBtnEl.style.display = isOwn ? 'none' : 'inline-flex';
    followBtnEl.onclick = () => toggleFollow(username);
  }

  // Block button — only shown on other people's profiles, never your own
  const blockBtnEl = el('profileBlockBtn');
  if (blockBtnEl) {
    if (isOwn || !S.user) {
      blockBtnEl.style.display = 'none';
    } else {
      blockBtnEl.style.display = 'inline-flex';
      const isBlocked = S.blockedUsers.includes(username);
      blockBtnEl.innerHTML = isBlocked ? '<i class="fas fa-ban"></i> Unblock' : '<i class="fas fa-ban"></i> Block';
      blockBtnEl.className = isBlocked ? 'btn-ghost small' : 'btn-ghost small';
      blockBtnEl.onclick = async () => {
        const target = S.users.find(x => x.username === username);
        if (!target?.id || !S.user?.id) { toast('Unable to reach this user right now','err'); return; }
        blockBtnEl.disabled = true;
        try {
          if (isBlocked) {
            const { error } = await DB.unblockUser(S.user.id, target.id);
            if (error) { toast('Failed to unblock — try again','err'); return; }
            S.blockedUsers = S.blockedUsers.filter(u => u !== username);
            toast(`Unblocked ${username}`, 'ok');
          } else {
            if (!confirm(`Block ${username}? They won't be able to message you, and you won't see their posts or profile in the members list.`)) return;
            const { error } = await DB.blockUser(S.user.id, target.id);
            if (error) { toast('Failed to block — try again','err'); return; }
            S.blockedUsers.push(username);
            toast(`${username} has been blocked`, 'ok');
          }
        } finally {
          blockBtnEl.disabled = false;
          viewMemberProfile(username); // re-render to reflect new block state
        }
      };
    }
  }

  // Pin hint (own profile only)
  const pinHint = el('profilePinHint');
  if (pinHint) pinHint.style.display = isOwn ? 'inline-flex' : 'none';

  // Pinned build
  const pinnedId = localStorage.getItem('dl_pinned_'+username);
  const pinnedPost = pinnedId ? posts.find(p => p.id === pinnedId) : null;
  const pinnedWrap = el('profilePinnedWrap');
  const pinnedGrid = el('profilePinnedGrid');
  if (pinnedWrap && pinnedGrid) {
    if (pinnedPost) {
      pinnedWrap.style.display = 'block';
      pinnedGrid.innerHTML = cardHTML(pinnedPost, 0);
      attachCardEvents(pinnedGrid);
    } else {
      pinnedWrap.style.display = 'none';
    }
  }

  // Builds grid (exclude pinned post from main grid)
  const grid = el('profileGrid');
  const noBuilds = el('noBuilds');
  const gridPosts = pinnedPost ? posts.filter(p => p.id !== pinnedPost.id) : posts;
  if (gridPosts.length) {
    noBuilds.style.display = 'none';
    grid.innerHTML = gridPosts.map((p,i) => cardHTML(p,i)).join('');
    attachCardEvents(grid);
    // Right-click to pin (own profile only)
    if (isOwn) {
      grid.querySelectorAll('.card').forEach(card => {
        card.addEventListener('contextmenu', e => {
          e.preventDefault();
          const postId = card.dataset.id;
          const cur = localStorage.getItem('dl_pinned_'+username);
          if (cur === postId) {
            localStorage.removeItem('dl_pinned_'+username);
            toast('Build unpinned','');
          } else {
            localStorage.setItem('dl_pinned_'+username, postId);
            toast('Build pinned to top of your profile ✓','ok');
          }
          viewMemberProfile(username); // re-render
        });
      });
    }
  } else {
    grid.innerHTML = '';
    noBuilds.style.display = 'block';
  }
}
// ─── PUBLIC PROFILE ROUTER ─────────────────────────────────────
async function viewPublicProfile(username) {
  if (!username) return;
  // viewMemberProfile handles fetching from Supabase if not cached
  await viewMemberProfile(username);
}

function buildSocialLinks(u) {
  // Respect the "Show Social Links" privacy toggle — owners always see
  // their own links (so they can still edit/verify them), everyone else
  // sees nothing if it's turned off.
  const isOwner = S.user?.username === u.username;
  if (u.privacySocials === false && !isOwner) return '';
  return [
    u.instagram?`<a class="prof-social ig" href="https://instagram.com/${u.instagram}" target="_blank" rel="noopener"><i class="fab fa-instagram"></i> @${u.instagram}</a>`:'',
    u.tiktok?`<a class="prof-social tt" href="https://tiktok.com/@${u.tiktok}" target="_blank" rel="noopener"><i class="fab fa-tiktok"></i> @${u.tiktok}</a>`:'',
    u.youtube?`<a class="prof-social yt" href="https://youtube.com/@${u.youtube}" target="_blank" rel="noopener"><i class="fab fa-youtube"></i> @${u.youtube}</a>`:'',
    u.website?`<a class="prof-social wb" href="${u.website}" target="_blank" rel="noopener"><i class="fas fa-globe"></i> Website</a>`:'',
  ].join('');
}

// ─── GARAGE ───────────────────────────────────────────────────
function initGarage() {
  // Tab wiring lives in renderGarage() (single source of truth) so
  // counts and panels stay in sync. Nothing to do at init.
}
function renderGarage() {
  const signin = el('garageSignin');
  const tabs   = el('garageTabs');
  const panels = document.querySelectorAll('.gpanel');

  // ── Signed out: one clear sign-in state, everything else hidden ──
  if (!S.user) {
    if (signin) signin.style.display = 'block';
    if (tabs)   tabs.style.display   = 'none';
    panels.forEach(p => p.style.display = 'none');
    // Clear any stale content from a previous session
    ['likedGrid','savedGrid','sharedGrid'].forEach(id => { const g=el(id); if(g) g.innerHTML=''; });
    return;
  }
  if (signin) signin.style.display = 'none';
  if (tabs)   tabs.style.display   = '';
  panels.forEach(p => p.style.display = '');

  const uname  = S.user.username;
  const uid    = S.user.id || '';
  const byDate = (a,b) => new Date(b.createdAt||b.date||0) - new Date(a.createdAt||a.date||0);
  const likedAll  = S.posts.filter(p=>(p.likedBy||[]).includes(uname)||(p.likedBy||[]).includes(uid));
  const savedAll  = S.posts.filter(p=>(p.savedBy||[]).includes(uname)||(p.savedBy||[]).includes(uid));
  const sharedAll = S.posts.filter(p=>p.user===uname);
  let liked  = likedAll.filter(applyFiltersToPost);
  let saved  = savedAll.filter(applyFiltersToPost);
  let shared = sharedAll.filter(applyFiltersToPost);

  // Sort — same options as the home feed (Newest/Most Liked/Most Comments)
  const gsort = S.garageSort || 'newest';
  const sortFn = gsort==='popular'   ? (a,b)=>b.likes-a.likes
               : gsort==='discussed'? (a,b)=>(b.comments||[]).length-(a.comments||[]).length
               : byDate;
  liked.sort(sortFn); saved.sort(sortFn); shared.sort(sortFn);

  const filterActive = countActiveFilters() > 0;
  const emptyMsg = (elx, hasAny) => {
    if (!elx) return;
    if (elx.dataset.origHtml === undefined) elx.dataset.origHtml = elx.innerHTML;
    elx.innerHTML = (hasAny && filterActive)
      ? '<i class="fas fa-filter"></i><h3>No matches</h3><p>Nothing here matches your current filters.</p>'
      : elx.dataset.origHtml;
  };

  // Liked
  el('likedGrid').innerHTML = liked.map((p,i)=>cardHTML(p,i)).join('');
  el('likedEmpty').style.display = liked.length ? 'none' : 'block';
  emptyMsg(el('likedEmpty'), likedAll.length > 0);
  attachCardEvents(el('likedGrid'));

  // Saved
  el('savedGrid').innerHTML = saved.map((p,i)=>cardHTML(p,i)).join('');
  el('savedEmpty').style.display = saved.length ? 'none' : 'block';
  emptyMsg(el('savedEmpty'), savedAll.length > 0);
  attachCardEvents(el('savedGrid'));

  // Shared (your builds)
  if (el('sharedGrid')) {
    el('sharedGrid').innerHTML = shared.map((p,i)=>cardHTML(p,i)).join('');
    el('sharedEmpty').style.display = shared.length ? 'none' : 'block';
    emptyMsg(el('sharedEmpty'), sharedAll.length > 0);
    attachCardEvents(el('sharedGrid'));
  }

  // Saved Parts + Saved Socials
  if (el('partsPanel'))   renderParts();
  if (el('socialsPanel')) renderSavedSocials();

  // Tab counts — total counts, unaffected by the active filter (like Gmail
  // label counts not changing when you search)
  const parts   = JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
  const socials = getSavedSocials();
  const setCount = (id, n) => { const e = el(id); if (e) e.textContent = n > 0 ? n : ''; };
  setCount('gcount-liked',  likedAll.length);
  setCount('gcount-saved',  savedAll.length);
  setCount('gcount-shared', sharedAll.length);
  setCount('gcount-parts',  parts.length);
  setCount('gcount-socials',socials.length);

  // Filter count badge on the garage Filters button
  const gFilterCount = el('garageFilterTriggerCount');
  if (gFilterCount) {
    const n = countActiveFilters();
    gFilterCount.textContent = n > 0 ? n : '';
    gFilterCount.style.display = n > 0 ? '' : 'none';
  }

  // Sort+filter row only makes sense on the build-post tabs (Liked/Saved/
  // Shared) — Parts and Socials aren't build posts, so year/HP/category
  // filtering doesn't apply to them.
  const BUILD_TABS = ['liked','saved','shared'];
  function updateSortRowVisibility() {
    const activeTab = document.querySelector('.gtab.active')?.dataset.gtab || 'liked';
    const row = el('garageSortRow');
    if (row) row.style.display = BUILD_TABS.includes(activeTab) ? '' : 'none';
  }
  updateSortRowVisibility();

  // Wire sort buttons once
  if (!S._garageSortWired) {
    S._garageSortWired = true;
    document.querySelectorAll('.sort-btn[data-gsort]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sort-btn[data-gsort]').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        S.garageSort = btn.dataset.gsort;
        renderGarage();
      });
    });
  }

  // Wire tabs — single wiring point (onclick replaces, never stacks)
  document.querySelectorAll('.gtab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.gtab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.gpanel').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const panel = el('gpanel-'+t.dataset.gtab);
      if (panel) panel.classList.add('active');
      if (t.dataset.gtab === 'socials') renderSavedSocials();
      if (t.dataset.gtab === 'parts')   renderParts();
      updateSortRowVisibility();
    };
  });
}

// ─── SAVED SOCIALS ─────────────────────────────────────────────
function getSavedSocials() {
  try { return JSON.parse(localStorage.getItem('dl_socials_'+(S.user?.username||''))||'[]'); } catch(_) { return []; }
}

function saveSocial(entry) {
  if (!S.user) { toast('Sign in to save socials','err'); el('authModal')?.classList.add('open'); return; }
  const uname = S.user.username;
  const all = getSavedSocials();
  if (all.find(s => s.platform === entry.platform && s.handle === entry.handle)) {
    toast('Already saved!',''); return;
  }
  all.unshift({ ...entry, ts: Date.now() });
  localStorage.setItem('dl_socials_'+uname, JSON.stringify(all));
  toast(entry.platform + ' saved to your Garage ✓', 'ok');
  if (S.page === 'garage') renderSavedSocials();
}

const SOCIAL_PLATFORM_ICONS  = { Instagram:'fab fa-instagram', TikTok:'fab fa-tiktok', YouTube:'fab fa-youtube', Website:'fas fa-globe', Twitter:'fab fa-x-twitter' };
const SOCIAL_PLATFORM_COLORS = { Instagram:'#e1306c', TikTok:'#69c9d0', YouTube:'#ff0000', Website:'#3b82f6', Twitter:'#000' };

function renderSavedSocials() {
  const panel = el('socialsPanel'); if (!panel || !S.user) return;
  const socials = getSavedSocials();
  panel.innerHTML = `
    <div class="parts-section">
      <div class="parts-header"><h3>Saved Socials</h3><p>Social media accounts you've saved from build pages.</p></div>
      ${socials.length ? `<div class="saved-socials-grid">${socials.map((s,i) => `
        <div class="saved-social-card">
          <div class="saved-social-icon" style="background:${(SOCIAL_PLATFORM_COLORS[s.platform]||'#666')}22;color:${SOCIAL_PLATFORM_COLORS[s.platform]||'#888'}">
            <i class="${SOCIAL_PLATFORM_ICONS[s.platform]||'fas fa-link'}"></i>
          </div>
          <div class="saved-social-info">
            <div class="saved-social-platform">${esc(s.platform)}</div>
            <div class="saved-social-handle">${esc(s.handle)}</div>
            <div class="saved-social-from">from <b>${esc(s.fromUser||'')}</b> &middot; ${timeAgo(s.ts)}</div>
          </div>
          <div class="saved-social-actions">
            <a href="${esc(s.url)}" target="_blank" rel="noopener" class="btn-primary small">
              <i class="fas fa-external-link-alt"></i> Visit
            </a>
            <button class="saved-social-rm" data-i="${i}" title="Remove"><i class="fas fa-times"></i></button>
          </div>
        </div>`).join('')}</div>` : `
      <div class="parts-empty">
        <i class="fab fa-instagram"></i>
        <p>No saved socials yet. On any build page, hover over the social links and click the save icon.</p>
      </div>`}
    </div>`;
  panel.querySelectorAll('.saved-social-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      const all = getSavedSocials();
      all.splice(+btn.dataset.i,1);
      localStorage.setItem('dl_socials_'+S.user.username, JSON.stringify(all));
      renderSavedSocials();
    });
  });
}


// ─── SAVE PART FROM BUILD ─────────────────────────────────────
function savePartFromBuild(partData) {
  if (!S.user) { toast('Sign in to save parts','err'); el('authModal')?.classList.add('open'); return; }
  const uname = S.user.username;
  const parts = JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
  // Don't duplicate same part from same post
  if (parts.find(p => p.text === partData.text && p.fromPostId === partData.fromPostId)) {
    toast('Part already saved to Garage',''); return;
  }
  parts.unshift({ ...partData, ts: Date.now() });
  localStorage.setItem('dl_parts_'+uname, JSON.stringify(parts));
  toast('Part saved to Garage ✓','ok');
  // Animate the button
}

function wirePartSaveButtons(post) {
  document.querySelectorAll('.cp-save-part-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      try {
        const partData = JSON.parse(decodeURIComponent(btn.dataset.part));
        savePartFromBuild(partData);
        btn.classList.add('saved');
        btn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { btn.classList.remove('saved'); btn.innerHTML = '<i class="fas fa-bookmark"></i>'; }, 2000);
      } catch(err) { console.warn('Save part failed:', err); }
    });
    // Mark already-saved parts
    if (S.user) {
      try {
        const partData = JSON.parse(decodeURIComponent(btn.dataset.part));
        const parts = JSON.parse(localStorage.getItem('dl_parts_'+S.user.username)||'[]');
        if (parts.find(p => p.text === partData.text && p.fromPostId === partData.fromPostId)) {
          btn.classList.add('saved');
          btn.innerHTML = '<i class="fas fa-check"></i>';
        }
      } catch(_) {}
    }
  });
}

function renderParts() {
  const uname = S.user?.username; if (!uname) return;
  const parts = JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
  el('partsPanel').innerHTML = `
    <div class="parts-section">
      <div class="parts-header"><h3>Saved Parts</h3><p>Parts you've saved from builds or added manually.</p></div>
      <div class="parts-add-row">
        <input class="finput" id="partsInput" placeholder="Add a part manually (e.g. Tein coilovers, HKS turbo kit…)" style="flex:1;margin-bottom:0"/>
        <button class="btn-primary small" id="partsAddBtn"><i class="fas fa-plus"></i> Add</button>
      </div>
      <div class="parts-list" id="partsList">
        ${parts.length ? parts.map((p,i) => {
          const hasFavicon = p.url && p.url.startsWith('http');
          let faviconHTML = '';
          try {
            if (hasFavicon) {
              const domain = new URL(p.url).hostname;
              faviconHTML = `<div class="parts-item-thumb"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<i class=\\'fas fa-link\\'></i>'"/></div>`;
            } else {
              faviconHTML = `<span class="parts-item-icon"><i class="fas fa-wrench"></i></span>`;
            }
          } catch(_) { faviconHTML = `<span class="parts-item-icon"><i class="fas fa-wrench"></i></span>`; }
          return `<div class="parts-item">
            ${faviconHTML}
            <div class="parts-item-body">
              <span class="parts-item-text">${esc(p.text||p)}</span>
              ${p.fromUser ? `<span class="parts-item-from">from <b>${esc(p.fromUser)}</b>'s build</span>` : ''}
              ${p.url ? `<a class="parts-item-link" href="${esc(p.url)}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i> View Part</a>` : ''}
            </div>
            <span class="parts-item-date">${timeAgo(p.ts||Date.now())}</span>
            <button class="parts-rm-btn" data-i="${i}" title="Remove"><i class="fas fa-times"></i></button>
          </div>`;
        }).join('') : '<p class="parts-empty"><i class="fas fa-wrench" style="margin-right:6px"></i>No saved parts yet. Browse builds and click the bookmark icon on any part.</p>'}
      </div>
    </div>`;
  el('partsAddBtn')?.addEventListener('click', () => {
    const txt = el('partsInput')?.value.trim(); if(!txt) return;
    const parts2 = JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
    parts2.unshift({ text: txt, ts: Date.now() });
    localStorage.setItem('dl_parts_'+uname, JSON.stringify(parts2));
    renderParts();
  });
  el('partsInput')?.addEventListener('keydown', e => { if(e.key==='Enter') el('partsAddBtn')?.click(); });
  el('partsList')?.querySelectorAll('.parts-rm-btn').forEach(btn => btn.addEventListener('click', () => {
    const parts2 = JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
    parts2.splice(+btn.dataset.i, 1);
    localStorage.setItem('dl_parts_'+uname, JSON.stringify(parts2));
    renderParts();
  }));
}

// ─── PROFILE (own) ────────────────────────────────────────────
async function updateProfilePage() {
  // Wire banner upload button
  const bannerUploadBtn = el('profileBannerUploadBtn');
  const bannerInput     = el('profileBannerInput');
  if (bannerUploadBtn && S.user) {
    bannerUploadBtn.style.display = 'flex';
    bannerUploadBtn.onclick = () => bannerInput?.click();
    if (bannerInput && !bannerInput._bannerWired) {
      bannerInput._bannerWired = true;
      bannerInput.addEventListener('change', async () => {
        const file = bannerInput.files[0]; if (!file) return;
        if (file.size > 5*1024*1024) { toast('Max 5MB for banner','err'); return; }
        bannerUploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        const reader = new FileReader();
        reader.onload = async e => {
          const dataUrl = e.target.result;
          const coverEl = el('profileCover');
          if (coverEl) {
            coverEl.style.backgroundImage = `url(${dataUrl})`;
            coverEl.style.backgroundSize = 'cover';
            coverEl.style.backgroundPosition = 'center';
          }
          localStorage.setItem('dl_banner_'+S.user.username, dataUrl);
          try {
            const res = await DB.uploadBanner(S.user.id, dataUrl);
            if (res?.url) {
              // Save the NEW URL — overwrite any previous
              localStorage.setItem('dl_banner_'+S.user.username, res.url);
              S.user.bannerUrl = res.url;
              localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
              localStorage.setItem('dl_user', JSON.stringify(S.user));
            } else {
              // Supabase upload failed — keep base64 in localStorage as fallback
              localStorage.setItem('dl_banner_'+S.user.username, dataUrl);
            }
          } catch(e) {
            console.warn('Banner upload failed, keeping local:', e);
            localStorage.setItem('dl_banner_'+S.user.username, dataUrl);
          }
          bannerUploadBtn.innerHTML = '<i class="fas fa-camera"></i> Change Cover';
          toast('Cover photo updated!','ok');
          bannerInput.value = '';
        };
        reader.readAsDataURL(file);
      });
    }
  }
  if(!S.user){
    el('noLoginMsg').style.display='block'; el('profilePostsWrap').style.display='none'; el('profileActions').style.display='none';
    el('profileName').textContent='Sign in to view profile'; el('profileBio').textContent=''; el('profileJoined').textContent='';
    el('profileSocials').innerHTML=''; const clStEl=el('profileStats'); if(clStEl) clStEl.innerHTML=''; el('profileAv').textContent='';
    return;
  }
  const u=S.user, posts=S.posts.filter(p=>p.user===u.username), likes=posts.reduce((a,p)=>a+p.likes,0);
  el('noLoginMsg').style.display='none'; el('profilePostsWrap').style.display='block'; el('profileActions').style.display='flex';
  // Apply custom banner
  const savedBanner = localStorage.getItem('dl_banner_'+u.username) || u.bannerUrl || null;
  const coverEl = el('profileCover');
  if (coverEl) {
    if (savedBanner) {
      coverEl.style.backgroundImage = `url(${savedBanner})`;
      coverEl.style.backgroundSize = 'cover';
      coverEl.style.backgroundPosition = 'center';
    } else {
      coverEl.style.backgroundImage = '';
    }
  }
  // Show/hide banner upload button — always show on own profile
  const bannerBtn = el('profileBannerUploadBtn');
  if (bannerBtn) bannerBtn.style.display = 'flex';

  const profUrl = getAvatarUrl(u.username);
  if (profUrl) {
    el('profileAv').innerHTML=`<img src="${profUrl}" alt="${esc(u.username)}" class="av-photo"/>`;
    el('profileAv').style.background='transparent';
  } else {
    el('profileAv').innerHTML=u.username[0].toUpperCase();
    setAvEl(el('profileAv'), u.username);
  }
  el('profileName').textContent=u.username;
  // Awards next to name
  const ownAwardsEl = el('profileAwards');
  if (ownAwardsEl) ownAwardsEl.innerHTML = renderAwards(u, true);
  el('profileBio').textContent=truncateBio(u.bio||'');
  const mAgeInfo=accountAge(u);
  el('profileJoined').innerHTML=`Member since ${u.joined} &nbsp;<span class="acct-age-badge"><i class="fas fa-clock"></i> ${mAgeInfo.full}</span>`;
  el('profileSocials').innerHTML=buildSocialLinks(u);

  // age gate notice
  const notice=el('profileAgeNotice'); if(notice) notice.style.display='none';

  const [ownFollowerCount, ownFollowingCount] = await Promise.all([
    DB.getFollowerCount(S.user.id).catch(() => 0),
    DB.getFollowingCount(S.user.id).catch(() => S.following.length),
  ]);
  const ownStEl=el('profileStats'); if(ownStEl) ownStEl.innerHTML=`<div class="pstat"><span class="pstat-n">${posts.length}</span><span class="pstat-l">Builds</span></div><div class="pstat"><span class="pstat-n">${likes.toLocaleString()}</span><span class="pstat-l">Likes</span></div><div class="pstat clickable" id="profileFollowersStat"><span class="pstat-n">${ownFollowerCount.toLocaleString()}</span><span class="pstat-l">Followers</span></div><div class="pstat clickable" id="profileFollowingStat"><span class="pstat-n">${ownFollowingCount.toLocaleString()}</span><span class="pstat-l">Following</span></div>`;
  el('profileFollowersStat')?.addEventListener('click', () => openFollowList(S.user.id, 'followers'));
  el('profileFollowingStat')?.addEventListener('click', () => openFollowList(S.user.id, 'following'));
  el('followBtn').style.display='none';
  el('profileBuildsLabel').textContent='Your Builds';
  const ownEditBtn = el('editProfileBtn');
  const ownDmBtn   = el('profileDmBtn');
  if (ownEditBtn) ownEditBtn.style.display = 'inline-flex';
  if (ownDmBtn)   ownDmBtn.style.display = 'none';
  // Share button — this render path (own profile via normal nav) never
  // wired this up before, which is why clicking it did nothing.
  const ownShareBtn = el('profileShareBtn');
  if (ownShareBtn) {
    ownShareBtn.style.display = 'inline-flex';
    ownShareBtn.onclick = () => {
      const profileUrl = `${window.location.origin}${window.location.pathname}?user=${encodeURIComponent(u.username)}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(profileUrl).then(() => toast('Profile link copied! 🔗','ok'));
      } else {
        const ta = document.createElement('textarea');
        ta.value = profileUrl; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        toast('Profile link copied! 🔗','ok');
      }
    };
  }
  const grid=el('profileGrid');
  if(posts.length){el('noBuilds').style.display='none';grid.innerHTML=posts.map((p,i)=>cardHTML(p,i)).join('');attachCardEvents(grid);}
  else{grid.innerHTML='';el('noBuilds').style.display='block';}
  // Your Media — social posts
  renderProfileMedia(u.username);
}

// ─── UTILS ────────────────────────────────────────────────────
function el(id)   {return document.getElementById(id);}
function val(id)  {const e=el(id);return e?e.value.trim():'';}
function esc(s)   {const d=document.createElement('div');d.textContent=String(s);return d.innerHTML;}
// formatCount — abbreviates large numbers for compact display on cards
// (1234 -> "1.2k", 15000 -> "15k"). Used for view counts, like counts, etc.
function formatCount(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return (n/1000).toFixed(n % 1000 >= 100 ? 1 : 0).replace(/\.0$/,'') + 'k';
  return (n/1000000).toFixed(1).replace(/\.0$/,'') + 'm';
}
function fmtDate(d){return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}
function timeAgo(ts){const m=Math.floor((Date.now()-ts)/60000);if(m<1)return'just now';if(m<60)return m+'m ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';}

let _toastTimer;
function toast(msg,type=''){
  let t=el('dl-toast');
  if(!t){t=document.createElement('div');t.id='dl-toast';t.className='toast';document.body.appendChild(t);}
  t.textContent=msg; t.className='toast'+(type==='ok'?' ok':type==='err'?' err':'');
  clearTimeout(_toastTimer);
  requestAnimationFrame(()=>{t.classList.add('show');_toastTimer=setTimeout(()=>t.classList.remove('show'),3000);});
}

// ─── AVATAR HELPERS ────────────────────────────────────────────
// Returns the avatar URL for a user if they have one, otherwise null
// In-memory avatar URL cache — populated from localStorage at boot,
// updated on every cacheAvatarUrl() call. No JSON.parse on every lookup.
// avatar cache moved to top of file

// Returns HTML string for an avatar circle — img if custom, letter if not
// size: css class suffix ('sm'=26px, 'md'=36px, 'lg'=48px, null=use inline style)
function renderAvatarHTML(username, extraClass='', extraStyle='', dataUser=true) {
  const url      = getAvatarUrl(username);
  const initial  = (username||'?')[0].toUpperCase();
  const bg       = avColor(username);
  const userAttr = dataUser ? `data-user="${username}"` : '';
  if (url) {
    return `<div class="av-circle ${extraClass} has-photo" ${userAttr} style="${extraStyle}">
      <img src="${url}" alt="${esc(username)}" class="av-photo"/>
    </div>`;
  }
  return `<div class="av-circle ${extraClass}" ${userAttr} style="background:${bg};${extraStyle}">
    ${initial}
  </div>`;
}

// ─── ACCOUNT AGE ──────────────────────────────────────────────
// Returns { years, months, short, full } computed from joinedFull or joined
function accountAge(user) {
  if (!user) return { years:0, months:0, short:'New', full:'Just joined' };
  const joinDate = new Date(user.joinedFull || (user.joined + '-01'));
  const now = new Date();
  let years  = now.getFullYear() - joinDate.getFullYear();
  let months = now.getMonth()    - joinDate.getMonth();
  if (months < 0) { years--; months += 12; }
  if (years < 0)  { years = 0; months = Math.max(0, months); }
  const short = years > 0
    ? `${years}y ${months}mo`
    : months > 0 ? `${months} mo` : 'New';
  const full = years > 0
    ? `${years} year${years!==1?'s':''}, ${months} month${months!==1?'s':''}`
    : months > 0 ? `${months} month${months!==1?'s':''}` : 'Just joined';
  return { years, months, short, full };
}

// ─── CAR DETAIL PAGE (Build Page) ────────────────────────────
// The full build detail page is at id="page-car" in index.html.
// It is NOT a modal — it's a full page rendered via goTo('car').
// This is different from the OLD car modal (initCarModal / openCarModal)
// which is a legacy overlay that may still be used in some places.
//
// The build page has tabs for: Comments | Build Timeline | Build Costs
// Tab switching is handled by switchCpTab(tab).
//
// Gallery: the main image is in #cpGallMain, thumbnails in #cpGallStrip.
// On mobile, left/right arrow buttons are hidden and the user swipes.
// Swipe is detected on #cpGallMain with touchstart/touchend handlers.
// IMPORTANT: The swipe calls el('cpGalNext').click() — note ONE 'l' in
// 'Gal', not 'Gall'. These buttons are rendered by cpRenderGallery().
//
// openCarPage(post) is the correct way to navigate to a build.
// It sets S.openCarPost, calls goTo('car'), then renderCarPage(post).
function initCarPage() {
  el('carPageBack')?.addEventListener('click', () => {
    goTo(S._prevPage || 'home');
  });
  el('cpLike')?.addEventListener('click', () => {
    cpHandleLike();
    const btn = el('cpLike');
    if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); setTimeout(() => btn.classList.remove('pop'), 400); }
  });
  // BOTM vote button — wiring happens in renderCarPage(post) instead,
  // since a real post doesn't exist yet at boot time (this function
  // runs once during DOMContentLoaded, before any build page is open).
  // The old code here read post.id with no post in scope, throwing a
  // ReferenceError on every single page load — and since it ran inside
  // the DOMContentLoaded init loop uncaught, it also silently prevented
  // this listener from ever being wired correctly.
  el('cpSave')?.addEventListener('click', () => {
    cpHandleSave();
    const btn = el('cpSave');
    if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); setTimeout(() => btn.classList.remove('pop'), 400); }
  });
  el('cpShare')?.addEventListener('click', cpHandleShare);
  el('cpSubmitComment')?.addEventListener('click', cpSubmitComment);
  el('cpCommentInput')?.addEventListener('keydown', e => { if(e.key==='Enter') cpSubmitComment(); });
  document.querySelectorAll('.cptab').forEach(t => t.addEventListener('click', () => switchCpTab(t.dataset.cptab)));
}

async function openCarPage(post) {
  S._prevPage   = S.page;
  // Update URL so this build page is shareable
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('post', post.id);
    url.hash = 'car';
    window.history.pushState({ page:'car', post:post.id }, '', url.toString());
  } catch(_) {}
  // Clear stale content from any previously-viewed post BEFORE the page
  // becomes visible, so nothing flashes for a frame (e.g. old category tag)
  if (el('cpCat')) el('cpCat').innerHTML = '';
  if (el('cpTitle')) el('cpTitle').textContent = '';
  if (el('cpGallMain')) el('cpGallMain').innerHTML = '';
  // Show page immediately with cached data. Keep the cached comment COUNT
  // (from the feed's relational query) so the tab/counter shows a real
  // number right away, even though the full comment list isn't loaded yet.
  const cachedCommentCount = (post.comments || []).length;
  const freshPost = { ...post, comments: Array(cachedCommentCount).fill(null) };
  S.openCarPost = freshPost;
  S.openPost    = freshPost;
  goTo('car');
  // Wrapped in try/catch deliberately: renderCarPage() touches many
  // sub-systems (gallery, specs, mods, comments). A single uncaught
  // exception anywhere in that chain used to silently abort everything
  // below this line too — the real Supabase fetch for fresh post data
  // and real comments, the Build Costs tab, and the meta tags — since
  // openCarPage is async and nothing here was catching errors. Now a
  // rendering bug stays contained to rendering; the data fetch always runs.
  try { renderCarPage(freshPost); } catch(e) { console.error('renderCarPage failed:', e); }
  setMetaTags(freshPost.title, freshPost.desc, freshPost.images?.[0]);
  setTimeout(() => addCostTab(freshPost), 50);

  // ── View counter ──────────────────────────────────────────────
  // Fires exactly once per genuine "open a build" action, because
  // openCarPage() itself is only called once per click/navigation —
  // unlike renderCarPage() below, which runs twice within this same
  // call (once with cached data, once with fresh Supabase data) and
  // would double-count if the increment lived there instead.
  // The _lastViewedPostId guard additionally stops a double-increment
  // if something re-triggers openCarPage for the post that's already
  // open (e.g. a stray popstate event), without blocking normal
  // navigation away and back to the same post later.
  if (S._lastViewedPostId !== post.id) {
    S._lastViewedPostId = post.id;
    DB.incrementPostViews(post.id).then(newCount => {
      if (typeof newCount !== 'number') return;
      // Update the open post page and the feed card in place — no
      // full re-render needed, just patch the number in the DOM
      if (S.openCarPost?.id === post.id) S.openCarPost.views = newCount;
      const cached = S.posts.find(p => p.id === post.id);
      if (cached) cached.views = newCount;
      document.querySelectorAll(`.card-views[data-id="${post.id}"]`).forEach(elx => {
        elx.textContent = formatCount(newCount);
      });
    }).catch(() => {});
  }

  const targetPostId = post.id;

  // Fetch the fresh post AND its comments at the same time instead of
  // waiting for one to finish before starting the other — comments used
  // to wait behind the full post refresh, doubling the visible delay.
  const [postResult, commentsResult] = await Promise.allSettled([
    DB.getPost(post.id),
    DB.getComments(targetPostId),
  ]);

  // Apply fresh post data (fixes stale cache issue where make/model/year
  // were missing), but preserve whatever comments we already have so this
  // update never wipes out comments that finished loading first.
  if (postResult.status === 'fulfilled' && postResult.value &&
      S.page === 'car' && S.openCarPost?.id === targetPostId) {
    const updatedPost = { ...dbPostToApp(postResult.value), comments: S.openCarPost.comments };
    S.openCarPost = updatedPost;
    S.openPost    = updatedPost;
    const idx = S.posts.findIndex(p => p.id === updatedPost.id);
    if (idx >= 0) S.posts[idx] = { ...S.posts[idx], ...updatedPost };
    try { renderCarPage(updatedPost); } catch(e) { console.error('renderCarPage failed:', e); }
  } else if (postResult.status === 'rejected') {
    console.warn('Fresh post fetch failed', postResult.reason);
  }

  // Apply comments as soon as they arrive — independent of post refresh timing
  if (commentsResult.status === 'fulfilled' &&
      S.openCarPost?.id === targetPostId && S.page === 'car') {
    const comments = (commentsResult.value || []).map(r => ({
      id:r.id, user:r.username, text:r.text, image:null,
      date:r.created_at, parentId:r.parent_id||null,
      upvotes:r.upvotes||0, upvotedBy:r.upvoted_by||[],
    }));
    S.openCarPost = { ...S.openCarPost, comments };
    cpRenderComments(S.openCarPost);
    bindCommentHandlers(S.openCarPost);
  } else if (commentsResult.status === 'rejected') {
    console.warn('Comments load failed', commentsResult.reason);
  }
}

function renderCarPage(post) {
  if (!post) return;
  // Gallery
  cpRenderGallery(post);
  // BOTM vote button — wired here (not initCarPage) since we need a
  // real post.id, and this function re-runs fresh every time a build
  // page opens so re-wiring the click listener each time is correct.
  const botmBtn = el('cpBotmVote');
  if (botmBtn) {
    botmBtn.dataset.id = post.id;
    renderBotmVoteBtn(post.id);
    botmBtn.onclick = () => castBotmVote(botmBtn.dataset.id);
  }
  // Category badge
  const cfg = catCfg(post.category);
  const cpCats = Array.isArray(post.categories) && post.categories.length ? post.categories : [post.category].filter(Boolean);
  el('cpCat').innerHTML = cpCats.map(c=>`<span class="cat-badge ${catCfg(c).badge}" style="position:static">${c}</span>`).join(' ');
  // Title
  el('cpTitle').textContent = post.title;
  // Poster info
  const usr = S.users.find(u => u.username === post.user) || {};
  el('cpAv').dataset.user = post.user;
  el('cpAv').classList.add('clickable-user');
  setAvEl(el('cpAv'), post.user);
  el('cpPosterName').textContent = post.user;
  el('cpPosterName').dataset.user = post.user;
  el('cpPosterName').className = 'car-page-poster-name clickable-user';
  el('cpPosterDate').textContent = fmtDate(post.date);
  el('cpSocials').innerHTML = [
    usr.instagram ? `<div class="soc-btn-wrap">
      <a class="soc-btn ig" href="https://instagram.com/${usr.instagram}" target="_blank" rel="noopener"><i class="fab fa-instagram"></i></a>
      <button class="soc-save-btn" title="Save to Garage" onclick="saveSocial({platform:'Instagram',handle:'${usr.instagram}',url:'https://instagram.com/${usr.instagram}',fromUser:'${esc(post.user)}'})"><i class="fas fa-bookmark"></i></button>
    </div>` : '',
    usr.tiktok ? `<div class="soc-btn-wrap">
      <a class="soc-btn tt" href="https://tiktok.com/@${usr.tiktok}" target="_blank" rel="noopener"><i class="fab fa-tiktok"></i></a>
      <button class="soc-save-btn" title="Save to Garage" onclick="saveSocial({platform:'TikTok',handle:'${usr.tiktok}',url:'https://tiktok.com/@${usr.tiktok}',fromUser:'${esc(post.user)}'})"><i class="fas fa-bookmark"></i></button>
    </div>` : '',
    usr.youtube ? `<div class="soc-btn-wrap">
      <a class="soc-btn yt" href="https://youtube.com/@${usr.youtube}" target="_blank" rel="noopener"><i class="fab fa-youtube"></i></a>
      <button class="soc-save-btn" title="Save to Garage" onclick="saveSocial({platform:'YouTube',handle:'${usr.youtube}',url:'https://youtube.com/@${usr.youtube}',fromUser:'${esc(post.user)}'})"><i class="fas fa-bookmark"></i></button>
    </div>` : '',
    usr.website ? `<div class="soc-btn-wrap">
      <a class="soc-btn wb" href="${usr.website}" target="_blank" rel="noopener"><i class="fas fa-globe"></i></a>
      <button class="soc-save-btn" title="Save to Garage" onclick="saveSocial({platform:'Website',handle:'${usr.website}',url:'${usr.website}',fromUser:'${esc(post.user)}'})"><i class="fas fa-bookmark"></i></button>
    </div>` : '',
  ].join('');
  // DM button — show if logged in and not own post
  const dmBtn = el('cpDmBtn');
  if (S.user && post.user !== S.user.username) {
    dmBtn.style.display = 'inline-flex';
    dmBtn.onclick = () => openDmWith(post.user);
  } else {
    dmBtn.style.display = 'none';
  }
  // Delete button — show only to post owner
  const deleteBtn = el('cpDelete');
  if (deleteBtn) {
    if (S.user && S.user.username === post.user) {
      deleteBtn.style.display = 'inline-flex';
      deleteBtn.onclick = async () => {
        if (!confirm(`Delete "${post.title}"?\n\nThis cannot be undone.`)) return;
        deleteBtn.disabled = true;
        try { await DB.deletePost(post.id, S.user.id); } catch(e) { console.warn('DB delete failed',e); }
        S.posts = S.posts.filter(p => p.id !== post.id);
        if (S.user) S.user.posts = Math.max(0, (S.user.posts || 1) - 1);
        save();
        renderFeed(); renderSidebar(); renderBOTW(); updateProfilePage();
        toast('Build deleted', 'ok');
        goTo(S._prevPage || 'home');
      };
    } else {
      deleteBtn.style.display = 'none';
    }
  }
  const editBtn = el('cpEditBtn');
  if (editBtn) {
    if (S.user && S.user.username === post.user) {
      editBtn.style.display = 'inline-flex';
      editBtn.onclick = () => openEditPost(post);
    } else {
      editBtn.style.display = 'none';
    }
  }
  // Description — right column, always populate
  const descEl = el('cpDesc');
  if (descEl) {
    if (post.desc && post.desc.trim()) {
      descEl.innerHTML = post.desc.replace(/\n/g,'<br>');
      descEl.style.display = '';
    } else {
      descEl.innerHTML = '';  // CSS :empty handles placeholder
      descEl.style.display = '';
    }
  }
  // Specs table — two column layout (specs left, blank right for future use)
  const cpChipsEl = el('cpChips');
  if (cpChipsEl) {
    const specRows = [
      { icon:'fas fa-calendar-alt', label:'Year',         val: post.year },
      { icon:'fas fa-industry',     label:'Make',         val: post.make },
      { icon:'fas fa-car',          label:'Model',        val: post.model },
      { icon:'fas fa-bolt',         label:'Power',        val: post.hp,           accent:true },
      { icon:'fas fa-cogs',         label:'Transmission', val: post.transmission },
      { icon:'fas fa-road',         label:'Mileage',      val: post.mileage ? Number(post.mileage).toLocaleString()+' mi' : '' },
      { icon:'fas fa-stopwatch',    label:'0–60 mph',     val: post.zeroSixty,    accent:true },
      { icon:'fas fa-flag',         label:'¼ Mile',       val: post.quarterMile,  accent:true },
      { icon:'fas fa-tachometer-alt',label:'Top Speed',   val: post.topSpeed,     accent:true },
      { icon:'fas fa-map-marker-alt',label:'State',       val: post.buildState },
    ].filter(r => r.val && r.val.toString().trim());

    cpChipsEl.innerHTML = `
      <div class="specs-layout">
        <div class="specs-table-wrap">
          <div class="specs-table">
            ${specRows.map(r => `
              <div class="spec-row">
                <div class="spec-label">
                  <i class="fas ${r.icon.replace('fas ','')} spec-icon"></i>
                  ${r.label}
                </div>
                <div class="spec-value${r.accent?' spec-accent':''}">
                  ${esc(r.val.toString())}
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div class="specs-right-panel" id="specsRightPanel">
          <!-- Videos render here via renderCpVideos() -->
        </div>
      </div>`;

    // Always show details section
    const cpDetailsEl = el('cpDetails');
    if (cpDetailsEl) cpDetailsEl.style.display = '';
  }
  // Structured mods — or fall back to legacy string
  const modsEl = el('cpMods');
  const MOD_CATS = [
    { key:'engine',     icon:'fas fa-cog',          label:'Engine'              },
    { key:'drivetrain', icon:'fas fa-circle-notch',   label:'Drivetrain'          },
    { key:'suspension', icon:'fas fa-sliders-h',      label:'Suspension & Brakes' },
    { key:'wheels',     icon:'fas fa-circle',         label:'Wheels & Tires'      },
    { key:'exterior',   icon:'fas fa-paint-brush',    label:'Exterior'            },
    { key:'interior',   icon:'fas fa-couch',          label:'Interior'            },
    { key:'other',      icon:'fas fa-wrench',         label:'Other'               },
  ];
  // Check modsDetail — handle null, empty object, and populated object
  const hasModsDetail = post.modsDetail && typeof post.modsDetail === 'object' &&
    Object.values(post.modsDetail).some(v => Array.isArray(v) ? v.length > 0 : !!(v && v.toString().trim()));
  if (hasModsDetail) {
    const filled = MOD_CATS.filter(c => {
      const v = post.modsDetail[c.key];
      return Array.isArray(v) ? v.length > 0 : !!v;
    });
    modsEl.innerHTML = '<div class="cp-mods-section-label"><i class="fas fa-wrench"></i> Modifications</div><div class="cp-mods-grid">' + filled.map(c => {
      const val = post.modsDetail[c.key];
      const items = Array.isArray(val)
        ? val
        : val.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      const listHTML = items.map(rawItem => {
        // Support both old string and new {text, url} format
        let text, url;
        if (typeof rawItem === 'object' && rawItem !== null) {
          text = rawItem.text || '';
          url  = rawItem.url  || '';
        } else {
          // Try parsing as JSON (stored from new form)
          try { const p = JSON.parse(rawItem); text = p.text||''; url = p.url||''; }
          catch(_) { text = String(rawItem); url = ''; }
        }
        if (!text) return '';
        // Build the link preview
        let thumbHTML = '';
        if (url) {
          try {
            const domain = new URL(url).hostname;
            // Use Google's favicon API for a clean 32px icon — works for any site
            thumbHTML = `<div class="cp-part-thumb">
              <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64"
                   alt="" class="cp-part-favicon" loading="lazy"
                   onerror="this.parentElement.innerHTML='<i class=\\'fas fa-link cp-part-link-icon\\'></i>'"/>
            </div>`;
          } catch(_) { thumbHTML = '<div class="cp-part-thumb-placeholder"><i class="fas fa-link"></i></div>'; }
        }
        // Encode for data attribute
        const encodedPart = encodeURIComponent(JSON.stringify({text, url, fromUser: post.user, fromPostId: post.id}));
        return `<li class="cp-mod-item${url?' has-link':''}">
          ${thumbHTML}
          <div class="cp-mod-item-body">
            <span class="cp-mod-item-text">${esc(text)}</span>
            ${url ? `<a class="cp-mod-item-link" href="${esc(url)}" target="_blank" rel="noopener">
              <i class="fas fa-external-link-alt"></i> View Part
            </a>` : ''}
          </div>
          <button class="cp-save-part-btn" data-part="${esc(encodedPart)}" title="Save part to Garage">
            <i class="fas fa-bookmark"></i>
          </button>
        </li>`;
      }).join('');
      return `<div class="cp-mod-section">
        <div class="cp-mod-head"><span class="cp-mod-icon-wrap"><i class="${c.icon}"></i></span><span class="cp-mod-label">${c.label}</span></div>
        <ul class="cp-mod-list">${listHTML}</ul>
      </div>`;
    }).join('') + '</div>';
  } else if (post.mods) {
    // Legacy plain string — split into bullet list
    const legacyItems = post.mods.split(',').map(s=>s.trim()).filter(Boolean);
    modsEl.innerHTML = `<div class="cp-mods-legacy-list">
      ${legacyItems.map(m=>`<span class="legacy-mod-item">— ${esc(m)}</span>`).join('')}
    </div>`;
  } else {
    modsEl.innerHTML = '';
  }
  // Wire save-part buttons now that mods are rendered
  wirePartSaveButtons(post);

  // Show/hide the details section
  const detailsEl = el('cpDetails');
  if (detailsEl) {
    detailsEl.style.display = '';
  }
  // Like / save state
  syncCpActions(post);
  // Reactions — only in the actions row
  // Videos in specs right panel
  renderCpVideos(post);
  // Compare button
  const cpCmp = el('cpCompare');
  if (cpCmp) cpCmp.onclick = () => { S.compareA = post; goTo('compare'); renderComparePage(); toast('Build loaded for comparison ✓',''); };
  // Comments
  cpRenderComments(post);
  // Timeline
  cpRenderTimeline(post);
  switchCpTab('comments');
}

function cpRenderGallery(post) {
  // Add touch swipe support after rendering
  const gallMain = el('cpGallMain');
  if (gallMain && !gallMain._swipeWired) {
    gallMain._swipeWired = true;
    let _swipeStartX = 0, _swipeStartY = 0, _swipeMoved = false;
    gallMain.addEventListener('touchstart', e => {
      _swipeStartX = e.touches[0].clientX;
      _swipeStartY = e.touches[0].clientY;
      _swipeMoved = false;
    }, { passive: true });
    gallMain.addEventListener('touchmove', e => {
      const dx = Math.abs(e.touches[0].clientX - _swipeStartX);
      const dy = Math.abs(e.touches[0].clientY - _swipeStartY);
      if (dx > 8) _swipeMoved = true; // track that user swiped
    }, { passive: true });
    gallMain.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - _swipeStartX;
      const dy = e.changedTouches[0].clientY - _swipeStartY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 35) {
        // Horizontal swipe — navigate gallery
        if (dx < 0) el('cpGalNext')?.click();
        else el('cpGalPrev')?.click();
      } else if (!_swipeMoved) {
        // Pure tap — open lightbox (the img has pointer-events:none on mobile
        // so we handle the tap here on the parent instead)
        const img = gallMain.querySelector('#cpMainImg');
        if (img) img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }, { passive: true });
  }
  const imgs   = post.images || [];
  const vids   = post.videos || [];
  const mainEl = el('cpGallMain');
  const stripEl = el('cpGallStrip');

  // Build a unified media array: { type:'image'|'video', src }
  const media = [
    ...imgs.map(src => ({ type:'image', src })),
    ...vids.map(src => ({ type:'video', src })),
  ];

  if (!media.length) {
    mainEl.innerHTML = `<div class="gallery-ph" style="background:${phBg(post.id)}"><span>${post.make.toUpperCase()}</span><small>${post.year||''}</small></div>`;
    stripEl.innerHTML = ''; return;
  }

  let curIdx = 0;

  function setMain(idx) {
    curIdx = idx;
    const item = media[idx];
    const navBtns = media.length > 1 ? `
      <button class="gal-nav gal-prev" id="cpGalPrev"><i class="fas fa-chevron-left"></i></button>
      <button class="gal-nav gal-next" id="cpGalNext"><i class="fas fa-chevron-right"></i></button>
      <div class="gal-count">${idx+1} / ${media.length}</div>` : '';

    if (item.type === 'video') {
      // Videos: inline player, no lightbox, preload only metadata
      mainEl.innerHTML = `
        <video id="cpMainVideo" class="gallery-video" controls preload="metadata" playsinline>
          <source src="${item.src}" type="video/mp4"/>
          Your browser does not support video playback.
        </video>
        ${navBtns}`;
    } else {
      mainEl.innerHTML = `
        <img src="${item.src}" alt="${esc(post.title)}" style="cursor:zoom-in" id="cpMainImg" loading="eager"/>
        ${navBtns}`;
      // Single click = lightbox (delayed), double click/tap = like the build
      (function(){
        const mainImg = el('cpMainImg'); if (!mainImg) return;
        let t=null, lastTap=0;
        function likeBuild(){
          const wrapEl = mainImg.closest('.car-page-gallery-main') || mainImg.parentElement;
          if (wrapEl) {
            wrapEl.style.position = wrapEl.style.position || 'relative';
            const h=document.createElement('div');
            h.className='soc-heart-burst';
            h.innerHTML='<i class="fas fa-heart"></i>';
            wrapEl.appendChild(h);
            setTimeout(()=>h.remove(),900);
          }
          if(!S.user){ toast('Sign in to like','err'); el('authModal').classList.add('open'); return; }
          const post = S.openCarPost;
          if (post && !(post.likedBy||[]).includes(S.user.username)) cpHandleLike();
        }
        mainImg.addEventListener('dblclick', e=>{
          e.preventDefault();
          if(t){clearTimeout(t);t=null;}
          likeBuild();
        });
        mainImg.addEventListener('click', ()=>{
          const now=Date.now();
          if(now-lastTap<300){ lastTap=0; if(t){clearTimeout(t);t=null;} likeBuild(); return; }
          lastTap=now;
          if(t)clearTimeout(t);
          t=setTimeout(()=>{t=null;openLightbox(imgs, idx);},260);
        });
      })();
    }

    if (media.length > 1) {
      el('cpGalPrev')?.addEventListener('click', e => { e.stopPropagation(); setMain((idx-1+media.length)%media.length); upStrip(); });
      el('cpGalNext')?.addEventListener('click', e => { e.stopPropagation(); setMain((idx+1)%media.length); upStrip(); });
    }
    upStrip();
  }

  function upStrip() {
    stripEl.querySelectorAll('.strip-thumb-wrap').forEach((t,i) => t.classList.toggle('active', i === curIdx));
  }

  // Build strip — images get thumbnails, videos get a play icon tile
  stripEl.innerHTML = media.map((item, i) => {
    if (item.type === 'video') {
      return `<div class="strip-thumb-wrap video-thumb-wrap${i===0?' active':''}" data-i="${i}">
        <i class="fas fa-play"></i>
      </div>`;
    }
    return `<div class="strip-thumb-wrap${i===0?' active':''}" data-i="${i}">
      <img class="strip-thumb" src="${item.src}" alt="" loading="lazy"/>
    </div>`;
  }).join('');

  stripEl.querySelectorAll('.strip-thumb-wrap').forEach(t => t.addEventListener('click', () => setMain(+t.dataset.i)));
  setMain(0);
}

function syncCpActions(post) {
  // Always read from S.posts (source of truth after save())
  const canonical = S.posts.find(p => p.id === post.id) || post;
  const vid   = S.user?.username || getDeviceId();
  const liked = (canonical.likedBy||[]).includes(vid);
  const saved = !!(S.user && (canonical.savedBy||[]).includes(S.user.username));
  el('cpLike').className = 'act-btn like-btn' + (liked ? ' liked' : '');
  el('cpLikeCount').textContent = canonical.likes;
  el('cpSave').className = 'act-btn save-btn' + (saved ? ' saved' : '');
  el('cpSave').innerHTML = saved ? '<i class="fas fa-bookmark"></i> Saved' : '<i class="fas fa-bookmark"></i> Save';
}

function cpHandleLike() {
  if (!S.user) { toast('Sign in to like', 'err'); el('authModal').classList.add('open'); return; }
  const vid  = S.user.username; // always use username
  const post = S.posts.find(x => x.id === S.openCarPost.id); if (!post) return;
  const idx  = post.likedBy.indexOf(vid);
  if (idx >= 0) { post.likes = Math.max(0,post.likes-1); post.likedBy.splice(idx,1); }
  else {
    post.likes++;
    post.likedBy.push(vid);
    if (post.user !== S.user.username)
      pushNotif('like', S.user.username, `liked your build <b>${post.title}</b>`, 'post:'+post.id);
  }
  S.openCarPost = post;
  syncCpActions(post);
  DB.toggleLike(post.id, vid).catch(()=>{});
  save();
}
function cpHandleSave() {
  if (!S.user) { toast('Sign in to save','err'); return; }
  const post = S.posts.find(x => x.id === S.openCarPost.id); if (!post) return;
  const vid = S.user.username;
  const idx = post.savedBy.indexOf(vid);
  if (idx >= 0) { post.savedBy.splice(idx,1); toast('Removed from garage',''); }
  else { post.savedBy.push(vid); toast('Saved to garage ✓','ok'); }
  S.openCarPost = post;
  syncCpActions(post);
  DB.toggleSave(post.id, vid).catch(()=>{});
  save();
}
function cpHandleShare() {
  const p = S.openCarPost; if (!p) return;
  const url = window.location.href.split('#')[0] + '#car:' + p.id;
  if (navigator.share) navigator.share({title:p.title, url});
  else navigator.clipboard.writeText(url).then(()=>toast('Link copied','ok'));
}

// switchCpTab is defined later in the file — handles comments, timeline, and costs tabs

// ─── CAR PAGE COMMENTS WITH REPLIES + UPVOTES ─────────────────
function cpRenderComments(post) {
  const rawComments = post.comments || [];
  const cc = el('cpCommentCount');
  if (cc) cc.textContent = rawComments.length ? `(${rawComments.length})` : '';
  const count = rawComments.length;
  el('cpCommentCount').textContent = count > 0 ? `(${count})` : '';
  // Update avatar
  const av = el('cpCommentAv');
  if (S.user) setAvEl(av, S.user.username);
  // Show image attach button only if this is the post owner's post
  const imgAttachBtn = el('cpCommentImgBtn');
  const imgInput     = el('cpCommentImgInput');
  const imgPreview   = el('cpCommentImgPreview');
  const isOwner = S.user && post.user === S.user.username;
  if (imgAttachBtn) {
    imgAttachBtn.style.display = isOwner ? 'inline-flex' : 'none';
    if (isOwner && !imgAttachBtn._wired) {
      imgAttachBtn._wired = true;
      imgAttachBtn.addEventListener('click', () => imgInput && imgInput.click());
      if (imgInput) imgInput.addEventListener('change', () => {
        const file = imgInput.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => { if (imgPreview) { imgPreview.src = e.target.result; imgPreview.style.display = 'block'; } };
        reader.readAsDataURL(file);
      });
    }
  }
  if (!rawComments.length) {
    el('cpCommentsList').innerHTML = '<p class="no-comments">No comments yet. Be the first!</p>';
    return;
  }
  // IMPORTANT: post.comments can temporarily contain placeholder `null`
  // entries — openCarPage() fills comments with Array(count).fill(null)
  // so the comment-count badge shows instantly, before the real comment
  // list has loaded from Supabase. Filtering them out here is required:
  // without this, `.filter(c => !c.parentId)` below throws trying to read
  // .parentId off a null entry. That crash was previously UNCAUGHT and
  // synchronous, which — since openCarPage() is async and this call isn't
  // wrapped in try/catch — silently aborted everything after it: the real
  // comments fetch, the fresh post-data refresh, and the Build Costs tab
  // never ran. This one bug was responsible for a lot more than just a
  // blank comments section.
  const comments = rawComments.filter(c => c && typeof c === 'object');
  if (!comments.length) {
    el('cpCommentsList').innerHTML = '<p class="no-comments"><i class="fas fa-spinner fa-spin"></i> Loading comments…</p>';
    return;
  }
  // Top-level comments only (no parentId), sorted by upvotes then date
  const topLevel = comments.filter(c => !c.parentId).sort((a,b) => (b.upvotes||0)-(a.upvotes||0));
  el('cpCommentsList').innerHTML = topLevel.map(c => renderComment(c, comments, 0)).join('');
  // Attach vote + reply handlers
  el('cpCommentsList').querySelectorAll('.cp-comment-upvote').forEach(btn => {
    btn.addEventListener('click', () => cpUpvoteComment(post, btn.dataset.cid));
  });
  el('cpCommentsList').querySelectorAll('.cp-comment-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => cpShowReplyBox(post, btn.dataset.cid));
  });
}

function renderComment(comment, allComments, depth) {
  const replies = allComments.filter(c => c.parentId === comment.id);
  const liked = S.user && (comment.upvotedBy||[]).includes(S.user.username);
  const indent = depth > 0 ? 'style="margin-left:28px;border-left:2px solid var(--border);padding-left:14px;"' : '';
  return `<div class="cp-comment" data-cid="${comment.id}" ${indent}>
    <div class="cp-comment-head">
      ${(()=>{const _cu=getAvatarUrl(comment.user);const _ring=hasActiveSpotStory(comment.user)?' has-story-ring':'';return _cu?`<div class="comment-av av-circle clickable-user has-photo${_ring}" data-user="${comment.user}"><img src="${_cu}" alt="" class="av-photo"/></div>`:`<div class="comment-av av-circle clickable-user${_ring}" data-user="${comment.user}" style="background:${avColor(comment.user)}">${comment.user[0].toUpperCase()}</div>`;})()} 
      <div class="cp-comment-meta">
        <b class="comment-author clickable-user" data-user="${comment.user}">${esc(comment.user)}</b>
        <span class="comment-time">${timeAgo(new Date(comment.date).getTime())}</span>
      </div>
    </div>
    <div class="cp-comment-body">${comment.text?esc(comment.text):''}</div>
    ${comment.image?`<img class="comment-img-thumb" src="${comment.image}" alt="tap to expand" loading="lazy" onclick="this.classList.toggle('expanded')"/>`:''}
    <div class="cp-comment-foot">
      <button class="cp-comment-upvote${liked?' active':''}" data-cid="${comment.id}">
        <i class="fas fa-arrow-up"></i> ${comment.upvotes||0}
      </button>
      ${depth < 2 ? `<button class="cp-comment-reply-btn" data-cid="${comment.id}">Reply</button>` : ''}
    </div>
    <div class="cp-reply-box" id="replyBox-${comment.id}" style="display:none">
      <div class="cp-comment-input-row">
        <input class="finput cp-reply-input" type="text" placeholder="Reply to ${esc(comment.user)}…"/>
        <button class="btn-primary small cp-reply-submit" data-cid="${comment.id}">Post</button>
      </div>
    </div>
    ${replies.length ? `<div class="cp-replies">${replies.map(r=>renderComment(r,allComments,depth+1)).join('')}</div>` : ''}
  </div>`;
}

function cpUpvoteComment(post, commentId) {
  if (!S.user) { toast('Sign in to vote','err'); el('authModal').classList.add('open'); return; }
  // ALWAYS use S.openCarPost — it has the async-loaded comments
  // S.posts[i].comments is often empty (async load goes to openCarPost only)
  const livePost = S.openCarPost?.id === post.id ? S.openCarPost : (S.posts.find(p=>p.id===post.id) || post);
  const comment = livePost.comments?.find(c => c.id === commentId);
  if (!comment) return;
  comment.upvotedBy = comment.upvotedBy || [];
  const vid = S.user.username;
  const idx = comment.upvotedBy.indexOf(vid);
  if (idx >= 0) {
    comment.upvotedBy.splice(idx,1);
    comment.upvotes = Math.max(0,(comment.upvotes||1)-1);
  } else {
    comment.upvotedBy.push(vid);
    comment.upvotes = (comment.upvotes||0)+1;
  }
  // Update openCarPost reference
  S.openCarPost = livePost;
  // Persist to Supabase
  DB.toggleCommentUpvote(commentId, vid).catch(()=>{});
  save();
  cpRenderComments(livePost);
  bindCommentHandlers(livePost);
}

function cpShowReplyBox(post, parentId) {
  // Hide all other open reply boxes
  document.querySelectorAll('.cp-reply-box').forEach(b => { if(b.id !== 'replyBox-'+parentId) b.style.display='none'; });
  const box = el('replyBox-'+parentId);
  if (!box) return;
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
  if (box.style.display === 'block') {
    const input = box.querySelector('.cp-reply-input');
    if (input) { input.focus(); }
    const submitBtn = box.querySelector('.cp-reply-submit');
    if (submitBtn) {
      submitBtn.onclick = () => {
        if (!S.user) { toast('Sign in to reply','err'); return; }
        if (!canInteract()) { toast(gateMsg(),'err'); return; }
        const txt = input.value.trim(); if (!txt) return;
        post.comments.push({ id:'c'+Date.now(), user:S.user.username, text:txt, date:new Date().toISOString(), parentId, upvotes:0, upvotedBy:[] });
        save(); cpRenderComments(post); bindCommentHandlers(post);
        toast('Reply posted','ok');
      };
    }
  }
}

function bindCommentHandlers(post) {
  // Always use S.openCarPost which has current comments loaded from Supabase
  const livePost = S.openCarPost?.id === post.id ? S.openCarPost : post;
  el('cpCommentsList').querySelectorAll('.cp-comment-upvote').forEach(btn =>
    btn.addEventListener('click', () => cpUpvoteComment(livePost, btn.dataset.cid))
  );
  el('cpCommentsList').querySelectorAll('.cp-comment-reply-btn').forEach(btn =>
    btn.addEventListener('click', () => cpShowReplyBox(post, btn.dataset.cid))
  );
  el('cpCommentsList').querySelectorAll('.cp-comment-report-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const c = post.comments.find(x=>x.id===btn.dataset.cid);
      openReport('comment', btn.dataset.cid, c?.text||'');
    })
  );
}

function cpSubmitComment() {
  if (!S.user) { toast('Sign in to comment','err'); el('authModal').classList.add('open'); return; }
  // Validate the current session is real — prevents ghost comments from old sessions
  if (!S.user.username) { toast('Please sign in again','err'); return; }
  const txt = el('cpCommentInput').value.trim();
  const imgInput = el('cpCommentImgInput');
  const imgFile  = imgInput && imgInput.files[0];
  if (!txt && !imgFile) return;
  // Use S.openCarPost which has comments loaded from Supabase
  const post = S.openCarPost; if (!post) return;

  async function addComment(imageUrl) {
    const tempId = 'c'+Date.now();
    const newComment = {
      id:tempId, user:S.user.username, text:txt,
      image:imageUrl||null, date:new Date().toISOString(),
      parentId:null, upvotes:0, upvotedBy:[]
    };
    post.comments.push(newComment);
    el('cpCommentInput').value = '';
    if (imgInput) imgInput.value = '';
    const preview = el('cpCommentImgPreview');
    if (preview) { preview.src=''; preview.style.display='none'; }
    S.openCarPost = post;
    cpRenderComments(post); bindCommentHandlers(post);
    const cc = el('cpCommentCount');
    if (cc) cc.textContent = `(${post.comments.length})`;
    // Save to Supabase
    try {
      const { data } = await DB.addComment(post.id, S.user.id, S.user.username, txt, null);
      if (data) {
        const idx = post.comments.findIndex(c=>c.id===tempId);
        if (idx>=0) post.comments[idx].id = data.id;
      }
    } catch(e) { console.warn('Comment save failed',e); }
    if (post.user !== S.user.username) {
      const postOwner = S.users.find(u=>u.username===post.user);
      pushNotif('comment', S.user.username, `commented on <b>${post.title}</b>`, 'post:'+post.id, postOwner?.id);
    }
    save();
  }

  if (imgFile) {
    // Compress comment image before storing
    compressImage(imgFile, 800, 0.78).then(url => addComment(url));
  } else {
    addComment(null);
  }
}

// ─── CAR PAGE — VIDEOS in specs right panel ───────────────────
function renderCpVideos(post) {
  const panel = el('specsRightPanel'); if (!panel) return;
  const videos = post.videos || [];
  panel.style.display = 'flex';
  if (!videos.length) {
    panel.innerHTML = `<div class="cp-videos-label"><i class="fas fa-video"></i> Videos</div>
      <p class="cp-videos-none">No videos uploaded for this build.</p>`;
    return;
  }
  panel.innerHTML = `
    <div class="cp-videos-label"><i class="fas fa-video"></i> Videos</div>
    <div class="cp-videos-grid">
      ${videos.map((src, i) => `
        <div class="cp-video-thumb" data-src="${esc(src)}" data-i="${i}">
          <video class="cp-video-preview" src="${esc(src)}" muted preload="metadata" playsinline></video>
          <div class="cp-video-play"><i class="fas fa-play"></i></div>
        </div>`).join('')}
    </div>`;

  // Seek each preview to 10% for a good thumbnail frame
  panel.querySelectorAll('.cp-video-preview').forEach(v => {
    v.addEventListener('loadedmetadata', () => { v.currentTime = v.duration * 0.1; });
  });

  // Click to play/pause inline — video plays right in the thumbnail
  panel.querySelectorAll('.cp-video-thumb').forEach(thumb => {
    const preview = thumb.querySelector('.cp-video-preview');
    const playIcon = thumb.querySelector('.cp-video-play');
    thumb.addEventListener('click', () => {
      if (!preview) return;
      // Toggle controls and play
      preview.controls = true;
      preview.style.cursor = 'default';
      if (preview.paused) {
        // Pause all other videos first
        panel.querySelectorAll('.cp-video-preview').forEach(v => {
          if (v !== preview) { v.pause(); v.controls = false; }
        });
        preview.play();
        if (playIcon) playIcon.style.display = 'none';
      } else {
        preview.pause();
        if (playIcon) playIcon.style.display = 'flex';
      }
    });
    preview?.addEventListener('pause', () => { if (playIcon) playIcon.style.display = 'flex'; });
    preview?.addEventListener('play',  () => { if (playIcon) playIcon.style.display = 'none'; });
    preview?.addEventListener('ended', () => { if (playIcon) playIcon.style.display = 'flex'; preview.controls = false; });
  });
}

function cpRenderTimeline(post) {
  const all = [...(SEED_TIMELINES[post.id]||[]), ...JSON.parse(localStorage.getItem('dl_tl_'+post.id)||'[]')];
  const wrap = el('cpTimelineContent');
  const isOwner = S.user && post.user === S.user.username;
  wrap.innerHTML = `
    ${all.length ? `<div class="timeline">${all.map((e,i)=>`
      <div class="tl-item${i===all.length-1?' last':''}">
        <div class="tl-left"><div class="tl-dot" style="background:${e.color||'#a855f7'}"><i class="${e.icon||'fas fa-circle'}" style="font-size:.5rem"></i></div>${i<all.length-1?'<div class="tl-line"></div>':''}</div>
        <div class="tl-right">
          <div class="tl-date">${e.date}</div>
          <div class="tl-title">${esc(e.title)}</div>
          <p class="tl-body">${esc(e.body)}</p>
        </div>
      </div>`).join('')}</div>` : '<p class="no-timeline"><i class="fas fa-history" style="margin-right:6px"></i>No build timeline yet.</p>'}
    ${isOwner ? `
    <div class="tl-add-form" id="tlAddForm">
      <div class="tl-add-row">
        <input class="finput tl-input" id="tlTitle" placeholder="Update title (e.g. Turbo installed)" style="margin-bottom:8px"/>
        <textarea class="finput tl-input" id="tlBody" rows="2" placeholder="What happened? Describe the update…" style="resize:none;margin-bottom:8px"></textarea>
        <button class="btn-primary small" id="cpAddTlBtn"><i class="fas fa-plus"></i> Add Update</button>
      </div>
    </div>` : ''}`;
  const btn = el('cpAddTlBtn');
  if (btn) btn.addEventListener('click', () => {
    const title = el('tlTitle')?.value.trim(); if(!title) { toast('Add a title','err'); return; }
    const body  = el('tlBody')?.value.trim();  if(!body)  { toast('Add a description','err'); return; }
    const stored = JSON.parse(localStorage.getItem('dl_tl_'+post.id)||'[]');
    stored.push({date:new Date().toISOString().slice(0,10),title,body,icon:'fas fa-plus',color:'#a855f7'});
    localStorage.setItem('dl_tl_'+post.id, JSON.stringify(stored));
    // Save to Supabase
    DB.addTimelineEntry(post.id, title, body, new Date().toISOString().slice(0,10), 'fas fa-plus', '#a855f7').catch(()=>{});
    cpRenderTimeline(post);
    toast('Timeline updated ✓','ok');
  });
}

// ─── DIRECT MESSAGES ──────────────────────────────────────────
// DMs are stored in two places:
//   1. localStorage (dl_dm_*): immediate, works offline, persists
//      across sessions on the same device
//   2. Supabase messages table: cross-device sync, realtime delivery
//
// The localStorage key for a conversation is always sorted so that
// the same key is used regardless of who sent the first message:
//   dl_dm_alice_bob (not dl_dm_bob_alice)
//
// When a realtime message arrives via setupRealtimeSubscriptions(),
// it's written to localStorage AND rendered in the open conversation
// if the user is currently looking at that thread.
//
// On mobile: the conversation list and chat panel are separate
// "screens". msg-list-col.msg-hide-list hides the list to show
// the chat, and #msgBackBtn returns to the list.
function dmKey(user1, user2) {
  // Canonical key: alphabetically sorted so both users share same thread
  return [user1, user2].sort().join('::');
}

function loadDmThread(otherUser) {
  // DMs stored per-user in localStorage as { "user1::user2": [{from,text,ts},...] }
  const key = 'dl_dm_' + dmKey(S.user.username, otherUser);
  return JSON.parse(localStorage.getItem(key) || '[]');
}

function saveDmThread(otherUser, messages) {
  const key = 'dl_dm_' + dmKey(S.user.username, otherUser);
  localStorage.setItem(key, JSON.stringify(messages));
}

function getAllDmConversations() {
  if (!S.user) return [];
  // Scan localStorage for all DM threads involving this user
  const convs = [];
  const prefix = 'dl_dm_';
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k.startsWith(prefix)) continue;
    const pair = k.slice(prefix.length);
    const [u1, u2] = pair.split('::');
    if (u1 !== S.user.username && u2 !== S.user.username) continue;
    const other = u1 === S.user.username ? u2 : u1;
    const msgs = JSON.parse(localStorage.getItem(k) || '[]');
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const unread = msgs.filter(m => m.from !== S.user.username && !m.read).length;
    convs.push({ other, last, unread, msgs });
  }
  convs.sort((a,b) => b.last.ts - a.last.ts);
  return convs;
}

function updateDmBadge() {
  if (!S.user) { hideEl('navDmBadge'); hideEl('mobDmBadge'); hideEl('mobTabDmBadge'); return; }
  const total = getAllDmConversations().reduce((a,c)=>a+c.unread,0);
  ['navDmBadge','mobDmBadge','mobTabDmBadge'].forEach(id => {
    const b = el(id); if(!b) return;
    if (total > 0) { b.textContent = total > 9 ? '9+' : total; b.style.display='inline-flex'; }
    else b.style.display = 'none';
  });
}
function hideEl(id) { const e=el(id); if(e) e.style.display='none'; }

function initMessages() {
  el('newDmBtn')?.addEventListener('click', openNewDm);
  el('msgNewClose')?.addEventListener('click', () => el('msgNewModal').style.display='none');
  el('msgSendBtn')?.addEventListener('click', sendDmMessage);
  el('msgInput')?.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey) sendDmMessage(); });
  // Image attach
  const attachBtn = el('msgAttachBtn');
  const fileInput = el('msgFileInput');
  const imgPreviewRow = el('msgImgPreviewRow');
  const imgPreview    = el('msgImgPreview');
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', ()=>fileInput.click());
    fileInput.addEventListener('change', ()=>{
      const file = fileInput.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = e2 => {
        imgPreview.src = e2.target.result;
        imgPreviewRow.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    });
    el('msgImgRemove')?.addEventListener('click', ()=>{
      fileInput.value=''; imgPreview.src=''; imgPreviewRow.style.display='none';
    });
  }
  el('msgBackBtn')?.addEventListener('click', () => {
    el('msgChatWrap').style.display='none';
    el('msgNoneSelected').style.display='flex';
    el('msgChatCol') && el('msgChatCol').classList.remove('active');
    S.openDm = null;
    el('msgListCol').classList.remove('msg-hide-list');
  });
  el('msgSearch')?.addEventListener('input', renderMessages);
  el('msgNewSearch')?.addEventListener('input', renderNewDmSearch);
  el('msgViewProfileBtn')?.addEventListener('click', () => {
    if (!S.openDm) return;
    // View the OTHER person's profile, not our own
    if (S.user && S.openDm === S.user.username) { goTo('profile'); return; }
    viewMemberProfile(S.openDm);
    el('notifDrop') && el('notifDrop').classList.remove('open');
  });
}

async function renderMessages() {
  if (!S.user) {
    el('msgConvList').innerHTML = '<div class="msg-empty"><i class="fas fa-lock"></i><p>Sign in to view messages</p></div>';
    return;
  }
  // Merge local threads with Supabase conversations
  if (_sbOk() && S.user.id) {
    try {
      const sbConvs = await DB.getConversations(S.user.id);
      sbConvs.forEach(c => {
        if (!c.otherName) return;
        const local = loadDmThread(c.otherName);
        const sbMsg = {
          from: c.lastMsg.from_user_id === S.user.id ? S.user.username : c.otherName,
          text: c.lastMsg.text || '',
          ts:   new Date(c.lastMsg.created_at).getTime(),
          read: !!c.lastMsg.read,
        };
        // Add to local if not already there
        if (!local.find(m => Math.abs(m.ts - sbMsg.ts) < 3000 && m.from === sbMsg.from))
          local.push(sbMsg);
        local.sort((a,b) => a.ts - b.ts);
        saveDmThread(c.otherName, local);
      });
    } catch(_) {}
  }
  const q = (el('msgSearch')?.value||'').toLowerCase();
  const convs = getAllDmConversations().filter(c => !q || c.other.toLowerCase().includes(q));
  if (!convs.length) {
    el('msgConvList').innerHTML = '<div class="msg-empty"><i class="fas fa-envelope-open"></i><p>No conversations yet.<br><small>Start one by clicking + New Message</small></p></div>';
    return;
  }
  el('msgConvList').innerHTML = convs.map(c => {
    const preview = (c.last.text||'').length > 40 ? c.last.text.slice(0,40)+'…' : (c.last.text||'📷 Image');
    const isMe = c.last.from === S.user.username;
    return `<div class="msg-conv-item${S.openDm===c.other?' active':''}${c.unread?' unread':''}" data-user="${esc(c.other)}">
      ${renderAv(c.other, 42, 'msg-conv-av')}
      <div class="msg-conv-info">
        <div class="msg-conv-name">${esc(c.other)}${c.unread?`<span class="msg-unread-dot">${c.unread}</span>`:''}</div>
        <div class="msg-conv-preview">${isMe?'You: ':''}${esc(preview)}</div>
      </div>
      <div class="msg-conv-time">${timeAgo(c.last.ts)}</div>
    </div>`;
  }).join('');
  el('msgConvList').querySelectorAll('.msg-conv-item').forEach(item =>
    item.addEventListener('click', () => openDmWith(item.dataset.user))
  );
  updateDmBadge();
}

async function openDmWith(username) {
  if (!S.user) { toast('Sign in to send messages','err'); return; }
  if (S.blockedUsers.includes(username)) { toast('You have blocked this user','err'); return; }
  const otherUserForBlockCheck = S.users.find(u => u.username === username);
  if (otherUserForBlockCheck?.id && S.user?.id) {
    const blocked = await DB.isBlockedEitherWay(S.user.id, otherUserForBlockCheck.id).catch(() => false);
    if (blocked) { toast('You can\'t message this user','err'); return; }
  }
  S.openDm = username;
  // Mark all messages from this user as read locally
  const msgs = loadDmThread(username);
  msgs.forEach(m => { if(m.from !== S.user.username) m.read = true; });
  saveDmThread(username, msgs);
  updateDmBadge();
  // Show chat window, handle mobile layout
  const msgNone = el('msgNoneSelected');
  const chatWrap = el('msgChatWrap');
  const chatCol = el('msgChatCol');
  const listCol = el('msgListCol');
  if (msgNone) msgNone.style.display = 'none';
  if (chatWrap) chatWrap.style.display = 'flex';
  // Mobile: hide list, show chat
  if (window.innerWidth <= 768) {
    if (listCol) listCol.classList.add('msg-hide-list');
    if (chatCol) chatCol.classList.add('active');
    // Show back button
    const backBtn = el('msgBackBtn');
    if (backBtn) backBtn.style.display = 'flex';
  }
  const _mcu = getAvatarUrl(username);
  setAvEl(el('msgChatAv'), username);
  el('msgChatName').textContent = username;
  const otherUser = S.users.find(u => u.username === username);
  const age = otherUser ? accountAge(otherUser) : null;
  el('msgChatStatus').textContent = age ? `Member · ${age.short}` : 'Member';
  el('msgListCol').classList.add('msg-hide-list');
  el('msgChatCol') && el('msgChatCol').classList.add('active');
  renderDmMessages(username);
  renderMessages();
  if (S.page !== 'messages') goTo('messages');
  // Load fresh messages from Supabase
  if (otherUser?.id && S.user?.id) {
    try {
      const rows = await DB.getMessages(S.user.id, otherUser.id);
      if (rows.length) {
        const sbMsgs = rows.map(r => ({
          from:  r.from_user_id === S.user.id ? S.user.username : username,
          text:  r.text || '',
          image: r.image_url || null,
          ts:    new Date(r.created_at).getTime(),
          read:  r.read,
        }));
        // Merge with local — keep unique by sender+timestamp proximity
        const local = loadDmThread(username);
        sbMsgs.forEach(sm => {
          if (!local.find(m => Math.abs(m.ts - sm.ts) < 3000 && m.from === sm.from && m.text === sm.text))
            local.push(sm);
        });
        local.sort((a,b) => a.ts - b.ts);
        saveDmThread(username, local);
        if (S.openDm === username) renderDmMessages(username);
      }
      DB.markMessagesRead(S.user.id, otherUser.id).catch(()=>{});
    } catch(e) { console.warn('DM load failed', e); }
  }
}

function renderDmMessages(username) {
  const msgs = loadDmThread(username);
  const body = el('msgChatBody');
  if (!msgs.length) {
    body.innerHTML = `<div class="msg-day-divider">Start of your conversation with <b>${esc(username)}</b></div>`;
    return;
  }
  // Group messages by day
  let lastDay = '';
  body.innerHTML = msgs.map((m, i) => {
    const mine   = m.from === S.user.username;
    const msgDay = new Date(m.ts).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'});
    const dayDiv = msgDay !== lastDay ? `<div class="msg-day-divider">${msgDay}</div>` : '';
    lastDay      = msgDay;
    // Show sender name on first message in a group (incoming only)
    const prevMsg = msgs[i-1];
    const showName = !mine && (!prevMsg || prevMsg.from !== m.from || prevMsg.ts < m.ts - 120000);
    const avUrl  = getAvatarUrl(m.from);
    const avHTML = renderAv(m.from, 28, 'msg-bubble-av');
    const imgHTML = m.image
      ? `<img src="${m.image}" class="msg-bubble-img" alt="image" onclick="this.classList.toggle('expanded')" loading="lazy"/>`
      : '';
    const textHTML = m.text ? `<div class="msg-bubble-text">${esc(m.text)}</div>` : '';
    return `${dayDiv}
      <div class="msg-bubble-row${mine?' mine':''}">
        ${!mine ? avHTML : ''}
        <div class="msg-bubble-group">
          ${showName ? `<div class="msg-bubble-sender">${esc(m.from)}</div>` : ''}
          <div class="msg-bubble${mine?' mine':''}${m.image?' has-img':''}">
            ${imgHTML}${textHTML}
            <span class="msg-bubble-time">${timeAgo(m.ts)}${mine&&m.read?' <i class="fas fa-check-double msg-read-icon"></i>':''}</span>
          </div>
        </div>
      </div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}

async function sendDmMessage() {
  if (!S.user) { toast('Sign in to send messages','err'); return; }
  if (!S.openDm) return;
  if (S.blockedUsers.includes(S.openDm)) { toast('You have blocked this user','err'); return; }
  const txt      = el('msgInput').value.trim();
  const fileInput= el('msgFileInput');
  const imgFile  = fileInput?.files[0];
  if (!txt && !imgFile) return;
  // Compress image if attached
  let imageData = null;
  if (imgFile) {
    imageData = await compressImage(imgFile, 800, 0.82);
    fileInput.value = '';
    el('msgImgPreview').src = '';
    el('msgImgPreviewRow').style.display = 'none';
  }
  const msgs = loadDmThread(S.openDm);
  msgs.push({ from:S.user.username, text:txt, image:imageData||null, ts:Date.now(), read:false });
  saveDmThread(S.openDm, msgs);
  el('msgInput').value = '';
  // Supabase
  const otherUser = S.users.find(u=>u.username===S.openDm);
  if (txt) {
    if (otherUser?.id) {
      DB.sendMessage(S.user.id, otherUser.id, S.user.username, S.openDm, txt).catch(e => {
        console.warn('Message send failed:', e);
        toast('Message sent locally — will sync when online','');
      });
    } else {
      // Fetch user ID from Supabase then send
      DB.getProfileByUsername(S.openDm).then(profile => {
        if (profile?.id) {
          DB.sendMessage(S.user.id, profile.id, S.user.username, S.openDm, txt).catch(()=>{});
          // Cache for future sends
          const u = dbUserToApp(profile);
          if (!S.users.find(x=>x.username===u.username)) S.users.push(u);
        }
      }).catch(()=>{});
    }
  }
  renderDmMessages(S.openDm);
  renderMessages();
  // Push notification to RECIPIENT only — never to self
  const notifTxt = txt || '📷 Image';
  const otherU = S.users.find(u=>u.username===S.openDm);
  if (otherU?.id && otherU.id !== S.user.id) {
    // Send server-side notification to recipient (they'll get it via realtime)
    DB.pushNotification(otherU.id, 'message', S.user.username,
      `sent you a message: "${notifTxt.length>40?notifTxt.slice(0,40)+'…':notifTxt}"`,
      'page:messages'
    ).catch(()=>{});
  }
}

function openNewDm() {
  if (!S.user) { toast('Sign in to send messages','err'); return; }
  el('msgNewModal').style.display = 'flex';
  el('msgNewSearch').value = '';
  renderNewDmSearch();
  el('msgNewSearch').focus();
}

function renderNewDmSearch() {
  const q = (el('msgNewSearch').value||'').toLowerCase();
  const members = S.users
    .filter(u => u.username !== S.user.username && (!q || u.username.toLowerCase().includes(q) || (u.bio||'').toLowerCase().includes(q)))
    .slice(0, 12);
  el('msgNewResults').innerHTML = members.length
    ? members.map(u => `
      <div class="msg-new-result" data-user="${u.username}">
        <div class="msg-conv-av" style="background:#6b7280">${u.username[0].toUpperCase()}</div>
        <div><div class="msg-conv-name">${esc(u.username)}</div><div class="msg-conv-preview">${u.bio?(u.bio.length>40?u.bio.slice(0,40)+'…':u.bio):'DriveLog member'}</div></div>
      </div>`).join('')
    : '<p class="msg-empty-sm">No members found</p>';
  el('msgNewResults').querySelectorAll('.msg-new-result').forEach(r => {
    r.addEventListener('click', () => {
      el('msgNewModal').style.display = 'none';
      openDmWith(r.dataset.user);
    });
  });
}

// Override cardHTML clicks to go to car page instead of modal
// (done by replacing attachCardEvents openCarModal call with openCarPage)

// ═══════════════════════════════════════════════════════════════
// ─── REACTIONS ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const REACTION_TYPES = [
  { key:'fire',  icon:'fas fa-fire',         label:'Fire',  color:'#f0a030' },
  { key:'clean', icon:'fas fa-check-circle', label:'Clean', color:'#22c55e' },
  { key:'wow',   icon:'fas fa-bolt',          label:'Wow',   color:'#3b82f6' },
  { key:'laugh', icon:'fas fa-laugh-squint',   label:'Laugh', color:'#a855f7' },
];

// Device fingerprint — used to rate-limit guest likes/reactions
function getDeviceId() {
  let did = localStorage.getItem('dl_device_id');
  if (!did) {
    did = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('dl_device_id', did);
  }
  return did;
}

// Returns the "voter ID" — username if logged in, deviceId if guest
function voterId() {
  return S.user ? S.user.username : getDeviceId();
}

function initReactions() {
  // Report button in old car modal (if still used)
  const rb = el('carReport');
  if (rb) rb.addEventListener('click', () => openReport('post', S.openPost?.id));
}

function renderReactions(post, containerId) {
  const container = el(containerId);
  if (!container || !post) return;
  const reactions = post.reactions || {};
  container.innerHTML = REACTION_TYPES.map(r => {
    const count = (reactions[r.key] || []).length;
    const reacted = (reactions[r.key] || []).includes(voterId());
    return `<button class="reaction-btn${reacted?' reacted':''}" data-pid="${post.id}" data-rkey="${r.key}" title="${r.label}">
      <span class="reaction-icon-wrap" style="background:${r.color}18;border-color:${r.color}30"><i class="${r.icon}" style="color:${reacted?r.color:'var(--muted)'}"></i></span>
      <span class="reaction-label">${r.label}</span>
      ${count > 0 ? `<span class="reaction-count">${count}</span>` : ''}
    </button>`;
  }).join('');
  container.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleReaction(post, btn.dataset.rkey, containerId));
  });
}

function toggleReaction(post, rkey, containerId) {
  if (!S.user) { toast('Sign in to react','err'); return; }
  const vid = S.user.username; // always use username for consistency
  const realPost = S.posts.find(p => p.id === post.id);
  if (!realPost) return;
  if (!realPost.reactions) realPost.reactions = {};
  if (!realPost.reactions[rkey]) realPost.reactions[rkey] = [];
  const idx = realPost.reactions[rkey].indexOf(vid);
  const added = idx < 0;
  if (!added) {
    realPost.reactions[rkey].splice(idx, 1);
  } else {
    REACTION_TYPES.forEach(r => {
      if (r.key === rkey || !realPost.reactions[r.key]) return;
      const oi = realPost.reactions[r.key].indexOf(vid);
      if (oi >= 0) realPost.reactions[r.key].splice(oi, 1);
    });
    realPost.reactions[rkey].push(vid);
    if (realPost.user !== S.user.username) {
      const r = REACTION_TYPES.find(x=>x.key===rkey);
      const postOwner = S.users.find(u=>u.username===realPost.user);
      pushNotif('reaction', S.user.username, `reacted ${r.label} to your build <b>${realPost.title}</b>`, 'post:'+realPost.id, postOwner?.id);
    }
  }
  S.openCarPost = realPost;
  // Persist to Supabase
  DB.toggleReaction(post.id, vid, rkey).catch(()=>{});
  save();
  renderReactions(realPost, containerId);
}

// ═══════════════════════════════════════════════════════════════
// ─── REPORT SYSTEM ─────────────────────────────────════════════
// ═══════════════════════════════════════════════════════════════
let _reportTarget = { type: null, id: null };

// ─── FOLLOWERS / FOLLOWING LIST ─────────────────────────────────
function initFollowListModal() {
  el('followListClose')?.addEventListener('click', closeFollowList);
  el('followListModal')?.addEventListener('click', e => { if (e.target === el('followListModal')) closeFollowList(); });
}
function closeFollowList() {
  el('followListModal')?.classList.remove('open');
  document.body.style.overflow = '';
}
async function openFollowList(userId, type) {
  const modal = el('followListModal');
  const body = el('followListBody');
  const title = el('followListTitle');
  if (!modal || !body) return;
  title.textContent = type === 'followers' ? 'Followers' : 'Following';
  body.innerHTML = '<div class="follow-list-empty"><i class="fas fa-spinner fa-spin"></i><br>Loading…</div>';
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  const list = type === 'followers'
    ? await DB.getFollowersList(userId).catch(() => [])
    : await DB.getFollowingList(userId).catch(() => []);

  if (!list.length) {
    body.innerHTML = `<div class="follow-list-empty"><i class="fas fa-user-friends"></i>${type === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</div>`;
    return;
  }
  body.innerHTML = list.map(u => `
    <div class="follow-list-item" data-user="${esc(u.username)}">
      ${u.avatarUrl
        ? `<img src="${u.avatarUrl}" class="follow-list-av" alt=""/>`
        : `<div class="follow-list-av" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>`}
      <div class="follow-list-info"><div class="follow-list-name">${esc(u.username)}</div></div>
    </div>`).join('');
  body.querySelectorAll('.follow-list-item').forEach(item => {
    item.addEventListener('click', () => { closeFollowList(); viewPublicProfile(item.dataset.user); });
  });
}

function initReport() {
  const closeBtn = el('reportClose');
  const submitBtn = el('submitReport');
  const overlay = el('reportModal');
  if (!closeBtn || !submitBtn) return;
  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  submitBtn.addEventListener('click', submitReport);
  // Wire car page report buttons
  const cpRep = el('cpReport');
  if (cpRep) cpRep.addEventListener('click', () => openReport('post', S.openCarPost?.id));
}

function openReport(type, id, context) {
  if (!S.user) { toast('Sign in to report content', 'err'); return; }
  if (!id) return;
  _reportTarget = { type, id, context: context || '' };
  el('reportModal').classList.add('open');
  document.querySelectorAll('input[name="reportReason"]').forEach(r => r.checked = false);
  if (el('reportDetails')) el('reportDetails').value = '';
  // Show what's being reported
  const lbl = el('reportTargetLabel');
  if (lbl) {
    const typeLabels = { post:'Build', comment:'Comment', user:'Account', social:'Social Post' };
    lbl.textContent  = `Reporting: ${typeLabels[type]||type}${context?' — "'+context.slice(0,40)+(context.length>40?'…':'')+'"':''}`;
  }
}

function submitReport() {
  const reason = document.querySelector('input[name="reportReason"]:checked')?.value;
  if (!reason) { toast('Please select a reason', 'err'); return; }
  const details = el('reportDetails')?.value.trim() || '';
  const reports = JSON.parse(localStorage.getItem('dl_reports') || '[]');
  reports.push({
    id: 'r' + Date.now(),
    type: _reportTarget.type,
    targetId: _reportTarget.id,
    context: _reportTarget.context || '',
    reporter: S.user.username,
    reason, details,
    ts: Date.now(),
    status: 'pending',
  });
  localStorage.setItem('dl_reports', JSON.stringify(reports));
  // Save to Supabase
  DB.submitReport(S.user.id, S.user.username, _reportTarget.type, _reportTarget.id, reason, details).catch(e => console.warn('Report sync', e));
  // Notify all admins immediately
  S.users.filter(u => u.isAdmin && u.id).forEach(admin => {
    DB.pushNotification(
      admin.id, 'report', S.user.username,
      `⚠️ reported ${_reportTarget.type} "${_reportTarget.context||_reportTarget.id}" — Reason: ${reason}`,
      'admin'
    ).catch(()=>{});
  });
  el('reportModal').classList.remove('open');
  toast('Report submitted — thank you 🙏', 'ok');
}

// ═══════════════════════════════════════════════════════════════
// ─── BADGES & REPUTATION ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// ─── AWARDS SYSTEM ─────────────────────────────────────────────
// Awards are granted by admins only. Definitions in data.js (AWARDS_DEF).

function grantAward(username, awardId) {
  // Update in S.users
  const u = S.users.find(x => x.username === username);
  if (!u) { toast('User not found', 'err'); return; }
  u.awards = u.awards || [];
  if (u.awards.includes(awardId)) { toast('Already has this award', 'err'); return; }
  u.awards.push(awardId);
  // If this is the logged-in user, update S.user too so profile re-renders correctly
  if (S.user && S.user.username === username) {
    S.user.awards = [...u.awards];
  }
  const def = getAwardDef(awardId);
  if (def) { toast(`${def.label} granted to ${username}`, 'ok'); pushNotif('award','DriveLog',`You received the <b>${def.label}</b> award!`,'page:profile'); }
  save();
  renderAdminUsers();
  // Refresh profile page if it's currently showing this user
  if (S.page === 'profile') updateProfilePage();
}

async function toggleFeaturedUser(username) {
  let u = S.users.find(x=>x.username===username);
  if (!u) {
    // Fetch from Supabase if not in local cache
    try {
      const p = await DB.getProfileByUsername(username);
      if (p) { u = dbUserToApp(p); S.users.push(u); }
    } catch(_) {}
    if (!u) { toast('User not found', 'err'); return; }
  }
  u.isFeatured = !u.isFeatured;
  // Persist to Supabase
  if (u.id) {
    const { error } = await DB.updateProfile(u.id, { is_featured: u.isFeatured }).catch(e=>({error:e}));
    if (error) { toast('Save failed: ' + (error.message||'unknown error'), 'err'); return; }
  }
  try {
    const featuredList = JSON.parse(localStorage.getItem('dl_featured_users') || '[]');
    if (u.isFeatured) { if (!featuredList.includes(username)) featuredList.push(username); }
    else { const i = featuredList.indexOf(username); if (i>=0) featuredList.splice(i,1); }
    localStorage.setItem('dl_featured_users', JSON.stringify(featuredList));
  } catch(_) {}
  save(); renderAdminUsers(); renderFeaturedMembers();
  toast(`${u.isFeatured?'✓ Added to':'Removed from'} Featured Members`, 'ok');
}

function revokeAward(username, awardId) {
  const u = S.users.find(x => x.username === username);
  if (!u) return;
  u.awards = (u.awards || []).filter(a => a !== awardId);
  if (S.user && S.user.username === username) {
    S.user.awards = [...u.awards];
  }
  save(); renderAdminUsers();
  if (S.page === 'profile') updateProfilePage();
  toast('Award revoked', 'ok');
}

function renderAwards(user, inline) {
  // inline=true → renders small chips next to name; inline=false → full row
  if (!user || !(user.awards||[]).length) return '';
  return (user.awards||[]).map(id => {
    const def = getAwardDef(id); if (!def) return '';
    if (inline) {
      return `<span class="award-inline" title="${def.label}: ${def.desc}" style="background:${def.bg};border-color:${def.border};color:${def.color}"><i class="${def.icon}"></i> ${def.label}</span>`;
    }
    return `<div class="award-chip" style="background:${def.bg};border-color:${def.border}">
      <span class="award-icon" style="color:${def.color}"><i class="${def.icon}"></i></span>
      <div><div class="award-label" style="color:${def.color}">${def.label}</div><div class="award-desc">${def.desc}</div></div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// ─── FOR YOU FEED ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function getForYouPosts() {
  if (!S.user) return [...S.posts].sort((a,b) => b.likes - a.likes);
  // Build interest profile from: liked posts, saved posts, categories viewed
  const liked    = S.posts.filter(p => p.likedBy.includes(S.user.username));
  const saved    = S.posts.filter(p => p.savedBy.includes(S.user.username));
  const followed = S.following;
  // Score each post
  const scored = S.posts.map(p => {
    let score = p.likes * 0.5;
    // Boost posts from followed users
    if (followed.includes(p.user)) score += 80;
    // Boost same category as liked posts
    const likedCats = liked.map(x => x.category);
    const pCats = Array.isArray(p.categories) ? p.categories : [p.category];
    if (pCats.some(c => likedCats.includes(c))) score += 40;
    // Boost same make as liked posts
    const likedMakes = liked.map(x => x.make);
    if (likedMakes.includes(p.make)) score += 30;
    // Boost recency
    const ageDays = (Date.now() - new Date(p.date).getTime()) / 86400000;
    score += Math.max(0, 30 - ageDays);
    // Don't show already-liked posts at top
    if (p.likedBy.includes(S.user.username)) score -= 20;
    return { post: p, score };
  });
  return scored.sort((a,b) => b.score - a.score).map(x => x.post);
}

// ═══════════════════════════════════════════════════════════════
// ─── SKELETON LOADING ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function showSkeletons(containerId, count = 6) {
  const c = el(containerId); if (!c) return;
  c.innerHTML = Array(count).fill(0).map(() => `
    <div class="card skeleton-card">
      <div class="skel skel-img"></div>
      <div class="card-body">
        <div class="skel skel-title"></div>
        <div class="skel skel-sub"></div>
        <div class="skel-foot">
          <div class="skel skel-av"></div>
          <div class="skel skel-stat"></div>
        </div>
      </div>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// ─── INFINITE SCROLL ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function initInfiniteScroll() {
  const sentinel = document.createElement('div');
  sentinel.id = 'feedSentinel';
  sentinel.style.cssText = 'height:1px;margin-top:-1px';
  const lmw = el('loadMoreBtn')?.parentElement;
  if (lmw) lmw.after(sentinel);
  const obs = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && el('loadMoreBtn') && el('loadMoreBtn').style.display !== 'none') {
      S.visibleCount += 8;
      renderFeed();
    }
  }, { rootMargin: '200px' });
  obs.observe(sentinel);
  S.infiniteScrollObserver = obs;
  // Hide the manual Load More button — scroll is automatic now
  const lmBtn = el('loadMoreBtn');
  if (lmBtn) lmBtn.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
// ─── COMPARE BUILDS ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// ─── DISCUSSIONS (Reddit-style board) ──────────────────────────
// The HTML/CSS/DB-layer/migration for this were already fully built —
// this is the missing piece that actually renders and wires it up.
// ═══════════════════════════════════════════════════════════════
const DISC_PAGE_SIZE = 15;
let discPage = 0;
let discCategory = '';   // '' = All
let discSort = 'hot';
let discSearchQ = '';

function dbDiscussionToApp(row) {
  if (!row) return null;
  return {
    id:        row.id,
    user:      row.username || '',
    user_id:   row.user_id  || null,
    title:     row.title    || '',
    body:      row.body     || '',
    category:  row.category || 'General',
    imageUrl:  row.image_url|| null,
    upvotes:   row.upvotes  || [],
    downvotes: row.downvotes|| [],
    comments:  row.comments || [],
    pinned:    row.pinned   || false,
    ts:        row.ts || (row.created_at ? new Date(row.created_at).getTime() : Date.now()),
  };
}

// Merges Supabase discussions with any local-only fallbacks, then applies
// the active category/search/sort — same resilience pattern as Car Spotting.
function getDiscussions() {
  const local = JSON.parse(localStorage.getItem('dl_discussions')||'[]').map(dbDiscussionToApp).filter(Boolean);
  const source = S._discussions?.length ? S._discussions : local;
  let all = [...source];
  if (discCategory) all = all.filter(d => d.category === discCategory);
  if (discSearchQ) {
    const q = discSearchQ.toLowerCase();
    all = all.filter(d => d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q));
  }
  return all.sort((a,b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1; // pinned always first
    const scoreA = (a.upvotes||[]).length - (a.downvotes||[]).length;
    const scoreB = (b.upvotes||[]).length - (b.downvotes||[]).length;
    if (discSort === 'new') return b.ts - a.ts;
    if (discSort === 'top') return scoreB - scoreA;
    // "Hot" — classic Reddit-style decay: score matters less as a post ages
    const hoursA = (Date.now()-a.ts)/3600000, hoursB = (Date.now()-b.ts)/3600000;
    return (scoreB / Math.pow(hoursB+2, 1.5)) - (scoreA / Math.pow(hoursA+2, 1.5));
  });
}

function initDiscussions() {
  const newBtn = el('newDiscussionBtn');
  newBtn?.addEventListener('click', () => {
    if (!S.user) { toast('Sign in to start a discussion','err'); el('authModal').classList.add('open'); return; }
    el('discComposerModal').classList.add('open');
    document.body.style.overflow = 'hidden';
    el('discTitleInput')?.focus();
  });
  el('discComposerClose')?.addEventListener('click', closeDiscComposer);
  el('discComposerModal')?.addEventListener('click', e => { if (e.target === el('discComposerModal')) closeDiscComposer(); });
  el('discTitleInput')?.addEventListener('input', e => { el('discTitleCount').textContent = e.target.value.length + ' / 150'; });
  el('discBodyInput')?.addEventListener('input', e => { el('discBodyCount').textContent = e.target.value.length + ' / 5000'; });
  el('discSubmitBtn')?.addEventListener('click', submitDiscussion);

  // Category pills — single-select, like a subreddit switcher
  document.querySelectorAll('.disc-cat-pill').forEach(p => p.addEventListener('click', () => {
    document.querySelectorAll('.disc-cat-pill').forEach(x=>x.classList.remove('active'));
    p.classList.add('active');
    discCategory = p.dataset.dcat;
    renderDiscussions(true);
  }));

  // Sort tabs
  document.querySelectorAll('.disc-sort-tabs .sort-btn[data-dsort]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.disc-sort-tabs .sort-btn[data-dsort]').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    discSort = b.dataset.dsort;
    renderDiscussions(true);
  }));

  // Search (debounced)
  let discSearchTimer;
  el('discSearchInput')?.addEventListener('input', e => {
    clearTimeout(discSearchTimer);
    discSearchTimer = setTimeout(() => { discSearchQ = e.target.value.trim(); renderDiscussions(true); }, 250);
  });

  // Detail modal close
  el('discDetailClose')?.addEventListener('click', closeDiscDetail);
  el('discDetailModal')?.addEventListener('click', e => { if (e.target === el('discDetailModal')) closeDiscDetail(); });

  // Infinite scroll
  const sentinel = el('discSentinel');
  if (sentinel) {
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) { discPage++; renderDiscussions(); }
    }, { rootMargin: '200px' });
    obs.observe(sentinel);
  }
}

function closeDiscComposer() {
  el('discComposerModal').classList.remove('open');
  document.body.style.overflow = '';
  el('discTitleInput').value = ''; el('discBodyInput').value = '';
  el('discTitleCount').textContent = '0 / 150'; el('discBodyCount').textContent = '0 / 5000';
}
function closeDiscDetail() {
  el('discDetailModal').classList.remove('open');
  document.body.style.overflow = '';
}

function renderDiscussions(reset) {
  if (reset) discPage = 0;
  const wrap = el('discList'); if (!wrap) return;

  // Paint whatever's already in memory instantly
  const cached = getDiscussions();
  if (cached.length) {
    wrap.innerHTML = cached.slice(0, (discPage+1)*DISC_PAGE_SIZE).map(discussionRowHTML).join('');
    bindDiscussionListEvents(wrap);
  } else if (reset) {
    wrap.innerHTML = '';
  }

  DB.getDiscussions({ limit: DISC_PAGE_SIZE*(discPage+1)+1 }).then(rows => {
    const sbDiscussions = (rows||[]).map(dbDiscussionToApp).filter(Boolean);
    const localOnly = JSON.parse(localStorage.getItem('dl_discussions')||'[]').map(dbDiscussionToApp).filter(Boolean);
    const merged = [...sbDiscussions];
    localOnly.forEach(ld => { if (!merged.find(sd => sd.id === ld.id)) merged.push(ld); });
    S._discussions = merged;

    if (!merged.length) {
      wrap.innerHTML = `<div class="disc-empty">
        <i class="fas fa-comments"></i>
        <h3>No discussions yet</h3>
        <p>${S.user ? 'Be the first to start one — use the button up top.' : 'Sign in to start one.'}</p>
      </div>`;
      return;
    }
    const visible = getDiscussions().slice(0, (discPage+1)*DISC_PAGE_SIZE);
    if (!visible.length) {
      wrap.innerHTML = `<div class="disc-empty"><i class="fas fa-filter"></i><h3>No matches</h3><p>Nothing here matches your filters yet.</p></div>`;
      return;
    }
    wrap.innerHTML = visible.map(discussionRowHTML).join('');
    bindDiscussionListEvents(wrap);
  }).catch(err => {
    console.warn('Discussions fetch failed (table may not exist yet):', err?.message||err);
    if (!cached.length) {
      wrap.innerHTML = `<div class="disc-empty">
        <i class="fas fa-comments"></i>
        <h3>Discussions</h3>
        <p>Run <b>discussions_migration.sql</b> in Supabase to enable cross-device discussions.</p>
      </div>`;
    }
  });
}

function discAvatarHTML(username, cls, size) {
  const url = getAvatarUrl(username);
  const ring = hasActiveSpotStory(username) ? ' has-story-ring' : '';
  const sizeStyle = size ? `width:${size}px;height:${size}px;` : '';
  return url
    ? `<img src="${url}" class="${cls}${ring} clickable-user" data-user="${esc(username)}" alt="" style="${sizeStyle}overflow:${ring?'visible':'hidden'}"/>`
    : `<div class="${cls}${ring} clickable-user" data-user="${esc(username)}" style="${sizeStyle}background:${avColor(username)};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;overflow:${ring?'visible':'hidden'}">${(username||'?')[0].toUpperCase()}</div>`;
}

function discussionRowHTML(d) {
  const myVote = S.user && (d.upvotes||[]).includes(S.user.username) ? 'up' : (S.user && (d.downvotes||[]).includes(S.user.username) ? 'down' : '');
  const score = (d.upvotes||[]).length - (d.downvotes||[]).length;
  const preview = (d.body||'').length > 180 ? d.body.slice(0,180)+'…' : (d.body||'');
  return `<div class="disc-item" data-id="${d.id}">
    <div class="disc-vote-col">
      <button class="disc-vote-btn disc-up${myVote==='up'?' active':''}" data-id="${d.id}" data-dir="up"><i class="fas fa-arrow-up"></i></button>
      <span class="disc-vote-count">${score}</span>
      <button class="disc-vote-btn disc-down${myVote==='down'?' active':''}" data-id="${d.id}" data-dir="down"><i class="fas fa-arrow-down"></i></button>
    </div>
    <div class="disc-row-content">
      <div class="disc-row-meta">
        <span class="disc-cat-badge">${esc(d.category)}</span>
        ${discAvatarHTML(d.user, 'disc-row-meta-av')}
        <span class="disc-row-meta-user clickable-user" data-user="${esc(d.user)}">${esc(d.user)}</span>
        <span class="disc-row-meta-time">${timeAgo(d.ts)}</span>
      </div>
      <h3 class="disc-row-title">${esc(d.title)}</h3>
      ${preview ? `<p class="disc-row-preview">${esc(preview)}</p>` : ''}
      <div class="disc-row-footer">
        <span class="disc-comment-count"><i class="fas fa-comment"></i> ${(d.comments||[]).length}</span>
        ${d.pinned ? '<span class="disc-pin-badge"><i class="fas fa-thumbtack"></i> Pinned</span>' : ''}
      </div>
    </div>
  </div>`;
}

function bindDiscussionListEvents(wrap) {
  wrap.querySelectorAll('.disc-vote-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!S.user) { toast('Sign in to vote','err'); el('authModal').classList.add('open'); return; }
      toggleDiscussionVote(btn.dataset.id, btn.dataset.dir);
    });
  });
  wrap.querySelectorAll('.disc-item').forEach(item => {
    item.addEventListener('click', () => openDiscussionDetail(item.dataset.id));
  });
  wrap.querySelectorAll('.clickable-user').forEach(el2 => {
    el2.addEventListener('click', e => { e.stopPropagation(); viewPublicProfile(el2.dataset.user); });
  });
}

function findDiscussion(id) {
  return (S._discussions||[]).find(x=>x.id===id) || getDiscussions().find(x=>x.id===id);
}

function toggleDiscussionVote(id, dir) {
  const d = findDiscussion(id); if (!d) return;
  const uname = S.user.username;
  let up = d.upvotes||[], down = d.downvotes||[];
  if (dir==='up') { down = down.filter(u=>u!==uname); up = up.includes(uname) ? up.filter(u=>u!==uname) : [...up, uname]; }
  else            { up   = up.filter(u=>u!==uname);   down = down.includes(uname) ? down.filter(u=>u!==uname) : [...down, uname]; }
  // findDiscussion() returns the live object straight out of S._discussions
  // when it's there (the common case) — assigning to `d` already updates
  // that shared object, so there is nothing further to mutate here.
  d.upvotes = up; d.downvotes = down;
  const local = JSON.parse(localStorage.getItem('dl_discussions')||'[]');
  const li = local.findIndex(x=>x.id===id);
  if (li>=0) { local[li].upvotes=up; local[li].downvotes=down; localStorage.setItem('dl_discussions', JSON.stringify(local)); }
  DB.toggleDiscussionVote(id, uname, dir).catch(()=>{});
  refreshVoteUI(id, up, down, uname);
}

function refreshVoteUI(id, up, down, uname) {
  const score = up.length - down.length;
  document.querySelectorAll(`.disc-item[data-id="${id}"] .disc-vote-count, .disc-detail-votes[data-id="${id}"] .disc-vote-count`)
    .forEach(node => node.textContent = score);
  document.querySelectorAll(`.disc-vote-btn[data-id="${id}"]`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dir==='up' ? up.includes(uname) : down.includes(uname));
  });
}

function openDiscussionDetail(id) {
  const d = findDiscussion(id); if (!d) return;
  const content = el('discDetailContent');
  const modal = el('discDetailModal');
  if (!content || !modal) return;
  content.innerHTML = discussionDetailHTML(d);
  bindDiscussionDetailEvents(content, d);
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function discussionDetailHTML(d) {
  const isOwn = S.user && (d.user === S.user.username || (d.user_id && d.user_id === S.user.id));
  const canDelete = isOwn || S.user?.isAdmin;
  const myVote = S.user && (d.upvotes||[]).includes(S.user.username) ? 'up' : (S.user && (d.downvotes||[]).includes(S.user.username) ? 'down' : '');
  const score = (d.upvotes||[]).length - (d.downvotes||[]).length;
  const commentCount = (d.comments||[]).length;

  return `
    <div class="disc-detail-header">
      <span class="disc-cat-badge">${esc(d.category)}</span>
      <span class="disc-detail-time">${timeAgo(d.ts)}</span>
      ${canDelete ? `<button class="disc-detail-del" data-id="${d.id}"><i class="fas fa-trash-alt"></i> Delete</button>` : ''}
    </div>
    <h2 class="disc-detail-title">${esc(d.title)}</h2>
    <div class="disc-detail-author">
      ${discAvatarHTML(d.user, 'disc-detail-author-av')}
      <span class="disc-detail-author-name clickable-user" data-user="${esc(d.user)}">${esc(d.user)}</span>
    </div>
    ${d.body ? `<div class="disc-detail-body">${esc(d.body)}</div>` : ''}
    <div class="disc-detail-votes" data-id="${d.id}">
      <button class="disc-vote-btn disc-up${myVote==='up'?' active':''}" data-id="${d.id}" data-dir="up"><i class="fas fa-arrow-up"></i></button>
      <span class="disc-vote-count">${score}</span>
      <button class="disc-vote-btn disc-down${myVote==='down'?' active':''}" data-id="${d.id}" data-dir="down"><i class="fas fa-arrow-down"></i></button>
    </div>
    ${S.user ? `<div class="disc-comment-composer">
      ${renderAv(S.user.username, 32, 'disc-comment-composer-av')}
      <div class="disc-comment-composer-body">
        <textarea rows="2" placeholder="What are your thoughts?" id="discNewCommentInput" maxlength="2000"></textarea>
        <button class="disc-comment-submit" id="discNewCommentSubmit">Comment</button>
      </div>
    </div>` : `<p class="disc-comment-signin">Sign in to comment</p>`}
    <div class="disc-comments-heading">${commentCount} Comment${commentCount===1?'':'s'}</div>
    <div class="disc-comments-list" id="discCommentsList-${d.id}">${renderCommentTree(d.comments||[], null)}</div>
  `;
}

// Recursively renders a comment thread — comments reference their parent
// via parentId, so arbitrary reply depth "just works" the same way
// Reddit's does, each level nesting inside .disc-replies.
function renderCommentTree(comments, parentId) {
  const children = comments.filter(c => (c.parentId||null) === parentId);
  if (!children.length) return parentId === null ? '<p class="disc-no-comments">No comments yet — start the conversation.</p>' : '';
  return children.map(c => commentHTML(c, comments)).join('');
}

function commentHTML(c, allComments) {
  const myVote = S.user && (c.upvotes||[]).includes(S.user.username) ? 'up' : (S.user && (c.downvotes||[]).includes(S.user.username) ? 'down' : '');
  const score = (c.upvotes||[]).length - (c.downvotes||[]).length;
  const canDelete = S.user && (S.user.username===c.user || S.user.isAdmin) && c.user !== '[deleted]';
  const childrenHTML = renderCommentTree(allComments, c.id);
  return `<div class="disc-comment" data-cid="${c.id}">
    <div class="disc-comment-vote">
      <button class="disc-vote-btn disc-up${myVote==='up'?' active':''}" data-cid="${c.id}" data-dir="up"><i class="fas fa-arrow-up"></i></button>
      <span class="disc-vote-count">${score}</span>
      <button class="disc-vote-btn disc-down${myVote==='down'?' active':''}" data-cid="${c.id}" data-dir="down"><i class="fas fa-arrow-down"></i></button>
    </div>
    <div class="disc-comment-body-wrap">
      <div class="disc-comment-meta">
        ${discAvatarHTML(c.user, 'disc-comment-av')}
        <span class="disc-comment-author clickable-user" data-user="${esc(c.user)}">${esc(c.user)}</span>
        <span class="disc-comment-time">${timeAgo(c.ts)}</span>
      </div>
      <div class="disc-comment-text">${esc(c.text)}</div>
      <div class="disc-comment-actions">
        ${S.user && c.user !== '[deleted]' ? `<button class="disc-reply-btn" data-cid="${c.id}">Reply</button>` : ''}
        ${canDelete ? `<button class="disc-comment-del-btn" data-cid="${c.id}">Delete</button>` : ''}
      </div>
      ${S.user ? `<div class="disc-reply-composer" id="discReplyComposer-${c.id}">
        ${renderAv(S.user.username, 24, '')}
        <input type="text" placeholder="Reply…" data-parent="${c.id}" maxlength="2000"/>
        <button class="disc-reply-send" data-parent="${c.id}"><i class="fas fa-paper-plane"></i></button>
      </div>` : ''}
      ${childrenHTML ? `<div class="disc-replies">${childrenHTML}</div>` : ''}
    </div>
  </div>`;
}

function bindDiscussionDetailEvents(content, d) {
  // Top-level elements — the discussion's own vote buttons, the delete
  // button, the author name, and the new-comment composer. None of these
  // live inside the comments list that refreshDiscussionCommentsUI()
  // rebuilds, so they must only ever be bound ONCE per modal open.
  // (Previously this whole function — including these bindings — was
  // re-run every time a comment was posted or voted on, which stacked a
  // fresh duplicate listener onto every one of these elements each time:
  // clicking the discussion's upvote would fire the toggle twice in the
  // same click and cancel itself out, and the comment submit button would
  // fire twice per click, posting the same comment twice.)
  content.querySelectorAll('.disc-detail-votes .disc-vote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!S.user) { toast('Sign in to vote','err'); el('authModal').classList.add('open'); return; }
      toggleDiscussionVote(btn.dataset.id, btn.dataset.dir);
    });
  });
  content.querySelector('.disc-detail-del')?.addEventListener('click', () => deleteDiscussionFromDetail(d.id));
  content.querySelectorAll('.disc-detail-author .clickable-user').forEach(el2 => {
    el2.addEventListener('click', () => viewPublicProfile(el2.dataset.user));
  });
  el('discNewCommentSubmit')?.addEventListener('click', () => sendDiscussionComment(d.id, content));
  el('discNewCommentInput')?.addEventListener('keydown', e => {
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendDiscussionComment(d.id, content); }
  });

  // Comment-tree elements — safe to (re)bind every time, since the list
  // they live in is fully replaced (fresh DOM nodes) on every re-render.
  bindDiscussionCommentEvents(content, d);
}

// Binds vote/reply/delete/profile-link handlers for everything inside the
// comments list only. Called once on initial open (via
// bindDiscussionDetailEvents above) and again every time the list is
// re-rendered — safe to call repeatedly because renderCommentTree() always
// produces brand-new DOM nodes, so there's nothing stale to double-bind.
function bindDiscussionCommentEvents(content, d) {
  const listEl = content.querySelector(`#discCommentsList-${d.id}`);
  if (!listEl) return;
  listEl.querySelectorAll('.disc-vote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!S.user) { toast('Sign in to vote','err'); el('authModal').classList.add('open'); return; }
      toggleCommentVote(d.id, btn.dataset.cid, btn.dataset.dir, content);
    });
  });
  listEl.querySelectorAll('.disc-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const composer = el('discReplyComposer-'+btn.dataset.cid);
      composer?.classList.toggle('open');
      if (composer?.classList.contains('open')) composer.querySelector('input')?.focus();
    });
  });
  listEl.querySelectorAll('.disc-reply-send').forEach(btn => {
    btn.addEventListener('click', () => sendDiscussionReply(d.id, btn.dataset.parent, content));
  });
  listEl.querySelectorAll('.disc-reply-composer input').forEach(input => {
    input.addEventListener('keydown', e => { if (e.key==='Enter') sendDiscussionReply(d.id, input.dataset.parent, content); });
  });
  listEl.querySelectorAll('.disc-comment-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteDiscussionComment(d.id, btn.dataset.cid, content));
  });
  listEl.querySelectorAll('.clickable-user').forEach(el2 => {
    el2.addEventListener('click', () => viewPublicProfile(el2.dataset.user));
  });
}

function addDiscussionCommentToStores(discussionId, comment) {
  // findDiscussion() checks S._discussions FIRST, so `d` here IS the same
  // object living in S._discussions whenever that discussion is cached
  // there (virtually always). A second "if (S._discussions) {...}" lookup
  // used to re-find that identical object and push the same comment onto
  // it a second time — that's what was causing every comment to post
  // twice. Mutating `d` once is sufficient.
  const d = findDiscussion(discussionId);
  if (d) d.comments = [...(d.comments||[]), comment];
  const local = JSON.parse(localStorage.getItem('dl_discussions')||'[]');
  const li = local.findIndex(x=>x.id===discussionId);
  if (li>=0) { local[li].comments = [...(local[li].comments||[]), comment]; localStorage.setItem('dl_discussions', JSON.stringify(local)); }
  DB.addDiscussionComment(discussionId, comment).catch(()=>{});
}

function refreshDiscussionCommentsUI(discussionId, content) {
  const d = findDiscussion(discussionId); if (!d) return;
  const listEl = content.querySelector(`#discCommentsList-${discussionId}`);
  if (listEl) listEl.innerHTML = renderCommentTree(d.comments||[], null);
  const heading = content.querySelector('.disc-comments-heading');
  if (heading) heading.textContent = `${(d.comments||[]).length} Comment${(d.comments||[]).length===1?'':'s'}`;
  bindDiscussionCommentEvents(content, d);
  document.querySelectorAll(`.disc-item[data-id="${discussionId}"] .disc-comment-count`).forEach(node => {
    node.innerHTML = `<i class="fas fa-comment"></i> ${(d.comments||[]).length}`;
  });
}

function notifyDiscussionOwner(discussionId, comment, isReply) {
  const d = findDiscussion(discussionId);
  if (!d || !d.user_id || d.user === S.user.username) return;
  const preview = comment.text.length > 40 ? comment.text.slice(0,40)+'…' : comment.text;
  DB.pushNotification(d.user_id, 'comment', S.user.username, (isReply?'replied: "':'commented: "')+preview+'"', 'page:discussions').catch(()=>{});
}

function sendDiscussionComment(discussionId, content) {
  const input = el('discNewCommentInput');
  const text = input.value.trim();
  if (!text) return;
  if (!S.user) { toast('Sign in to comment','err'); return; }
  const comment = { id:'c'+Date.now()+Math.random().toString(36).slice(2,7), user:S.user.username, text, ts:Date.now(), upvotes:[], downvotes:[], parentId:null };
  input.value = '';
  addDiscussionCommentToStores(discussionId, comment);
  refreshDiscussionCommentsUI(discussionId, content);
  notifyDiscussionOwner(discussionId, comment, false);
}

function sendDiscussionReply(discussionId, parentId, content) {
  const input = content.querySelector(`.disc-reply-composer input[data-parent="${parentId}"]`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!S.user) { toast('Sign in to reply','err'); return; }
  const comment = { id:'c'+Date.now()+Math.random().toString(36).slice(2,7), user:S.user.username, text, ts:Date.now(), upvotes:[], downvotes:[], parentId };
  input.value = '';
  addDiscussionCommentToStores(discussionId, comment);
  refreshDiscussionCommentsUI(discussionId, content);
  notifyDiscussionOwner(discussionId, comment, true);
}

function toggleCommentVote(discussionId, commentId, dir, content) {
  const d = findDiscussion(discussionId); if (!d) return;
  const uname = S.user.username;
  const applyVote = c => {
    if (c.id !== commentId) return c;
    let up = c.upvotes||[], down = c.downvotes||[];
    if (dir==='up') { down = down.filter(u=>u!==uname); up = up.includes(uname)?up.filter(u=>u!==uname):[...up,uname]; }
    else            { up   = up.filter(u=>u!==uname);   down = down.includes(uname)?down.filter(u=>u!==uname):[...down,uname]; }
    return { ...c, upvotes:up, downvotes:down };
  };
  // Same shared-object issue as addDiscussionCommentToStores() — applying
  // this toggle a second time to the identical object flipped the vote
  // right back off, which is why votes on comments looked like they
  // silently did nothing.
  d.comments = (d.comments||[]).map(applyVote);
  const local = JSON.parse(localStorage.getItem('dl_discussions')||'[]');
  const li = local.findIndex(x=>x.id===discussionId);
  if (li>=0) { local[li].comments = d.comments; localStorage.setItem('dl_discussions', JSON.stringify(local)); }
  DB.toggleDiscussionCommentVote(discussionId, commentId, uname, dir).catch(()=>{});
  refreshDiscussionCommentsUI(discussionId, content);
}

function deleteDiscussionComment(discussionId, commentId, content) {
  if (!confirm('Delete this comment? Replies to it will remain.')) return;
  const d = findDiscussion(discussionId); if (!d) return;
  // Soft-delete — keeps the node so any replies underneath don't orphan,
  // same "[deleted]" convention Reddit itself uses.
  const softDelete = c => c.id===commentId ? { ...c, text:'[deleted]', user:'[deleted]' } : c;
  d.comments = (d.comments||[]).map(softDelete);
  const local = JSON.parse(localStorage.getItem('dl_discussions')||'[]');
  const li = local.findIndex(x=>x.id===discussionId);
  if (li>=0) { local[li].comments = d.comments; localStorage.setItem('dl_discussions', JSON.stringify(local)); }
  DB.setDiscussionComments(discussionId, d.comments).catch(()=>{});
  refreshDiscussionCommentsUI(discussionId, content);
  toast('Comment deleted','ok');
}

function deleteDiscussionFromDetail(id) {
  if (!confirm('Delete this discussion? This cannot be undone.')) return;
  const d = findDiscussion(id);
  const isMine = d && S.user && (d.user===S.user.username || d.user_id===S.user.id);
  Promise.resolve((!isMine && S.user?.isAdmin) ? DB.adminDeleteDiscussion(id) : DB.deleteDiscussion(id, S.user?.id))
    .catch(()=>{})
    .finally(() => {
      S._discussions = (S._discussions||[]).filter(x=>x.id!==id);
      const local = JSON.parse(localStorage.getItem('dl_discussions')||'[]').filter(x=>x.id!==id);
      localStorage.setItem('dl_discussions', JSON.stringify(local));
      closeDiscDetail();
      toast('Discussion deleted','ok');
      renderDiscussions(true);
    });
}

async function submitDiscussion() {
  if (!S.user) { toast('Sign in to post','err'); return; }
  const category = el('discCatSelect')?.value || 'General';
  const title = el('discTitleInput')?.value.trim() || '';
  const body  = el('discBodyInput')?.value.trim() || '';
  if (!title) { toast('Give your discussion a title','err'); return; }

  const btn = el('discSubmitBtn');
  const originalHTML = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Posting…';

  let finalId = 'd'+Date.now(), finalTs = Date.now();
  try {
    const { data, error } = await DB.createDiscussion(S.user.id, S.user.username, { title, body, category });
    if (error) throw error;
    if (data) { finalId = data.id; finalTs = data.created_at ? new Date(data.created_at).getTime() : Date.now(); }
  } catch(e) {
    console.warn('Discussion create failed, saving locally:', e?.message||e);
    const local = JSON.parse(localStorage.getItem('dl_discussions')||'[]');
    local.unshift({ id:finalId, username:S.user.username, user_id:S.user.id, title, body, category, upvotes:[], downvotes:[], comments:[], pinned:false, created_at:new Date().toISOString() });
    localStorage.setItem('dl_discussions', JSON.stringify(local));
  }

  S._discussions = [dbDiscussionToApp({ id:finalId, username:S.user.username, user_id:S.user.id, title, body, category, upvotes:[], downvotes:[], comments:[], pinned:false, ts:finalTs }), ...(S._discussions||[])];

  btn.disabled = false; btn.innerHTML = originalHTML;
  closeDiscComposer();
  toast('Discussion posted ✓','ok');
  discCategory=''; discSort='hot'; discSearchQ='';
  const searchInput = el('discSearchInput'); if (searchInput) searchInput.value = '';
  document.querySelectorAll('.disc-cat-pill').forEach(p=>p.classList.toggle('active', p.dataset.dcat===''));
  document.querySelectorAll('.disc-sort-tabs .sort-btn[data-dsort]').forEach(p=>p.classList.toggle('active', p.dataset.dsort==='hot'));
  renderDiscussions(true);
}

// ═══════════════════════════════════════════════════════════════
// ─── SPOTTING MAP — world map of Car Spotting post locations ───
// Original, self-contained SVG world map (simplified continent
// silhouettes, not precise cartography) — avoids depending on any
// external mapping API or paid service. Pins are placed using real
// equirectangular projection math against each post's actual lat/lng,
// captured opt-in at post time via the browser's Geolocation API.
// ═══════════════════════════════════════════════════════════════

// Converts real coordinates to x/y in the map's 1000×500 viewBox.
function projectLatLng(lat, lng) {
  return { x: (lng+180)/360*1000, y: (90-lat)/180*500 };
}

// Static background — ocean, graticule (lat/long grid), and simplified
// continent shapes. Shared by the sidebar teaser and the full map modal.
function worldMapStaticSvg() {
  const graticule = [];
  for (let lng=-180; lng<=180; lng+=30) { const x=(lng+180)/360*1000; graticule.push(`<line class="wm-grat" x1="${x}" y1="0" x2="${x}" y2="500"/>`); }
  for (let lat=-60; lat<=60; lat+=30) { const y=(90-lat)/180*500; graticule.push(`<line class="wm-grat" x1="0" y1="${y}" x2="1000" y2="${y}"/>`); }
  return `<rect class="wm-ocean" x="0" y="0" width="1000" height="500"/>
    ${graticule.join('')}
    <polygon class="wm-land" data-continent="north-america" points="41.7,61.1 111.1,55.6 166.7,50.0 236.1,61.1 277.8,69.4 319.4,83.3 347.2,111.1 333.3,125.0 305.6,133.3 291.7,152.8 277.8,180.6 263.9,194.4 250.0,208.3 236.1,211.1 222.2,205.6 208.3,194.4 194.4,180.6 180.6,166.7 166.7,152.8 155.6,138.9 152.8,116.7 138.9,97.2 111.1,88.9 69.4,83.3 41.7,69.4"/>
    <polygon class="wm-land" data-continent="south-america" points="277.8,222.2 291.7,236.1 305.6,250.0 305.6,277.8 305.6,300.0 300.0,319.4 305.6,347.2 319.4,375.0 311.1,394.4 300.0,400.0 311.1,388.9 327.8,361.1 338.9,347.2 347.2,319.4 366.7,305.6 388.9,277.8 402.8,263.9 388.9,250.0 361.1,236.1 333.3,227.8 305.6,222.2 277.8,222.2"/>
    <polygon class="wm-land" data-continent="europe" points="472.2,130.6 477.8,116.7 486.1,105.6 500.0,108.3 513.9,105.6 527.8,100.0 541.7,97.2 555.6,94.4 569.4,88.9 583.3,83.3 597.2,77.8 611.1,83.3 611.1,111.1 597.2,125.0 583.3,133.3 569.4,138.9 555.6,138.9 541.7,144.4 527.8,144.4 513.9,138.9 500.0,133.3 486.1,130.6 472.2,130.6"/>
    <polygon class="wm-land" data-continent="africa" points="452.8,208.3 458.3,194.4 466.7,180.6 486.1,166.7 500.0,161.1 527.8,158.3 555.6,161.1 583.3,163.9 591.7,180.6 597.2,208.3 611.1,222.2 625.0,236.1 633.3,250.0 625.0,277.8 611.1,305.6 597.2,327.8 583.3,338.9 569.4,341.7 555.6,338.9 550.0,327.8 541.7,311.1 533.3,291.7 527.8,263.9 522.2,236.1 486.1,227.8 472.2,222.2 458.3,216.7 452.8,208.3"/>
    <polygon class="wm-land" data-continent="asia" points="597.2,133.3 611.1,125.0 638.9,116.7 666.7,105.6 694.4,97.2 722.2,88.9 750.0,83.3 777.8,77.8 805.6,83.3 833.3,97.2 861.1,111.1 875.0,125.0 888.9,125.0 894.4,138.9 888.9,152.8 861.1,161.1 838.9,166.7 827.8,180.6 805.6,194.4 791.7,222.2 777.8,236.1 763.9,250.0 772.2,236.1 783.3,222.2 791.7,208.3 763.9,194.4 750.0,188.9 736.1,194.4 722.2,208.3 708.3,222.2 694.4,227.8 680.6,222.2 666.7,208.3 661.1,194.4 652.8,180.6 638.9,172.2 625.0,166.7 611.1,152.8 597.2,144.4 583.3,152.8 577.8,144.4 588.9,138.9 597.2,133.3"/>
    <polygon class="wm-land" data-continent="australia" points="813.9,311.1 819.4,305.6 833.3,300.0 847.2,291.7 861.1,283.3 875.0,283.3 888.9,291.7 902.8,294.4 911.1,305.6 916.7,319.4 925.0,327.8 916.7,341.7 911.1,355.6 902.8,355.6 888.9,355.6 883.3,347.2 875.0,338.9 861.1,338.9 847.2,341.7 833.3,344.4 819.4,338.9 813.9,327.8 813.9,311.1"/>`;
}

function initSpotMap() {
  const svg = el('spotMapSvg');
  if (svg) svg.innerHTML = worldMapStaticSvg();
  const mini = el('spotMapMiniSvg');
  if (mini) mini.innerHTML = worldMapStaticSvg();

  el('spotMapOpenBtn')?.addEventListener('click', openSpotMap);
  el('spotMapTeaserBtn')?.addEventListener('click', e => {
    // Clicking anywhere on the teaser card opens the map, not just the button
    if (!e.target.closest('a')) openSpotMap();
  });
  el('spotMapClose')?.addEventListener('click', closeSpotMap);
  el('spotMapModal')?.addEventListener('click', e => { if (e.target === el('spotMapModal')) closeSpotMap(); });

  renderSpotMapMiniPins();
}

function openSpotMap() {
  el('spotMapModal')?.classList.add('open');
  document.body.style.overflow = 'hidden';
  renderSpotMapFull();
}
function closeSpotMap() {
  el('spotMapModal')?.classList.remove('open');
  document.body.style.overflow = '';
  hideSpotMapPopup();
}

// Small, non-interactive pin dots on the sidebar teaser — just enough to
// look alive without needing full click/popup wiring for a tiny preview.
async function renderSpotMapMiniPins() {
  const svg = el('spotMapMiniSvg'); if (!svg) return;
  const locations = await DB.getSpottingLocations().catch(() => []);
  if (!locations.length) return;
  const pinsHTML = locations.slice(0, 60).map(loc => {
    const { x, y } = projectLatLng(loc.lat, loc.lng);
    return `<circle class="wm-mini-pin" cx="${x}" cy="${y}" r="3.5"/>`;
  }).join('');
  svg.insertAdjacentHTML('beforeend', pinsHTML);
}

// Full interactive map — real pins from every located post, click for a
// popup with the post's photo + spotter, click the popup to open the post.
let _spotMapLocations = [];
async function renderSpotMapFull() {
  const svg = el('spotMapSvg');
  const countEl = el('spotMapCount');
  if (!svg) return;

  // Repaint the static base (clears any previously-rendered pins) then add fresh ones
  svg.innerHTML = worldMapStaticSvg();

  const locations = await DB.getSpottingLocations().catch(() => null);
  if (locations === null) {
    if (countEl) countEl.textContent = 'Run spotting_locations_migration.sql in Supabase to enable the map.';
    return;
  }
  _spotMapLocations = locations;
  if (countEl) {
    countEl.textContent = locations.length
      ? `${locations.length} spot${locations.length===1?'':'s'} located on the map`
      : 'No located spots yet — be the first to share your location when posting.';
  }
  if (!locations.length) return;

  const pinsHTML = locations.map((loc, i) => {
    const { x, y } = projectLatLng(loc.lat, loc.lng);
    return `<g class="wm-pin" data-idx="${i}" transform="translate(${x},${y})">
      <circle class="wm-pin-pulse" r="5"/>
      <circle class="wm-pin-dot" r="5"/>
    </g>`;
  }).join('');
  svg.insertAdjacentHTML('beforeend', pinsHTML);

  svg.querySelectorAll('.wm-pin').forEach(pin => {
    pin.addEventListener('click', e => {
      e.stopPropagation();
      showSpotMapPopup(_spotMapLocations[pin.dataset.idx], pin);
    });
  });
}

function showSpotMapPopup(loc, pinEl) {
  const popup = el('spotMapPopup');
  const wrap = pinEl.closest('.spot-map-wrap');
  if (!popup || !loc) return;
  const img = loc.media?.[0]?.url;
  popup.innerHTML = `
    <div class="spot-map-popup-close"><i class="fas fa-times"></i></div>
    ${img ? `<img src="${img}" class="spot-map-popup-img" alt=""/>` : `<div class="spot-map-popup-img" style="background:${phBg(loc.id)}"></div>`}
    <div class="spot-map-popup-body">
      <div class="spot-map-popup-user">${esc(loc.username)}</div>
      ${loc.location_name ? `<div class="spot-map-popup-loc"><i class="fas fa-map-marker-alt"></i> ${esc(loc.location_name)}</div>` : ''}
    </div>`;

  popup.style.display = 'block'; // must be visible before offsetWidth/Height can be measured below

  // Position the popup relative to the map wrap, anchored above the pin —
  // clamped so it can't render off the left/right/top edge of the map,
  // which a fixed-width popup near the map's border would otherwise do
  // (especially visible on narrow phone screens).
  const svg = el('spotMapSvg');
  const svgRect = svg.getBoundingClientRect();
  const wrapRect = (wrap||svg.parentElement).getBoundingClientRect();
  const { x, y } = projectLatLng(loc.lat, loc.lng);
  const scaleX = svgRect.width / 1000, scaleY = svgRect.height / 500;
  let left = (svgRect.left - wrapRect.left) + x*scaleX;
  let top  = (svgRect.top  - wrapRect.top)  + y*scaleY;
  const popupHalfWidth = (popup.offsetWidth || 160) / 2;
  const popupHeight = popup.offsetHeight || 220;
  left = Math.max(popupHalfWidth + 4, Math.min(left, wrapRect.width - popupHalfWidth - 4));
  top  = Math.max(popupHeight + 4, top); // keep it from going above the map's top edge
  popup.style.left = left + 'px';
  popup.style.top  = top + 'px';

  popup.querySelector('.spot-map-popup-close').addEventListener('click', e => { e.stopPropagation(); hideSpotMapPopup(); });
  popup.onclick = async () => {
    const cached = findSocialPost(loc.id);
    if (cached) { closeSpotMap(); openSocialDetail(loc.id); return; }
    // Not already loaded in the feed — fetch it directly so the click
    // doesn't silently do nothing.
    const row = await DB.getSocialPostById(loc.id).catch(() => null);
    const post = dbSocialToApp(row);
    if (!post) { toast('Could not load that post','err'); return; }
    S._socialPosts = [post, ...(S._socialPosts||[])];
    closeSpotMap();
    openSocialDetail(loc.id);
  };
}
function hideSpotMapPopup() {
  const popup = el('spotMapPopup');
  if (popup) popup.style.display = 'none';
}

function initCompare() {
  [1, 2].forEach(slot => {
    const inp = el(`compareSearch${slot}`);
    const res = el(`compareResults${slot}`);
    if (!inp || !res) return;
    let t;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const q = inp.value.trim().toLowerCase();
        if (!q) { res.innerHTML = ''; return; }
        const hits = S.posts.filter(p =>
          p.title.toLowerCase().includes(q) ||
          p.make.toLowerCase().includes(q) ||
          p.model.toLowerCase().includes(q)
        ).slice(0, 5);
        res.innerHTML = hits.map(p => `
          <div class="compare-result" data-id="${p.id}" data-slot="${slot}">
            <div class="compare-result-info">
              <span class="compare-result-title">${esc(p.title)}</span>
              <span class="compare-result-meta">${p.year||''} ${p.make} ${p.model}</span>
            </div>
          </div>`).join('') || '<p class="compare-none">No builds found</p>';
        res.querySelectorAll('.compare-result').forEach(r => {
          r.addEventListener('click', () => {
            const post = S.posts.find(x => x.id === r.dataset.id);
            if (!post) return;
            if (+r.dataset.slot === 1) S.compareA = post;
            else S.compareB = post;
            inp.value = post.title;
            res.innerHTML = '';
            renderCompareSelected(+r.dataset.slot, post);
            if (S.compareA && S.compareB) buildCompareTable();
          });
        });
      }, 150);
    });
  });
}

function renderComparePage() {
  if (S.compareA) renderCompareSelected(1, S.compareA);
  if (S.compareB) renderCompareSelected(2, S.compareB);
  if (S.compareA && S.compareB) buildCompareTable();
}

function renderCompareSelected(slot, post) {
  const el2 = el(`compareSelected${slot}`);
  if (!el2) return;
  const img = post.images?.[0];
  const cats = Array.isArray(post.categories) ? post.categories : [post.category].filter(Boolean);
  el2.style.display = 'block';
  el2.innerHTML = `
    <div class="compare-card">
      <div class="compare-card-img">
        ${img
          ? `<img src="${img}" alt="${esc(post.title)}"/>`
          : `<div class="compare-card-ph" style="background:${phBg(post.id)}"><span>${esc(post.make.toUpperCase())}</span></div>`
        }
        <div class="compare-card-overlay">
          ${cats.map(c=>`<span class="cat-badge ${catCfg(c).badge}" style="position:static">${c}</span>`).join(' ')}
        </div>
      </div>
      <div class="compare-card-info">
        <div class="compare-card-title">${esc(post.title)}</div>
        <div class="compare-card-by">by <b class="clickable-user" data-user="${post.user}">${esc(post.user)}</b> · ${post.likes||0} likes</div>
      </div>
    </div>`;
}

function buildCompareTable() {
  const a = S.compareA, b = S.compareB;
  const tbl = el('compareTable');
  if (!a || !b || !tbl) return;
  const rows = [
    { label:'Make',         va: a.make,    vb: b.make    },
    { label:'Model',        va: a.model,   vb: b.model   },
    { label:'Year',         va: a.year,    vb: b.year    },
    { label:'Power',        va: a.hp,      vb: b.hp,       compare: true  },
    { label:'Transmission', va: a.transmission||'—', vb: b.transmission||'—' },
    { label:'Mileage',      va: a.mileage ? Number(a.mileage).toLocaleString()+' mi' : '—', vb: b.mileage ? Number(b.mileage).toLocaleString()+' mi' : '—' },
    { label:'0–60 mph',     va: a.zeroSixty||'—',   vb: b.zeroSixty||'—',   compare: true, lower: true },
    { label:'¼ Mile',       va: a.quarterMile||'—', vb: b.quarterMile||'—', compare: true, lower: true },
    { label:'Top Speed',    va: a.topSpeed||'—',    vb: b.topSpeed||'—',    compare: true  },
    { label:'Likes',        va: a.likes,   vb: b.likes,    compare: true  },
    { label:'Category',     va: (Array.isArray(a.categories)?a.categories:[a.category]).join(', '), vb: (Array.isArray(b.categories)?b.categories:[b.category]).join(', ') },
    { label:'Posted by',    va: a.user,    vb: b.user    },
  ];
  function numOf(v) { return parseFloat(String(v).replace(/[^0-9.]/g,'')) || 0; }
  tbl.style.display = 'block';
  tbl.innerHTML = `
    <div class="compare-table">
      <div class="compare-table-head">
        <div class="ct-col-a">${esc(a.title.length>28?a.title.slice(0,28)+'…':a.title)}</div>
        <div class="ct-col-label"></div>
        <div class="ct-col-b">${esc(b.title.length>28?b.title.slice(0,28)+'…':b.title)}</div>
      </div>
      ${rows.map(r => {
        let winA = '', winB = '';
        if (r.compare && r.va!=='—' && r.vb!=='—') { const na=numOf(r.va), nb=numOf(r.vb); if(na&&nb){ if(r.lower){ if(na<nb) winA='winner'; else if(nb<na) winB='winner'; } else { if(na>nb) winA='winner'; else if(nb>na) winB='winner'; } } }
        return `<div class="ct-row">
          <div class="ct-val ct-val-a ${winA}">${esc(String(r.va||'—'))}</div>
          <div class="ct-label">${r.label}</div>
          <div class="ct-val ct-val-b ${winB}">${esc(String(r.vb||'—'))}</div>
        </div>`;
      }).join('')}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
// ─── WEEKLY CHALLENGES ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const CHALLENGE_THEMES = [
  { id:'c1', title:'Best JDM Build',         desc:'Show us your finest Japanese machine — bone stock or fully built.',   cat:'JDM'       },
  { id:'c2', title:'Wildest Engine Bay',      desc:'Pop the hood. We want to see what\'s lurking underneath.',            cat:null        },
  { id:'c3', title:'Best Euro',               desc:'Precision, power, and elegance. European iron only.',                  cat:'Euro'      },
  { id:'c4', title:'Most Extreme Mods',       desc:'The more outrageous, the better. Stack those mods.',                  cat:null        },
  { id:'c5', title:'Cleanest Classic',        desc:'Pre-1980 cars only. Restoration or patina — judges choice.',          cat:'Classic'   },
  { id:'c6', title:'Off-Road Beast of Week',  desc:'Trail-ready, lifted, and battle-tested. Mud optional.',               cat:'Off-Road'  },
  { id:'c7', title:'Best Drift Machine',      desc:'Built sideways. Angle seekers welcome.',                              cat:'Drift'     },
  { id:'c8', title:'Rarest Find',             desc:'Barn finds, limited editions, and forgotten legends.',                cat:'Collector' },
];

function getCurrentChallenge() {
  // Rotates weekly based on week number
  const week = Math.floor(Date.now() / (7 * 86400000));
  return CHALLENGE_THEMES[week % CHALLENGE_THEMES.length];
}

function getChallengeTimeRemaining() {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Sunday
  weekStart.setHours(0,0,0,0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  const ms = weekEnd.getTime() - now.getTime();
  const days = Math.floor(ms / 86400000);
  const hrs  = Math.floor((ms % 86400000) / 3600000);
  return `${days}d ${hrs}h remaining`;
}

function renderChallenges() {
  const ch = getCurrentChallenge();
  const timerEl = el('challengeTimer');
  if (timerEl) timerEl.innerHTML = '<i class="fas fa-clock" style="margin-right:5px"></i>' + getChallengeTimeRemaining();
  const cur = el('currentChallenge');
  if (cur) {
    cur.innerHTML = `
      <div class="challenge-card">
        <div class="challenge-week-tag">Week of ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
        <h2 class="challenge-title">${ch.title}</h2>
        <p class="challenge-desc">${ch.desc}</p>
        ${ch.cat ? `<span class="cat-badge ${catCfg(ch.cat).badge}" style="position:static;display:inline-block">${ch.cat} only</span>` : '<span class="cat-badge badge-default" style="position:static;display:inline-block">All categories</span>'}
        ${S.user && canInteract() ? `<button class="btn-primary" id="enterChallengeBtn" style="margin-top:16px"><i class="fas fa-plus"></i> Enter This Challenge</button>` : ''}
      </div>`;
    const enterBtn = el('enterChallengeBtn');
    if (enterBtn) enterBtn.addEventListener('click', () => enterChallenge(ch));
  }

  // Entries — posts that match this week's challenge cat, sorted by 🔥 reactions
  let entries = [...S.posts];
  if (ch.cat) entries = entries.filter(p => {
    const cats = Array.isArray(p.categories) ? p.categories : [p.category];
    return cats.includes(ch.cat);
  });
  entries = entries.sort((a,b) => {
    const ar = (a.reactions?.fire||[]).length;
    const br = (b.reactions?.fire||[]).length;
    return br - ar;
  }).slice(0, 12);

  const entriesEl = el('challengeEntries');
  if (entriesEl) {
    entriesEl.innerHTML = `<h3 class="challenge-entries-head">Current Entries <span class="ce-count">${entries.length}</span></h3>` +
      (entries.length
        ? `<div class="card-grid">${entries.map((p,i)=>cardHTML(p,i)).join('')}</div>`
        : '<p class="no-entries">No entries yet — be the first to submit!</p>');
    attachCardEvents(entriesEl);
  }

  // Past winners from localStorage
  const winners = JSON.parse(localStorage.getItem('dl_challenge_winners') || '[]');
  const pw = el('pastWinners');
  if (pw) {
    pw.innerHTML = winners.length
      ? winners.slice(0,5).map(w => `
          <div class="past-winner">
            <div class="pw-av clickable-user" data-user="${w.user}" style="background:${avColor(w.user)}">${w.user[0].toUpperCase()}</div>
            <div><div class="pw-challenge">${w.challenge}</div><div class="pw-user">${esc(w.user)}</div></div>
            <span class="pw-icon"><i class="fas fa-trophy" style="color:var(--gold)"></i></span>
          </div>`).join('')
      : '<p class="no-entries">No past winners yet</p>';
  }
}

function enterChallenge(ch) {
  if (!S.user) { toast('Sign in to enter', 'err'); return; }
  const myPosts = S.posts.filter(p => p.user === S.user.username);
  if (!myPosts.length) { toast('Post a build first to enter!', 'err'); openPostModal(); return; }
  // Check if already entered
  const entries = JSON.parse(localStorage.getItem('dl_challenge_entries')||'[]');
  if (entries.find(e=>e.challengeId===ch.id&&e.user===S.user.username)) {
    toast("You've already entered this challenge",'err'); return;
  }
  // Show inline build picker
  const existing = el('challengeBuildPicker');
  if (existing) { existing.remove(); return; }
  const picker = document.createElement('div');
  picker.id = 'challengeBuildPicker';
  picker.className = 'challenge-picker';
  picker.innerHTML = `
    <div class="challenge-picker-head"><i class="fas fa-car"></i> Select a build to enter</div>
    <div class="challenge-picker-list">
      ${myPosts.map(p=>`
        <div class="challenge-pick-item" data-id="${p.id}">
          <div class="challenge-pick-img">${p.images?.[0]?`<img src="${p.images[0]}" alt=""/>`:''}</div>
          <div class="challenge-pick-info">
            <div class="challenge-pick-title">${esc(p.title)}</div>
            <div class="challenge-pick-sub">${[p.year,p.make,p.model].filter(Boolean).join(' ')}</div>
          </div>
          <i class="fas fa-chevron-right" style="color:var(--muted);margin-left:auto"></i>
        </div>`).join('')}
    </div>
    <button class="btn-ghost small" id="closePicker" style="margin-top:8px;width:100%">Cancel</button>`;
  const enterBtn = el('enterChallengeBtn');
  if (enterBtn) enterBtn.parentNode.insertBefore(picker, enterBtn.nextSibling);
  el('closePicker')?.addEventListener('click', () => picker.remove());
  picker.querySelectorAll('.challenge-pick-item').forEach(item => {
    item.addEventListener('click', () => {
      const post = myPosts.find(p=>p.id===item.dataset.id); if(!post) return;
      entries.push({ challengeId:ch.id, postId:post.id, user:S.user.username, ts:Date.now() });
      localStorage.setItem('dl_challenge_entries', JSON.stringify(entries));
      picker.remove();
      toast(`"${post.title}" entered into the challenge! 🏆`,'ok');
      renderChallenges();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// ─── ADMIN PANEL ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function renderAdmin() {
  // Security: only admin users can access this panel
  if (!S.user || !S.user.isAdmin) {
    const panel = el('adminPanel');
    if (panel) panel.innerHTML = '<div style="padding:60px;text-align:center;color:var(--muted)"><i class="fas fa-lock" style="font-size:2.5rem;margin-bottom:16px;display:block"></i><h3 style="margin-bottom:8px">Admin Access Only</h3><p>You do not have permission to view this page.</p></div>';
    return;
  }
  // Tab switching
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.admin-tab,.admin-panel').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const panel = el('apanel-'+t.dataset.atab);
      if (panel) panel.classList.add('active');
      if (t.dataset.atab==='reports') renderAdminReports();
      if (t.dataset.atab==='posts') renderAdminPosts();
      if (t.dataset.atab==='users') renderAdminUsers();
      if (t.dataset.atab==='activity') renderAdminActivity();
    };
  });
  renderAdminReports();
}

function renderAdminReports() {
  const reports = JSON.parse(localStorage.getItem('dl_reports') || '[]');
  const rb = el('reportsBadge');
  if (rb) { rb.textContent = reports.filter(r=>r.status==='pending').length || ''; }
  const list = el('adminReportsList'); if (!list) return;
  if (!reports.length) { list.innerHTML = '<p class="admin-empty">No reports filed yet.</p>'; return; }
  list.innerHTML = reports.slice().reverse().map(r => {
    const target = r.type === 'post' ? S.posts.find(p=>p.id===r.targetId) : null;
    return `<div class="admin-report-row ${r.status==='resolved'?'resolved':''}">
      <div class="admin-report-info">
        <div class="admin-report-type"><span class="abadge">${r.type}</span> <b>${r.reason}</b></div>
        ${target ? `<div class="admin-report-target">"${esc(target.title)}" by ${esc(target.user)}</div>` : ''}
        ${r.details ? `<div class="admin-report-details">${esc(r.details)}</div>` : ''}
        <div class="admin-report-meta">Reported by ${esc(r.reporter)} · ${timeAgo(r.ts)} · <span class="report-status-${r.status}">${r.status}</span></div>
      </div>
      <div class="admin-report-actions">
        ${r.status==='pending' ? `
          <button class="admin-btn dismiss" data-rid="${r.id}">Dismiss</button>
          ${target ? `<button class="admin-btn remove" data-rid="${r.id}" data-pid="${r.targetId}">Remove Post</button>` : ''}
        ` : ''}
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.admin-btn.dismiss').forEach(b => b.addEventListener('click', () => {
    const rpts = JSON.parse(localStorage.getItem('dl_reports')||'[]');
    const r = rpts.find(x=>x.id===b.dataset.rid); if(r) r.status='resolved';
    localStorage.setItem('dl_reports', JSON.stringify(rpts));
    renderAdminReports(); toast('Report dismissed','ok');
  }));
  list.querySelectorAll('.admin-btn.remove').forEach(b => b.addEventListener('click', () => {
    if (!confirm('Remove this post? This cannot be undone.')) return;
    S.posts = S.posts.filter(p=>p.id!==b.dataset.pid);
    const rpts = JSON.parse(localStorage.getItem('dl_reports')||'[]');
    const r = rpts.find(x=>x.id===b.dataset.rid); if(r) r.status='resolved';
    localStorage.setItem('dl_reports', JSON.stringify(rpts));
    save(); renderAdminReports(); renderFeed();
    toast('Post removed','ok');
  }));
}

function renderAdminPosts() {
  const list = el('adminPostsList'); if (!list) return;
  const botm  = JSON.parse(localStorage.getItem('dl_botm')||'null');
  const atgIds = JSON.parse(localStorage.getItem('dl_atg')||'[]');
  const q = (el('adminPostSearch')?.value||'').toLowerCase();
  const posts = S.posts.filter(p=>!q||p.title.toLowerCase().includes(q)||p.user.toLowerCase().includes(q)).slice(0,30);
  list.innerHTML = posts.map(p => {
    const isBotm = botm?.postId === p.id;
    const isAtg  = atgIds.includes(p.id);
    return `
    <div class="admin-post-row">
      <div class="admin-post-thumb" style="background:${phBg(p.id)}">${p.images?.[0]?`<img src="${p.images[0]}" alt=""/>`:''}</div>
      <div class="admin-post-info">
        <div class="admin-post-title">${esc(p.title)} ${isBotm?'<span class="abadge" style="background:#d97706;color:#fff">BOTM</span>':''} ${isAtg?'<span class="abadge" style="background:#7e22ce;color:#fff">ATG</span>':''}</div>
        <div class="admin-post-meta">by ${esc(p.user)} · ${p.date} · ♥ ${p.likes} · ${(p.comments||[]).length} comments</div>
      </div>
      <div class="admin-post-actions">
        <button class="admin-btn view" data-pid="${p.id}">View</button>
        <button class="admin-btn ${isBotm?'remove':'verify'} admin-set-botm" data-pid="${p.id}" title="${isBotm?'Remove as BOTM':'Set as Build of the Month'}">
          <i class="fas fa-calendar-star"></i> ${isBotm?'Unset BOTM':'Set BOTM'}
        </button>
        <button class="admin-btn ${isAtg?'remove':'verify'} admin-toggle-atg" data-pid="${p.id}" title="${isAtg?'Remove from ATG':'Add to All Time Greats'}">
          <i class="fas fa-medal"></i> ${isAtg?'Remove ATG':'Add ATG'}
        </button>
        <button class="admin-btn remove" data-pid="${p.id}">Remove</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.admin-btn.view').forEach(b=>b.addEventListener('click',()=>{const p=S.posts.find(x=>x.id===b.dataset.pid);if(p)openCarPage(p);}));

  list.querySelectorAll('.admin-set-botm').forEach(b=>b.addEventListener('click',()=>{
    const curr = JSON.parse(localStorage.getItem('dl_botm')||'null');
    if (curr?.postId === b.dataset.pid) {
      localStorage.removeItem('dl_botm');
      toast('Build of the Month removed','ok');
    } else {
      localStorage.setItem('dl_botm', JSON.stringify({postId:b.dataset.pid}));
      toast('Build of the Month set!','ok');
    }
    renderAdminPosts(); renderLbBotm();
  }));

  list.querySelectorAll('.admin-toggle-atg').forEach(b=>b.addEventListener('click',()=>{
    const ids = JSON.parse(localStorage.getItem('dl_atg')||'[]');
    const idx = ids.indexOf(b.dataset.pid);
    if (idx>=0) { ids.splice(idx,1); toast('Removed from All Time Greats','ok'); }
    else { ids.push(b.dataset.pid); toast('Added to All Time Greats!','ok'); }
    localStorage.setItem('dl_atg', JSON.stringify(ids));
    renderAdminPosts(); renderLbAtg();
  }));

  list.querySelectorAll('.admin-btn.remove:not(.admin-set-botm):not(.admin-toggle-atg)').forEach(b=>b.addEventListener('click',()=>{
    if(!confirm('Remove this post?'))return;
    S.posts=S.posts.filter(p=>p.id!==b.dataset.pid); save(); renderAdminPosts(); renderFeed(); toast('Post removed','ok');
  }));

  el('adminPostSearch')?.addEventListener('input', renderAdminPosts);
}

function renderAdminUsers() {
  const list = el('adminUsersList'); if (!list) return;
  // Show loading state
  if (S.users.length <= 1) {
    list.innerHTML = '<p class="admin-empty"><i class="fas fa-spinner fa-spin"></i> Loading all members…</p>';
  }
  // Always refresh from Supabase to get all users
  DB.getAllProfiles().then(profiles => {
    if (profiles.length > 0) {
      S.users = profiles.map(dbUserToApp).filter(Boolean);
      try { localStorage.setItem('dl_users_cache', JSON.stringify(S.users)); } catch(_) {}
    }
    _renderAdminUsersList();
  }).catch(() => _renderAdminUsersList());
}

function _renderAdminUsersList() {
  const list = el('adminUsersList'); if (!list) return;
  list.innerHTML = S.users.map(u => {
    const posts = S.posts.filter(p=>p.user===u.username).length;
    const age = accountAge(u);
    return `<div class="admin-user-row">
      <div class="admin-user-av clickable-user" data-user="${u.username}" style="background:#6b7280">${u.username[0].toUpperCase()}</div>
      <div class="admin-user-info">
        <div class="admin-user-name">${esc(u.username)}</div>
        <div class="admin-user-meta">${posts} posts · ${age.short} old · Joined ${u.joined}</div>
        ${(u.awards||[]).length ? `<div class="admin-user-badges">${(u.awards||[]).map(id=>{const a=getAwardDef(id);return a?`<span title="${a.label}">${a.icon}</span>`:''}).join('')}</div>` : ''}
      </div>
      <div class="admin-user-actions">
        <div class="admin-award-btns">
          ${AWARDS_DEF.map(a => `<button class="admin-btn verify award-grant-btn" data-un="${u.username}" data-aid="${a.id}" title="Grant ${a.label}">${a.icon}</button>`).join('')}
        </div>
        <button class="admin-btn ${u.isFeatured?'remove':'verify'} admin-toggle-featured" data-un="${u.username}" title="${u.isFeatured?'Remove from Featured':'Add to Featured'}">
          <i class="fas fa-star"></i> ${u.isFeatured?'Unfeature':'Feature'}
        </button>
        ${u.avatarUrl ? `<button class="admin-btn remove admin-rm-avatar" data-un="${u.username}" title="Remove profile picture"><i class="fas fa-user-slash"></i></button>` : ''}
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.award-grant-btn').forEach(b=>b.addEventListener('click',()=>grantAward(b.dataset.un, b.dataset.aid)));
  list.querySelectorAll('.admin-toggle-featured').forEach(b=>b.addEventListener('click',()=>toggleFeaturedUser(b.dataset.un)));
  list.querySelectorAll('.admin-rm-avatar').forEach(b=>b.addEventListener('click',()=>{
    if(!confirm(`Remove ${b.dataset.un}'s profile picture?`)) return;
    const u=S.users.find(x=>x.username===b.dataset.un); if(!u) return;
    delete u.avatarUrl;
    if(S.user&&S.user.username===b.dataset.un) { delete S.user.avatarUrl; updateAuthUI(); }
    save(); renderAdminUsers(); updateProfilePage();
    toast('Profile picture removed','ok');
  }));
}

function renderAdminActivity() {
  const act = el('adminActivity'); if (!act) return;
  const now = Date.now();
  const last7 = S.posts.filter(p => (now-new Date(p.date).getTime())<7*86400000).length;
  const last7Users = S.users.filter(u => u.joinedFull && (now-new Date(u.joinedFull).getTime())<7*86400000).length;
  const totalLikes = S.posts.reduce((a,p)=>a+p.likes,0);
  const totalComments = S.posts.reduce((a,p)=>a+(p.comments||[]).length,0);
  act.innerHTML = `
    <div class="admin-stats-grid">
      <div class="admin-stat"><div class="admin-stat-n">${S.posts.length}</div><div class="admin-stat-l">Total Builds</div></div>
      <div class="admin-stat"><div class="admin-stat-n">${S.users.length}</div><div class="admin-stat-l">Total Members</div></div>
      <div class="admin-stat"><div class="admin-stat-n">${last7}</div><div class="admin-stat-l">Posts This Week</div></div>
      <div class="admin-stat"><div class="admin-stat-n">${last7Users}</div><div class="admin-stat-l">New Members This Week</div></div>
      <div class="admin-stat"><div class="admin-stat-n">${totalLikes.toLocaleString()}</div><div class="admin-stat-l">Total Likes</div></div>
      <div class="admin-stat"><div class="admin-stat-n">${totalComments}</div><div class="admin-stat-l">Total Comments</div></div>
    </div>`;
}

// Reactions and compare are wired directly inside renderCarPage above.

// ═══════════════════════════════════════════════════════════════
// ─── DARK/LIGHT TOGGLE IN HEADER ───────────────────────────────
// ═══════════════════════════════════════════════════════════════
function initThemeToggle() {
  const btn = el('themeToggleBtn');
  if (!btn) return;
  syncThemeToggle();
  btn.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark');
    document.body.classList.toggle('light', !isDark);
    // Also remove any leftover opposite class
    if (isDark) document.body.classList.remove('light');
    else document.body.classList.remove('dark');
    // Save to prefs
    const p = JSON.parse(localStorage.getItem('dl_prefs') || '{}');
    p.theme = isDark ? 'dark' : 'light';
    localStorage.setItem('dl_prefs', JSON.stringify(p));
    syncThemeToggle();
  });
}
function syncThemeToggle() {
  const btn = el('themeToggleBtn'); if (!btn) return;
  const isDark = document.body.classList.contains('dark');
  btn.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

// ═══════════════════════════════════════════════════════════════
// ─── SETTINGS REAL-TIME SYNC ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// Listen for storage changes from settings.html tab
window.addEventListener('storage', e => {
  if (e.key === 'dl_prefs') {
    applyPrefs();
    syncThemeToggle();
  }
  // Avatar updated in settings — reload and push to Supabase
  if (e.key === 'dl_avatar_updated' && S.user) {
    // Read the avatar URL directly — settings saves it to dl_avatar_url
    const newAvatarUrl = localStorage.getItem('dl_avatar_url') ||
      JSON.parse(localStorage.getItem('dl_user_cache') || localStorage.getItem('dl_user') || '{}').avatarUrl;
    if (newAvatarUrl) {
      S.user.avatarUrl = newAvatarUrl;
      S.users = S.users.map(u => u.username === S.user.username ? { ...u, avatarUrl: newAvatarUrl } : u);
      cacheAvatarUrl(S.user.username, newAvatarUrl);
      updateAuthUI(); updateProfilePage(); renderFeed();
      // Push to Supabase Storage in background — use dedicated avatar bucket
      if (newAvatarUrl.startsWith('data:')) {
        DB.uploadAvatar(S.user.id, newAvatarUrl).then(res => {
          if (res?.url) {
            S.user.avatarUrl = res.url;
            S.users = S.users.map(u => u.username === S.user.username ? { ...u, avatarUrl: res.url } : u);
            cacheAvatarUrl(S.user.username, res.url);
            localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
            localStorage.setItem('dl_avatar_url', res.url);
            updateAuthUI(); updateProfilePage();
          }
        }).catch(()=>{});
      }
    }
  }
  // Prefs changed in settings — also re-read user in case session was cleared
  if (e.key === 'dl_user_cache' || e.key === 'dl_user') {
    const fresh = JSON.parse(e.newValue || 'null');
    if (fresh && fresh.username) {
      S.user = { ...S.user, ...fresh };
      updateAuthUI(); updateProfilePage();
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// ─── IMAGE COMPRESSION BEFORE UPLOAD ──────────────────────────
// ═══════════════════════════════════════════════════════════════
function compressImage(file, maxW = 1600, quality = 0.90) {
  return new Promise((resolve, reject) => {
    // Use object URL — much faster than FileReader for large files
    const objUrl = URL.createObjectURL(file);
    const img    = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objUrl); // free memory immediately after load
      const canvas = document.createElement('canvas');
      let w = img.naturalWidth  || img.width;
      let h = img.naturalHeight || img.height;
      // Only downscale if needed — never upscale
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      // Enable high-quality image smoothing
      ctx.imageSmoothingEnabled  = true;
      ctx.imageSmoothingQuality  = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };

    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      // Fallback: read as-is via FileReader if object URL fails
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    };

    img.src = objUrl;
  });
}

// Override addFiles to compress before storing
// (addFiles is defined earlier with progress tracking)

// ═══════════════════════════════════════════════════════════════
// ─── FIRST-TIME VISITOR ONBOARDING ────────────────────────────
// ═══════════════════════════════════════════════════════════════
function initOnboarding() {
  if (localStorage.getItem('dl_onboarded')) return;
  if (S.user) { localStorage.setItem('dl_onboarded','1'); return; }
  // Show after 1.5s so the page has loaded
  setTimeout(() => {
    const modal = el('onboardingModal');
    if (modal) modal.classList.add('open');
  }, 1500);
}

function closeOnboarding(action) {
  const modal = el('onboardingModal');
  if (modal) modal.classList.remove('open');
  localStorage.setItem('dl_onboarded', '1');
  if (action === 'register') {
    el('authModal').classList.add('open');
    // Switch to register tab
    document.querySelectorAll('.mtab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'register'));
    document.querySelectorAll('.mform').forEach(x => x.classList.remove('active'));
    const rf = el('registerForm'); if (rf) rf.classList.add('active');
  }
}

// ═══════════════════════════════════════════════════════════════
// ─── BUILD COST TRACKER ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function getCosts(postId) {
  return JSON.parse(localStorage.getItem('dl_costs_' + postId) || '[]');
}
function saveCosts(postId, costs) {
  localStorage.setItem('dl_costs_' + postId, JSON.stringify(costs));
}

function renderCostTracker(post, container) {
  if (!container) return;
  const costs  = getCosts(post.id);
  const total  = costs.reduce((a, c) => a + (parseFloat(c.amount) || 0), 0);
  const isOwner = S.user && post.user === S.user.username;

  container.innerHTML = `
    <div class="cost-tracker">
      <div class="cost-header">
        <span class="cost-title"><i class="fas fa-dollar-sign cost-title-icon"></i> Build Cost Tracker</span>
        <span class="cost-total">Total: <b>$${total.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</b></span>
      </div>
      ${costs.length ? `
        <div class="cost-list">
          ${costs.map((c,i) => `
            <div class="cost-row">
              <span class="cost-cat-badge" style="background:${c.color||'var(--raised)'}"></span>
              <span class="cost-item-name">${esc(c.name)}</span>
              <span class="cost-item-cat">${esc(c.category||'Other')}</span>
              <span class="cost-item-amount">$${parseFloat(c.amount||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
              ${isOwner ? `<button class="cost-rm-btn" data-i="${i}"><i class="fas fa-times"></i></button>` : ''}
            </div>`).join('')}
        </div>` : `<p class="cost-empty">${isOwner?'Add your build costs below.':'No costs listed yet.'}</p>`}
      ${isOwner ? `
        <div class="cost-add-row">
          <input class="finput cost-input" id="costName" placeholder="Item (e.g. Turbocharger)" style="flex:2"/>
          <select class="finput cost-input" id="costCategory" style="flex:1">
            <option value="Engine">Engine</option>
            <option value="Drivetrain">Drivetrain</option>
            <option value="Suspension">Suspension</option>
            <option value="Wheels">Wheels</option>
            <option value="Exterior">Exterior</option>
            <option value="Interior">Interior</option>
            <option value="Labour">Labour</option>
            <option value="Other">Other</option>
          </select>
          <input class="finput cost-input" id="costAmount" type="number" placeholder="$ Amount" step="0.01" min="0" style="flex:1"/>
          <button class="btn-primary small" id="addCostBtn"><i class="fas fa-plus"></i> Add</button>
        </div>` : ''}
    </div>`;

  if (isOwner) {
    el('addCostBtn')?.addEventListener('click', () => {
      const name     = (el('costName')?.value||'').trim();
      const category = el('costCategory')?.value || 'Other';
      const amount   = parseFloat(el('costAmount')?.value || '0');
      if (!name) { toast('Enter an item name', 'err'); return; }
      const catColors = {Engine:'#e8392a',Drivetrain:'#f0a030',Suspension:'#22c55e',Wheels:'#3b82f6',Exterior:'#a855f7',Interior:'#14b8a6',Labour:'#8b5cf6',Other:'#6b7280'};
      const newCosts = [...costs, { name, category, amount, color: catColors[category]||'#6b7280' }];
      saveCosts(post.id, newCosts);
      renderCostTracker(post, container);
    });
    container.querySelectorAll('.cost-rm-btn').forEach(b => b.addEventListener('click', () => {
      const newCosts = costs.filter((_,i) => i !== +b.dataset.i);
      saveCosts(post.id, newCosts);
      renderCostTracker(post, container);
    }));
  }
}

// ─── Wire cost tracker into timeline tab ──────────────────────
function addCostTab(post) {
  const tabsEl  = document.querySelector('.car-page-tabs');
  const panelsEl = document.querySelector('.car-page-tabs-wrap');
  if (!tabsEl || !panelsEl) return;

  // Remove any previously added costs tab so we start fresh each time
  const oldBtn   = tabsEl.querySelector('[data-cptab="costs"]');
  const oldPanel = el('cptab-costs');
  if (oldBtn)   oldBtn.remove();
  if (oldPanel) oldPanel.remove();

  // Add tab button
  const tabBtn = document.createElement('button');
  tabBtn.className      = 'cptab';
  tabBtn.dataset.cptab  = 'costs';
  tabBtn.innerHTML      = '<i class="fas fa-dollar-sign"></i> Build Costs';
  tabsEl.appendChild(tabBtn);

  // Add panel
  const panel    = document.createElement('div');
  panel.id        = 'cptab-costs';
  panel.className = 'cptab-panel';
  panel.style.display = 'none';
  panelsEl.appendChild(panel);

  // Click handler using the already-correct switchCpTab
  tabBtn.addEventListener('click', () => {
    switchCpTab('costs');
    renderCostTracker(post, panel);
  });
}

// Override switchCpTab once to handle the dynamic costs panel
function switchCpTab(tab) {
  document.querySelectorAll('.cptab').forEach(t => t.classList.toggle('active', t.dataset.cptab === tab));
  ['cptab-comments','cptab-timeline','cptab-costs'].forEach(id => {
    const p = el(id);
    if (p) p.style.display = (p.id === 'cptab-' + tab) ? '' : 'none';
  });
  // Also handle legacy panel IDs
  ['dtab-comments','dtab-timeline'].forEach(id => {
    const p = el(id);
    if (p) p.style.display = 'none';
  });
}

// ─── Meta tags helper ─────────────────────────────────────────
function setMetaTags(title, desc, img) {
  document.title = (title || 'DriveLog') + ' — DriveLog';
  const setMeta = (prop, val, attr='property') => {
    let m = document.querySelector(`meta[${attr}="${prop}"]`);
    if (!m) { m = document.createElement('meta'); m.setAttribute(attr, prop); document.head.appendChild(m); }
    m.setAttribute('content', val);
  };
  setMeta('og:title',      title || 'DriveLog');
  setMeta('og:description', desc || 'Check out this build on DriveLog.');
  setMeta('og:image',       img  || 'https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=800');
  setMeta('og:type',        'website');
  setMeta('twitter:card',   'summary_large_image', 'name');
  setMeta('twitter:title',  title || 'DriveLog', 'name');
  setMeta('description',    desc || 'DriveLog — The car community for builders and enthusiasts.', 'name');
}
// ═══════════════════════════════════════════════════════════════
// ─── SOCIAL FEED ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const SOCIAL_PAGE_SIZE = 8;
let socialPage = 0;
let socialTab  = 'foryou';
let socialSentinelObs = null;

function initSocialPage() {
  const uploadBtn = el('socialUploadBtn');
  const zone      = el('socialUploadZone');
  const fileInput = el('socialFileInput');
  const submitBtn = el('socialSubmitBtn');

  // "Post" button on the Car Spotting feed → full composer page
  if (uploadBtn) uploadBtn.addEventListener('click', () => {
    if (!S.user) { toast('Sign in to post','err'); el('authModal').classList.add('open'); return; }
    goTo('spotpost');
  });

  // Back button on the composer page
  el('spotPostBack')?.addEventListener('click', () => goTo('social'));

  // "Change photos" on the details step — restart at the upload step
  // but keep the privacy checkbox accepted (they already agreed).
  el('spotAddMoreBtn')?.addEventListener('click', () => {
    _socialPendingFiles = []; _blurredDataURLs = [];
    _blurImages = []; _blurBoxes = []; _blurImgIdx = 0;
    el('socialUploadZone').style.display = 'block';
    el('csBlurEditor').style.display     = 'none';
    el('csPostForm').style.display       = 'none';
    if (fileInput) fileInput.value = '';
    setSpotStep(1);
  });

  // Privacy acceptance enables the upload zone
  el('csPrivacyAccept')?.addEventListener('change', () => {
    const accepted = el('csPrivacyAccept').checked;
    zone.classList.toggle('cs-enabled', accepted);
  });

  // Zone click — only if accepted
  if (zone) {
    zone.addEventListener('click', () => {
      if (!el('csPrivacyAccept')?.checked) {
        el('csPrivacyAccept').closest('.cs-warn-accept').classList.add('cs-warn-shake');
        setTimeout(() => el('csPrivacyAccept').closest('.cs-warn-accept').classList.remove('cs-warn-shake'), 600);
        return;
      }
      fileInput?.click();
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); if (el('csPrivacyAccept')?.checked) zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      if (!el('csPrivacyAccept')?.checked) return;
      handleSocialFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')));
    });
  }
  if (fileInput) fileInput.addEventListener('change', () =>
    handleSocialFiles(Array.from(fileInput.files).filter(f => f.type.startsWith('image/')))
  );
  if (submitBtn) submitBtn.addEventListener('click', submitSocialPost);

  renderStoryBar();
  renderTrendingTags();

  // Detail modal — closes on X, backdrop click, or Escape
  el('socialDetailClose')?.addEventListener('click', closeSocialDetail);
  el('socialDetailModal')?.addEventListener('click', e => {
    if (e.target === el('socialDetailModal')) closeSocialDetail();
  });

  // Sidebar usernames/avatars → profile (delegated once; buttons excluded)
  const socialPage_ = el('page-social');
  if (socialPage_ && !socialPage_._userNavWired) {
    socialPage_._userNavWired = true;
    socialPage_.addEventListener('click', e => {
      if (e.target.closest('#socialPostsWrap')) return; // cards handle their own
      if (e.target.closest('button')) return;
      const cu = e.target.closest('.clickable-user');
      if (cu?.dataset.user) viewMemberProfile(cu.dataset.user);
    });
  }

  // Feed tabs
  document.querySelectorAll('.soc-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.soc-tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    socialTab = t.dataset.soctab;
    if (socialTab === 'builds') {
      const wrap = el('socialPostsWrap');
      if (wrap) {
        const recBuilds = [...S.posts].sort((a,b)=>new Date(b.createdAt||b.date)-new Date(a.createdAt||a.date)).slice(0,12);
        wrap.innerHTML = recBuilds.length
          ? `<div class="card-grid social-builds-grid">${recBuilds.map((p,i)=>cardHTML(p,i)).join('')}</div>`
          : '<div class="social-empty"><i class="fas fa-car social-empty-icon"></i><h3>No builds yet</h3><p>Builds from the main feed appear here.</p></div>';
        attachCardEvents(wrap); return;
      }
    }
    socialPage = 0;
    const si = el('socialSearchInput');
    if (si) { si.value = ''; S._socialSearchQ = ''; }
    el('socialSearchClear').style.display = 'none';
    renderSocialFeed(true);
  }));

  // Search
  el('socialSearchInput')?.addEventListener('input', () => {
    const q = el('socialSearchInput').value.trim();
    el('socialSearchClear').style.display = q ? 'block' : 'none';
    doSocialSearch();
  });
  el('socialSearchClear')?.addEventListener('click', () => {
    el('socialSearchInput').value = '';
    el('socialSearchClear').style.display = 'none';
    S._socialSearchQ = ''; socialPage = 0;
    renderSocialFeed(true);
  });

  // Infinite scroll — sentinel at the bottom of the spotting feed.
  // When it enters the viewport and more posts exist, load the next page.
  const sentinel = el('socialSentinel');
  if (sentinel && 'IntersectionObserver' in window) {
    socialSentinelObs = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      if (S.page !== 'social' || S._socialSearchQ || socialTab === 'builds') return;
      const total = getSocialPosts().length;
      if (total > (socialPage+1)*SOCIAL_PAGE_SIZE) {
        socialPage++;
        renderSocialFeed(false);
      }
    }, { rootMargin: '400px' });
    socialSentinelObs.observe(sentinel);
  }
}

// ─── SPOT COMPOSER PAGE STATE ─────────────────────────────────
// Steps: 1 = photos (privacy + upload), 2 = blur, 3 = details
function setSpotStep(n) {
  [1,2,3].forEach(i => {
    const s = el('spotStep'+i);
    if (s) { s.classList.toggle('active', i===n); s.classList.toggle('done', i<n); }
  });
}

// Reset the composer to step 1 — called every time the page opens
function resetSpotComposer() {
  const cap = el('socialCaption'); if (cap) cap.value = '';
  const loc = el('spotLocation'); if (loc) loc.value = '';
  const mapOptin = el('spotShareMapLocation'); if (mapOptin) mapOptin.checked = false;
  const prev = el('socialUploadPreview'); if (prev) prev.innerHTML = '';
  _socialPendingFiles = []; _blurredDataURLs = [];
  _blurImages = []; _blurBoxes = []; _blurImgIdx = 0;
  const fi = el('socialFileInput'); if (fi) fi.value = '';
  el('csPrivacyWarn').style.display    = 'block';
  el('socialUploadZone').style.display = 'block';
  el('csBlurEditor').style.display     = 'none';
  el('csPostForm').style.display       = 'none';
  el('csPrivacyAccept').checked        = false;
  el('socialUploadZone').classList.remove('cs-enabled');
  setSpotStep(1);
  // Category pills — click to select, click again to deselect
  el('socialTagPills').innerHTML = CATS.slice(0,12).map(c =>
    `<button type="button" class="post-cat-pill" data-cat="${c.name}" style="font-size:.7rem;padding:4px 11px">
      <i class="${c.fa} pill-icon"></i>${c.name}
    </button>`
  ).join('');
  el('socialTagPills').querySelectorAll('.post-cat-pill').forEach(p => p.addEventListener('click', () => {
    const wasActive = p.classList.contains('active');
    el('socialTagPills').querySelectorAll('.post-cat-pill').forEach(x=>x.classList.remove('active'));
    if (!wasActive) p.classList.add('active');
  }));
}

// ─── BLUR EDITOR ENGINE ───────────────────────────────────────
// Client-side canvas-based blur tool for Car Spotting posts.
// No server, no API, no ML — entirely in the browser.
//
// How it works:
//   - The selected image is drawn onto an HTML <canvas> (#csCanvas)
//   - A transparent overlay canvas (#csOverlay) sits on top and captures
//     mouse/touch drag events to draw the selection rectangle
//   - When the user releases, the selected region is pixelated using
//     applyBlurBox(), which:
//       1. Gets the pixel data for that region
//       2. Draws it onto a tiny canvas (1/pixelSize the original size)
//       3. Draws that tiny canvas back at full size with imageSmoothingEnabled=false
//       4. The result is a "pixelated" / mosaic blur effect
//   - Boxes are stored in _blurBoxes[imageIndex] so Undo/Clear work
//   - applyAllBlurs() processes every image, converts to JPEG, stores in
//     _blurredDataURLs — only these blurred versions are ever uploaded
//
// Pixel size is adaptive: Math.max(8, box_min_dimension / 10)
// So a tiny box gets a finer mosaic, a big box gets coarser pixels.
//
// Multiple images: _blurImages[] holds loaded Image objects,
// _blurBoxes[] is a parallel array of box arrays, one per image.
// _blurImgIdx tracks which image the editor is currently showing.

let _socialPendingFiles  = [];
let _blurredDataURLs     = [];   // final blurred images to upload
let _blurBoxes           = [];   // array of arrays, one per image
let _blurImgIdx          = 0;    // current image being edited
let _blurImages          = [];   // loaded Image objects
let _blurDrawing         = false;
let _blurStartX = 0, _blurStartY = 0;

function handleSocialFiles(files) {
  if (!files.length) return;
  _socialPendingFiles = files.slice(0, 6);
  _blurImages = [];
  _blurBoxes  = _socialPendingFiles.map(() => []);
  _blurredDataURLs = [];
  _blurImgIdx = 0;

  // Hide upload zone, show blur editor
  el('socialUploadZone').style.display = 'none';
  el('csPrivacyWarn').style.display    = 'none';
  el('csBlurEditor').style.display     = 'block';
  el('csPostForm').style.display       = 'none';
  setSpotStep(2);

  // Load all images first, then show editor for first one
  let loaded = 0;
  _socialPendingFiles.forEach((f, i) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e2 => {
      img.onload = () => {
        _blurImages[i] = img;
        loaded++;
        if (loaded === _socialPendingFiles.length) {
          initBlurEditor(_blurImgIdx);
        }
      };
      img.src = e2.target.result;
    };
    reader.readAsDataURL(f);
  });
}

function initBlurEditor(idx) {
  _blurImgIdx = idx;
  const img     = _blurImages[idx];
  if (!img) return;
  const canvas  = el('csCanvas');
  const overlay = el('csOverlay');
  const wrap    = el('csCanvasWrap');
  if (!canvas || !overlay || !wrap) return;

  // Size canvas to fit modal width, maintain aspect ratio
  const maxW = Math.min(720, window.innerWidth - 48); // full-page composer allows a wider canvas
  const scale = maxW / img.naturalWidth;
  const displayW = Math.round(img.naturalWidth  * scale);
  const displayH = Math.round(img.naturalHeight * scale);
  canvas.width    = overlay.width    = img.naturalWidth;
  canvas.height   = overlay.height   = img.naturalHeight;
  canvas.style.width  = overlay.style.width  = displayW + 'px';
  canvas.style.height = overlay.style.height = displayH + 'px';
  wrap.style.width  = displayW + 'px';
  wrap.style.height = displayH + 'px';

  // Draw base image
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // Re-draw saved boxes for this image
  redrawBlurBoxes(idx);

  // Multi-image navigation
  const nav = el('csBlurNav');
  if (_socialPendingFiles.length > 1) {
    nav.style.display = 'flex';
    el('csImgCount').textContent = `${idx+1} / ${_socialPendingFiles.length}`;
  } else {
    nav.style.display = 'none';
  }

  // Wire drag-to-blur on overlay canvas
  wireBlurCanvas(overlay, canvas, displayW, displayH);
}

function wireBlurCanvas(overlay, canvas, dW, dH) {
  // Remove old listeners by replacing element
  const fresh = overlay.cloneNode(true);
  overlay.parentNode.replaceChild(fresh, overlay);
  const ov = el('csOverlay');
  const ctx = canvas.getContext('2d');
  const scaleX = canvas.width  / dW;
  const scaleY = canvas.height / dH;
  let curBox = null;

  function getPos(e) {
    const rect = ov.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left)  * scaleX,
      y: (clientY - rect.top)   * scaleY,
    };
  }

  function startDraw(e) {
    e.preventDefault();
    _blurDrawing = true;
    const p = getPos(e);
    _blurStartX = p.x; _blurStartY = p.y;
    curBox = { x:p.x, y:p.y, w:0, h:0 };
  }
  function moveDraw(e) {
    if (!_blurDrawing || !curBox) return;
    e.preventDefault();
    const p = getPos(e);
    curBox.w = p.x - _blurStartX;
    curBox.h = p.y - _blurStartY;
    // Draw rubber-band rect on overlay
    const ovCtx = ov.getContext('2d');
    ovCtx.clearRect(0, 0, ov.width, ov.height);
    ovCtx.strokeStyle = '#3b82f6';
    ovCtx.lineWidth = 2;
    ovCtx.setLineDash([6,3]);
    ovCtx.strokeRect(_blurStartX, _blurStartY, curBox.w, curBox.h);
    ovCtx.fillStyle = 'rgba(59,130,246,.12)';
    ovCtx.fillRect(_blurStartX, _blurStartY, curBox.w, curBox.h);
  }
  function endDraw(e) {
    if (!_blurDrawing || !curBox) return;
    _blurDrawing = false;
    const p = e.changedTouches ? {
      x: (e.changedTouches[0].clientX - ov.getBoundingClientRect().left) * scaleX,
      y: (e.changedTouches[0].clientY - ov.getBoundingClientRect().top)  * scaleY,
    } : getPos(e);
    curBox.w = p.x - _blurStartX;
    curBox.h = p.y - _blurStartY;
    // Only save if box has meaningful size
    if (Math.abs(curBox.w) > 8 && Math.abs(curBox.h) > 8) {
      _blurBoxes[_blurImgIdx].push({ ...curBox });
      redrawBlurBoxes(_blurImgIdx);
    }
    const ovCtx = ov.getContext('2d');
    ovCtx.clearRect(0, 0, ov.width, ov.height);
    curBox = null;
  }

  ov.addEventListener('mousedown',  startDraw, { passive: false });
  ov.addEventListener('mousemove',  moveDraw,  { passive: false });
  ov.addEventListener('mouseup',    endDraw);
  ov.addEventListener('mouseleave', endDraw);
  ov.addEventListener('touchstart', startDraw, { passive: false });
  ov.addEventListener('touchmove',  moveDraw,  { passive: false });
  ov.addEventListener('touchend',   endDraw,   { passive: false });
}

function redrawBlurBoxes(idx) {
  const canvas = el('csCanvas');
  const img    = _blurImages[idx];
  if (!canvas || !img) return;
  const ctx = canvas.getContext('2d');
  // Redraw clean image first
  ctx.drawImage(img, 0, 0);
  // Apply each blur box via pixelation
  (_blurBoxes[idx] || []).forEach(box => {
    applyBlurBox(ctx, box);
  });
}

function applyBlurBox(ctx, box) {
  // Normalize negative width/height boxes
  let { x, y, w, h } = box;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  if (w < 4 || h < 4) return;

  // Pixelation blur — sample pixels at low res and scale back up
  // Pixel size controls how strong the blur is
  const pixelSize = Math.max(8, Math.round(Math.min(w, h) / 10));
  const imgData = ctx.getImageData(x, y, w, h);
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width  = w;
  tempCanvas.height = h;
  const tc = tempCanvas.getContext('2d');
  tc.putImageData(imgData, 0, 0);

  // Draw tiny version then scale back up (pixelation effect)
  const smallW = Math.max(1, Math.floor(w / pixelSize));
  const smallH = Math.max(1, Math.floor(h / pixelSize));
  tc.drawImage(tempCanvas, 0, 0, smallW, smallH);

  // Scale back up with no smoothing = blocky pixelation
  tc.imageSmoothingEnabled = false;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tempCanvas, 0, 0, smallW, smallH, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

// Wire toolbar buttons
document.addEventListener('DOMContentLoaded', () => {
  el('csToolUndo')?.addEventListener('click', () => {
    if (_blurBoxes[_blurImgIdx]?.length) {
      _blurBoxes[_blurImgIdx].pop();
      redrawBlurBoxes(_blurImgIdx);
    }
  });
  el('csToolClear')?.addEventListener('click', () => {
    _blurBoxes[_blurImgIdx] = [];
    redrawBlurBoxes(_blurImgIdx);
  });
  el('csPrevImg')?.addEventListener('click', () => {
    if (_blurImgIdx > 0) initBlurEditor(_blurImgIdx - 1);
  });
  el('csNextImg')?.addEventListener('click', () => {
    if (_blurImgIdx < _blurImages.length - 1) initBlurEditor(_blurImgIdx + 1);
  });
  el('csApplyBlur')?.addEventListener('click', applyAllBlurs);
});

async function applyAllBlurs() {
  const btn = el('csApplyBlur');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying…'; }

  _blurredDataURLs = [];
  for (let i = 0; i < _blurImages.length; i++) {
    // Apply blur to each image
    const img = _blurImages[i];
    // Blur at full resolution first so the boxes land exactly where drawn
    const full = document.createElement('canvas');
    full.width = img.naturalWidth; full.height = img.naturalHeight;
    const fctx = full.getContext('2d');
    fctx.drawImage(img, 0, 0);
    (_blurBoxes[i] || []).forEach(box => applyBlurBox(fctx, box));
    // Then downscale to max 1080px wide (Instagram standard) —
    // keeps uploads small and every post consistent
    let out = full;
    if (full.width > 1080) {
      const scale = 1080 / full.width;
      out = document.createElement('canvas');
      out.width = 1080; out.height = Math.round(full.height * scale);
      out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
    }
    _blurredDataURLs.push(out.toDataURL('image/jpeg', 0.88));
  }

  // Update preview strip
  const preview = el('socialUploadPreview');
  if (preview) {
    preview.innerHTML = _blurredDataURLs.map((url, i) =>
      `<div class="cs-preview-item">
        <img src="${url}" class="cs-preview-img" alt="Photo ${i+1}"/>
        <span class="cs-preview-label">Photo ${i+1}</span>
      </div>`
    ).join('');
  }

  // Show post form
  el('csBlurEditor').style.display = 'none';
  el('csPostForm').style.display   = 'block';
  setSpotStep(3);

  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Apply Blur & Continue'; }
}

async function submitSocialPost() {
  if (!S.user) { toast('Sign in to post','err'); return; }
  let caption   = el('socialCaption')?.value.trim() || '';
  const tag     = el('socialTagPills')?.querySelector('.post-cat-pill.active')?.dataset.cat || '';
  // Location is stored as a 📍 line appended to the caption — schema-safe
  // (no new column needed) and renders naturally on the card.
  const spotLoc = el('spotLocation')?.value.trim() || '';
  if (spotLoc) caption = caption ? caption + '\n📍 ' + spotLoc : '📍 ' + spotLoc;

  // Precise GPS coordinates for the Spotting Map — strictly opt-in via the
  // checkbox, never captured silently. Best-effort: if permission is
  // denied, times out, or isn't supported, we just skip it and post
  // normally rather than blocking on it.
  let mapCoords = null;
  if (el('spotShareMapLocation')?.checked && navigator.geolocation) {
    mapCoords = await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { timeout: 8000, maximumAge: 300000 }
      );
    });
  }

  const hasContent = caption.length > 0 || _blurredDataURLs.length > 0;
  if (!hasContent) { toast('Add a caption or photo to share','err'); return; }
  const btn     = el('socialSubmitBtn');
  const progBar = el('socialUploadProgress');
  if (btn) { btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Posting…'; }
  if (progBar) { progBar.style.display='block'; progBar.value=10; }

  // Upload blurred images to Supabase Storage.
  // Skip failures — never embed base64 in the social_posts table.
  const mediaItems = [];
  let failedSpots = 0;
  for (let i = 0; i < _blurredDataURLs.length; i++) {
    const result = await DB.uploadSpottingImage(S.user.id, _blurredDataURLs[i], i);
    if (result && result.url) mediaItems.push({ type:'image', url: result.url });
    else failedSpots++;
    if (progBar) progBar.value = 10 + Math.round(((i+1)/_blurredDataURLs.length)*70);
  }
  if (failedSpots) toast(`${failedSpots} photo(s) failed to upload and were skipped`, 'err');
  // If every photo failed AND there's no caption, don't create an empty post
  if (!mediaItems.length && !caption) {
    if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Post to Car Spotting'; }
    if (progBar) { progBar.style.display='none'; progBar.value=0; }
    toast('Post failed — no photos uploaded. Please try again.','err');
    return;
  }
  if (progBar) progBar.value = 85;

  const postId = 'sp' + Date.now();
  const postData = {
    id: postId, caption, tag,
    media: mediaItems,
    liked_by: [], likes: 0,
    comments: [], reactions: {},
    lat: mapCoords?.lat ?? null,
    lng: mapCoords?.lng ?? null,
    location_name: spotLoc || null,
  };

  // Save to Supabase
  const { error } = await DB.createSocialPost(S.user.id, S.user.username, postData);
  if (error) {
    console.warn('Social post save failed, storing locally:', error);
    // Fallback: store locally if Supabase fails
    const stored = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
    stored.unshift({ ...postData, user: S.user.username, ts: Date.now(), date: new Date().toISOString().slice(0,10) });
    localStorage.setItem('dl_social_posts', JSON.stringify(stored));
  }
  // Show the new post at the top of the feed immediately —
  // the background refetch in renderSocialFeed will confirm it.
  S._socialPosts = [
    dbSocialToApp({ ...postData, username: S.user.username, user_id: S.user.id, ts: Date.now() }),
    ...(S._socialPosts||[]),
  ].filter(Boolean);
  if (!S._activeSpotters) S._activeSpotters = new Set();
  S._activeSpotters.add(S.user.username);

  if (progBar) { progBar.value=100; setTimeout(()=>{ progBar.style.display='none'; progBar.value=0; },400); }
  _socialPendingFiles = []; _blurredDataURLs = [];
  if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Post to Car Spotting'; }
  toast('Posted to Car Spotting ✓','ok');
  socialPage=0;
  goTo('social');
}


// Convert Supabase social_posts row to app format
// Handles both Supabase rows (snake_case) and legacy localStorage posts (camelCase)
function dbSocialToApp(row) {
  if (!row) return null;
  return {
    id:       row.id,
    user:     row.username || row.user || '',
    user_id:  row.user_id  || null,
    caption:  row.caption  || '',
    tag:      row.tag      || '',
    media:    row.media    || [],
    likes:    row.likes    || 0,
    likedBy:  row.liked_by || row.likedBy || [],
    comments: row.comments || [],
    reactions:row.reactions|| {},
    ts:       row.ts || (row.created_at ? new Date(row.created_at).getTime() : Date.now()),
    date:     row.date || (row.created_at||'').slice(0,10),
    lat:          row.lat          ?? null,
    lng:          row.lng          ?? null,
    locationName: row.location_name || '',
  };
}

// getSocialPosts — merge Supabase posts with any local-only fallbacks
// S._socialPosts is populated by renderSocialFeed after Supabase fetch
const SPOT_STORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours, same convention as Instagram/Snapchat stories

// Unlike getSocialPosts(), this ignores the current Car Spotting page's
// tab filter (For You/Following/Builds) — it needs to answer "does this
// person have an active Car Spotting post" correctly from ANY page on the
// site, not just while looking at a particular feed tab.
function hasActiveSpotStory(username) {
  if (!username) return false;
  // Preferred source — fetched at boot, works on every page immediately,
  // not just after visiting Car Spotting.
  if (S._activeSpotters) return S._activeSpotters.has(username);
  // Fallback for the brief window before that boot fetch resolves, or if
  // it failed — uses whatever social post data we already have in memory.
  const posts = S._socialPosts?.length
    ? S._socialPosts
    : JSON.parse(localStorage.getItem('dl_social_posts')||'[]').map(dbSocialToApp).filter(Boolean);
  const cutoff = Date.now() - SPOT_STORY_WINDOW_MS;
  return posts.some(p => p.user === username && p.ts > cutoff);
}

// Adds/removes the gradient "story ring" class on an avatar element,
// depending on whether that user currently has an active Car Spotting
// post. Called from setAvEl() so every avatar rendered through the normal
// DOM-update path gets this automatically, site-wide.
function setStoryRing(domEl, username) {
  if (!domEl) return;
  const active = hasActiveSpotStory(username);
  domEl.classList.toggle('has-story-ring', active);
  // The ring extends outside the avatar's own box, but avatar elements
  // have overflow:hidden (to clip photos into a circle) — which silently
  // clipped the ring off entirely. The photo/SVG inside clips itself to a
  // circle independently (the <img> has its own border-radius, the
  // fallback SVG draws its own circle), so relaxing overflow here doesn't
  // risk a square photo peeking out.
  domEl.style.overflow = active ? 'visible' : '';
}

function getSocialPosts() {
  // Use in-memory cache if available (populated from Supabase)
  if (S._socialPosts?.length) {
    if (socialTab === 'following' && S.user)
      return S._socialPosts.filter(p => S.following.includes(p.user) || p.user === S.user.username);
    return S._socialPosts;
  }
  // Fallback to localStorage (posts created before Supabase migration)
  const stored = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
  if (socialTab === 'following' && S.user)
    return stored.filter(p => S.following.includes(p.user) || p.user === S.user.username);
  return stored;
}

function renderSocialFeed(reset) {
  if (reset) socialPage=0;
  const wrap = el('socialPostsWrap'); if (!wrap) return;
  if (S._socialSearchQ) { doSocialSearch(); return; }

  renderStoryBar();

  // Paint whatever we already have in memory instantly
  const cached = getSocialPosts();
  if (cached.length) {
    const slice = cached.slice(0, (socialPage+1)*SOCIAL_PAGE_SIZE);
    wrap.innerHTML = `<div class="social-discover-grid">${slice.map(p => renderSocialGridCard(p)).join('')}</div>`;
    bindSocialGridEvents(wrap);
  } else if (reset) {
    wrap.innerHTML = '';
  }

  // Fetch fresh from Supabase — handle missing table gracefully
  DB.getSocialPosts({ limit: SOCIAL_PAGE_SIZE * (socialPage+1) + 1 }).then(rows => {
    const sbPosts   = (rows||[]).map(dbSocialToApp).filter(Boolean);
    const localOnly = JSON.parse(localStorage.getItem('dl_social_posts')||'[]').map(dbSocialToApp).filter(Boolean);
    const merged    = [...sbPosts];
    localOnly.forEach(lp => { if (!merged.find(sp => sp.id === lp.id)) merged.push(lp); });
    merged.sort((a,b) => b.ts - a.ts);
    S._socialPosts = merged;

    if (!merged.length) {
      wrap.innerHTML = `<div class="social-empty">
        <i class="fas fa-camera-retro social-empty-icon"></i>
        <h3>No spots yet</h3>
        <p>Be the first to share a car you spotted.</p>
        ${S.user ? '<button class="btn-primary" onclick="goTo(\'spotpost\')"><i class="fas fa-camera"></i> Post a Spot</button>' : ''}
      </div>`;
      renderStoryBar();
      return;
    }

    const visible = getSocialPosts().slice(0, (socialPage+1)*SOCIAL_PAGE_SIZE);
    wrap.innerHTML = `<div class="social-discover-grid">${visible.map(p => renderSocialGridCard(p)).join('')}</div>`;
    bindSocialGridEvents(wrap);
    renderTrendingTags();
    renderStoryBar();
  }).catch(err => {
    console.warn('Social posts fetch failed (table may not exist yet):', err?.message || err);
    if (!cached.length) {
      wrap.innerHTML = `<div class="social-empty">
        <i class="fas fa-camera-retro social-empty-icon"></i>
        <h3>Car Spotting</h3>
        <p>Run <b>social_posts_migration.sql</b> in Supabase to enable cross-device posts.</p>
        ${S.user ? '<button class="btn-primary" onclick="goTo(\'spotpost\')"><i class="fas fa-camera"></i> Post Locally</button>' : ''}
      </div>`;
    }
  });
}

function renderSocialEventsPreview() {
  const el2 = el('socialEventsPreview'); if (!el2) return;
  const events = (S.events || []).slice(0,3);
  if (!events.length) {
    el2.innerHTML = '<p class="social-sidebar-empty">No events yet.</p>';
    return;
  }
  el2.innerHTML = events.map(e => `
    <div class="social-event-preview" onclick="goTo('events')">
      <div class="sep-date">${fmtDate(e.date)}</div>
      <div class="sep-name">${esc(e.title)}</div>
      <div class="sep-loc"><i class="fas fa-map-marker-alt"></i> ${esc(e.location||'TBD')}</div>
    </div>`).join('');
}

function renderSuggestedFollows(containerId) {
  const container = el(containerId); if (!container) return;
  if (!S.user) { container.innerHTML=''; return; }
  const suggestions = S.users
    .filter(u => u.username !== S.user.username && !S.following.includes(u.username))
    .sort((a,b) => (b.totalLikes||0)-(a.totalLikes||0))
    .slice(0,5);
  if (!suggestions.length) {
    container.innerHTML = '<p class="social-sidebar-empty">You\'re following everyone!</p>';
    return;
  }
  container.innerHTML = suggestions.map(u => `
    <div class="social-wtf-item">
      ${renderAv(u.username, 38, 'clickable-user social-wtf-av')}
      <div class="social-wtf-info clickable-user" data-user="${u.username}">
        <div class="social-wtf-name">${esc(u.username)}</div>
        <div class="social-wtf-sub">${u.posts||0} builds</div>
      </div>
      <button class="social-follow-pill${S.following.includes(u.username)?' active':''}"
        data-user="${u.username}">
        ${S.following.includes(u.username)?'Following':'Follow'}
      </button>
    </div>`).join('');
  container.querySelectorAll('.social-follow-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleFollow(btn.dataset.user);
      const following = S.following.includes(btn.dataset.user);
      btn.textContent = following ? 'Following' : 'Follow';
      btn.classList.toggle('active', following);
    });
  });
}


// Trending Tags widget — computed from ALL spot posts (Supabase +
// legacy local), counts both #hashtags in captions and category tags.
// Renders into #socialTags (the widget in the right sidebar).
// Tags are clickable → runs a search for that tag.
function renderTrendingTags() {
  const box = el('socialTags'); if (!box) return;
  const allPosts = (S._socialPosts?.length)
    ? S._socialPosts
    : JSON.parse(localStorage.getItem('dl_social_posts')||'[]').map(dbSocialToApp).filter(Boolean);
  const counts = {};
  allPosts.forEach(p => {
    ((p.caption||'').match(/#[\w]+/g)||[]).forEach(t => { const k=t.toLowerCase(); counts[k]=(counts[k]||0)+1; });
    if (p.tag && p.tag !== 'All') { const k='#'+p.tag.toLowerCase().replace(/\s+/g,''); counts[k]=(counts[k]||0)+1; }
  });
  const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if (!sorted.length) {
    box.innerHTML = '<p class="social-sidebar-empty">No tags yet. Use #hashtags in your captions!</p>';
    return;
  }
  box.innerHTML = sorted.map(([tag,count]) =>
    `<button class="social-trend-tag" data-tag="${esc(tag)}">
      <span class="social-trend-name">${esc(tag)}</span>
      <span class="social-trend-count">${count}</span>
    </button>`).join('');
  box.querySelectorAll('.social-trend-tag').forEach(b => b.addEventListener('click', () => {
    if (S.page !== 'social') goTo('social');
    const si = el('socialSearchInput');
    if (si) { si.value = b.dataset.tag.replace('#',''); el('socialSearchClear').style.display='block'; doSocialSearch(); }
  }));
}

// ─── BIO WORD LIMIT ────────────────────────────────────────────
function truncateBio(bio, charLimit=150) {
  if (!bio) return '';
  const trimmed = bio.trim();
  if (trimmed.length<=charLimit) return trimmed;
  return trimmed.slice(0,charLimit).trim()+'…';
}

// ═══════════════════════════════════════════════════════════════
// ─── UPLOAD SUCCESS POPUP ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function showUploadSuccess(post) {
  // Remove any existing popup
  const existing = el('uploadSuccessPopup');
  if (existing) existing.remove();

  const img = post?.images?.[0] || null;
  const popup = document.createElement('div');
  popup.id = 'uploadSuccessPopup';
  popup.className = 'upload-success-overlay';
  popup.innerHTML = `
    <div class="upload-success-box">
      <div class="upload-success-check">
        <i class="fas fa-check"></i>
      </div>
      ${img ? `<div class="upload-success-thumb"><img src="${img}" alt=""/></div>` : ''}
      <h2 class="upload-success-title">Build Posted!</h2>
      <p class="upload-success-sub">Your build is now live on DriveLog and visible to the community.</p>
      ${post?.title ? `<div class="upload-success-build-name">${esc(post.title)}</div>` : ''}
      <div class="upload-success-actions">
        <button class="btn-primary" id="usViewBuild">View Build</button>
        <button class="btn-ghost" id="usGoHome">Back to Feed</button>
      </div>
    </div>`;

  document.body.appendChild(popup);
  // Animate in
  requestAnimationFrame(() => popup.classList.add('open'));

  // Wire buttons
  el('usViewBuild')?.addEventListener('click', () => {
    popup.classList.remove('open');
    setTimeout(() => { popup.remove(); if (post?.id) { const p=S.posts.find(x=>x.id===post.id); if(p) openCarPage(p); } }, 250);
  });
  el('usGoHome')?.addEventListener('click', () => {
    popup.classList.remove('open');
    setTimeout(() => popup.remove(), 250);
  });
  // Auto-dismiss after 8s
  setTimeout(() => {
    if (el('uploadSuccessPopup')) {
      popup.classList.remove('open');
      setTimeout(() => popup.remove(), 250);
    }
  }, 8000);
}

// ─── WHATS NEW PAGE ────────────────────────────────────────────
function renderWhatsNew() {
  // Page is static HTML — nothing dynamic to render yet
  // Future: load updates from Supabase, pull live events feed
}

// Re-sync user state when returning from settings tab
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  syncFromSettingsCache();
});

// pageshow fires when returning via history.back() — more reliable than visibilitychange
window.addEventListener('pageshow', e => {
  if (e.persisted) {
    // Page was restored from bfcache (browser back button)
    syncFromSettingsCache();
  }
});

function syncFromSettingsCache() {
  try {
    const cached = JSON.parse(localStorage.getItem('dl_user_cache') || localStorage.getItem('dl_user') || 'null');
    if (cached && cached.username) {
      // Always prefer locally-saved avatar
      const localAvatar = localStorage.getItem('dl_avatar_url') || cached.avatarUrl;
      if (S.user) {
        S.user = { ...S.user, ...cached, avatarUrl: localAvatar || S.user.avatarUrl };
        S.users = S.users.map(u => u.username === S.user.username ? { ...u, ...S.user } : u);
      } else {
        S.user = { ...cached, avatarUrl: localAvatar || cached.avatarUrl };
        const userInList = S.users.find(u => u.username === cached.username);
        if (!userInList) S.users.push(S.user);
        else S.users = S.users.map(u => u.username === S.user.username ? { ...u, ...S.user } : u);
      }
      updateAuthUI(); updateProfilePage();
    }
    applyPrefs(); syncThemeToggle();
  } catch(e) {}
}

// ─── PROFILE MEDIA SECTION ────────────────────────────────────
function renderProfileMedia(username) {
  const section = el('profileMediaSection');
  const grid    = el('profileMediaGrid');
  if (!section || !grid) return;
  const allSocial = JSON.parse(localStorage.getItem('dl_social_posts') || '[]');
  const userPosts = allSocial.filter(p => p.user === username);
  if (!userPosts.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  grid.innerHTML = userPosts.map(p => {
    const media = p.media?.[0];
    const thumb = media
      ? (media.type === 'video'
          ? `<div class="pm-thumb pm-video"><i class="fas fa-play"></i></div>`
          : `<img src="${media.url}" alt="" class="pm-thumb-img"/>`)
      : `<div class="pm-thumb pm-no-media"><i class="fas fa-comment"></i></div>`;
    return `<div class="pm-item">
      ${thumb}
      ${p.caption ? `<div class="pm-caption">${esc(p.caption.slice(0,60))}${p.caption.length>60?'…':''}</div>` : ''}
      <div class="pm-meta">${timeAgo(p.ts)} · ${p.likes||0} likes</div>
    </div>`;
  }).join('');
}

// ─── SOCIAL SEARCH ────────────────────────────────────────────
function doSocialSearch() {
  const q = el('socialSearchInput')?.value.trim().toLowerCase() || '';
  if (!q) {
    S._socialSearchQ = '';
    socialPage = 0;
    renderSocialFeed(true);
    return;
  }
  S._socialSearchQ = q;
  // Search everything we know about: Supabase posts + legacy local posts
  const allPosts = (S._socialPosts?.length)
    ? S._socialPosts
    : JSON.parse(localStorage.getItem('dl_social_posts')||'[]').map(dbSocialToApp).filter(Boolean);
  const results = allPosts.filter(p => {
    const caption = (p.caption||'').toLowerCase();
    const tags    = (p.tag||'').toLowerCase();
    const user    = (p.user||'').toLowerCase();
    return caption.includes(q) || tags.includes(q) || user.includes(q);
  });
  const wrap = el('socialPostsWrap'); if (!wrap) return;
  if (!results.length) {
    wrap.innerHTML = `<div class="social-no-results"><i class="fas fa-search"></i><p>No posts found for "<b>${esc(q)}</b>"</p></div>`;
    return;
  }
  wrap.innerHTML = `<div class="social-discover-grid">${results.map(p => renderSocialGridCard(p)).join('')}</div>`;
  bindSocialGridEvents(wrap);
}

// Handle browser/mobile back button
window.addEventListener('popstate', e => {
  const page = e.state?.page || 'home';
  // Don't push another history entry — just switch page
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const pageEl = el('page-'+page);
  if (pageEl) { pageEl.classList.add('active'); S.page = page; }
  // Close mob nav if open
  el('mobNav') && el('mobNav').classList.remove('open');
  el('mobOverlay') && el('mobOverlay').classList.remove('open');
  document.body.style.overflow = '';
});

// ─── SOCIAL CARD HELPERS (used by search) ─────────────────────
// Render a spot caption: escape, linkify #hashtags, style 📍 location lines
function socialCaptionHTML(caption) {
  if (!caption) return '';
  const lines = caption.split('\n').map(line => {
    const escd = esc(line);
    const linked = escd.replace(/#([\w]+)/g, '<span class="soc-hashtag" data-tag="#$1">#$1</span>');
    if (line.trim().startsWith('📍')) {
      return `<span class="soc-post-location"><i class="fas fa-map-marker-alt"></i> ${linked.replace('📍','').trim()}</span>`;
    }
    return linked;
  });
  return lines.join('<br/>');
}

// ─── STORY BAR — horizontal-scrolling profile bubbles (Snapchat-style) ──
// Shows your own bubble first (tap → post a new spot), then one bubble per
// distinct recent poster, most-recent-first. Tapping someone else's bubble
// opens their profile via the existing global [data-user] click handler —
// no extra click wiring needed for that part.
function renderStoryBar() {
  const bar = el('storyBar'); if (!bar) return;
  const posts = getSocialPosts();
  const seenUsers = new Set();
  const posters = [];
  let ownHasPost = false;
  posts.forEach(p => {
    if (!p.user) return;
    if (p.user === S.user?.username) { ownHasPost = true; return; }
    if (seenUsers.has(p.user)) return;
    seenUsers.add(p.user);
    posters.push(p.user);
  });

  const ownBubble = `
    <div class="story-bubble story-bubble-own${(S.user && ownHasPost) ? ' has-story' : ''}" id="storyBubbleOwn">
      <div class="story-bubble-ring">
        ${S.user ? renderAv(S.user.username, 64, 'story-bubble-av-inner') : `<div style="width:100%;height:100%;border-radius:50%;overflow:hidden;background:transparent">${_defaultAvSVG()}</div>`}
        <div class="story-bubble-own-plus"><i class="fas fa-plus"></i></div>
      </div>
      <span class="story-bubble-name">${S.user ? 'You' : 'Post'}</span>
    </div>`;

  const otherBubbles = posters.slice(0, 20).map(u => `
    <div class="story-bubble clickable-user" data-user="${esc(u)}">
      <div class="story-bubble-ring">${renderAv(u, 64, 'story-bubble-av-inner')}</div>
      <span class="story-bubble-name">${esc(u)}</span>
    </div>`).join('');

  bar.innerHTML = ownBubble + otherBubbles;

  const ownEl = el('storyBubbleOwn');
  if (ownEl) ownEl.addEventListener('click', () => {
    if (!S.user) { toast('Sign in to post','err'); el('authModal').classList.add('open'); return; }
    goTo('spotpost');
  });
}

// Compact 4:5 thumbnail card for the discover grid — tapping opens the
// full rich card (comments, carousel, etc.) in the detail modal.
function renderSocialGridCard(p) {
  if (!p) return '';
  const media = (p.media||[]).filter(Boolean);
  const first = media[0];
  const isVideo = first?.type === 'video';
  const thumbSrc = first?.url || '';
  const badge = media.length > 1
    ? '<div class="social-grid-multi-badge"><i class="fas fa-clone"></i></div>'
    : (isVideo ? '<div class="social-grid-multi-badge"><i class="fas fa-play"></i></div>' : '');
  const mediaTag = thumbSrc
    ? (isVideo
        ? `<video src="${thumbSrc}" muted playsinline preload="metadata"></video>`
        : `<img src="${thumbSrc}" alt="" loading="lazy"/>`)
    : `<div style="width:100%;height:100%;background:${phBg(p.id)}"></div>`;
  return `<div class="social-grid-card" data-id="${p.id}">
    ${mediaTag}
    ${badge}
    <div class="social-grid-card-overlay">
      <span class="social-grid-card-user">${esc(p.user)}</span>
      <span class="social-grid-card-likes"><i class="fas fa-heart"></i> ${(p.likedBy||[]).length}</span>
    </div>
  </div>`;
}

function bindSocialGridEvents(wrap) {
  if (!wrap) return;
  wrap.querySelectorAll('.social-grid-card').forEach(card => {
    card.addEventListener('click', () => openSocialDetail(card.dataset.id));
    // Video thumbnails show a black box until a frame is grabbed
    const video = card.querySelector('video');
    if (video) video.addEventListener('loadedmetadata', () => { video.currentTime = video.duration * 0.1; }, { once:true });
  });
}

// Opens the full rich card (same one used everywhere else — comments,
// carousel, like/delete/report — nothing lost by moving to a grid+modal
// layout) in a modal when a discover-grid thumbnail is tapped.
function openSocialDetail(id) {
  const post = findSocialPost(id);
  if (!post) return;
  const content = el('socialDetailContent');
  const modal = el('socialDetailModal');
  if (!content || !modal) return;
  content.innerHTML = renderSocialCard(post);
  bindSocialCardEvents(content);
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSocialDetail() {
  const modal = el('socialDetailModal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function renderSocialCard(p) {
  if (!p) return '';
  const media   = (p.media||[]).filter(Boolean);
  const avUrl   = getAvatarUrl(p.user);
  const avHTML  = avUrl
    ? `<div class="soc-av has-photo clickable-user" data-user="${p.user}"><img src="${avUrl}" alt="" class="av-photo"/></div>`
    : `<div class="soc-av clickable-user" data-user="${p.user}" style="background:${avColor(p.user)}">${(p.user||'?')[0].toUpperCase()}</div>`;
  const cats = (p.tag && p.tag !== 'All') ? `<span class="cat-badge ${catCfg(p.tag).badge}" style="position:static">${p.tag}</span>` : '';
  const isOwn = S.user && (p.user === S.user.username || (p.user_id && p.user_id === S.user.id));
  const canDelete = isOwn || S.user?.isAdmin;
  const menu = (canDelete
    ? `<button class="soc-post-del" data-id="${p.id}" title="Delete post"><i class="fas fa-trash-alt"></i></button>` : '')
    + `<button class="soc-post-close" id="socDetailCloseBtn" title="Close"><i class="fas fa-times"></i></button>`;

  // Media: uniform 4:5 frame (1080x1350 — Instagram post format).
  // Multiple photos become a swipeable carousel with arrows + dots.
  const mediaHTML = media.length ? `<div class="soc-post-media-wrap">
    <div class="soc-carousel" data-count="${media.length}">
      <div class="soc-carousel-track">${media.map((m,i) =>
        m.type==='video'
          ? `<div class="soc-slide"><video src="${m.url}" class="soc-slide-media" muted playsinline preload="metadata" controls></video></div>`
          : `<div class="soc-slide" data-idx="${i}"><img src="${m.url}" alt="" class="soc-slide-media" loading="lazy"/></div>`
      ).join('')}</div>
      ${media.length > 1 ? `
        <button class="soc-car-arrow soc-car-prev" style="display:none"><i class="fas fa-chevron-left"></i></button>
        <button class="soc-car-arrow soc-car-next"><i class="fas fa-chevron-right"></i></button>
        <div class="soc-car-count">1/${media.length}</div>
        <div class="soc-car-dots">${media.map((_,i)=>`<span class="soc-car-dot${i===0?' active':''}"></span>`).join('')}</div>` : ''}
    </div>
  </div>` : '';

  const comments = p.comments || [];
  const commentsListHTML = comments.length
    ? comments.map(c => socialCommentHTML(c)).join('')
    : '<p class="social-no-comments">No comments yet — be the first.</p>';

  return `<article class="social-post-card soc-detail-layout" data-id="${p.id}">
    <div class="soc-detail-media">
      ${mediaHTML}
    </div>
    <div class="soc-detail-info">
      <div class="soc-post-head">
        ${avHTML}
        <div class="soc-post-head-info">
          <span class="soc-post-user clickable-user" data-user="${p.user}">${esc(p.user)}</span>
          <span class="soc-post-time">${timeAgo(p.ts)}</span>
        </div>
        ${cats}
        ${menu}
      </div>
      <div class="soc-detail-scroll">
        ${p.caption ? `<div class="soc-caption-row">
          ${avHTML}
          <div class="soc-caption-text"><span class="soc-post-user clickable-user" data-user="${p.user}">${esc(p.user)}</span> ${socialCaptionHTML(p.caption)}</div>
        </div>` : ''}
        <div class="soc-comments-list" id="scl-${p.id}">${commentsListHTML}</div>
      </div>
      <div class="soc-post-actions">
        <button class="soc-like-btn${(p.likedBy||[]).includes(S.user?.username)?' active':''}" data-id="${p.id}">
          <i class="fas fa-heart"></i> <span>${(p.likedBy||[]).length}</span>
        </button>
        <button class="soc-comment-btn" data-id="${p.id}"><i class="fas fa-comment"></i> <span>${comments.length}</span></button>
      </div>
      ${S.user ? `<div class="soc-comment-input-row">
        ${renderAv(S.user.username, 28, 'soc-comment-my-av')}
        <input type="text" class="soc-comment-input" data-id="${p.id}" maxlength="300" placeholder="Add a comment…"/>
        <button class="soc-comment-send" data-id="${p.id}" title="Post comment"><i class="fas fa-paper-plane"></i></button>
      </div>` : '<p class="soc-comment-signin">Sign in to comment</p>'}
    </div>
  </article>`;
}

function socialCommentHTML(c) {
  const avUrl = getAvatarUrl(c.user);
  const ring = hasActiveSpotStory(c.user) ? ' has-story-ring' : '';
  const av = avUrl
    ? `<span class="social-comment-av has-photo clickable-user${ring}" data-user="${c.user}"><img src="${avUrl}" alt="" class="av-photo"/></span>`
    : `<span class="social-comment-av clickable-user${ring}" data-user="${c.user}" style="background:${avColor(c.user)}">${(c.user||'?')[0].toUpperCase()}</span>`;
  return `<div class="social-comment-item">
    ${av}
    <div class="social-comment-body"><b class="clickable-user" data-user="${c.user}">${esc(c.user)}</b> ${esc(c.text)}</div>
    <span class="social-comment-time">${timeAgo(c.ts)}</span>
  </div>`;
}

// Find a spot post in every place we keep them
function findSocialPost(id) {
  return (S._socialPosts||[]).find(p=>p.id===id)
    || JSON.parse(localStorage.getItem('dl_social_posts')||'[]').map(dbSocialToApp).find(p=>p&&p.id===id);
}

function bindSocialCardEvents(wrap) {
  if (!wrap) return;

  // ── Close (now lives inside the header row itself, to the right of
  // the trash icon — used to float outside the card entirely) ──
  wrap.querySelector('#socDetailCloseBtn')?.addEventListener('click', closeSocialDetail);

  // ── Likes (optimistic) ──
  wrap.querySelectorAll('.soc-like-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!S.user) { toast('Sign in to like','err'); el('authModal').classList.add('open'); return; }
      const liked = btn.classList.contains('active');
      btn.classList.toggle('active', !liked);
      const countEl = btn.querySelector('span');
      if (countEl) countEl.textContent = Math.max(0, parseInt(countEl.textContent||'0') + (liked ? -1 : 1));
      DB.toggleSocialLike(btn.dataset.id, S.user.username).catch(()=>{});
      // Notify the post owner (only on like, not unlike, never self)
      if (!liked) {
        const sp0 = findSocialPost(btn.dataset.id);
        if (sp0?.user_id && sp0.user !== S.user.username) {
          DB.pushNotification(sp0.user_id, 'like', S.user.username, 'liked your spot', 'page:social').catch(()=>{});
        }
      }
      const all = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
      const post = all.find(p=>p.id===btn.dataset.id);
      if (post) {
        if (liked) post.likedBy = (post.likedBy||[]).filter(u=>u!==S.user.username);
        else post.likedBy = [...(post.likedBy||[]), S.user.username];
        post.likes = (post.likedBy||[]).length;
        localStorage.setItem('dl_social_posts', JSON.stringify(all));
      }
      if (S._socialPosts) {
        const sp = S._socialPosts.find(p=>p.id===btn.dataset.id);
        if (sp) {
          if (liked) sp.likedBy = (sp.likedBy||[]).filter(u=>u!==S.user.username);
          else sp.likedBy = [...(sp.likedBy||[]), S.user.username];
          sp.likes = (sp.likedBy||[]).length;
        }
      }
    });
  });

  // ── Comments: focus the input (comments are always visible now) ──
  wrap.querySelectorAll('.soc-comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelector(`.soc-comment-input[data-id="${btn.dataset.id}"]`)?.focus();
    });
  });

  // ── Comments: submit ──
  function sendComment(id, inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    if (!S.user) { toast('Sign in to comment','err'); return; }
    const comment = { user: S.user.username, text, ts: Date.now() };
    inputEl.value = '';
    // Optimistic: append to the list + bump the count
    const list = el('scl-'+id);
    if (list) {
      if (list.querySelector('.social-no-comments')) list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', socialCommentHTML(comment));
      list.scrollTop = list.scrollHeight;
    }
    const countSpan = wrap.querySelector(`.soc-comment-btn[data-id="${id}"] span`);
    if (countSpan) countSpan.textContent = parseInt(countSpan.textContent||'0') + 1;
    // Update every store
    const sp = (S._socialPosts||[]).find(p=>p.id===id);
    if (sp) sp.comments = [...(sp.comments||[]), comment];
    const all = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
    const lp = all.find(p=>p.id===id);
    if (lp) { lp.comments = [...(lp.comments||[]), comment]; localStorage.setItem('dl_social_posts', JSON.stringify(all)); }
    DB.addSocialComment(id, comment).catch(()=>{});
    // Notify the post owner (never self)
    const owner = findSocialPost(id);
    if (owner?.user_id && owner.user !== S.user.username) {
      const preview = text.length > 40 ? text.slice(0,40)+'…' : text;
      DB.pushNotification(owner.user_id, 'comment', S.user.username, 'commented on your spot: "'+preview+'"', 'page:social').catch(()=>{});
    }
  }
  wrap.querySelectorAll('.soc-comment-send').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = wrap.querySelector(`.soc-comment-input[data-id="${btn.dataset.id}"]`);
      if (input) sendComment(btn.dataset.id, input);
    });
  });
  wrap.querySelectorAll('.soc-comment-input').forEach(input => {
    input.addEventListener('keydown', e => { if (e.key==='Enter') sendComment(input.dataset.id, input); });
  });

  // ── Delete own post (admins can delete any) ──
  wrap.querySelectorAll('.soc-post-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!S.user) return;
      if (!confirm('Delete this spot? This cannot be undone.')) return;
      const card = wrap.querySelector(`.social-post-card[data-id="${id}"]`);
      if (card) { card.style.opacity='.4'; card.style.pointerEvents='none'; }
      const post = findSocialPost(id);
      const isMine = post && (post.user === S.user.username || post.user_id === S.user.id);
      try {
        // Admins deleting someone else's post use the unfiltered call;
        // owners use the user-scoped call. Promise.resolve guards the
        // "Supabase not ready" path which returns undefined.
        const res = await Promise.resolve(
          (!isMine && S.user.isAdmin)
            ? DB.adminDeleteSocialPost(id)
            : DB.deleteSocialPost(id, S.user.id)
        );
        if (res?.error) throw res.error;
      } catch(e) {
        // If it only exists locally, deleting locally below still works;
        // otherwise surface the failure.
        const existsLocally = JSON.parse(localStorage.getItem('dl_social_posts')||'[]').some(p=>p.id===id);
        if (!existsLocally) {
          if (card) { card.style.opacity=''; card.style.pointerEvents=''; }
          toast('Delete failed — try again','err');
          return;
        }
      }
      // Remove from every local store + the DOM
      S._socialPosts = (S._socialPosts||[]).filter(p=>p.id!==id);
      const all = JSON.parse(localStorage.getItem('dl_social_posts')||'[]').filter(p=>p.id!==id);
      localStorage.setItem('dl_social_posts', JSON.stringify(all));
      card?.remove();
      toast('Spot deleted','ok');
      renderTrendingTags();
    });
  });

  // ── Media: carousel nav + single click = lightbox, double = like ──
  wrap.querySelectorAll('.social-post-card').forEach(card => {
    const id = card.dataset.id;
    const post = findSocialPost(id);
    const imgUrls = (post?.media||[]).filter(m=>m && m.type!=='video').map(m=>m.url);
    let clickTimer = null, lastTap = 0;

    function likeViaDouble() {
      const mediaWrap = card.querySelector('.soc-post-media-wrap');
      if (mediaWrap) {
        const h = document.createElement('div');
        h.className = 'soc-heart-burst';
        h.innerHTML = '<i class="fas fa-heart"></i>';
        mediaWrap.appendChild(h);
        setTimeout(() => h.remove(), 900);
      }
      if (!S.user) { toast('Sign in to like','err'); el('authModal').classList.add('open'); return; }
      const likeBtn = card.querySelector('.soc-like-btn');
      if (likeBtn && !likeBtn.classList.contains('active')) likeBtn.click();
    }

    // Carousel state
    const carousel = card.querySelector('.soc-carousel');
    if (carousel) {
      const track = carousel.querySelector('.soc-carousel-track');
      const slides = carousel.querySelectorAll('.soc-slide');
      const dots  = carousel.querySelectorAll('.soc-car-dot');
      const prev  = carousel.querySelector('.soc-car-prev');
      const next  = carousel.querySelector('.soc-car-next');
      const count = carousel.querySelector('.soc-car-count');
      let cur = 0;

      function goSlide(n) {
        cur = Math.max(0, Math.min(slides.length-1, n));
        track.style.transform = `translateX(-${cur*100}%)`;
        dots.forEach((d,i)=>d.classList.toggle('active', i===cur));
        if (prev) prev.style.display = cur===0 ? 'none' : '';
        if (next) next.style.display = cur===slides.length-1 ? 'none' : '';
        if (count) count.textContent = `${cur+1}/${slides.length}`;
        // Pause any videos not on screen
        carousel.querySelectorAll('video').forEach(v => { if (!slides[cur].contains(v)) v.pause(); });
      }
      prev?.addEventListener('click', e => { e.stopPropagation(); goSlide(cur-1); });
      next?.addEventListener('click', e => { e.stopPropagation(); goSlide(cur+1); });

      // Touch swipe
      let touchX = null;
      carousel.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, {passive:true});
      carousel.addEventListener('touchend', e => {
        if (touchX === null) return;
        const dx = e.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) > 40) goSlide(cur + (dx < 0 ? 1 : -1));
      }, {passive:true});

      // Image taps: single = lightbox, double = like
      carousel.querySelectorAll('.soc-slide img').forEach((img, idx) => {
        img.addEventListener('dblclick', e => {
          e.preventDefault();
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          likeViaDouble();
        });
        img.addEventListener('click', () => {
          const now = Date.now();
          if (now - lastTap < 300) {
            lastTap = 0;
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            likeViaDouble();
            return;
          }
          lastTap = now;
          if (clickTimer) clearTimeout(clickTimer);
          clickTimer = setTimeout(() => {
            clickTimer = null;
            if (imgUrls.length) openLightbox(imgUrls, Math.min(idx, imgUrls.length-1));
          }, 280);
        });
      });
    }
  });

  // ── Usernames + avatars → profile (delegated, once per wrap) ──
  if (!wrap._userNavWired) {
    wrap._userNavWired = true;
    wrap.addEventListener('click', e => {
      const cu = e.target.closest('.clickable-user');
      if (cu?.dataset.user) viewMemberProfile(cu.dataset.user);
    });
  }

  // ── Hashtag click → search ──
  wrap.querySelectorAll('.soc-hashtag').forEach(tag => {
    tag.addEventListener('click', () => {
      const si = el('socialSearchInput');
      if (si) { si.value = tag.dataset.tag.replace('#',''); el('socialSearchClear').style.display='block'; doSocialSearch(); window.scrollTo({top:0,behavior:'smooth'}); }
    });
  });
}

