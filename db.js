/* ============================================================
   DRIVELOG — DB.JS   (Supabase data layer)
   All data operations go through this file.
   app.js calls DB.* instead of reading/writing localStorage.
   ============================================================ */

const SUPABASE_URL  = 'https://lsnpxneywkrirfkfszbo.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_wF4jFiIEuucuJXJJo8sn0Q_b2PRnh6-';
const STORAGE_BUCKET = 'post-images';

// ─── CLIENT ───────────────────────────────────────────────────
let _sb = null;
function _initSb() {
  if (_sb) return _sb;
  try {
    if (typeof supabase !== 'undefined') {
      _sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
  } catch(e) { console.warn('Supabase init failed:', e); }
  return _sb;
}
// Initialize immediately (works if CDN is in <head>)
_initSb();

// Helper: returns true if Supabase is available
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

  // ── Get current session ────────────────────────────────────
  async getSession() {
    if (!_sbOk()) return null;
    const { data } = await _sb.auth.getSession();
    if (!data?.session) return null;
    // Return immediately from session metadata — don't wait for profile fetch
    // Profile enrichment happens via getAllProfiles in background
    const meta = data.session.user.user_metadata || {};
    const base = { ...data.session.user, username: meta.username || data.session.user.email?.split('@')[0] || 'User' };
    // Non-blocking profile enrich — fires but doesn't block session return
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

  async getAllProfiles() {
    if (!_sbOk()) return [];
    // Only fetch fields needed for display — skip heavy fields like bio/awards/socials
    // Full profile loads on demand when someone opens a profile page
    const { data, error } = await _sb
      .from('profiles')
      .select('id,username,avatar_url,is_featured,is_admin,joined_at,posts_count')
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

  async toggleLike(postId, voterId) {
    const { data: post } = await _sb.from('posts').select('liked_by, likes').eq('id', postId).single();
    if (!post) return;
    const liked = (post.liked_by || []);
    const already = liked.includes(voterId);
    const newLikedBy = already ? liked.filter(v => v !== voterId) : [...liked, voterId];
    return _sb.from('posts').update({
      liked_by: newLikedBy,
      likes: newLikedBy.length,
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

  // Upload avatar — goes to avatars bucket, overwrites previous
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
        // Also save URL to profile
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
      if (res?.url) await DB.updateProfile(userId, { banner_url: res.url });
      return res;
    } catch(e) { return { error: e }; }
  },

  // Upload a base64 data URL for post images
  async uploadBase64(userId, base64DataUrl, index) {
    if (!_sbOk()) return { url: base64DataUrl };
    const arr   = base64DataUrl.split(',');
    const mime  = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const bstr  = atob(arr[1]);
    const bytes = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
    const file = new File([bytes], `img_${index}.jpg`, { type: mime });
    return DB.uploadImage(userId, file);
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

  // Bulk-fetch comment counts for many posts in ONE query (used by the feed
  // so card previews can show real comment counts without N+1 queries)
  async getCommentCounts(postIds) {
    if (!_sbOk() || !postIds?.length) return {};
    // NOTE: PostgREST's count() aggregate only works when counting rows in
    // a RELATED/joined table (e.g. posts.select('*, comments(count)')).
    // It cannot be used to group-count rows within the same table like
    // this, so a previous version of this query (select('post_id, id.count()'))
    // always returned a 400 error on every single request. Fetching the
    // post_id column for matching rows and counting client-side is the
    // correct approach here — one query, no server-side grouping needed.
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

  async searchUsers(query) {
    const { data } = await _sb
      .from('profiles')
      .select('*')
      .or(`username.ilike.%${query}%,bio.ilike.%${query}%`)
      .limit(5);
    return data || [];
  },

  // ─── SOCIAL POSTS (Car Spotting) ──────────────────────────
  // Stored in social_posts table — separate from main build posts.
  // Media URLs point to Supabase Storage (never store raw base64).
  // Requires social_posts_migration.sql to have been run in Supabase.
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

  async createSocialPost(userId, username, postData) {
    if (!_sbOk()) return { error: { message: 'Not connected.' } };
    const { data, error } = await _sb
      .from('social_posts')
      .insert({ user_id: userId, username, ...postData })
      .select()
      .single();
    return { data, error };
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

  // Upload a Car Spotting image to post-images bucket
  async uploadSpottingImage(userId, base64DataUrl, index) {
    if (!_sbOk()) return { url: base64DataUrl };
    try {
      const arr   = base64DataUrl.split(',');
      const mime  = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bstr  = atob(arr[1]);
      const bytes = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
      const file = new File([bytes], `spot_${index}.jpg`, { type: mime });
      const path = `spotting/${userId}/${Date.now()}_${index}.jpg`;
      return DB._uploadFile('post-images', path, file);
    } catch(e) { return { url: base64DataUrl }; }
  },

};

// ─── DATA FORMAT HELPERS ───────────────────────────────────────
// Convert Supabase row format → app's internal format
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
    reactions:    row.reactions   || {},
    images:       row.images      || [],
    videos:       row.videos      || [],
    // Comment count comes from separate getCommentCounts() call after render
    comments:     [],
    commentCount: 0,
    date:         (row.created_at || '').slice(0, 10),
    createdAt:    row.created_at || '',
    editedAt:     row.edited_at,
  };
}

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
    avatarUrl:   row.avatar_url || null,
    posts:       0,
    totalLikes:  row.total_likes || 0,
    joined:      (row.joined_at || row.created_at || '').slice(0, 7),
    joinedFull:  row.joined_at || row.created_at,
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
  
  // ─── BOTM VOTING ───────────────────────────────────────────
  async castBotmVote(postId, userId, voteKey) {
    if (!_sbOk()) return { error: 'not connected' };
    // Upsert — one row per user per month (voteKey = "botm_2025_05")
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

  // ─── FULL TEXT SEARCH ──────────────────────────────────────
  async searchPostsFTS(query, limit = 30) {
    if (!_sbOk() || !query?.trim()) return [];
    // Try Supabase full-text search first
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

  async searchUsers(query, limit = 20) {
    if (!_sbOk() || !query?.trim()) return [];
    const { data } = await _sb
      .from('profiles')
      .select('*')
      .ilike('username', `%${query}%`)
      .limit(limit);
    return data || [];
  },

};
}
