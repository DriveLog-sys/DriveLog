/* ============================================================
   DRIVELOG — DB.JS  (Supabase data layer)
   ─────────────────────────────────────────────────────────────
   This file is the ONLY place that talks to Supabase directly.
   app.js should never reference _sb or call supabase.* directly —
   all database and storage operations go through DB.*.

   Supabase project:
     URL: https://lsnpxneywkrirfkfszbo.supabase.co
     Key: sb_publishable_wF4jFiIEuucuJXJJo8sn0Q_b2PRnh6-
     Dashboard: app.supabase.com → lsnpxneywkrirfkfszbo

   Storage buckets:
     post-images — uploaded build photos (public read)
     avatars     — profile + banner photos (public read)
                   stored as {userId}/avatar.jpg and {userId}/banner.jpg
                   Always upsert same path so the URL never changes

   Supabase tables:
     profiles      — one row per user (id matches auth.users.id)
     posts         — build posts
     comments      — comments on posts (supports parent_id for replies)
     follows       — follower/following relationships
     notifications — in-app notifications
     messages      — direct messages
     events        — community events
     reports       — user-submitted reports
     build_costs   — line-item cost tracker per post
     build_timeline— chronological build update entries per post
     botm_votes    — Build Of The Month votes (one per user per month)

   Row Level Security (RLS) MUST be configured correctly for the
   site to work. If posts show "No Builds Yet" despite data existing,
   the posts table is missing a public SELECT policy. Run fix_rls.sql.

   Data flow:
     Supabase row → dbPostToApp() → S.posts[] → renderFeed()
     Supabase row → dbUserToApp() → S.users[] → renderMembers() etc.
     S.posts (app format) → appPostToDb() → Supabase row (for updates)
   ============================================================ */

const SUPABASE_URL  = 'https://lsnpxneywkrirfkfszbo.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_wF4jFiIEuucuJXJJo8sn0Q_b2PRnh6-';
const STORAGE_BUCKET = 'post-images';

// ─── CLIENT INIT ──────────────────────────────────────────────
// _sb is the Supabase client instance. It's null until _initSb() runs.
// The Supabase CDN <script> must load before db.js for this to work.
// In index.html: supabase CDN is in <head> (no defer), then db.js at
// the bottom of <body> with defer — by the time db.js executes, the
// CDN has already run and window.supabase is defined.
let _sb = null;
function _initSb() {
  if (_sb) return _sb; // already initialized
  try {
    if (typeof supabase !== 'undefined') {
      _sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
  } catch(e) { console.warn('Supabase init failed:', e); }
  return _sb;
}
// Try to init immediately — will succeed if CDN is loaded
_initSb();

// _sbOk() — guard function used before every DB call.
// Retries _initSb() in case the client wasn't ready on first attempt.
// Returns true if _sb is initialized and safe to use.
function _sbOk() { _initSb(); return !!_sb; }

// ─── AUTH ─────────────────────────────────────────────────────
const DB = {

  // ── Sign up ────────────────────────────────────────────────
  async signUp(email, password, username) {
    if (!_sbOk()) return { error: { message: 'Not connected to database. Check your internet connection.' } };
    // Check username isn't taken first
    const { data: existing } = await _sb
      .from('profiles')
      .select('username')
      .eq('username', username)
      .single();
    if (existing) return { error: { message: 'USERNAME_TAKEN' } };

    const { data, error } = await _sb.auth.signUp({ email, password });
    if (error) return { error };

    // Create profile row
    const { error: profErr } = await _sb.from('profiles').insert({
      id:        data.user.id,
      username,
      joined_at: new Date().toISOString(),
    });
    if (profErr) return { error: profErr };

    return { data: { ...data.user, username } };
  },

  // ── Sign in ────────────────────────────────────────────────
  async signIn(email, password) {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error) return { error };
    const profile = await DB.getProfile(data.user.id);
    return { data: { ...data.user, ...profile } };
  },

  // ── Sign out ───────────────────────────────────────────────
  async signOut() {
    if (!_sbOk()) return;
    return _sb.auth.signOut();
  },

  // ── Sign out — explicit scope variants ──────────────────────
  // signOut() above uses Supabase's default scope. These two are
  // explicit so "this device only" vs "everywhere" actually differ:
  // 'local'  = only this browser's session is revoked
  // 'global' = every session/device for this account is revoked
  async signOutLocal() {
    if (!_sbOk()) return { error: null };
    const { error } = await _sb.auth.signOut({ scope: 'local' });
    return { error };
  },
  async signOutGlobal() {
    if (!_sbOk()) return { error: null };
    const { error } = await _sb.auth.signOut({ scope: 'global' });
    return { error };
  },

  // ── Email change ─────────────────────────────────────────────
  // Supabase sends a confirmation link to the new address (and, depending
  // on project auth settings, sometimes the old one too) before the change
  // actually takes effect — the returned user object here is NOT yet the
  // final state, just confirmation the request was accepted.
  async updateEmail(newEmail) {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { data, error } = await _sb.auth.updateUser({ email: newEmail });
    return { data, error };
  },

  // ── Two-factor authentication (TOTP via Supabase Auth MFA) ───
  async mfaListFactors() {
    if (!_sbOk()) return { factors: [], error: null };
    const { data, error } = await _sb.auth.mfa.listFactors();
    if (error) return { factors: [], error };
    return { factors: data?.totp || [], error: null };
  },
  async mfaEnroll() {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { data, error } = await _sb.auth.mfa.enroll({ factorType: 'totp' });
    return { data, error };
  },
  async mfaVerifyEnrollment(factorId, code) {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { data: challenge, error: challengeErr } = await _sb.auth.mfa.challenge({ factorId });
    if (challengeErr) return { error: challengeErr };
    const { data, error } = await _sb.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    return { data, error };
  },
  async mfaUnenroll(factorId) {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { data, error } = await _sb.auth.mfa.unenroll({ factorId });
    return { data, error };
  },
  // Called at sign-in time to check whether a second-factor challenge is
  // required before the session is fully trusted (aal2).
  async mfaGetAuthLevel() {
    if (!_sbOk()) return { nextLevel: 'aal1', currentLevel: 'aal1' };
    const { data } = await _sb.auth.mfa.getAuthenticatorAssuranceLevel();
    return data || { nextLevel: 'aal1', currentLevel: 'aal1' };
  },
  async mfaChallengeAndVerify(factorId, code) {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { data: challenge, error: challengeErr } = await _sb.auth.mfa.challenge({ factorId });
    if (challengeErr) return { error: challengeErr };
    const { data, error } = await _sb.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    return { data, error };
  },

  // ── Get current session ────────────────────────────────────
  // Returns the logged-in user from the Supabase auth token,
  // or null if not logged in.
  //
  // IMPORTANT: This does NOT make a secondary getProfile() round-trip.
  // The username is read from user_metadata (set at registration time).
  // Full profile data (bio, avatar, awards, etc.) loads later via
  // getAllProfiles() which runs in the background after boot.
  //
  // This design means getSession() is fast (~200ms) and the session
  // is never blocked waiting for the profiles table.
  async getSession() {
    if (!_sbOk()) return null;
    const { data } = await _sb.auth.getSession();
    if (!data?.session) return null;
    // Read username from metadata — avoids a second DB round-trip
    const meta = data.session.user.user_metadata || {};
    const base = { ...data.session.user, username: meta.username || data.session.user.email?.split('@')[0] || 'User' };
    // Enrich with profile data in the background — doesn't block return
    DB.getProfile(data.session.user.id).then(profile => {
      if (profile) Object.assign(base, profile);
    }).catch(() => {});
    return base;
  },

  // ─── PROFILES ──────────────────────────────────────────────
  async getProfile(userId) {
    const { data, error } = await _sb
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (error && error.code !== 'PGRST116') console.error('DriveLog getProfile error:', error.message, error.code);
    return data;
  },

  async getProfileByUsername(username) {
    const { data } = await _sb
      .from('profiles')
      .select('*')
      .eq('username', username)
      .single();
    return data;
  },

  // getAllProfiles() — fetches ALL user profiles for the members page,
  // Loads full profile data (bio, banner, socials, privacy, awards, etc.)
  // for every user, not just avatars — previously this used a minimal
  // column set to save payload size, but that broke correctness: it
  // assumed missing fields would be loaded on demand the moment someone
  // opened a specific profile, but that on-demand path only fired when the
  // user wasn't already in the cached list — which, in practice, was
  // almost never true once someone had been on the site a bit, since
  // everyone ends up in this bulk-fetched list. The result: banner photos,
  // bios, and socials looked like they'd silently reset on a new device or
  // fresh session, even though the data was correctly saved server-side —
  // it just was never being read back in. Trading a larger payload for
  // actual correctness here.
  //
  // Cache TTL: 90 seconds (checked in loadStorage via dl_profile_cache_ts).
  async getAllProfiles() {
    if (!_sbOk()) return [];
    const { data, error } = await _sb
      .from('profiles')
      .select('*')
      .order('joined_at', { ascending: true });
    if (error) console.error('DriveLog getAllProfiles error:', error.message, error.code);
    return data || [];
  },

  async updateProfile(userId, updates) {
    const { data, error } = await _sb
      .from('profiles')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select()
      .single();
    return { data, error };
  },

  async grantAward(username, awardId) {
    const { data: profile } = await _sb
      .from('profiles')
      .select('awards')
      .eq('username', username)
      .single();
    if (!profile) return { error: 'User not found' };
    const awards = profile.awards || [];
    if (awards.includes(awardId)) return { error: 'Already has this award' };
    return _sb.from('profiles').update({ awards: [...awards, awardId] }).eq('username', username);
  },

  async revokeAward(username, awardId) {
    const { data: profile } = await _sb
      .from('profiles')
      .select('awards')
      .eq('username', username)
      .single();
    if (!profile) return;
    const awards = (profile.awards || []).filter(a => a !== awardId);
    return _sb.from('profiles').update({ awards }).eq('username', username);
  },

  // ─── POSTS ─────────────────────────────────────────────────
  // getPosts() is the primary feed query. Called from:
  //   - startPrefetch() at script load (if cache is stale)
  //   - loadStorage() via _prefetchPostsPromise
  //   - Infinite scroll when user reaches the bottom of the feed
  //
  // If this returns 0 rows and you know posts exist in Supabase,
  // the issue is almost certainly RLS (Row Level Security).
  // The posts table must have a SELECT policy with USING (true)
  // to allow anonymous reads. Run fix_rls.sql to fix this.
  //
  // The console.log on success is intentional — useful for diagnosing
  // "No Builds Yet" issues in the browser console.
  async getPosts({ limit = 50, offset = 0, category = null } = {}) {
    if (!_sbOk()) { console.warn('DriveLog: Supabase not ready'); return []; }
    let q = _sb
      .from('posts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (category) q = q.contains('categories', [category]);
    const { data, error } = await q;
    if (error) console.error('DriveLog getPosts error:', error.message, error.code, error.details);
    if (data) console.log('DriveLog getPosts returned', data.length, 'posts');
    return data || [];
  },

  async getPost(postId) {
    const { data } = await _sb.from('posts').select('*').eq('id', postId).single();
    return data;
  },

  // recordPostView — calls the record_post_view() Postgres function
  // (added by add_views_migration.sql). Tracks WHO has viewed each post
  // via a viewed_by array, so it's always safe to call this on every
  // page load / refresh / back-navigation — the database only counts
  // the FIRST time a given viewerId is seen for a given post and is a
  // silent no-op every time after that, for that same person. This is
  // what makes "once per user" actually hold: the client doesn't need
  // to track state or guess whether this is a fresh view, the database
  // decides based on viewed_by every time.
  async recordPostView(postId, viewerId) {
    if (!_sbOk() || !postId || !viewerId) return null;
    const { data, error } = await _sb.rpc('record_post_view', { post_id_input: postId, viewer_id_input: viewerId });
    if (error) { console.warn('recordPostView error:', error.message); return null; }
    return data; // current total view count (unchanged if already viewed by this person)
  },

  async createPost(userId, username, postData) {
    if (!_sbOk()) return { error: { message: 'Not connected.' } };
    const { data, error } = await _sb
      .from('posts')
      .insert({ user_id: userId, username, ...postData })
      .select()
      .single();
    // Update profile post count
    if (!error) {
      await _sb.rpc('increment_post_count', { uid: userId });
    }
    return { data, error };
  },

  async updatePost(postId, userId, updates) {
    const { data, error } = await _sb
      .from('posts')
      .update({ ...updates, edited_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', postId)
      .eq('user_id', userId)  // security: only owner
      .select()
      .single();
    return { data, error };
  },

  async deletePost(postId, userId) {
    return _sb.from('posts').delete().eq('id', postId).eq('user_id', userId);
  },

  // toggleLike() — add or remove a like on a post.
  // voterId is the username (string), not the UUID.
  // liked_by is stored as an array of usernames in Supabase.
  // likes count is always derived from liked_by.length (never manually incremented)
  // so it can't get out of sync.
  //
  // NOTE: app.js also updates S.posts[].likedBy optimistically BEFORE
  // calling this function, so the UI updates instantly without waiting
  // for the Supabase round-trip.
  async toggleLike(postId, voterId) {
    const { data: post } = await _sb.from('posts').select('liked_by, likes').eq('id', postId).single();
    if (!post) return;
    const liked = (post.liked_by || []);
    const already = liked.includes(voterId);
    const newLikedBy = already ? liked.filter(v => v !== voterId) : [...liked, voterId];
    return _sb.from('posts').update({
      liked_by: newLikedBy,
      likes: newLikedBy.length,  // derived from array length — never drifts
    }).eq('id', postId);
  },

  async toggleSave(postId, userId) {
    const { data: post } = await _sb.from('posts').select('saved_by').eq('id', postId).single();
    if (!post) return;
    const saved = (post.saved_by || []);
    const already = saved.includes(userId);
    const newSavedBy = already ? saved.filter(v => v !== userId) : [...saved, userId];
    return _sb.from('posts').update({ saved_by: newSavedBy }).eq('id', postId);
  },

  async toggleReaction(postId, voterId, rkey) {
    const { data: post } = await _sb.from('posts').select('reactions').eq('id', postId).single();
    if (!post) return;
    const reactions = post.reactions || {};
    // Remove voter from all reaction types first
    Object.keys(reactions).forEach(k => {
      reactions[k] = (reactions[k] || []).filter(v => v !== voterId);
    });
    // Toggle this reaction
    if (!reactions[rkey]) reactions[rkey] = [];
    const already = reactions[rkey].includes(voterId);
    if (!already) reactions[rkey].push(voterId);
    return _sb.from('posts').update({ reactions }).eq('id', postId);
  },

  // ─── IMAGE UPLOAD ───────────────────────────────────────────
  // Upload any File object to a specific bucket
  async _uploadFile(bucket, path, file) {
    const { error } = await _sb.storage
      .from(bucket)
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: true });
    if (error) return { error };
    const { data: urlData } = _sb.storage.from(bucket).getPublicUrl(path);
    return { url: urlData.publicUrl };
  },

  async uploadImage(userId, file) {
    const ext  = file.name?.split('.').pop() || 'jpg';
    const path = `${userId}/${Date.now()}.${ext}`;
    return DB._uploadFile(STORAGE_BUCKET, path, file);
  },

  // uploadAvatar() — convert a base64 data URL to a File and upload
  // to Supabase Storage avatars bucket at {userId}/avatar.jpg.
  // The path is always the same so the URL is stable — no need to
  // update every post/comment that references the avatar URL.
  // After upload, also saves the URL to profiles.avatar_url.
  //
  // Takes base64 because the blur editor and crop tool produce data URLs.
  // For File objects (direct uploads), use uploadImage() instead.
  async uploadAvatar(userId, base64DataUrl) {
    if (!_sbOk()) return { url: null };
    try {
      const arr   = base64DataUrl.split(',');
      const mime  = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bstr  = atob(arr[1]);
      const bytes = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
      const file = new File([bytes], 'avatar.jpg', { type: mime });
      // Overwrite same path so URL is stable across updates
      const path = `${userId}/avatar.jpg`;
      const res  = await DB._uploadFile('avatars', path, file);
      if (res?.url) {
        // Cache-bust: the storage path is stable, so without a version
        // param the CDN serves the OLD photo to everyone for up to an
        // hour. A fresh ?v= makes the new picture show instantly.
        res.url = res.url.split('?')[0] + '?v=' + Date.now();
        await DB.updateProfile(userId, { avatar_url: res.url });
      }
      return res;
    } catch(e) { return { error: e }; }
  },

  // Upload banner — goes to avatars bucket (banners subfolder)
  async uploadBanner(userId, base64DataUrl) {
    if (!_sbOk()) return { url: null };
    try {
      const arr   = base64DataUrl.split(',');
      const mime  = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bstr  = atob(arr[1]);
      const bytes = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
      const file = new File([bytes], 'banner.jpg', { type: mime });
      const path = `${userId}/banner.jpg`;
      const res  = await DB._uploadFile('avatars', path, file);
      if (res?.url) {
        res.url = res.url.split('?')[0] + '?v=' + Date.now(); // cache-bust (see uploadAvatar)
        await DB.updateProfile(userId, { banner_url: res.url });
      }
      return res;
    } catch(e) { return { error: e }; }
  },

  // Upload a base64 data URL for post images.
  // IMPORTANT: never falls back to returning the raw base64 —
  // storing base64 in the posts table makes every feed load
  // download megabytes of image data (this caused 30s page loads).
  // On failure, returns { error } and the caller must skip the file.
  async uploadBase64(userId, base64DataUrl, index) {
    if (!_sbOk()) return { error: { message: 'Not connected — image not uploaded.' } };
    try {
      const arr   = base64DataUrl.split(',');
      const mime  = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bstr  = atob(arr[1]);
      const bytes = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
      const file = new File([bytes], `img_${index}.jpg`, { type: mime });
      return DB.uploadImage(userId, file);
    } catch(e) { return { error: e }; }
  },

  // Upload a video (base64 data URL) to Supabase Storage.
  // Videos MUST go to Storage — never into the posts table.
  // A single base64 video in a post row is ~9MB of text that every
  // visitor downloads on every page load.
  // On failure, returns { error } and the caller must skip the file.
  async uploadVideo(userId, base64DataUrl, index) {
    if (!_sbOk()) return { error: { message: 'Not connected — video not uploaded.' } };
    try {
      const arr   = base64DataUrl.split(',');
      const mime  = arr[0].match(/:(.*?);/)?.[1] || 'video/mp4';
      const ext   = (mime.split('/')[1] || 'mp4').replace('quicktime', 'mov');
      const bstr  = atob(arr[1]);
      const bytes = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
      const file = new File([bytes], `vid_${index}.${ext}`, { type: mime });
      const path = `${userId}/videos/${Date.now()}_${index}.${ext}`;
      return DB._uploadFile(STORAGE_BUCKET, path, file);
    } catch(e) { return { error: e }; }
  },

  // ─── COMMENTS ──────────────────────────────────────────────
  async getComments(postId) {
    const { data } = await _sb
      .from('comments')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    return data || [];
  },

  async addComment(postId, userId, username, text, parentId = null) {
    const { data, error } = await _sb.from('comments').insert({
      post_id: postId, user_id: userId, username, text, parent_id: parentId,
    }).select().single();
    return { data, error };
  },

  // getCommentCounts() — bulk fetch comment counts for all posts in
  // a single query. Called 2 seconds after the feed renders so it
  // doesn't compete with the initial paint.
  //
  // WHY: If we fetched comment counts per-post that would be 60 separate
  // queries for a 60-post feed (N+1 problem). Instead we do ONE query
  // with .in('post_id', allIds) and count client-side in the result.
  //
  // NOTE: PostgREST's count() aggregate only works when counting rows in
  // a RELATED/joined table (e.g. posts.select('*, comments(count)')).
  // It cannot be used to group-count rows within the same table, so a
  // previous version of this query (select('post_id, id.count()')) always
  // returned a 400 error on every single request. Fetching the post_id
  // column for matching rows and counting client-side is the correct
  // approach here — one query, no server-side grouping needed.
  async getCommentCounts(postIds) {
    if (!_sbOk() || !postIds?.length) return {};
    const { data, error } = await _sb
      .from('comments')
      .select('post_id')
      .in('post_id', postIds);
    if (error) { console.warn('getCommentCounts error:', error.message); return {}; }
    const counts = {};
    (data||[]).forEach(row => { counts[row.post_id] = (counts[row.post_id]||0)+1; });
    return counts;
  },

  async toggleCommentUpvote(commentId, voterId) {
    const { data } = await _sb.from('comments').select('upvoted_by, upvotes').eq('id', commentId).single();
    if (!data) return;
    const upvotedBy = data.upvoted_by || [];
    const already   = upvotedBy.includes(voterId);
    const newUpvotedBy = already ? upvotedBy.filter(v=>v!==voterId) : [...upvotedBy, voterId];
    return _sb.from('comments').update({ upvoted_by: newUpvotedBy, upvotes: newUpvotedBy.length }).eq('id', commentId);
  },

  // ─── EVENTS ────────────────────────────────────────────────
  async getEvents() {
    if (!_sbOk()) return [];
    const { data } = await _sb.from('events').select('*').order('date', { ascending: true });
    return data || [];
  },

  async createEvent(hostId, hostUsername, eventData) {
    const { data, error } = await _sb.from('events')
      .insert({ host_id: hostId, host_username: hostUsername, attendees: [hostUsername], ...eventData })
      .select().single();
    return { data, error };
  },

  async toggleRsvp(eventId, username) {
    const { data: evt } = await _sb.from('events').select('attendees, capacity').eq('id', eventId).single();
    if (!evt) return { error: 'Event not found' };
    const attendees = evt.attendees || [];
    const already   = attendees.includes(username);
    if (!already && evt.capacity && attendees.length >= evt.capacity) return { error: 'Event is full' };
    const newAttendees = already ? attendees.filter(a=>a!==username) : [...attendees, username];
    const { error } = await _sb.from('events').update({ attendees: newAttendees }).eq('id', eventId);
    return { error, attending: !already };
  },

  // ─── FOLLOWS ───────────────────────────────────────────────
  async getFollowing(userId) {
    if (!_sbOk()) return [];
    const { data } = await _sb.from('follows').select('following_id, profiles!following_id(username)').eq('follower_id', userId);
    return (data || []).map(f => f.profiles?.username).filter(Boolean);
  },

  // ── Followers/Following counts + lists, with avatars, for the
  // followers/following system on profile pages ──
  async getFollowerCount(userId) {
    if (!_sbOk() || !userId) return 0;
    // The follows table has no `id` column — it's a pure junction table
    // keyed on (follower_id, following_id). Selecting a column that
    // doesn't exist caused a 400 (Postgres error 42703) on every single
    // call. follower_id always exists, so select that instead — for a
    // head:true count query the column selected doesn't affect the
    // count, it just needs to be real.
    const { count } = await _sb.from('follows').select('follower_id', { count:'exact', head:true }).eq('following_id', userId);
    return count || 0;
  },
  async getFollowingCount(userId) {
    if (!_sbOk() || !userId) return 0;
    const { count } = await _sb.from('follows').select('following_id', { count:'exact', head:true }).eq('follower_id', userId);
    return count || 0;
  },
  async getFollowersList(userId) {
    if (!_sbOk() || !userId) return [];
    const { data } = await _sb.from('follows').select('follower_id, profiles!follower_id(username,avatar_url)').eq('following_id', userId);
    return (data || []).map(r => ({ id:r.follower_id, username:r.profiles?.username, avatarUrl:r.profiles?.avatar_url||null })).filter(x=>x.username);
  },
  async getFollowingList(userId) {
    if (!_sbOk() || !userId) return [];
    const { data } = await _sb.from('follows').select('following_id, profiles!following_id(username,avatar_url)').eq('follower_id', userId);
    return (data || []).map(r => ({ id:r.following_id, username:r.profiles?.username, avatarUrl:r.profiles?.avatar_url||null })).filter(x=>x.username);
  },

  async toggleFollow(followerId, followingId) {
    const { data } = await _sb.from('follows').select('*').eq('follower_id', followerId).eq('following_id', followingId).single();
    if (data) {
      await _sb.from('follows').delete().eq('follower_id', followerId).eq('following_id', followingId);
      return { following: false };
    } else {
      await _sb.from('follows').insert({ follower_id: followerId, following_id: followingId });
      return { following: true };
    }
  },

  // ─── BLOCKS ────────────────────────────────────────────────
  // Requires the blocked_users table — see blocked_users_migration.sql
  async blockUser(blockerId, blockedId) {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { error } = await _sb.from('blocked_users').insert({ blocker_id: blockerId, blocked_id: blockedId });
    if (error && error.code !== '23505') return { error }; // ignore duplicate-block conflicts
    return { error: null };
  },
  async unblockUser(blockerId, blockedId) {
    if (!_sbOk()) return { error: { message: 'Not connected to database.' } };
    const { error } = await _sb.from('blocked_users').delete().eq('blocker_id', blockerId).eq('blocked_id', blockedId);
    return { error };
  },
  // Returns usernames the current user has blocked
  async getBlockedUsers(blockerId) {
    if (!_sbOk()) return [];
    const { data } = await _sb.from('blocked_users').select('blocked_id, profiles!blocked_id(username)').eq('blocker_id', blockerId);
    return (data || []).map(b => ({ id: b.blocked_id, username: b.profiles?.username })).filter(b => b.username);
  },
  // Checks both directions — true if either user has blocked the other
  async isBlockedEitherWay(userIdA, userIdB) {
    if (!_sbOk() || !userIdA || !userIdB) return false;
    const { data } = await _sb.from('blocked_users').select('blocker_id')
      .or(`and(blocker_id.eq.${userIdA},blocked_id.eq.${userIdB}),and(blocker_id.eq.${userIdB},blocked_id.eq.${userIdA})`);
    return !!(data && data.length);
  },

  // ─── MESSAGES ──────────────────────────────────────────────
  async getMessages(userId, otherUserId) {
    const { data } = await _sb
      .from('messages')
      .select('*')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${otherUserId}),and(from_user_id.eq.${otherUserId},to_user_id.eq.${userId})`)
      .order('created_at', { ascending: true });
    return data || [];
  },

  async getConversations(userId) {
    // Get all messages involving this user, grouped by conversation partner
    const { data } = await _sb
      .from('messages')
      .select('*')
      .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    if (!data) return [];
    // Group into conversations
    const seen = new Set();
    const convs = [];
    for (const msg of data) {
      const otherId = msg.from_user_id === userId ? msg.to_user_id : msg.from_user_id;
      const otherName = msg.from_user_id === userId ? msg.to_username : msg.from_username;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const unread = data.filter(m => m.from_user_id === otherId && m.to_user_id === userId && !m.read).length;
      convs.push({ otherId, otherName, lastMsg: msg, unread });
    }
    return convs;
  },

  async sendMessage(fromUserId, toUserId, fromUsername, toUsername, text) {
    const { data, error } = await _sb.from('messages').insert({
      from_user_id: fromUserId, to_user_id: toUserId,
      from_username: fromUsername, to_username: toUsername,
      text,
    }).select().single();
    return { data, error };
  },

  async markMessagesRead(fromUserId, toUserId) {
    return _sb.from('messages')
      .update({ read: true })
      .eq('from_user_id', fromUserId)
      .eq('to_user_id', toUserId)
      .eq('read', false);
  },

  // ─── NOTIFICATIONS ─────────────────────────────────────────
  async getNotifications(userId) {
    if (!_sbOk()) return [];
    const { data } = await _sb
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);
    return data || [];
  },

  async pushNotification(userId, type, fromUsername, message, link = '') {
    return _sb.from('notifications').insert({ user_id: userId, type, from_username: fromUsername, message, link });
  },

  async markNotifRead(notifId) {
    return _sb.from('notifications').update({ read: true }).eq('id', notifId);
  },

  async markAllNotifsRead(userId) {
    return _sb.from('notifications').update({ read: true }).eq('user_id', userId).eq('read', false);
  },

  // ─── REPORTS ───────────────────────────────────────────────
  async submitReport(reporterId, reporterUsername, targetType, targetId, reason, details = '') {
    return _sb.from('reports').insert({
      reporter_id: reporterId, reporter_username: reporterUsername,
      target_type: targetType, target_id: targetId, reason, details,
    });
  },

  async getReports() {
    const { data } = await _sb.from('reports').select('*').order('created_at', { ascending: false });
    return data || [];
  },

  async updateReportStatus(reportId, status) {
    return _sb.from('reports').update({ status }).eq('id', reportId);
  },

  // ─── BUILD COSTS ───────────────────────────────────────────
  async getBuildCosts(postId) {
    const { data } = await _sb.from('build_costs').select('*').eq('post_id', postId).order('created_at');
    return data || [];
  },

  async addBuildCost(postId, name, category, amount, color) {
    const { data, error } = await _sb.from('build_costs').insert({ post_id: postId, name, category, amount, color }).select().single();
    return { data, error };
  },

  async deleteBuildCost(costId) {
    return _sb.from('build_costs').delete().eq('id', costId);
  },

  // ─── TIMELINE ──────────────────────────────────────────────
  async getTimeline(postId) {
    const { data } = await _sb.from('build_timeline').select('*').eq('post_id', postId).order('date');
    return data || [];
  },

  async addTimelineEntry(postId, title, body, date, icon, color) {
    const { data, error } = await _sb.from('build_timeline').insert({ post_id: postId, title, body, date, icon, color }).select().single();
    return { data, error };
  },

  // ─── REALTIME SUBSCRIPTIONS ────────────────────────────────
  subscribeToPost(postId, callback) {
    return _sb.channel(`post:${postId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts', filter: `id=eq.${postId}` }, callback)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments', filter: `post_id=eq.${postId}` }, callback)
      .subscribe();
  },

  // subscribeToMessages() — subscribe to new incoming messages in real-time.
  // Only listens for INSERT events where to_user_id = current user.
  // This means you only receive messages sent TO you, not your own outgoing ones.
  //
  // REQUIRES: Supabase Realtime must be enabled for the messages table.
  // Dashboard → Database → Replication → toggle messages table ON.
  // Without this, messages only appear on refresh.
  subscribeToMessages(userId, callback) {
    return _sb.channel(`messages:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `to_user_id=eq.${userId}` }, callback)
      .subscribe();
  },

  subscribeToNotifications(userId, callback) {
    return _sb.channel(`notifs:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, callback)
      .subscribe();
  },

  // ─── Public-content realtime (new builds/spots/discussions) ────
  // Unlike messages/notifications, these aren't gated by sign-in — a new
  // build posted from someone's phone should show up live for anyone
  // already browsing the feed, signed in or not. No filter needed since
  // this is public content, not addressed to a specific user.
  //
  // REQUIRES: Realtime enabled for these tables in the Supabase dashboard
  // — Database → Replication → toggle posts / social_posts / discussions
  // ON. Without that, new content still appears, just only on refresh.
  subscribeToNewPosts(callback) {
    return _sb.channel('posts:new')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, callback)
      .subscribe();
  },
  subscribeToNewSocialPosts(callback) {
    return _sb.channel('social_posts:new')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'social_posts' }, callback)
      .subscribe();
  },
  subscribeToNewDiscussions(callback) {
    return _sb.channel('discussions:new')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'discussions' }, callback)
      .subscribe();
  },

  // ─── SEARCH ────────────────────────────────────────────────
  async searchPosts(query) {
    const { data } = await _sb
      .from('posts')
      .select('*')
      .or(`title.ilike.%${query}%,make.ilike.%${query}%,model.ilike.%${query}%,description.ilike.%${query}%,mods.ilike.%${query}%`)
      .order('likes', { ascending: false })
      .limit(10);
    return data || [];
  },

  // ─── SOCIAL POSTS (Car Spotting) ──────────────────────────
  // Stored in social_posts table — separate from main build posts.
  // Media URLs point to Supabase Storage (never store raw base64).
  async getSocialPosts({ limit = 30, offset = 0 } = {}) {
    if (!_sbOk()) return [];
    const { data, error } = await _sb
      .from('social_posts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) console.error('getSocialPosts error:', error.message);
    return data || [];
  },

  // getSocialPostsCount — just the total row count, not the rows
  // themselves. Uses head:true (a HEAD request — no response body) so
  // fetching a number for a stats display doesn't cost downloading
  // potentially hundreds of full post records just to count them.
  async getSocialPostsCount() {
    if (!_sbOk()) return 0;
    const { count, error } = await _sb.from('social_posts').select('id', { count:'exact', head:true });
    if (error) { console.warn('getSocialPostsCount error:', error.message); return 0; }
    return count || 0;
  },

  // Fetches one full post by id — used when opening a post from somewhere
  // that only had lightweight data (like a Spotting Map pin), so it works
  // even if that post isn't already sitting in the loaded feed.
  async getSocialPostById(id) {
    if (!_sbOk()) return null;
    const { data, error } = await _sb.from('social_posts').select('*').eq('id', id).single();
    if (error) return null;
    return data;
  },

  // Lightweight — just enough to know WHO has an active (<24hr) Car
  // Spotting post, for the story ring shown across the whole site. Avoids
  // pulling full post data (images/captions/comments) just to answer that.
  async getRecentSpotters() {
    if (!_sbOk()) return [];
    const cutoffIso = new Date(Date.now() - 24*60*60*1000).toISOString();
    const { data, error } = await _sb
      .from('social_posts')
      .select('username,created_at')
      .gte('created_at', cutoffIso)
      .order('created_at', { ascending: false });
    if (error) { console.error('getRecentSpotters error:', error.message); return []; }
    return data || [];
  },

  // Lightweight — just enough to plot a pin on the Spotting Map, not full
  // post data (media/caption/comments). Requires the lat/lng columns from
  // spotting_locations_migration.sql.
  async getSpottingLocations() {
    if (!_sbOk()) return [];
    const { data, error } = await _sb
      .from('social_posts')
      .select('id,username,lat,lng,location_name,media')
      .not('lat', 'is', null)
      .not('lng', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) { console.error('getSpottingLocations error:', error.message); return []; }
    return data || [];
  },

  async createSocialPost(userId, username, postData) {
    if (!_sbOk()) return { error: { message: 'Not connected.' } };
    const { data, error } = await _sb
      .from('social_posts')
      .insert({ user_id: userId, username, ...postData })
      .select()
      .single();
    return { data, error };
  },

  // ─── DISCUSSIONS (Reddit-style board) ───────────────────────
  async getDiscussions({ limit = 30, offset = 0 } = {}) {
    if (!_sbOk()) return [];
    const { data, error } = await _sb
      .from('discussions')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) console.error('getDiscussions error:', error.message);
    return data || [];
  },

  async createDiscussion(userId, username, discussionData) {
    if (!_sbOk()) return { error: { message: 'Not connected.' } };
    const { data, error } = await _sb
      .from('discussions')
      .insert({ user_id: userId, username, ...discussionData })
      .select()
      .single();
    return { data, error };
  },

  async toggleDiscussionVote(discussionId, username, direction) {
    if (!_sbOk()) return;
    const { data: d } = await _sb.from('discussions').select('upvotes,downvotes').eq('id', discussionId).single();
    if (!d) return;
    let up = d.upvotes || [], down = d.downvotes || [];
    if (direction === 'up') {
      down = down.filter(u => u !== username);
      up = up.includes(username) ? up.filter(u => u !== username) : [...up, username];
    } else {
      up = up.filter(u => u !== username);
      down = down.includes(username) ? down.filter(u => u !== username) : [...down, username];
    }
    return _sb.from('discussions').update({ upvotes: up, downvotes: down }).eq('id', discussionId);
  },

  async deleteDiscussion(discussionId, userId) {
    if (!_sbOk()) return;
    return _sb.from('discussions').delete().eq('id', discussionId).eq('user_id', userId);
  },

  async adminDeleteDiscussion(discussionId) {
    if (!_sbOk()) return;
    return _sb.from('discussions').delete().eq('id', discussionId);
  },

  // Comments (and their replies + votes) live in the `comments` jsonb
  // column, same pattern as social_posts — comment shape:
  // { id, user, text, ts, upvotes:[], downvotes:[], parentId (or null) }
  async addDiscussionComment(discussionId, comment) {
    if (!_sbOk()) return;
    const { data: d } = await _sb.from('discussions').select('comments').eq('id', discussionId).single();
    if (!d) return;
    const comments = [...(d.comments || []), comment];
    return _sb.from('discussions').update({ comments }).eq('id', discussionId);
  },

  async toggleDiscussionCommentVote(discussionId, commentId, username, direction) {
    if (!_sbOk()) return;
    const { data: d } = await _sb.from('discussions').select('comments').eq('id', discussionId).single();
    if (!d) return;
    const comments = (d.comments || []).map(c => {
      if (c.id !== commentId) return c;
      let up = c.upvotes || [], down = c.downvotes || [];
      if (direction === 'up') {
        down = down.filter(u => u !== username);
        up = up.includes(username) ? up.filter(u => u !== username) : [...up, username];
      } else {
        up = up.filter(u => u !== username);
        down = down.includes(username) ? down.filter(u => u !== username) : [...down, username];
      }
      return { ...c, upvotes: up, downvotes: down };
    });
    return _sb.from('discussions').update({ comments }).eq('id', discussionId);
  },

  // Overwrites the full comments array — used for deleting a comment
  // (and any replies to it), which requires writing back the modified
  // array rather than appending like addDiscussionComment does.
  async setDiscussionComments(discussionId, comments) {
    if (!_sbOk()) return;
    return _sb.from('discussions').update({ comments }).eq('id', discussionId);
  },

  async toggleSocialLike(postId, username) {
    if (!_sbOk()) return;
    const { data: post } = await _sb.from('social_posts').select('liked_by,likes').eq('id', postId).single();
    if (!post) return;
    const liked = post.liked_by || [];
    const already = liked.includes(username);
    const newLikedBy = already ? liked.filter(u => u !== username) : [...liked, username];
    return _sb.from('social_posts').update({ liked_by: newLikedBy, likes: newLikedBy.length }).eq('id', postId);
  },

  async deleteSocialPost(postId, userId) {
    if (!_sbOk()) return;
    return _sb.from('social_posts').delete().eq('id', postId).eq('user_id', userId);
  },

  // Admin-only delete — no user filter; Supabase RLS must allow it
  // (falls through harmlessly if the policy blocks non-owners).
  async adminDeleteSocialPost(postId) {
    if (!_sbOk()) return;
    return _sb.from('social_posts').delete().eq('id', postId);
  },

  // Append a comment to a spot post. Comments live in the `comments`
  // jsonb column on the social_posts row (same pattern as liked_by),
  // so no extra table or migration is needed.
  // comment shape: { id, user, text, ts, likedBy }
  async addSocialComment(postId, comment) {
    if (!_sbOk()) return;
    const { data: post } = await _sb.from('social_posts').select('comments').eq('id', postId).single();
    if (!post) return;
    const comments = [...(post.comments || []), comment];
    return _sb.from('social_posts').update({ comments }).eq('id', postId);
  },

  // toggleSocialCommentLike — comments are stored inline in the
  // social_posts.comments jsonb array (no separate comments table for
  // spot posts), so "liking" a comment means: fetch the array, find the
  // matching comment by id (or by user+text+ts for older comments that
  // predate having an id — see socialCommentId() in app.js), flip the
  // username in its likedBy array, write the whole array back.
  async toggleSocialCommentLike(postId, commentMatch, username) {
    if (!_sbOk()) return;
    const { data: post } = await _sb.from('social_posts').select('comments').eq('id', postId).single();
    if (!post) return;
    const comments = post.comments || [];
    const idx = comments.findIndex(c =>
      c.id ? c.id === commentMatch.id : (c.user === commentMatch.user && c.text === commentMatch.text && c.ts === commentMatch.ts)
    );
    if (idx === -1) return;
    const likedBy = comments[idx].likedBy || [];
    const already = likedBy.includes(username);
    comments[idx] = { ...comments[idx], likedBy: already ? likedBy.filter(u=>u!==username) : [...likedBy, username] };
    return _sb.from('social_posts').update({ comments }).eq('id', postId);
  },

  // Upload a Car Spotting image to post-images bucket
  // On failure returns { error } — NEVER falls back to raw base64
  // (base64 in the social_posts table would bloat every feed load).
  async uploadSpottingImage(userId, base64DataUrl, index) {
    if (!_sbOk()) return { error: { message: 'Not connected — image not uploaded.' } };
    try {
      const arr   = base64DataUrl.split(',');
      const mime  = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bstr  = atob(arr[1]);
      const bytes = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
      const file = new File([bytes], `spot_${index}.jpg`, { type: mime });
      const path = `spotting/${userId}/${Date.now()}_${index}.jpg`;
      return DB._uploadFile('post-images', path, file);
    } catch(e) { return { error: e }; }
  },

  // ─── BUILD OF THE MONTH VOTING ────────────────────────────
  // BOTM votes use a voteKey like "botm_2025_05" (year_month format)
  // so votes automatically reset each calendar month without any
  // cron job or cleanup needed.
  //
  // The botm_votes table has a unique constraint on (user_id, vote_key)
  // so upsert replaces an existing vote for the same month — meaning
  // a user CAN change their vote within the month.
  // To check if a user has voted this month, app.js checks for a row
  // with the current voteKey and the user's id.
  //
  // Supabase table needed: botm_votes (user_id, vote_key, post_id, created_at)
  // RLS: SELECT public, INSERT for authenticated users only.
  async castBotmVote(postId, userId, voteKey) {
    if (!_sbOk()) return { error: 'not connected' };
    // Upsert replaces an existing vote for this user+month
    const { data, error } = await _sb
      .from('botm_votes')
      .upsert({ user_id: userId, vote_key: voteKey, post_id: postId, created_at: new Date().toISOString() },
               { onConflict: 'user_id,vote_key' });
    return { data, error };
  },

  async getBotmVotes(voteKey) {
    if (!_sbOk()) return [];
    const { data } = await _sb
      .from('botm_votes')
      .select('post_id, user_id')
      .eq('vote_key', voteKey);
    return data || [];
  },

  // ─── FULL TEXT SEARCH ─────────────────────────────────────
  // searchPostsFTS() tries Supabase's native full-text search (websearch mode)
  // which supports quoted phrases, AND/OR operators, and stemming.
  // If FTS returns no results (e.g. FTS index not set up on the table),
  // falls back to ILIKE pattern matching on title and description.
  //
  // To set up FTS in Supabase: add a tsvector column or use the
  // textSearch() method which Supabase handles server-side.
  // For now the ILIKE fallback is reliable enough for a small community.
  async searchPostsFTS(query, limit = 30) {
    if (!_sbOk() || !query?.trim()) return [];
    const { data, error } = await _sb
      .from('posts')
      .select('*')
      .textSearch('title', query, { type: 'websearch', config: 'english' })
      .limit(limit);
    if (!error && data?.length) return data;
    // Fallback: ilike on title and caption
    const q = `%${query}%`;
    const { data: d2 } = await _sb
      .from('posts')
      .select('*')
      .or(`title.ilike.${q},description.ilike.${q}`)
      .limit(limit);
    return d2 || [];
  },

  // Matches on username OR bio, with a caller-configurable result limit.
  // (Two versions of this existed before — one hardcoded to limit(5) and
  // username-only, one with a configurable limit but no bio match. Merged
  // so every call site's limit argument is actually honored.)
  async searchUsers(query, limit = 20) {
    if (!_sbOk() || !query?.trim()) return [];
    const { data } = await _sb
      .from('profiles')
      .select('*')
      .or(`username.ilike.%${query}%,bio.ilike.%${query}%`)
      .limit(limit);
    return data || [];
  },

  // adminDeleteUserAccount — removes a user's profile, build posts,
  // car spotting posts, and comments (everything an admin can act on
  // with the app's publishable key).
  //
  // IMPORTANT LIMITATION: this does NOT delete the person's actual
  // login/auth.users row in Supabase. Deleting an auth user requires
  // the service_role key via Supabase's admin API — that key must
  // never be shipped in client-side code (anyone could read it out of
  // the page source and gain full database access), so a browser app
  // like this one can never safely do a "true" full account deletion
  // on its own. If you want that too, it needs a small server-side
  // function (a Supabase Edge Function using the service role key) —
  // ask and this can be scaffolded, but it can't run from here.
  //
  // What this DOES fully accomplish: the account disappears from the
  // site completely — no profile, no posts, no comments anywhere. The
  // person could theoretically still log into a blank account with
  // their original email/password, but there is nothing left to see.
  async adminDeleteUserAccount(userId) {
    if (!_sbOk() || !userId) return { error: { message: 'Not connected or missing id.' } };
    const results = await Promise.allSettled([
      _sb.from('comments').delete().eq('user_id', userId),
      _sb.from('posts').delete().eq('user_id', userId),
      _sb.from('social_posts').delete().eq('user_id', userId),
      _sb.from('profiles').delete().eq('id', userId),
    ]);
    const failed = results.filter(r => r.status === 'rejected' || r.value?.error);
    if (failed.length) {
      console.warn('adminDeleteUserAccount partial failure:', failed);
      return { error: { message: `${failed.length} of 4 cleanup steps failed — check console.` } };
    }
    return { error: null };
  },

};

// ─── DATA FORMAT CONVERTERS ───────────────────────────────────
// These three functions are the translation layer between Supabase's
// snake_case column names and the app's camelCase property names.
//
// dbPostToApp(row)    — Supabase posts row   → S.posts[] entry
// dbUserToApp(row)    — Supabase profiles row → S.users[] entry
// appPostToDb(post)   — S.posts[] entry      → Supabase posts row
//
// IMPORTANT: any time a new column is added to the Supabase posts or
// profiles table, it must be mapped here or the app won't see it.
//
// dbPostToApp sets comments:[] and commentCount:0 because comment data
// is loaded separately via getCommentCounts() to avoid a JOIN on the
// main feed query (which would be significantly slower).
function dbPostToApp(row) {
  if (!row) return null;
  return {
    id:           row.id,
    title:        row.title,
    make:         row.make,
    model:        row.model,
    year:         row.year,
    category:     row.category,
    categories:   row.categories  || [],
    hp:           row.hp,
    mods:         row.mods,
    modsDetail:   row.mods_detail || {},
    desc:         row.description,
    transmission: row.transmission|| '',
    mileage:      row.mileage     || '',
    buildState:   row.build_state || '',
    zeroSixty:    row.zero_sixty  || '',
    quarterMile:  row.quarter_mile|| '',
    topSpeed:     row.top_speed   || '',
    showSocials:  row.show_socials !== false,
    user:         row.username,
    user_id:      row.user_id,
    likes:        row.likes       || 0,
    likedBy:      row.liked_by    || [],
    savedBy:      row.saved_by    || [],
    views:        row.views       || 0,
    reactions:    row.reactions   || {},
    images:       row.images      || [],
    videos:       row.videos      || [],
    youtubeLinks: row.youtube_links || [],
    color:          row.color          || '',
    colorName:      row.color_name     || '',
    interiorColor:  row.interior_color || '',
    // Comment count comes from separate getCommentCounts() call after render
    comments:     [],
    commentCount: 0,
    date:         (row.created_at || '').slice(0, 10),
    createdAt:    row.created_at || '',
    editedAt:     row.edited_at,
  };
}

// dbUserToApp — converts a Supabase profiles row to the app user format.
// Note: getAllProfiles() only fetches a subset of columns (for speed),
// so some fields here (bio, location, instagram, etc.) will be empty
// strings when the user came from getAllProfiles. They're populated
// fully when getProfile(userId) or getProfileByUsername() is called,
// which selects all columns.
function dbUserToApp(row) {
  if (!row) return null;
  return {
    id:          row.id,
    username:    row.username,
    bio:         row.bio || '',
    location:    row.location || '',
    dreamCar:    row.dream_car || '',
    instagram:   row.instagram || '',
    tiktok:      row.tiktok || '',
    youtube:     row.youtube || '',
    website:     row.website || '',
    awards:      row.awards || [],
    isAdmin:     row.is_admin || false,
    isFeatured:  row.is_featured || false,
    isBrand:     row.is_brand || false,
    lastUsernameChange: row.last_username_change || null,
    isDealership:row.is_dealership || false,
    avatarUrl:   row.avatar_url || null,
    bannerUrl:   row.banner_url || null,
    posts:       0,
    totalLikes:  row.total_likes || 0,
    joined:      (row.joined_at || row.created_at || '').slice(0, 7),
    joinedFull:  row.joined_at || row.created_at,
    // Privacy prefs — stored server-side because they need to affect what
    // OTHER users see, not just this device (localStorage can't do that).
    // Defaults match the settings page's original toggle defaults.
    privacyPublic:      row.privacy_public      !== false, // default true
    privacyLeaderboard: row.privacy_leaderboard !== false, // default true
    privacySocials:     row.privacy_socials     !== false, // default true
    privacyFollowing:   row.privacy_following    === true,  // default false
    privacyLiked:       row.privacy_liked        === true,  // default false
  };
}

function appPostToDb(post) {
  return {
    title:        post.title,
    make:         post.make,
    model:        post.model,
    year:         post.year        || '',
    category:     post.category    || '',
    categories:   post.categories  || [],
    hp:           post.hp          || '',
    mods:         post.mods        || '',
    mods_detail:  post.modsDetail  || {},
    description:  post.desc        || '',
    images:       post.images      || [],
    videos:       post.videos      || [],
    youtube_links: post.youtubeLinks || [],
    color:          post.color         || '',
    color_name:     post.colorName     || '',
    interior_color: post.interiorColor || '',
    transmission: post.transmission|| '',
    mileage:      post.mileage     || '',
    build_state:  post.buildState  || '',
    zero_sixty:   post.zeroSixty   || '',
    quarter_mile: post.quarterMile || '',
    top_speed:    post.topSpeed    || '',
    show_socials: post.showSocials !== false,
    state:        post.state || '',
    liked_by:     post.likedBy     || [],
    saved_by:     post.savedBy     || [],
    reactions:    post.reactions   || {},
  };
}
