/* ============================================================
   CARNET DE VOYAGES — Photo storage (Firebase Cloud Storage)
   ============================================================
   Trip photos are uploaded here as real files instead of being embedded as
   base64 inside Firestore documents (which cap at ~1 MB total per document).
   This is what lets the personal sync document (users/{uid}) stay tiny no
   matter how large the photo library grows — it only ever stores each
   photo's download URL, never its content.
   ============================================================ */

import { compressPhotoDataUrl } from './utils.js';

const FB = 'https://www.gstatic.com/firebasejs/11.1.0';

// "Web-quality full size" — large enough to look great on any screen (including
// 4K), but a fraction of a raw phone-camera photo's size (often 3000-4000px+ on
// the long edge), which is what was making photos slow to load over the network.
const UPLOAD_MAX_SIZE = 2000;
const UPLOAD_QUALITY  = 0.88;

let _storage = null;
let _refFn, _uploadStringFn, _getDownloadURLFn, _deleteObjectFn, _listAllFn;

// Local trips stay base64 forever (only the synced copy swaps to a URL), so
// every sync re-scans the same photos. Without a cache, an unchanged trip
// re-uploads its photos as brand-new files on every single sync — wasted
// bandwidth/quota, duplicate orphaned files in Storage (each sync/reload
// creating yet another copy of the exact same photo), and competing network
// traffic that made photos feel slower to load.
//
// Persisted to localStorage (not just in-memory) — a plain in-memory Map
// resets on every page reload/app restart, and a PWA gets reopened far more
// often than a single tab stays alive, so an in-memory-only cache barely
// helped: nearly every sync from a fresh session re-uploaded everything.
// Keyed by a cheap hash of the base64 content (not the content itself —
// storing full data: URLs as localStorage keys would burn through its
// 5-10 MB quota fast); only the short resulting URL is stored per entry.
const _CACHE_KEY = 'carnet_photo_upload_cache';

function _hashKey(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return str.length + ':' + h;
}

function _loadUploadCache() {
  try { return JSON.parse(localStorage.getItem(_CACHE_KEY) || '{}'); }
  catch (_) { return {}; }
}

const _uploadCache = _loadUploadCache(); // hash(base64) -> download URL

function _persistUploadCache() {
  try { localStorage.setItem(_CACHE_KEY, JSON.stringify(_uploadCache)); }
  catch (_) { /* storage full/unavailable — non-fatal, just no persistent caching this run */ }
}

/** Initialise Storage against the already-initialised Firebase app. Called once from auth.js. */
export async function initPhotoStore(app) {
  try {
    const mod = await import(`${FB}/firebase-storage.js`);
    _storage          = mod.getStorage(app);
    _refFn            = mod.ref;
    _uploadStringFn   = mod.uploadString;
    _getDownloadURLFn = mod.getDownloadURL;
    _deleteObjectFn   = mod.deleteObject;
    _listAllFn        = mod.listAll;
  } catch (err) {
    // Storage not enabled on this Firebase project (Spark plan, etc.) — sync
    // falls back to embedding compressed photos directly in Firestore.
    console.warn('[photostore] Storage init failed:', err.message);
  }
}

export function isPhotoStoreReady() { return !!_storage; }

/**
 * Upload a base64 data: URL photo to Storage and return its https download
 * URL. Returns null on failure (offline, quota, Storage not configured) —
 * callers fall back to embedding a compressed copy instead.
 */
export async function uploadPhoto(uid, dataUrl) {
  if (!_storage || !dataUrl || !dataUrl.startsWith('data:')) return null;
  const key    = _hashKey(dataUrl);
  const cached = _uploadCache[key];
  if (cached !== undefined) return cached;
  try {
    const resized = await compressPhotoDataUrl(dataUrl, UPLOAD_MAX_SIZE, UPLOAD_QUALITY);
    const id      = 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const fileRef = _refFn(_storage, `users/${uid}/photos/${id}.jpg`);
    // Each id is unique and the file is never overwritten, so it's safe to
    // cache aggressively — repeat views load instantly from then on.
    await _uploadStringFn(fileRef, resized || dataUrl, 'data_url', {
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const url = await _getDownloadURLFn(fileRef);
    _uploadCache[key] = url;
    _persistUploadCache();
    return url;
  } catch (err) {
    console.warn('[photostore] upload failed:', err.message);
    return null;
  }
}

/** Best-effort delete of a Storage photo by its download URL. Never throws. */
export async function deletePhoto(url) {
  if (!_storage || !url || !url.includes('firebasestorage')) return;
  // Drop any cache entry pointing at this URL — otherwise re-adding the exact
  // same photo later would return this now-dead URL instead of re-uploading.
  for (const [key, cachedUrl] of Object.entries(_uploadCache)) {
    if (cachedUrl === url) delete _uploadCache[key];
  }
  _persistUploadCache();
  try {
    await _deleteObjectFn(_refFn(_storage, url));
  } catch (_) { /* already gone, permission race, etc. — non-fatal */ }
}

/**
 * One-time bulk sweep of users/{uid}/photos/: lists every file actually
 * sitting in Storage and deletes any whose download URL isn't in
 * referencedUrls. Cleans up duplicates/orphans left behind before the
 * per-sync cleanup in syncToFirestore existed (or from any sync that failed
 * partway through). Returns { scanned, removed }. Never throws — a listing
 * or per-file failure just leaves that file for a future run.
 */
export async function cleanupOrphanedPhotos(uid, referencedUrls) {
  if (!_storage || !_listAllFn || !uid) return { scanned: 0, removed: 0 };
  const folderRef = _refFn(_storage, `users/${uid}/photos`);
  let items;
  try {
    ({ items } = await _listAllFn(folderRef));
  } catch (err) {
    console.warn('[photostore] cleanup listAll failed:', err.message);
    return { scanned: 0, removed: 0 };
  }

  let removed = 0;
  for (const itemRef of items) {
    let url;
    try {
      url = await _getDownloadURLFn(itemRef);
    } catch (_) {
      continue; // already gone / unreadable — skip
    }
    if (referencedUrls.has(url)) continue;
    // Purge any stale cache entry so a future re-add re-uploads instead of
    // returning this about-to-be-deleted URL.
    for (const [key, cachedUrl] of Object.entries(_uploadCache)) {
      if (cachedUrl === url) delete _uploadCache[key];
    }
    try {
      await _deleteObjectFn(itemRef);
      removed++;
    } catch (_) { /* permission race, already deleted — non-fatal */ }
  }
  if (removed) _persistUploadCache();
  return { scanned: items.length, removed };
}
