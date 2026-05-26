/* ============================================================
   DRIVELOG — APP.JS   (v2 — optimized, polished, age-gated)
   ============================================================ */
'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────
const MIN_ACCOUNT_AGE_DAYS = 0;
const BOTW_WINDOW_MS       = 7 * 24 * 60 * 60 * 1000;
const FEED_PAGE_SIZE       = 12;

// ─── STATE ────────────────────────────────────────────────────
const S = {
  user: null, posts: [], users: [], events: [],
  page: 'home', filter: 'All', sort: 'newest',
  visibleCount: FEED_PAGE_SIZE, evtFilter: 'All', memberSort: 'likes',
  openPost: null, galleryIdx: 0, lbImages: [], lbIdx: 0,
  following: [], notifs: [],
  filters: { categories:[], make:"", yearMin:1940, yearMax:2026, hp:0, likes:0, media:"", build:"" },
  dms: {},           // { otherUsername: [{from,text,ts},...] }
  openDm: null,      // username of active conversation
  openCarPost: null, // post shown on car page
  compareA: null, compareB: null,
  infiniteScrollObserver: null,
  _editingPostId: null,
};

// ─── BOOT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  showBootLoader();
  applyPrefs();
  initHeader(); initMobileNav(); initSearch(); initAuth();
  initPostModal(); initCarModal(); initLightbox();
  initGarage(); initEvents(); initMembers(); initNavLinks(); initFilterSidebar(); initMessages(); initCarPage();
  initReactions(); initReport(); initCompare(); initInfiniteScroll(); initSocialPage(); initThemeToggle();

  // ── Phase 1: Load cache instantly, render right away ──────
  loadFromCache();
  renderAll();
  // Show auth state from cache immediately — no flicker
  updateAuthUI(); updateNotifBadge();
  hideBootLoader();

  // ── Phase 2: Refresh from Supabase in background ──────────
  const prevUsername = S.user?.username;
  await loadStorage();
  renderAll();
  // Only update auth UI if user state actually changed
  updateAuthUI(); updateNotifBadge();
  if (S.user) setupRealtimeSubscriptions();

  // Fade in hero video if present
  const heroVid = document.querySelector('.hero-bg-video');
  if (heroVid && heroVid.src) {
    heroVid.addEventListener('canplay', () => heroVid.classList.add('loaded'), { once:true });
  }
});

function loadFromCache() {
  try {
    const cp = localStorage.getItem('dl_posts_cache');
    const cu = localStorage.getItem('dl_users_cache');
    const uu = localStorage.getItem('dl_user_cache');
    if (cp) S.posts = JSON.parse(cp);
    if (cu) S.users = JSON.parse(cu);
    if (uu) S.user  = JSON.parse(uu);
    if (!cp) S._loading = true; // no cache — show skeletons
  } catch(_) {}
}

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
  const cachedUser = (() => {
    try { return JSON.parse(localStorage.getItem('dl_user_cache') || localStorage.getItem('dl_user') || 'null'); } catch(_) { return null; }
  })();

  // ── Fire EVERYTHING in parallel — don't wait for auth before fetching posts ──
  const [sessionResult, postsResult, usersResult, evtsResult] = await Promise.allSettled([

    // Session restore (may be slow on cold start — runs in parallel now)
    DB.getSession(),

    // Posts — render immediately when they arrive
    DB.getPosts({ limit: 60 }).then(rows => {
      const freshPosts = rows.map(dbPostToApp).filter(Boolean);
      freshPosts.forEach(fp => {
        const local = S.posts.find(p => p.id === fp.id);
        if (local) {
          if ((local.likedBy||[]).length > (fp.likedBy||[]).length) fp.likedBy = local.likedBy;
          if ((local.savedBy||[]).length > (fp.savedBy||[]).length) fp.savedBy = local.savedBy;
        }
      });
      S.posts = freshPosts;
      S._loading = false;
      try { localStorage.setItem('dl_posts_cache', JSON.stringify(S.posts)); } catch(_) {}
      renderFeed(); renderSidebar(); renderBOTW(); renderHotPanel(); animateStats();
      return rows;
    }),

    DB.getAllProfiles(),
    DB.getEvents(),
  ]);

  // Process session result (now that it's done)
  if (sessionResult.status === 'fulfilled' && sessionResult.value) {
    const session  = sessionResult.value;
    const authUser = dbUserToApp(session);
    if (cachedUser && cachedUser.username === authUser.username) {
      S.user = { ...authUser, ...cachedUser, id: authUser.id };
    } else {
      S.user = authUser;
    }
    localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
    localStorage.setItem('dl_user', JSON.stringify(S.user));
  } else if (sessionResult.status === 'fulfilled' && !sessionResult.value) {
    S.user = null;
    localStorage.removeItem('dl_user_cache');
    localStorage.removeItem('dl_user');
  }

  if (usersResult.status === 'fulfilled') {
    S.users = usersResult.value.map(dbUserToApp).filter(Boolean);
    try { localStorage.setItem('dl_users_cache', JSON.stringify(S.users)); } catch(_) {}
    // Cache avatar URLs for instant display on next load
    S.users.forEach(u => { if (u.avatarUrl) cacheAvatarUrl(u.username, u.avatarUrl); });
    if (S.user) {
      const fresh = S.users.find(u => u.username === S.user.username);
      if (fresh) {
        const localAvatar = localStorage.getItem('dl_avatar_url') || S.user.avatarUrl || null;
        S.user = {
          ...fresh,
          ...S.user,
          avatarUrl:  localAvatar || fresh.avatarUrl || null,
          bio:        S.user.bio       || fresh.bio       || '',
          instagram:  S.user.instagram || fresh.instagram || '',
          tiktok:     S.user.tiktok    || fresh.tiktok    || '',
          youtube:    S.user.youtube   || fresh.youtube   || '',
          website:    S.user.website   || fresh.website   || '',
          location:   S.user.location  || fresh.location  || '',
          id:         fresh.id         || S.user.id,
          isAdmin:    fresh.isAdmin    || S.user.isAdmin  || false,
          awards:     (fresh.awards||[]).length ? fresh.awards : (S.user.awards || []),
        };
        localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
        localStorage.setItem('dl_user', JSON.stringify(S.user));
        updateAuthUI();
      }
    }
  }

  if (evtsResult.status === 'fulfilled') {
    S.events = evtsResult.value.map(e => ({
      id:e.id, title:e.title, type:e.type, location:e.location,
      date:e.date, time:e.time||'', description:e.description||'',
      host:e.host_username, capacity:e.capacity||null, attendees:e.attendees||[],
    }));
  }

  // ── STEP 4: Per-user data (only if logged in) ──────────────
  if (S.user) {
    const [followResult, notifResult] = await Promise.allSettled([
      DB.getFollowing(S.user.id),
      DB.getNotifications(S.user.id),
    ]);
    if (followResult.status === 'fulfilled') S.following = followResult.value;
    if (notifResult.status === 'fulfilled') {
      S.notifs = notifResult.value.map(n => ({
        id:n.id, type:n.type, from:n.from_username, msg:n.message,
        link:n.link||null, time:new Date(n.created_at).getTime(), read:n.read,
      }));
    }
  }
}

let _saveTimer;
// save() is kept for legacy calls but most writes go direct via DB.*
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
    if (p.accent) setAccent(p.accent);
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
function showBootLoader() {
  let bl = el('bootLoader');
  if (!bl) {
    bl = document.createElement('div');
    bl.id = 'bootLoader';
    bl.innerHTML = `<div class="boot-logo">DRIVE<span>LOG</span></div><div class="boot-dots"><span></span><span></span><span></span></div>`;
    document.body.appendChild(bl);
  }
  bl.style.display = 'flex';
}
function hideBootLoader() {
  const bl = el('bootLoader');
  if (bl) { bl.style.opacity='0'; bl.style.pointerEvents='none'; setTimeout(()=>bl.remove(),400); }
}

// ─── REALTIME SUBSCRIPTIONS ────────────────────────────────────
let _realtimeSubs = [];
function setupRealtimeSubscriptions() {
  // Clean up existing
  _realtimeSubs.forEach(sub => { try { sub.unsubscribe?.(); } catch(_) {} });
  _realtimeSubs = [];
  if (!S.user) return;
  // New messages — update DM badge
  const msgSub = DB.subscribeToMessages(S.user.id, () => updateDmBadge());
  // New notifications
  const notifSub = DB.subscribeToNotifications(S.user.id, payload => {
    if (payload.new) {
      S.notifs.unshift({ id:payload.new.id, type:payload.new.type, from:payload.new.from_username, msg:payload.new.message, link:payload.new.link||null, time:new Date(payload.new.created_at).getTime(), read:false });
      updateNotifBadge();
    }
  });
  _realtimeSubs.push(msgSub, notifSub);
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
  const ddChal = el('ddChallenges'); if(ddChal) ddChal.addEventListener('click', ()=>goTo('challenges'));
  const ddCmp = el('ddCompare'); if(ddCmp) ddCmp.addEventListener('click', ()=>goTo('compare'));
  const ddAdm = el('ddAdmin'); if(ddAdm) ddAdm.addEventListener('click', ()=>goTo('admin'));
  el('profileSignInBtn')?.addEventListener('click', ()=>el('authModal').classList.add('open'));
  el('profilePostBtn')?.addEventListener('click', openPostModal);
  const wl = document.querySelector('.widget-link[data-page="events"]');
  if (wl) wl.addEventListener('click', e=>{e.preventDefault();goTo('events');});
}

function goTo(page) {
  S.page = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = el('page-'+page);
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-link,.mob-link').forEach(a => a.classList.toggle('active', a.dataset.page===page));
  window.scrollTo({top:0, behavior:'auto'});
  closeMobNav();
  // Push state so mobile back button works
  try { window.history.pushState({ page }, '', '#'+page); } catch(_) {}
  if (page==='profile')     updateProfilePage();
  if (page==='leaderboard') renderLeaderboard();
  if (page==='garage')      renderGarage();
  if (page==='events')      renderEventsGrid();
  if (page==='members')     renderMembers();
  if (page==='social')      renderSocialFeed(true);
  if (page==='messages')    renderMessages();
  if (page==='whatsnew')    renderWhatsNew();
  if (page==='compare')     renderComparePage();
  if (page==='admin')       renderAdmin();
  updateDmBadge();
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
    // Don't intercept avatar dropdowns, DM chat head, message conv list, or new DM result list
    if (el2.id === 'avChip' || el2.closest('.av-drop') || el2.closest('.msg-chat-head') || el2.closest('.msg-conv-item') || el2.closest('.msg-new-result')) return;
    e.stopPropagation();
    viewPublicProfile(username);
  });
  el('avChip')?.addEventListener('click', e=>{e.stopPropagation(); el('avDrop').classList.toggle('open'); el('notifDrop').classList.remove('open');});
  el('notifBtn')?.addEventListener('click', e=>{e.stopPropagation(); el('notifDrop').classList.toggle('open'); el('avDrop').classList.remove('open'); renderNotifList();});
  document.addEventListener('click', ()=>{el('avDrop').classList.remove('open'); el('notifDrop').classList.remove('open');});
  el('avDrop')?.addEventListener('click',    e=>e.stopPropagation());
  el('notifDrop')?.addEventListener('click', e=>e.stopPropagation());
  el('notifClear')?.addEventListener('click', () => {
    S.notifs.forEach(n => n.read = true);
    save();
    updateNotifBadge();
    // Clear the visible list immediately — all are read, show empty state
    el('notifList').innerHTML = '<div class="notif-empty"><i class="fas fa-check-circle" style="color:var(--green);font-size:1.4rem"></i><p>All caught up!</p></div>';
  });
}

function updateAuthUI() {
  updateDmBadge();
  if (S.user) {
    el('openAuthBtn').style.display='none'; el('avWrap').style.display='block';
    const avCircleEl = el('avCircle');
    const avatarUrl = getAvatarUrl(S.user.username);
    if (avatarUrl) {
      avCircleEl.innerHTML = `<img src="${avatarUrl}" alt="" class="av-photo"/>`;
      avCircleEl.style.background = 'transparent';
    } else {
      avCircleEl.innerHTML = S.user.username[0].toUpperCase();
      avCircleEl.style.background = avColor(S.user.username);
    }
    el('avName').textContent = S.user.username;
    // Admin panel — only visible to admin users
    const ddAdm = el('ddAdmin');
    if (ddAdm) ddAdm.style.display = S.user.isAdmin ? '' : 'none';
    const mobAdm = document.querySelector('.mob-link[data-page="admin"]');
    if (mobAdm) mobAdm.style.display = S.user.isAdmin ? '' : 'none';
  } else {
    el('openAuthBtn').style.display=''; el('avWrap').style.display='none';
    const ddAdm = el('ddAdmin');
    if (ddAdm) ddAdm.style.display = 'none';
  }
}

// ─── MOBILE NAV ───────────────────────────────────────────────
function initMobileNav() {
  function openMobNav() {
    el('mobNav')?.classList.add('open');
    el('mobOverlay')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeMobNav() {
    el('mobNav')?.classList.remove('open');
    el('mobOverlay')?.classList.remove('open');
    document.body.style.overflow = '';
  }
  el('hamburger')?.addEventListener('click', openMobNav);
  el('mobNavClose')?.addEventListener('click', closeMobNav);
  el('mobOverlay')?.addEventListener('click', closeMobNav);
  el('mobClose')?.addEventListener('click', closeMobNav);
  el('mobOverlay')?.addEventListener('click', closeMobNav);
}
function closeMobNav() { el('mobNav').classList.remove('open'); el('mobOverlay').classList.remove('open'); document.body.style.overflow=''; }

// ─── ANIMATED STATS ───────────────────────────────────────────
function animateStats() {
  const tl = S.posts.reduce((a,p)=>a+p.likes,0);
  countUp('statBuilds',S.posts.length,1200); countUp('statMembers',S.users.length,1500); countUp('statLikes',tl,1800);
  renderFeaturedMembers();
}

function renderFeaturedMembers() {
  const strip    = el('featuredMembersStrip');
  const avatarsEl = el('featuredMembersAvatars');
  if (!strip || !avatarsEl) return;
  const featured = S.users.filter(u => u.isFeatured);
  if (!featured.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  const MAX_SHOW = 5;
  const shown = featured.slice(0, MAX_SHOW);
  const extra = featured.length - MAX_SHOW;
  avatarsEl.innerHTML = shown.map(u => {
    const url = getAvatarUrl(u.username);
    const bg  = url ? 'transparent' : avColor(u.username);
    const img = url ? `<img src="${url}" alt="" class="av-photo"/>` : u.username[0].toUpperCase();
    return `<div class="fm-av clickable-user" data-user="${u.username}" title="${esc(u.username)}" style="background:${bg}">${img}</div>`;
  }).join('') + (extra > 0
    ? `<div class="fm-av fm-av-more" onclick="goTo('members')">+${Math.min(extra,9)}${extra>=9?'+':''}</div>`
    : '');
  strip.addEventListener('click', e => {
    if (!e.target.closest('.clickable-user') && !e.target.closest('.fm-av-more')) goTo('members');
  });
}
function countUp(id,target,dur) {
  const node=el(id); if(!node)return;
  const s=performance.now();
  const tick=now=>{const t=Math.min((now-s)/dur,1); node.textContent=Math.floor(target*(1-Math.pow(1-t,3))).toLocaleString(); if(t<1)requestAnimationFrame(tick);};
  requestAnimationFrame(tick);
}

// ─── BUILD OF THE WEEK ────────────────────────────────────────
// Ranks the top 5 posts by whether they were posted within the last 7 days (priority),
// then by total likes — so new posts with rising engagement surface first,
// while community classics anchor the carousel when fresh content is scarce.
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
  const top5=getBotwPosts(), slidesEl=el('botwSlides'), dotsEl=el('botwDots');
  if (!slidesEl||!top5.length) return;
  let cur=0, timer;

  slidesEl.innerHTML=top5.map((p,i)=>{
    const cfg=catCfg(p.category), img=p.images?.[0];
    return `<div class="botw-slide${i===0?' active':''}" data-id="${p.id}">
      ${img?`<img src="${img}" alt="" loading="lazy"/>`:`<div class="botw-ph" style="background:${phBg(p.id)}"><span>${p.make.toUpperCase()}</span></div>`}
      <div class="botw-overlay"></div>
      <div class="botw-badge"><i class="fas fa-star"></i> Featured</div>
      <div class="botw-rank">${i+1}</div>
      <div class="botw-info">
        <div class="botw-title">${p.title}</div>
        <div class="botw-meta"><span>by <span class="clickable-user" data-user="${p.user}">${p.user}</span></span><span class="botw-likes">♥ ${p.likes.toLocaleString()}</span><span class="cat-badge ${cfg.badge}">${p.category}</span></div>
      </div></div>`;
  }).join('');

  dotsEl.innerHTML=top5.map((_,i)=>`<div class="botw-dot${i===0?' active':''}" data-i="${i}"></div>`).join('');

  function go(idx) {
    slidesEl.querySelectorAll('.botw-slide').forEach((s,i)=>s.classList.toggle('active',i===idx));
    dotsEl.querySelectorAll('.botw-dot').forEach((d,i)=>d.classList.toggle('active',i===idx));
    cur=idx; clearInterval(timer); timer=setInterval(()=>go((cur+1)%top5.length),4500);
  }
  dotsEl.querySelectorAll('.botw-dot').forEach(d=>d.addEventListener('click',()=>go(+d.dataset.i)));
  el('botwPrev').addEventListener('click',()=>go((cur-1+top5.length)%top5.length));
  el('botwNext').addEventListener('click',()=>go((cur+1)%top5.length));
  slidesEl.querySelectorAll('.botw-slide').forEach((s, i) => {
    s.style.cursor = 'pointer';
    const postId = top5[i]?.id;
    s.addEventListener('click', e => {
      if (e.target.closest('.clickable-user') || e.target.closest('.botw-dot')) return;
      // Find by ID from current S.posts — works even after cache refreshes
      const p = S.posts.find(x=>x.id===postId) || top5[i];
      if (p) openCarPage(p);
    });
  });
  timer=setInterval(()=>go((cur+1)%top5.length),4500);
}

// ─── HOT RIGHT NOW MOSAIC ─────────────────────────────────────
function renderTicker() { renderHotPanel(); } // alias for boot call
// ─── HOT RIGHT NOW — Cinematic Slider ─────────────────────────
let _hotSliderIdx  = 0;
let _hotSliderAuto = null;
const HOT_SLIDE_DURATION = 8000; // ms per slide

function renderHotPanel() {
  const slider = el('hotSlider'); if (!slider) return;
  const top    = [...S.posts].sort((a,b) => b.likes - a.likes).slice(0, 10);

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
    const cats   = Array.isArray(p.categories) && p.categories.length ? p.categories : [p.category].filter(Boolean);
    const img    = p.images?.[0];
    const imgs   = (p.images||[]).slice(1, 3); // up to 2 strip thumbs
    const rankLabels = ['🔥 #1 Hottest','#2','#3','#4','#5','#6','#7','#8','#9','#10'];
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
        <div class="hot-slide-cats">${cats.map(c=>`<span class="cat-badge ${catCfg(c).badge}" style="position:static">${c}</span>`).join(' ')}</div>
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
let _searchTimer;
function initSearch() {
  el('searchBtn').addEventListener('click', openSearch);
  el('searchClose').addEventListener('click', closeSearch);
  el('searchOverlay').addEventListener('click', e=>{if(e.target===el('searchOverlay'))closeSearch();});
  document.addEventListener('keydown', e=>{if(e.key==='Escape')closeSearch();});
  el('searchInput').addEventListener('input', ()=>{clearTimeout(_searchTimer); _searchTimer=setTimeout(doSearch,120);});
  document.querySelectorAll('.stag').forEach(t=>t.addEventListener('click',()=>{el('searchInput').value=t.dataset.q; doSearch();}));
}
function openSearch(){el('searchOverlay').classList.add('open'); setTimeout(()=>el('searchInput').focus(),80);}
function closeSearch(){el('searchOverlay').classList.remove('open'); el('searchInput').value=''; el('searchResults').innerHTML='';}
async function doSearch() {
  const q   = el('searchInput').value.trim();
  const res = el('searchResults');
  if (!q) { res.innerHTML = ''; return; }
  const lq = q.toLowerCase();

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
        <div class="sr-user-av" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
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
  el('openAuthBtn').addEventListener('click', ()=>{ clearAuthErrs(); el('authModal').classList.add('open'); });
  el('openPostBtn').addEventListener('click', openPostModal);
  el('authClose').addEventListener('click',  ()=>el('authModal').classList.remove('open'));
  el('authModal').addEventListener('click',  e=>{if(e.target===el('authModal'))el('authModal').classList.remove('open');});

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
  el('loginEmail').addEventListener('keydown',    e=>{if(e.key==='Enter')el('doLogin').click();});
  el('loginPassword').addEventListener('keydown', e=>{if(e.key==='Enter')el('doLogin').click();});
  el('regEmail').addEventListener('keydown',      e=>{if(e.key==='Enter')el('doRegister').click();});
  el('regPassword').addEventListener('keydown',   e=>{if(e.key==='Enter')el('doRegister').click();});

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
  el('doLogin').addEventListener('click', async () => {
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
    S.user = dbUserToApp(data);
    // Refresh users list
    try { const profiles = await DB.getAllProfiles(); S.users = profiles.map(dbUserToApp); } catch(_) {}
    el('authModal').classList.remove('open');
    document.body.classList.remove('modal-open');
    loginUser(S.user.username);
  });

  // ── REGISTER ──
  el('doRegister').addEventListener('click', async () => {
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
  // Always force-close auth modal
  el('authModal')?.classList.remove('open');
  updateAuthUI(); updateProfilePage(); updateDmBadge();
  setupRealtimeSubscriptions();
  toastSignIn(username);
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
  el('authModal').classList.remove('open');
  updateAuthUI(); updateProfilePage();
  // Send welcome notification
  pushNotif('welcome', 'DriveLog', `Welcome to DriveLog, <b>${username}</b>! 🎉 Start by posting your first build.`, null, null);
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
  el('onboardPostBtn').addEventListener('click', () => {
    modal.remove(); openPostModal();
  });
  el('onboardExploreBtn').addEventListener('click', () => {
    modal.remove(); goTo('home');
  });
}

function makeNewUser(username) {
  const now=new Date();
  return {username,posts:0,totalLikes:0,joined:now.toISOString().slice(0,7),joinedFull:now.toISOString(),bio:'',instagram:'',tiktok:'',youtube:'',website:'',awards:[]};
}

async function logout() {
  await DB.signOut().catch(()=>{});
  S.user=null; S.following=[]; S.notifs=[];
  updateAuthUI(); updateProfilePage(); updateDmBadge();
  toast('Signed out','');
  if(S.page==='profile'||S.page==='garage') goTo('home');
}

// ─── POST BUILD PAGE ─────────────────────────────────────────
let pendingImages=[];
let pendingVideos=[];
function initPostModal() {
  // Upload zone
  el('uploadZone').addEventListener('click', ()=>el('fileInput').click());
  el('uploadZone').addEventListener('dragover',  e=>{e.preventDefault(); el('uploadZone').classList.add('drag-over');});
  el('uploadZone').addEventListener('dragleave', ()=>el('uploadZone').classList.remove('drag-over'));
  el('uploadZone').addEventListener('drop', e=>{e.preventDefault(); el('uploadZone').classList.remove('drag-over'); addFiles(Array.from(e.dataTransfer.files));});
  el('fileInput').addEventListener('change', ()=>addFiles(Array.from(el('fileInput').files)));
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
    const key  = card.dataset.modkey;
    const inp  = card.querySelector('.mod-item-input');
    const btn  = card.querySelector('.mod-add-btn');
    const list = card.querySelector('.mod-item-list');
    if (!inp || !btn || !list) return;
    function addItem() {
      const val = inp.value.trim(); if (!val) return;
      const itemEl = document.createElement('div');
      itemEl.className = 'mod-item-row';
      itemEl.innerHTML = `<span class="mod-item-bullet">—</span><span class="mod-item-text-display">${escHtml(val)}</span><input type="hidden" class="mod-item-text" value="${escHtml(val)}"/><button type="button" class="mod-item-rm" aria-label="Remove"><i class="fas fa-times"></i></button>`;
      itemEl.querySelector('.mod-item-rm').addEventListener('click', () => itemEl.remove());
      list.appendChild(itemEl);
      inp.value = '';
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

    // Mods detail
    if (post.modsDetail) {
      ['engine','drivetrain','suspension','wheels','exterior','interior','other'].forEach(key => {
        const list  = el('modList-' + key);
        const items = post.modsDetail[key];
        const arr   = Array.isArray(items) ? items : (items||'').split(',').map(s=>s.trim()).filter(Boolean);
        if (!list || !arr.length) return;
        list.innerHTML = '';
        arr.forEach(text => {
          const itemEl = document.createElement('div');
          itemEl.className = 'mod-item-row';
          itemEl.innerHTML = `<span class="mod-item-bullet">—</span><span class="mod-item-text-display">${escHtml(text)}</span><input type="hidden" class="mod-item-text" value="${escHtml(text)}"/><button type="button" class="mod-item-rm" aria-label="Remove"><i class="fas fa-times"></i></button>`;
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

  // Collect structured mods — stored as arrays of items, each item a single mod
  function collectModItems(id) {
    // Collect all mod-item inputs within a mod-cat-card for this key
    const card = document.querySelector(`.mod-cat-card[data-modkey="${id}"]`);
    if (!card) return [];
    return [...card.querySelectorAll('.mod-item-text')]
      .map(i=>i.value.trim()).filter(Boolean);
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
  // Legacy mods string: flat list of all items for search/filter compat
  const mods = Object.values(modsDetail).flat().join(', ');

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
      existing.images       = [...pendingImages];
      existing.videos       = [...pendingVideos.map(v=>v.dataUrl)];
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

    // Upload images to Supabase Storage
    const imageUrls = [];
    for (let i=0; i<pendingImages.length; i++) {
      try {
        const res = await DB.uploadBase64(S.user.id, pendingImages[i], i);
        imageUrls.push(res.url || pendingImages[i]);
      } catch(_) { imageUrls.push(pendingImages[i]); }
    }

    const postData = appPostToDb({
      title, make, model, year, category:cat, categories:selectedCats,
      hp, mods, modsDetail, desc, transmission, mileage, buildState, zeroSixty, quarterMile, topSpeed,
      images: imageUrls,
      videos: pendingVideos.map(v=>v.dataUrl),
      liked_by:[], saved_by:[], reactions:{},
      showSocials: el('postShowSocials')?.checked ?? true,
    });

    const { data: newPost, error: postErr } = await DB.createPost(S.user.id, S.user.username, postData);
    if (submitBtn) { submitBtn.disabled=false; submitBtn.innerHTML='<i class="fas fa-upload"></i> Publish Build'; }
    if (postErr) { toast('Failed to post — please try again','err'); return; }

    const localPost = dbPostToApp(newPost) || {
      id:newPost?.id||'u'+Date.now(), title, make, model, year,
      category:cat, categories:selectedCats, hp, mods, modsDetail, desc, transmission, mileage,
      user:S.user.username, likes:0, comments:[], images:imageUrls,
      videos:pendingVideos.map(v=>v.dataUrl), likedBy:[], savedBy:[], reactions:{},
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
  el('carClose').addEventListener('click', closeCarModal);
  el('carModal').addEventListener('click', e=>{if(e.target===el('carModal'))closeCarModal();});
  el('carLike').addEventListener('click',  handleLike);
  el('carSave').addEventListener('click',  handleSave);
  el('carShare').addEventListener('click', handleShare);
  el('submitComment').addEventListener('click', submitComment);
  el('commentInput').addEventListener('keydown', e=>{if(e.key==='Enter')submitComment();});
  document.querySelectorAll('.dtab').forEach(t=>t.addEventListener('click',()=>switchDetailTab(t.dataset.dtab)));
}
function openCarModal(post) {
  S.openPost=post; S.galleryIdx=0;
  el('carModal').classList.add('open'); document.body.style.overflow='hidden';
  renderCarGallery(post);
  const cfg=catCfg(post.category);
  el('carCatBar').innerHTML=`<span class="cat-badge ${cfg.badge}">${post.category}</span>`;
  const usr=S.users.find(u=>u.username===post.user)||{};
  el('carPosterAv').textContent=post.user[0].toUpperCase(); el('carPosterAv').style.background=avColor(post.user);
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
      el('mainGallImg').addEventListener('click',()=>openLightbox(imgs,imgs.findIndex(s=>s===item.src)));
    }
    if(media.length>1){
      el('galPrev').addEventListener('click',e=>{e.stopPropagation();setMain((idx-1+media.length)%media.length);updateStrip();});
      el('galNext').addEventListener('click',e=>{e.stopPropagation();setMain((idx+1)%media.length);updateStrip();});
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
  if(idx>=0){post.likes=Math.max(0,post.likes-1); post.likedBy.splice(idx,1); el('carLike').classList.remove('liked');}
  else{post.likes++; post.likedBy.push(S.user.username); el('carLike').classList.add('liked'); pushNotif('like',S.user.username,`liked your build <b>${post.title}</b>`,'post:'+post.id);}
  el('carLikeCount').textContent=post.likes; save(); renderFeed();
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
  const all=[...(SEED_TIMELINES[post.id]||[]),...JSON.parse(localStorage.getItem('dl_tl_'+post.id)||'[]')];
  const wrap=el('timelineContent');
  if(!all.length){wrap.innerHTML='<p class="no-timeline">No build timeline yet.</p>'; return;}
  wrap.innerHTML=`<div class="timeline">${all.map((e,i)=>`
    <div class="tl-item${i===all.length-1?' last':''}">
      <div class="tl-left"><div class="tl-dot" style="background:${e.color||'#555'}"><i class="${e.icon||'fas fa-circle'}" style="font-size:.5rem"></i></div>${i<all.length-1?'<div class="tl-line"></div>':''}</div>
      <div class="tl-right"><div class="tl-date">${e.date}</div><div class="tl-title">${esc(e.title)}</div><p class="tl-body">${esc(e.body)}</p></div>
    </div>`).join('')}</div>
    ${S.user&&post.user===S.user.username?`<button class="btn-ghost small add-tl-btn" id="addTlBtn"><i class="fas fa-plus"></i> Add Update</button>`:''}`;
  const btn=el('addTlBtn');
  if(btn) btn.addEventListener('click',()=>addTimelineEntry(post.id));
}
function addTimelineEntry(postId) {
  const title=prompt('Update title:'); if(!title)return;
  const body=prompt('Describe the update:'); if(!body)return;
  const stored=JSON.parse(localStorage.getItem('dl_tl_'+postId)||'[]');
  stored.push({date:new Date().toISOString().slice(0,10),title,body,icon:'fas fa-plus',color:'#a855f7'});
  localStorage.setItem('dl_tl_'+postId,JSON.stringify(stored));
  const post=S.posts.find(p=>p.id===postId); if(post)renderTimeline(post);
  toast('Timeline updated ✓','ok');
}

// ─── LIGHTBOX ─────────────────────────────────────────────────
function initLightbox() {
  el('lbClose').addEventListener('click',    closeLightbox);
  el('lbBackdrop').addEventListener('click', closeLightbox);
  el('lbPrev').addEventListener('click',     ()=>lbGo(S.lbIdx-1));
  el('lbNext').addEventListener('click',     ()=>lbGo(S.lbIdx+1));
  document.addEventListener('keydown', e=>{
    if(!el('lightbox').classList.contains('open'))return;
    if(e.key==='Escape')    closeLightbox();
    if(e.key==='ArrowLeft') lbGo(S.lbIdx-1);
    if(e.key==='ArrowRight')lbGo(S.lbIdx+1);
  });
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
  const unread=S.notifs.filter(n=>!n.read).length, badge=el('notifBadge');
  if(unread>0){badge.textContent=unread>9?'9+':unread; badge.style.display='flex';} else badge.style.display='none';
}
function renderNotifList() {
  const icons  = {like:'fas fa-heart',comment:'fas fa-comment',follow:'fas fa-user-plus',event:'fas fa-calendar',welcome:'fas fa-star',reaction:'fas fa-fire',award:'fas fa-medal',badge:'fas fa-medal',dm:'fas fa-envelope',default:'fas fa-bell'};
  const colors = {like:'#e84242',comment:'#3b82f6',follow:'#22c55e',event:'#a855f7',welcome:'#f0a030',reaction:'#f0a030',award:'#c9a84c',badge:'#c9a84c',dm:'#14b8a6',default:'#555'};
  const list   = el('notifList');
  if (!S.notifs.length) { list.innerHTML='<div class="notif-empty">No notifications yet</div>'; return; }

  // Group by category for the filter bar
  const cats = ['all','like','comment','follow','event','dm','award'];
  const active = list._activeCat || 'all';

  // Only show unread notifications — read ones are dismissed
  const unreadNotifs = S.notifs.filter(n => !n.read);
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
  if(!S.user){toast('Sign in to follow members','err');return;}
  const idx=S.following.indexOf(username);
  if(idx>=0){
    S.following.splice(idx,1);
    toast(`Unfollowed ${username}`,'');
  } else {
    S.following.push(username);
    toast(`Now following ${username}`,'ok');
    const otherUser = S.users.find(u=>u.username===username);
    pushNotif('follow',S.user.username,'started following you','user:'+S.user.username, otherUser?.id);
  }
  // Persist to Supabase
  const other = S.users.find(u=>u.username===username);
  if (other?.id) DB.toggleFollow(S.user.id, other.id).catch(()=>{});
  save(); renderMembers(); updateFollowBtn(username);
}
function updateFollowBtn(username) {
  const fb=el('followBtn'); if(!fb)return;
  if(!S.user||username===S.user.username){fb.style.display='none';return;}
  fb.style.display='inline-flex';
  const f=isFollowing(username);
  fb.textContent=f?'Following ✓':'Follow'; fb.className=f?'btn-ghost small':'btn-primary small';
}

// ─── FEED ─────────────────────────────────────────────────────
// ─── FILTER HELPERS ───────────────────────────────────────────
function applyFiltersToPost(p) {
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
    const hpNum = parseInt((p.hp||'').replace(/[^0-9]/g,'')) || 0;
    if (!hpNum || hpNum < f.hp) return false;
  }
  if (f.likes > 0  && p.likes < f.likes) return false;
  if (f.media === 'photos' && (!p.images||!p.images.length))   return false;
  if (f.media === 'multi'  && (!p.images||p.images.length < 2)) return false;
  if (f.build === 'modified' && !p.mods)  return false;
  if (f.build === 'stock'    &&  p.mods)  return false;
  return true;
}

function countActiveFilters() {
  const f = S.filters; let n = 0;
  if (f.categories.length > 0) n++; if (f.make) n++; if (f.hp > 0) n++;
  if (f.likes > 0) n++; if (f.media) n++; if (f.build) n++;
  if (f.yearMin > 1940 || f.yearMax < 2026) n++;
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

    // Years: only posts that have a valid 4-digit year
    const years = posts.map(p=>parseInt(p.year)).filter(y=>y>1900&&y<=2100);
    const yearMin = years.length ? Math.min(...years) : 1940;
    const yearMax = years.length ? Math.max(...years) : new Date().getFullYear();

    // HP: extract numeric part from strings like "450whp", "355hp", "900+"
    const hps = posts.map(p=>parseInt((p.hp||'').replace(/[^0-9]/g,''))).filter(v=>v>0);
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
    if (S.filters.yearMax >= 2100) S.filters.yearMax = r.yearMax;

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

  btn.addEventListener('click', openFilter);
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

  // Category pills
  side.querySelectorAll('.fs-pill[data-fc]').forEach(p=>p.addEventListener('click',()=>{
    side.querySelectorAll('.fs-pill[data-fc]').forEach(x=>x.classList.remove('active'));
    p.classList.add('active'); S.filters.category = p.dataset.fc;
  }));

  // Media pills
  side.querySelectorAll('.fs-pill[data-fmedia]').forEach(p=>p.addEventListener('click',()=>{
    side.querySelectorAll('.fs-pill[data-fmedia]').forEach(x=>x.classList.remove('active'));
    p.classList.add('active'); S.filters.media = p.dataset.fmedia;
  }));

  // Build pills
  side.querySelectorAll('.fs-pill[data-fbuild]').forEach(p=>p.addEventListener('click',()=>{
    side.querySelectorAll('.fs-pill[data-fbuild]').forEach(x=>x.classList.remove('active'));
    p.classList.add('active'); S.filters.build = p.dataset.fbuild;
  }));

  // Make select
  el('fsMake').addEventListener('change', ()=>{ S.filters.make = el('fsMake').value; });

  // Year sliders — clamp each other, display real year value
  el('fsYearMin').addEventListener('input', ()=>{
    let v = +el('fsYearMin').value;
    if (v > S.filters.yearMax) { v = S.filters.yearMax; el('fsYearMin').value = v; }
    S.filters.yearMin = v;
    el('fsYearMinVal').textContent = v;
  });
  el('fsYearMax').addEventListener('input', ()=>{
    let v = +el('fsYearMax').value;
    if (v < S.filters.yearMin) { v = S.filters.yearMin; el('fsYearMax').value = v; }
    S.filters.yearMax = v;
    el('fsYearMaxVal').textContent = v;
  });

  // HP slider — shows real hp value extracted from post data range
  el('fsHP').addEventListener('input', ()=>{
    const v = +el('fsHP').value;
    S.filters.hp = v;
    el('fsHPVal').textContent = v > 0 ? v + '+ hp' : 'Any';
  });

  // Likes slider — shows real like counts from posts
  el('fsLikes').addEventListener('input', ()=>{
    const v = +el('fsLikes').value;
    S.filters.likes = v;
    el('fsLikesVal').textContent = v > 0 ? v + '+' : 'Any';
  });

  // Apply
  el('filterApply')?.addEventListener('click', ()=>{
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
    S.filters = { categories:[], make:'', yearMin:r.yearMin, yearMax:r.yearMax, hp:0, likes:0, media:'', build:'' };
    S.filter = 'All';
    S.visibleCount = FEED_PAGE_SIZE;
    syncFilterUI();
    document.querySelectorAll('.fpill[data-cat]').forEach(p=>p.classList.toggle('active',p.dataset.cat==='All'));
    renderFeed();
  });

  // Sync UI controls to current S.filters state
  function syncFilterUI() {
    const f = S.filters;
    side.querySelectorAll('.fs-pill[data-fc]').forEach(p=>p.classList.toggle('active', (f.categories||[]).includes(p.dataset.fc)));
    side.querySelectorAll('.fs-pill[data-fmedia]').forEach(p=>p.classList.toggle('active', p.dataset.fmedia===f.media));
    side.querySelectorAll('.fs-pill[data-fbuild]').forEach(p=>p.classList.toggle('active', p.dataset.fbuild===f.build));
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
  const liked=S.user&&post.likedBy.includes(S.user.username);
  const multi=imgs.length>1?`<div class="card-multi"><i class="fas fa-images"></i> ${imgs.length}</div>`:'';
  const imgHTML=imgs.length
    ?`<img class="card-img" src="${imgs[0]}" alt="${esc(post.title)}" loading="lazy"/>`
    :`<div class="card-img card-img-ph" style="background:${phBg(post.id)}"><span>${post.make.toUpperCase()}</span></div>`;
  return `<div class="card" data-id="${post.id}" style="animation-delay:${animIdx*.04}s">
    <div class="card-img-wrap">${imgHTML}<span class="cat-badge ${cfg.badge}">${post.category}</span>${multi}</div>
    <div class="card-body">
      <div class="card-title">${esc(post.title)}</div>
      <div class="card-sub">${post.year?post.year+' · ':''}${post.hp?post.hp+' · ':''}by ${esc(post.user)}</div>
      <div class="card-foot">
        <div class="card-av-row">${(()=>{const _u=getAvatarUrl(post.user);return _u?`<div class="card-av av-circle clickable-user has-photo" data-user="${post.user}"><img src="${_u}" alt="" class="av-photo"/></div>`:`<div class="card-av av-circle clickable-user" data-user="${post.user}" style="background:${avColor(post.user)}">${post.user[0].toUpperCase()}</div>`;})()} <span class="card-poster clickable-user" data-user="${post.user}">${esc(post.user)}</span></div>
        <div class="card-stats">
          <span class="card-comments"><i class="fas fa-comment"></i> ${(post.comments||[]).length}</span>
          <span class="card-likes${liked?' liked':''}" data-id="${post.id}"><i class="fas fa-heart"></i> ${post.likes}</span>
        </div>
      </div>
    </div></div>`;
}

function attachCardEvents(container) {
  container.querySelectorAll('.card').forEach(card=>card.addEventListener('click',e=>{
    if(e.target.closest('.card-likes'))return;
    const p=S.posts.find(x=>x.id===card.dataset.id); if(p)openCarPage(p);
  }));
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
      <div class="tm-av clickable-user" data-user="${u.username}" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
      <div><div class="tm-name">${esc(u.username)}</div><div class="tm-sub">${u.posts||0} builds · ${(u.totalLikes||0).toLocaleString()} likes</div></div>
      ${i<3?`<span class="tm-badge ${badges[i]}">#${i+1}</span>`:''}
    </div>`).join('');

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
    el('catFeedGrid').innerHTML=posts.length?posts.map((p,i)=>cardHTML(p,i)).join(''):'<p class="cat-empty">No builds yet.</p>';
    attachCardEvents(el('catFeedGrid'));
  }));
  el('backToCats').addEventListener('click',()=>{el('catGrid').style.display=''; el('catFeedWrap').style.display='none';});
}

// ─── LEADERBOARD ──────────────────────────────────────────────
function renderLeaderboard() {
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

  const topM=[...S.users].sort((a,b)=>(b.totalLikes||0)-(a.totalLikes||0)).slice(0,10);
  el('lbMembers').innerHTML=`<div class="lb-list">${topM.map((u,i)=>`
    <div class="lb-row${i===0?' gold':i===1?' silver':i===2?' bronze':''}">
      <div class="lb-pos${i===0?' p1':i===1?' p2':i===2?' p3':' pn'}">${i+1}</div>
      <div class="lb-thumb lb-av-th clickable-user" data-user="${u.username}" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
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

  const topPosts=[...S.users].sort((a,b)=>{
    const ap=S.posts.filter(p=>p.user===a.username).length;
    const bp=S.posts.filter(p=>p.user===b.username).length;
    return bp-ap;
  }).slice(0,10);
  el('lbPosts').innerHTML=`<div class="lb-list">${topPosts.map((u,i)=>{
    const pCount=S.posts.filter(p=>p.user===u.username).length;
    return `<div class="lb-row${i===0?' gold':i===1?' silver':i===2?' bronze':''}">
      <div class="lb-pos${i===0?' p1':i===1?' p2':i===2?' p3':' pn'}">${i+1}</div>
      <div class="lb-thumb lb-av-th clickable-user" data-user="${u.username}" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
      <div class="lb-info"><div class="lb-title">${esc(u.username)}</div><div class="lb-meta">Member since ${u.joined} · ${pCount} builds posted</div></div>
      <div class="lb-score"><div class="lb-num">${pCount}</div><div class="lb-lbl">Posts</div></div>
    </div>`;
  }).join('')}</div>`;

  const oldestUsers=[...S.users].filter(u=>u.joinedFull||u.joined).sort((a,b)=>{
    const aT=new Date(a.joinedFull||a.joined+'-01').getTime();
    const bT=new Date(b.joinedFull||b.joined+'-01').getTime();
    return aT-bT;
  }).slice(0,10);
  el('lbOldest').innerHTML=`<div class="lb-list">${oldestUsers.map((u,i)=>{
    const age=accountAge(u);
    return `<div class="lb-row${i===0?' gold':i===1?' silver':i===2?' bronze':''}">
      <div class="lb-pos${i===0?' p1':i===1?' p2':i===2?' p3':' pn'}">${i+1}</div>
      <div class="lb-thumb lb-av-th clickable-user" data-user="${u.username}" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
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
  el('createEvtBtn').addEventListener('click',()=>{
    if(!S.user){toast('Sign in to create events','err');return;}
    el('createEvtForm').style.display=el('createEvtForm').style.display==='none'?'block':'none';
  });
  el('createEvtClose').addEventListener('click',()=>el('createEvtForm').style.display='none');
  el('submitEvt').addEventListener('click',()=>{
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
  let members=[...S.users].filter(u=>!q||u.username.toLowerCase().includes(q)||(u.bio||'').toLowerCase().includes(q));
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
    const isSelf=S.user?.username===u.username, followers=Math.floor((u.totalLikes||0)/80);
    return `<div class="member-card">
      <div class="member-cover" style="background:${phBg(u.username)}">
        ${img?`<img src="${img}" alt="" loading="lazy"/>`:''}<div class="member-cover-ov"></div>
        ${rank<3?`<div class="member-rank rank${rank+1}">#${rank+1}</div>`:''}
      </div>
      <div class="member-body">
        <div class="member-av" style="background:${avColor(u.username)}">${
          u.avatarUrl
            ? `<img src="${u.avatarUrl}" alt="" class="av-photo"/>`
            : u.username[0].toUpperCase()
        }</div>
        <div class="member-info">
          <div class="member-name">${esc(u.username)}</div>
          <div class="member-bio">${u.bio?(u.bio.length>60?u.bio.slice(0,60)+'…':u.bio):'DriveLog member'}</div>
          <div class="member-stats"><span><b>${u.posts||0}</b> builds</span><span><b>${(u.totalLikes||0).toLocaleString()}</b> likes</span><span><b>${followers}</b> followers</span></div>
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

function viewMemberProfile(username) {
  // Security: clear any edit state
  S._editingPostId = null;
  // Check if user exists at all
  const u = S.users.find(x => x.username === username);
  if (!u) {
    // Show profile not found state
    goTo('profile');
    el('noLoginMsg').style.display = 'block';
    el('profilePostsWrap').style.display = 'none';
    el('profileActions').style.display = 'none';
    el('noLoginMsg').innerHTML = `
      <div class="profile-not-found">
        <i class="fas fa-user-slash" style="font-size:3rem;color:var(--mid);display:block;margin-bottom:16px"></i>
        <h2>Profile No Longer Exists</h2>
        <p>This account may have been deleted or removed.</p>
        <button class="btn-ghost small" onclick="goTo('home')" style="margin-top:12px"><i class="fas fa-home"></i> Go Home</button>
      </div>`;
    return;
  }
  // u is already declared above
  const posts=S.posts.filter(p=>p.user===username);
  const likes=posts.reduce((a,p)=>a+p.likes,0), followers=Math.floor((u.totalLikes||0)/80);
  const profUrl = getAvatarUrl(u.username);
  if (profUrl) {
    el('profileAv').innerHTML=`<img src="${profUrl}" alt="${esc(u.username)}" class="av-photo"/>`;
    el('profileAv').style.background='transparent';
  } else {
    el('profileAv').innerHTML=u.username[0].toUpperCase();
    el('profileAv').style.background=avColor(u.username);
  }
  el('profileName').textContent=u.username;
  // Awards inline next to name
  const awardsEl2 = el('profileAwards');
  if (awardsEl2) awardsEl2.innerHTML = renderAwards(u, true);
  el('profileBio').textContent=truncateBio(u.bio||'');
  const ageInfo=accountAge(u);
  el('profileJoined').innerHTML=`Member since ${u.joined} &nbsp;<span class="acct-age-badge"><i class="fas fa-clock"></i> ${ageInfo.full}</span>`;
  el('profileSocials').innerHTML=buildSocialLinks(u);
  const stEl=el('profileStats'); if(stEl) stEl.innerHTML=`<div class="pstat"><span class="pstat-n">${posts.length}</span><span class="pstat-l">Builds</span></div><div class="pstat"><span class="pstat-n">${likes.toLocaleString()}</span><span class="pstat-l">Likes</span></div><div class="pstat"><span class="pstat-n">${followers}</span><span class="pstat-l">Followers</span></div>`;
  el('profileActions').style.display='flex'; el('noLoginMsg').style.display='none'; el('profilePostsWrap').style.display='block';
  el('profileBuildsLabel').textContent=`${u.username}'s Builds`;
  updateFollowBtn(username); el('followBtn').onclick=()=>toggleFollow(username);
  const grid=el('profileGrid');
  if(posts.length){el('noBuilds').style.display='none';grid.innerHTML=posts.map((p,i)=>cardHTML(p,i)).join('');attachCardEvents(grid);}
  else{grid.innerHTML='';el('noBuilds').style.display='block';}
  goTo('profile');
}
// ─── PUBLIC PROFILE ROUTER ─────────────────────────────────────
// Called when any avatar/username is clicked anywhere on the site.
// Shows own editable profile for self, read-only view for others.
function viewPublicProfile(username) {
  if (!username) return;
  const u = S.users.find(x => x.username === username);
  if (!u) { toast('User not found', 'err'); return; }
  viewMemberProfile(username);
}

function buildSocialLinks(u) {
  return [
    u.instagram?`<a class="prof-social ig" href="https://instagram.com/${u.instagram}" target="_blank" rel="noopener"><i class="fab fa-instagram"></i> @${u.instagram}</a>`:'',
    u.tiktok?`<a class="prof-social tt" href="https://tiktok.com/@${u.tiktok}" target="_blank" rel="noopener"><i class="fab fa-tiktok"></i> @${u.tiktok}</a>`:'',
    u.youtube?`<a class="prof-social yt" href="https://youtube.com/@${u.youtube}" target="_blank" rel="noopener"><i class="fab fa-youtube"></i> @${u.youtube}</a>`:'',
    u.website?`<a class="prof-social wb" href="${u.website}" target="_blank" rel="noopener"><i class="fas fa-globe"></i> Website</a>`:'',
  ].join('');
}

// ─── GARAGE ───────────────────────────────────────────────────
function initGarage() {
  document.querySelectorAll('.gtab').forEach(t=>t.addEventListener('click',()=>{
    document.querySelectorAll('.gtab,.gpanel').forEach(x=>x.classList.remove('active'));
    t.classList.add('active'); el('gpanel-'+t.dataset.gtab).classList.add('active');
  }));
}
function renderGarage() {
  if (!S.user) {
    el('savedEmpty').style.display='block';
    el('likedEmpty').style.display='block';
    return;
  }
  const uname = S.user.username;
  const uid   = S.user.id || '';
  const saved  = S.posts.filter(p=>p.savedBy.includes(uname)||p.savedBy.includes(uid));
  const liked  = S.posts.filter(p=>p.likedBy.includes(uname)||p.likedBy.includes(uid));
  const shared = S.posts.filter(p=>p.user===uname);

  // Saved
  el('savedGrid').innerHTML = saved.map((p,i)=>cardHTML(p,i)).join('');
  el('savedEmpty').style.display = saved.length ? 'none' : 'block';
  attachCardEvents(el('savedGrid'));

  // Liked
  el('likedGrid').innerHTML = liked.map((p,i)=>cardHTML(p,i)).join('');
  el('likedEmpty').style.display = liked.length ? 'none' : 'block';
  attachCardEvents(el('likedGrid'));

  // Shared (your builds)
  if (el('sharedGrid')) {
    el('sharedGrid').innerHTML = shared.map((p,i)=>cardHTML(p,i)).join('');
    el('sharedEmpty').style.display = shared.length ? 'none' : 'block';
    attachCardEvents(el('sharedGrid'));
  }

  // Saved Parts
  if (el('partsPanel')) renderParts();

  // Wire tabs
  document.querySelectorAll('.gtab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.gtab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.gpanel').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const panel = el('gpanel-'+t.dataset.gtab);
      if (panel) panel.classList.add('active');
    };
  });
}

function renderParts() {
  const uname = S.user?.username; if (!uname) return;
  const parts = JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
  el('partsPanel').innerHTML = `
    <div class="parts-section">
      <div class="parts-header"><h3>Saved Parts</h3><p>Track parts you want to buy or are researching.</p></div>
      <div class="parts-add-row">
        <input class="finput" id="partsInput" placeholder="Part name (e.g. Tein coilovers, HKS turbo kit, Rays CE28N 18x9.5)…" style="flex:1;margin-bottom:0"/>
        <button class="btn-primary small" id="partsAddBtn"><i class="fas fa-plus"></i> Add Part</button>
      </div>
      <div class="parts-list" id="partsList">
        ${parts.length ? parts.map((p,i)=>`
          <div class="parts-item">
            <span class="parts-item-icon"><i class="fas fa-wrench"></i></span>
            <span class="parts-item-text">${esc(p.text)}</span>
            <span class="parts-item-date">${timeAgo(p.ts)}</span>
            <button class="parts-rm-btn" data-i="${i}" title="Remove"><i class="fas fa-times"></i></button>
          </div>`).join('') : '<p class="parts-empty"><i class="fas fa-wrench" style="margin-right:6px"></i>No saved parts yet.</p>'}
      </div>
    </div>`;
  el('partsAddBtn')?.addEventListener('click', () => {
    const txt = el('partsInput')?.value.trim(); if(!txt) return;
    const parts2 = JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
    parts2.unshift({text:txt, ts:Date.now()});
    localStorage.setItem('dl_parts_'+uname, JSON.stringify(parts2));
    renderParts();
  });
  el('partsInput')?.addEventListener('keydown', e=>{ if(e.key==='Enter') el('partsAddBtn')?.click(); });
  el('partsList')?.querySelectorAll('.parts-rm-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const parts2=JSON.parse(localStorage.getItem('dl_parts_'+uname)||'[]');
    parts2.splice(+btn.dataset.i,1);
    localStorage.setItem('dl_parts_'+uname,JSON.stringify(parts2));
    renderParts();
  }));
}

// ─── PROFILE (own) ────────────────────────────────────────────
function updateProfilePage() {
  if(!S.user){
    el('noLoginMsg').style.display='block'; el('profilePostsWrap').style.display='none'; el('profileActions').style.display='none';
    el('profileName').textContent='Sign in to view profile'; el('profileBio').textContent=''; el('profileJoined').textContent='';
    el('profileSocials').innerHTML=''; const clStEl=el('profileStats'); if(clStEl) clStEl.innerHTML=''; el('profileAv').textContent='';
    return;
  }
  const u=S.user, posts=S.posts.filter(p=>p.user===u.username), likes=posts.reduce((a,p)=>a+p.likes,0);
  el('noLoginMsg').style.display='none'; el('profilePostsWrap').style.display='block'; el('profileActions').style.display='flex';
  const profUrl = getAvatarUrl(u.username);
  if (profUrl) {
    el('profileAv').innerHTML=`<img src="${profUrl}" alt="${esc(u.username)}" class="av-photo"/>`;
    el('profileAv').style.background='transparent';
  } else {
    el('profileAv').innerHTML=u.username[0].toUpperCase();
    el('profileAv').style.background=avColor(u.username);
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

  const ownStEl=el('profileStats'); if(ownStEl) ownStEl.innerHTML=`<div class="pstat"><span class="pstat-n">${posts.length}</span><span class="pstat-l">Builds</span></div><div class="pstat"><span class="pstat-n">${likes.toLocaleString()}</span><span class="pstat-l">Likes</span></div><div class="pstat"><span class="pstat-n">${posts.reduce((a,p)=>a+(p.comments||[]).length,0)}</span><span class="pstat-l">Comments</span></div>`;
  el('followBtn').style.display='none'; el('profileBuildsLabel').textContent='Your Builds';
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
function getAvatarUrl(username) {
  if (!username) return null;
  // Check S.users first (loaded from Supabase)
  const u = S.users.find(x => x.username === username);
  if (u?.avatarUrl) return u.avatarUrl;
  // Fallback: check avatar cache in localStorage (set when user uploads avatar)
  if (S.user?.username === username) {
    const local = localStorage.getItem('dl_avatar_url');
    if (local) return local;
  }
  // Try per-user cache
  try {
    const cache = JSON.parse(localStorage.getItem('dl_avatar_cache') || '{}');
    if (cache[username]) return cache[username];
  } catch(_) {}
  return null;
}

// Called when we know an avatar URL — cache it for instant display
function cacheAvatarUrl(username, url) {
  if (!username || !url) return;
  try {
    const cache = JSON.parse(localStorage.getItem('dl_avatar_cache') || '{}');
    cache[username] = url;
    localStorage.setItem('dl_avatar_cache', JSON.stringify(cache));
  } catch(_) {}
}

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

// ─── CAR DETAIL PAGE ──────────────────────────────────────────
function initCarPage() {
  el('carPageBack')?.addEventListener('click', () => {
    history.back ? history.go(-1) : goTo('home');
    // fallback: just go home if no history
    goTo(S._prevPage || 'home');
  });
  el('cpLike')?.addEventListener('click', cpHandleLike);
  el('cpSave')?.addEventListener('click', cpHandleSave);
  el('cpShare')?.addEventListener('click', cpHandleShare);
  el('cpSubmitComment')?.addEventListener('click', cpSubmitComment);
  el('cpCommentInput').addEventListener('keydown', e => { if(e.key==='Enter') cpSubmitComment(); });
  document.querySelectorAll('.cptab').forEach(t => t.addEventListener('click', () => switchCpTab(t.dataset.cptab)));
}

async function openCarPage(post) {
  S._prevPage   = S.page;
  // Show page immediately with cached data
  const freshPost = { ...post, comments: [] };
  S.openCarPost = freshPost;
  S.openPost    = freshPost;
  goTo('car');
  renderCarPage(freshPost);
  setMetaTags(freshPost.title, freshPost.desc, freshPost.images?.[0]);
  setTimeout(() => addCostTab(freshPost), 50);

  // Fetch fresh post data from Supabase to get latest fields
  // (fixes stale cache issue where make/model/year were missing)
  try {
    const freshData = await DB.getPost(post.id);
    if (freshData && S.page === 'car' && S.openCarPost?.id === post.id) {
      const updatedPost = { ...dbPostToApp(freshData), comments: [] };
      S.openCarPost = updatedPost;
      S.openPost    = updatedPost;
      // Update in S.posts cache too
      const idx = S.posts.findIndex(p => p.id === updatedPost.id);
      if (idx >= 0) S.posts[idx] = { ...S.posts[idx], ...updatedPost };
      // Re-render with fresh data
      renderCarPage(updatedPost);
    }
  } catch(e) { console.warn('Fresh post fetch failed', e); }

  // Load comments separately
  const targetPostId = post.id;
  try {
    const rows = await DB.getComments(targetPostId);
    if (S.openCarPost?.id !== targetPostId || S.page !== 'car') return;
    const comments = rows.map(r => ({
      id:r.id, user:r.username, text:r.text, image:null,
      date:r.created_at, parentId:r.parent_id||null,
      upvotes:r.upvotes||0, upvotedBy:r.upvoted_by||[],
    }));
    S.openCarPost = { ...S.openCarPost, comments };
    cpRenderComments(S.openCarPost);
    bindCommentHandlers(S.openCarPost);
  } catch(e) { console.warn('Comments load failed', e); }
}

function renderCarPage(post) {
  if (!post) return;
  // Gallery
  cpRenderGallery(post);
  // Category badge
  const cfg = catCfg(post.category);
  const cpCats = Array.isArray(post.categories) && post.categories.length ? post.categories : [post.category].filter(Boolean);
  el('cpCat').innerHTML = cpCats.map(c=>`<span class="cat-badge ${catCfg(c).badge}">${c}</span>`).join(' ');
  // Title
  el('cpTitle').textContent = post.title;
  // Poster info
  const usr = S.users.find(u => u.username === post.user) || {};
  const _cpUrl = getAvatarUrl(post.user);
  el('cpAv').dataset.user = post.user;
  el('cpAv').classList.add('clickable-user');
  if (_cpUrl) {
    el('cpAv').innerHTML=`<img src="${_cpUrl}" alt="" class="av-photo"/>`;
    el('cpAv').style.background='transparent';
  } else {
    el('cpAv').innerHTML=post.user[0].toUpperCase();
    el('cpAv').style.background=avColor(post.user);
  }
  el('cpPosterName').textContent = post.user;
  el('cpPosterName').dataset.user = post.user;
  el('cpPosterName').className = 'car-page-poster-name clickable-user';
  el('cpPosterDate').textContent = fmtDate(post.date);
  el('cpSocials').innerHTML = [
    usr.instagram ? `<a class="soc-btn ig" href="https://instagram.com/${usr.instagram}" target="_blank" rel="noopener"><i class="fab fa-instagram"></i></a>` : '',
    usr.tiktok    ? `<a class="soc-btn tt" href="https://tiktok.com/@${usr.tiktok}" target="_blank" rel="noopener"><i class="fab fa-tiktok"></i></a>` : '',
    usr.youtube   ? `<a class="soc-btn yt" href="https://youtube.com/@${usr.youtube}" target="_blank" rel="noopener"><i class="fab fa-youtube"></i></a>` : '',
    usr.website   ? `<a class="soc-btn wb" href="${usr.website}" target="_blank" rel="noopener"><i class="fas fa-globe"></i></a>` : '',
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
        : val.split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
      const listHTML = items.map(item => `<li class="cp-mod-item">${esc(item)}</li>`).join('');
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
  // Show/hide the details section
  const detailsEl = el('cpDetails');
  if (detailsEl) {
    // Always show details — every post has at least year/make/model chips
    detailsEl.style.display = '';
  }
  // Like / save state
  syncCpActions(post);
  // Reactions — only in the actions row
  renderReactions(post, 'cpReactionsRow');
  // Videos in specs right panel
  renderCpVideos(post);
  // Compare button
  const cpCmp = el('cpCompare');
  if (cpCmp) cpCmp.onclick = () => { S.compareA = post; goTo('compare'); renderComparePage(); toast('Build loaded for comparison','ok'); };
  // Comments
  cpRenderComments(post);
  // Timeline
  cpRenderTimeline(post);
  switchCpTab('comments');
}

function cpRenderGallery(post) {
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
      el('cpMainImg').addEventListener('click', () => openLightbox(imgs, idx));
    }

    if (media.length > 1) {
      el('cpGalPrev').addEventListener('click', e => { e.stopPropagation(); setMain((idx-1+media.length)%media.length); upStrip(); });
      el('cpGalNext').addEventListener('click', e => { e.stopPropagation(); setMain((idx+1)%media.length); upStrip(); });
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
  const liked = post.likedBy.includes(S.user ? S.user.username : getDeviceId());
  const saved = !!(S.user && post.savedBy.includes(S.user.username));
  el('cpLike').className = 'act-btn like-btn' + (liked ? ' liked' : '');
  el('cpLikeCount').textContent = post.likes;
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
  const comments = post.comments || [];
  const cc = el('cpCommentCount');
  if (cc) cc.textContent = comments.length ? `(${comments.length})` : '';
  const count = comments.length;
  el('cpCommentCount').textContent = count > 0 ? `(${count})` : '';
  // Update avatar
  const av = el('cpCommentAv');
  if (S.user) { av.textContent = S.user.username[0].toUpperCase(); av.style.background = avColor(S.user.username); }
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
  if (!comments.length) {
    el('cpCommentsList').innerHTML = '<p class="no-comments">No comments yet. Be the first!</p>';
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
      ${(()=>{const _cu=getAvatarUrl(comment.user);return _cu?`<div class="comment-av av-circle clickable-user has-photo" data-user="${comment.user}"><img src="${_cu}" alt="" class="av-photo"/></div>`:`<div class="comment-av av-circle clickable-user" data-user="${comment.user}" style="background:${avColor(comment.user)}">${comment.user[0].toUpperCase()}</div>`;})()} 
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
  if (!videos.length) {
    panel.innerHTML = '';
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'flex';
  panel.innerHTML = `
    <div class="cp-videos-label"><i class="fas fa-video"></i> Build Videos</div>
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
  if (!S.user) { hideEl('navDmBadge'); hideEl('mobDmBadge'); return; }
  const total = getAllDmConversations().reduce((a,c)=>a+c.unread,0);
  ['navDmBadge','mobDmBadge'].forEach(id => {
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
    el('msgChatCol')?.classList.remove('active');
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
    el('notifDrop')?.classList.remove('open');
  });
}

function renderMessages() {
  if (!S.user) {
    el('msgConvList').innerHTML = '<div class="msg-empty"><i class="fas fa-lock"></i><p>Sign in to view messages</p></div>';
    return;
  }
  const q = (el('msgSearch').value||'').toLowerCase();
  const convs = getAllDmConversations().filter(c => !q || c.other.toLowerCase().includes(q));
  if (!convs.length) {
    el('msgConvList').innerHTML = '<div class="msg-empty"><i class="fas fa-envelope-open"></i><p>No messages yet. Start a conversation!</p></div>';
    return;
  }
  el('msgConvList').innerHTML = convs.map(c => {
    const preview = c.last.text.length > 40 ? c.last.text.slice(0,40)+'…' : c.last.text;
    const isMe = c.last.from === S.user.username;
    return `<div class="msg-conv-item${S.openDm===c.other?' active':''}${c.unread?' unread':''}" data-user="${c.other}">
      ${(()=>{const _mu=getAvatarUrl(c.other);return _mu?`<div class="msg-conv-av av-circle has-photo"><img src="${_mu}" alt="" class="av-photo"/></div>`:`<div class="msg-conv-av av-circle" style="background:${avColor(c.other)}">${c.other[0].toUpperCase()}</div>`;})()}
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
}

async function openDmWith(username) {
  if (!S.user) { toast('Sign in to send messages','err'); return; }
  S.openDm = username;
  // Mark all messages from this user as read locally
  const msgs = loadDmThread(username);
  msgs.forEach(m => { if(m.from !== S.user.username) m.read = true; });
  saveDmThread(username, msgs);
  updateDmBadge();
  // Show chat window
  el('msgNoneSelected').style.display = 'none';
  el('msgChatWrap').style.display = 'flex';
  const _mcu = getAvatarUrl(username);
  if (_mcu) { el('msgChatAv').innerHTML=`<img src="${_mcu}" alt="" class="av-photo"/>`; el('msgChatAv').style.background='transparent'; }
  else { el('msgChatAv').innerHTML=username[0].toUpperCase(); el('msgChatAv').style.background=avColor(username); }
  el('msgChatName').textContent = username;
  const otherUser = S.users.find(u => u.username === username);
  const age = otherUser ? accountAge(otherUser) : null;
  el('msgChatStatus').textContent = age ? `Member · ${age.short}` : 'Member';
  el('msgListCol').classList.add('msg-hide-list');
  el('msgChatCol')?.classList.add('active');
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
    const avHTML = avUrl
      ? `<div class="msg-bubble-av has-photo"><img src="${avUrl}" alt="" class="av-photo"/></div>`
      : `<div class="msg-bubble-av" style="background:${avColor(m.from)}">${m.from[0].toUpperCase()}</div>`;
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
  if (otherUser?.id && txt) {
    DB.sendMessage(S.user.id, otherUser.id, S.user.username, S.openDm, txt).catch(()=>{});
  }
  renderDmMessages(S.openDm);
  renderMessages();
  const notifTxt = txt || '📷 Image';
  const otherU = S.users.find(u=>u.username===S.openDm);
  pushNotif('dm', S.user.username, `sent you a message: "${notifTxt.length>40?notifTxt.slice(0,40)+'…':notifTxt}"`, 'page:messages', otherU?.id);
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
        <div class="msg-conv-av" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
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
  // Also save to Supabase
  DB.submitReport(S.user.id, S.user.username, _reportTarget.type, _reportTarget.id, reason, details).catch(e => console.warn('Report sync', e));
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

function toggleFeaturedUser(username) {
  const u = S.users.find(x=>x.username===username); if(!u) return;
  u.isFeatured = !u.isFeatured;
  // Persist to Supabase
  DB.updateProfile(u.id||'', { is_featured: u.isFeatured }).catch(()=>{});
  save(); renderAdminUsers(); renderFeaturedMembers();
  toast(`${u.isFeatured?'Added to':'Removed from'} Featured Members`, 'ok');
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
      <div class="admin-user-av clickable-user" data-user="${u.username}" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
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
      // Push to Supabase Storage in background
      if (newAvatarUrl.startsWith('data:')) {
        DB.uploadBase64(S.user.id, newAvatarUrl, 'avatar').then(res => {
          if (res?.url) {
            S.user.avatarUrl = res.url;
            S.users = S.users.map(u => u.username === S.user.username ? { ...u, avatarUrl: res.url } : u);
            DB.updateProfile(S.user.id, { avatar_url: res.url }).catch(()=>{});
            localStorage.setItem('dl_user_cache', JSON.stringify(S.user));
            localStorage.setItem('dl_avatar_url', res.url);
            updateAuthUI();
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
  const modal     = el('socialUploadModal');
  const closeBtn  = el('socialUploadClose');
  const zone      = el('socialUploadZone');
  const fileInput = el('socialFileInput');
  const submitBtn = el('socialSubmitBtn');

  if (uploadBtn) uploadBtn.addEventListener('click', () => {
    if (!S.user) { toast('Sign in to post','err'); el('authModal').classList.add('open'); return; }
    modal.classList.add('open');
    el('socialCaption').value = '';
    el('socialUploadPreview').innerHTML = '';
    _socialPendingFiles = [];
    el('socialTagPills').innerHTML = CATS.slice(0,12).map(c =>
      `<button type="button" class="post-cat-pill" data-cat="${c.name}" style="font-size:.7rem;padding:4px 11px"><i class="${c.fa} pill-icon"></i>${c.name}</button>`
    ).join('');
    el('socialTagPills').querySelectorAll('.post-cat-pill').forEach(p => p.addEventListener('click', () => {
      el('socialTagPills').querySelectorAll('.post-cat-pill').forEach(x=>x.classList.remove('active'));
      p.classList.toggle('active');
    }));
  });
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.remove('open'));
  if (modal) modal.addEventListener('click', e => { if(e.target===modal) modal.classList.remove('open'); });
  if (zone) {
    zone.addEventListener('click', () => fileInput && fileInput.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); handleSocialFiles(Array.from(e.dataTransfer.files)); });
  }
  if (fileInput) fileInput.addEventListener('change', () => handleSocialFiles(Array.from(fileInput.files)));
  if (submitBtn) submitBtn.addEventListener('click', submitSocialPost);
  document.querySelectorAll('.soc-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.soc-tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    socialTab = t.dataset.soctab;
    socialPage = 0;
    // Clear search when switching tabs
    const si = el('socialSearchInput');
    if (si) { si.value = ''; S._socialSearchQ = ''; }
    el('socialSearchClear').style.display = 'none';
    renderSocialFeed(true);
  }));
  // Social search
  el('socialSearchInput')?.addEventListener('input', () => {
    const q = el('socialSearchInput').value.trim();
    el('socialSearchClear').style.display = q ? 'block' : 'none';
    doSocialSearch();
  });
  el('socialSearchClear')?.addEventListener('click', () => {
    el('socialSearchInput').value = '';
    el('socialSearchClear').style.display = 'none';
    S._socialSearchQ = '';
    socialPage = 0;
    renderSocialFeed(true);
  });
}

let _socialPendingFiles = [];

function handleSocialFiles(files) {
  _socialPendingFiles = files.slice(0, 5);
  const preview = el('socialUploadPreview');
  if (!preview) return;
  preview.innerHTML = '';
  _socialPendingFiles.forEach(f => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;margin:3px;position:relative;vertical-align:top';
    if (f.type.startsWith('video/')) {
      // Show actual video preview
      const objUrl = URL.createObjectURL(f);
      wrap.innerHTML = `<video src="${objUrl}" class="social-file-thumb-video" muted playsinline preload="metadata"></video>
        <div class="social-file-thumb-play"><i class="fas fa-play"></i></div>`;
    } else {
      const reader = new FileReader();
      reader.onload = e2 => { wrap.innerHTML = `<img src="${e2.target.result}" class="social-file-thumb-img"/>`; };
      reader.readAsDataURL(f);
    }
    preview.appendChild(wrap);
  });
}

async function submitSocialPost() {
  if (!S.user) { toast('Sign in to post','err'); return; }
  const caption = el('socialCaption')?.value.trim() || '';
  const tag     = el('socialTagPills')?.querySelector('.post-cat-pill.active')?.dataset.cat || '';
  const hasContent = caption.length > 0 || _socialPendingFiles.length > 0;
  if (!hasContent) { toast('Add a caption or photo to share','err'); return; }
  const btn = el('socialSubmitBtn');
  const progBar = el('socialUploadProgress');
  if (btn) { btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Sharing…'; }
  if (progBar) { progBar.style.display='block'; progBar.value=0; }
  const mediaItems = [];
  const total = _socialPendingFiles.length || 1;
  for (let i=0; i<_socialPendingFiles.length; i++) {
    const f = _socialPendingFiles[i];
    if (f.type.startsWith('image/')) {
      const url = await compressImage(f, 1200, 0.88);
      mediaItems.push({ type:'image', url });
    } else if (f.type.startsWith('video/')) {
      const url = await new Promise(res => { const r=new FileReader(); r.onload=e=>res(e.target.result); r.readAsDataURL(f); });
      mediaItems.push({ type:'video', url });
    }
    if (progBar) progBar.value = Math.round(((i+1)/total)*90);
  }
  const post = {
    id:'sp'+Date.now(), user:S.user.username, caption, tag, media:mediaItems,
    likes:0, likedBy:[], comments:[], reactions:{}, ts:Date.now(),
    date:new Date().toISOString().slice(0,10),
  };
  const stored = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
  stored.unshift(post);
  localStorage.setItem('dl_social_posts', JSON.stringify(stored));
  if (progBar) { progBar.value=100; setTimeout(()=>{ progBar.style.display='none'; progBar.value=0; },400); }
  el('socialUploadModal').classList.remove('open');
  _socialPendingFiles = [];
  if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Share'; }
  toast('Posted!','ok');
  socialPage=0; renderSocialFeed(true);
}

function getSocialPosts() {
  const stored = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
  if (socialTab==='following' && S.user)
    return stored.filter(p => S.following.includes(p.user) || p.user===S.user.username);
  return stored;
}

function renderSocialFeed(reset) {
  if (reset) socialPage=0;
  const wrap = el('socialPostsWrap'); if (!wrap) return;
  // If search is active, delegate to doSocialSearch
  if (S._socialSearchQ) { doSocialSearch(); return; }
  const all   = getSocialPosts();
  const slice = all.slice(0, (socialPage+1)*SOCIAL_PAGE_SIZE);
  if (reset) wrap.innerHTML='';

  if (!all.length) {
    wrap.innerHTML=`<div class="social-empty"><i class="fas fa-camera-retro social-empty-icon"></i><h3>Nothing here yet</h3><p>Be the first to share a moment from your build.</p>${S.user?'<button class="btn-primary" onclick="el(\'socialUploadBtn\').click()"><i class="fas fa-plus"></i> Share Something</button>':''}</div>`;
    return;
  }

  const from = reset ? 0 : socialPage*SOCIAL_PAGE_SIZE;
  const newPosts = all.slice(from, (socialPage+1)*SOCIAL_PAGE_SIZE);

  newPosts.forEach(post => {
    const card = document.createElement('div');
    card.className='social-post-card'; card.dataset.id=post.id;
    const liked = post.likedBy.includes(S.user ? S.user.username : getDeviceId());
    const mainMedia = post.media[0];
    card.innerHTML=`
      <div class="social-post-head">
        ${(()=>{const _su=getAvatarUrl(post.user);return _su?`<div class="social-post-av av-circle clickable-user has-photo" data-user="${post.user}"><img src="${_su}" alt="" class="av-photo"/></div>`:`<div class="social-post-av av-circle clickable-user" data-user="${post.user}" style="background:${avColor(post.user)}">${post.user[0].toUpperCase()}</div>`;})()} 
        <div class="social-post-user-info">
          <span class="social-post-username clickable-user" data-user="${post.user}">${esc(post.user)}</span>
          <span class="social-post-time">${timeAgo(post.ts)}</span>
        </div>
        ${post.tag?`<span class="cat-badge ${catCfg(post.tag).badge}" style="position:static;margin-left:auto">${post.tag}</span>`:''}
        <button class="social-report-btn" data-id="${post.id}" title="Report"><i class="fas fa-flag"></i></button>
      </div>
      ${mainMedia?(mainMedia.type==='video'
        ?`<video class="social-post-media" controls preload="metadata" playsinline><source src="${mainMedia.url}"/></video>`
        :`<img class="social-post-media" src="${mainMedia.url}" alt="${esc(post.caption)}" loading="lazy"/>`
      ):''}
      ${post.media.length>1?`<div class="social-post-strip">${post.media.slice(1,5).map(m=>m.type==='video'?`<div class="social-strip-item video-thumb-wrap"><i class="fas fa-play"></i></div>`:`<img class="social-strip-item" src="${m.url}" alt="" loading="lazy"/>`).join('')}${post.media.length>5?`<div class="social-strip-more">+${post.media.length-5}</div>`:''}</div>`:''}
      ${post.caption?`<div class="social-post-caption"><b class="clickable-user" data-user="${post.user}">${esc(post.user)}</b> ${esc(post.caption)}</div>`:''}
      <div class="social-post-actions">
        <button class="social-action-btn social-like-btn${liked?' liked':''}" data-id="${post.id}"><i class="fas fa-heart"></i> <span>${post.likes||0}</span></button>
        <button class="social-action-btn social-comment-toggle" data-id="${post.id}"><i class="fas fa-comment"></i> <span>${(post.comments||[]).length}</span></button>
        ${S.user&&post.user===S.user.username?`<button class="social-action-btn social-delete-btn" data-id="${post.id}"><i class="fas fa-trash-alt"></i></button>`:''}
      </div>
      <div class="social-post-comments" id="spc-${post.id}" style="display:none">
        <div class="social-comments-list" id="scl-${post.id}"></div>
        <div class="social-comment-input">
          <input class="social-comment-text finput" type="text" placeholder="Add a comment…" data-id="${post.id}" style="margin-bottom:0"/>
          <button class="social-comment-submit btn-primary small" data-id="${post.id}">Post</button>
        </div>
      </div>`;
    wrap.appendChild(card);
  });

  // Events
  wrap.querySelectorAll('.social-like-btn').forEach(btn => btn.addEventListener('click', () => {
    const all2=JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
    const p=all2.find(x=>x.id===btn.dataset.id); if(!p) return;
    const vid=voterId(), idx=p.likedBy.indexOf(vid);
    if(idx>=0){p.likes=Math.max(0,p.likes-1);p.likedBy.splice(idx,1);}
    else{p.likes++;p.likedBy.push(vid);}
    localStorage.setItem('dl_social_posts',JSON.stringify(all2));
    btn.className='social-action-btn social-like-btn'+(idx<0?' liked':'');
    btn.querySelector('span').textContent=p.likes;
  }));
  wrap.querySelectorAll('.social-comment-toggle').forEach(btn => btn.addEventListener('click', () => {
    const pnl=el('spc-'+btn.dataset.id); if(!pnl) return;
    const open=pnl.style.display!=='none';
    pnl.style.display=open?'none':'block';
    if(!open) renderSocialComments(btn.dataset.id);
  }));
  wrap.querySelectorAll('.social-comment-submit').forEach(btn => btn.addEventListener('click', () => {
    if(!S.user){toast('Sign in to comment','err');return;}
    const inp=wrap.querySelector(`.social-comment-text[data-id="${btn.dataset.id}"]`);
    const txt=inp?.value.trim(); if(!txt) return;
    const all2=JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
    const p=all2.find(x=>x.id===btn.dataset.id); if(!p) return;
    p.comments=p.comments||[];
    p.comments.push({id:'sc'+Date.now(),user:S.user.username,text:txt,ts:Date.now()});
    localStorage.setItem('dl_social_posts',JSON.stringify(all2));
    if(inp) inp.value='';
    renderSocialComments(btn.dataset.id);
  }));
  wrap.querySelectorAll('.social-delete-btn').forEach(btn => btn.addEventListener('click', () => {
    if(!confirm('Delete this post?')) return;
    const all2=JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
    localStorage.setItem('dl_social_posts',JSON.stringify(all2.filter(p=>p.id!==btn.dataset.id)));
    renderSocialFeed(true);
  }));
  wrap.querySelectorAll('.social-report-btn').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const all2=JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
    const p=all2.find(x=>x.id===btn.dataset.id);
    openReport('social',btn.dataset.id,p?.caption||'');
  }));

  // Infinite scroll
  if (socialSentinelObs) socialSentinelObs.disconnect();
  const sentinel=el('socialSentinel');
  if (sentinel && slice.length<all.length) {
    socialSentinelObs=new IntersectionObserver(entries=>{
      if(entries[0].isIntersecting){socialPage++;renderSocialFeed(false);}
    },{rootMargin:'300px'});
    socialSentinelObs.observe(sentinel);
  }
  renderSocialSidebar();
}

function renderSocialComments(postId) {
  const list=el('scl-'+postId); if(!list) return;
  const all=JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
  const post=all.find(p=>p.id===postId);
  if(!post||!post.comments?.length){list.innerHTML='<p class="social-no-comments">No comments yet</p>';return;}
  list.innerHTML=post.comments.map(c=>`
    <div class="social-comment-item">
      <span class="social-comment-av clickable-user" data-user="${c.user}" style="background:${avColor(c.user)}">${c.user[0].toUpperCase()}</span>
      <div class="social-comment-body"><b class="clickable-user" data-user="${c.user}">${esc(c.user)}</b> ${esc(c.text)}</div>
      <span class="social-comment-time">${timeAgo(c.ts)}</span>
    </div>`).join('');
}

function renderSocialSidebar() {
  // Who to follow
  const wrap=el('socialWhoToFollow'); if(!wrap) return;
  const suggestions=S.users.filter(u=>!S.following.includes(u.username)&&(!S.user||u.username!==S.user.username)).slice(0,4);
  if(!suggestions.length){wrap.innerHTML='<p class="social-no-comments">You follow everyone!</p>';}
  else {
    wrap.innerHTML=suggestions.map(u=>`
      <div class="social-suggest-row">
        <div class="social-suggest-av clickable-user" data-user="${u.username}" style="background:${avColor(u.username)}">${u.username[0].toUpperCase()}</div>
        <div class="social-suggest-info">
          <div class="social-suggest-name clickable-user" data-user="${u.username}">${esc(u.username)}</div>
          <div class="social-suggest-meta">${S.posts.filter(p=>p.user===u.username).length} builds</div>
        </div>
        <button class="btn-ghost small social-follow-btn" data-user="${u.username}">${S.following.includes(u.username)?'Following':'Follow'}</button>
      </div>`).join('');
    wrap.querySelectorAll('.social-follow-btn').forEach(btn=>btn.addEventListener('click',()=>{
      if(!S.user){toast('Sign in to follow','err');return;}
      toggleFollow(btn.dataset.user);
      btn.textContent=S.following.includes(btn.dataset.user)?'Following':'Follow';
    }));
  }

  // Trending hashtags — extracted from captions
  const hashEl = el('socialHashtags');
  if (hashEl) {
    const allPosts = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
    const tagCounts = {};
    allPosts.forEach(p => {
      if (!p.caption) return;
      const tags = p.caption.match(/#[\w]+/g) || [];
      tags.forEach(t => { tagCounts[t] = (tagCounts[t]||0)+1; });
    });
    const sorted = Object.entries(tagCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
    if (!sorted.length) {
      hashEl.innerHTML = '<p class="social-no-comments">No hashtags yet. Use #tags in your captions!</p>';
    } else {
      hashEl.innerHTML = sorted.map(([tag,count]) =>
        `<div class="social-hashtag-row">
          <span class="social-hashtag-tag">${esc(tag)}</span>
          <span class="social-hashtag-count">${count} post${count!==1?'s':''}</span>
        </div>`
      ).join('');
    }
  }
}

// ─── BIO WORD LIMIT ────────────────────────────────────────────
function truncateBio(bio, wordLimit=50) {
  if (!bio) return '';
  const words=bio.trim().split(/\s+/);
  if (words.length<=wordLimit) return bio;
  return words.slice(0,wordLimit).join(' ')+'…';
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
  el('usViewBuild').addEventListener('click', () => {
    popup.classList.remove('open');
    setTimeout(() => { popup.remove(); if (post?.id) { const p=S.posts.find(x=>x.id===post.id); if(p) openCarPage(p); } }, 250);
  });
  el('usGoHome').addEventListener('click', () => {
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
  const allPosts = JSON.parse(localStorage.getItem('dl_social_posts')||'[]');
  if (!q) {
    S._socialSearchQ = '';
    socialPage = 0;
    renderSocialFeed(true);
    return;
  }
  S._socialSearchQ = q;
  const results = allPosts.filter(p => {
    const caption = (p.caption||'').toLowerCase();
    const tags    = (p.tag||'').toLowerCase();
    const user    = (p.user||'').toLowerCase();
    const hashtags= (caption.match(/#[\w]+/g)||[]).join(' ').toLowerCase();
    return caption.includes(q) || tags.includes(q) || user.includes(q) || hashtags.includes(q);
  });
  // Render results directly
  const wrap = el('socialPostsWrap'); if (!wrap) return;
  if (!results.length) {
    wrap.innerHTML = `<div class="social-no-results"><i class="fas fa-search"></i><p>No posts found for "<b>${esc(q)}</b>"</p></div>`;
    return;
  }
  wrap.innerHTML = results.map(p => renderSocialCard(p)).join('');
  bindSocialCardEvents(wrap);
}

// Handle browser/mobile back button
window.addEventListener('popstate', e => {
  const page = e.state?.page || 'home';
  // Don't push another history entry — just switch page
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const pageEl = el('page-'+page);
  if (pageEl) { pageEl.classList.add('active'); S.page = page; }
  // Close mob nav if open
  el('mobNav')?.classList.remove('open');
  el('mobOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
});
