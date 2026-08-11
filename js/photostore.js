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
let _refFn, _uploadStringFn, _getDownloadURLFn, _deleteObjectFn;

// Local trips stay base64 forever (only the synced copy swaps to a URL), so
// every sync re-scans the same photos. Without this cache, an unchanged trip
// re-uploads its photos as brand-new files on every single sync — wasted
// bandwidth/quota, duplicate orphaned files in Storage, and competing network
// traffic that made photos feel slower to load.
const _uploadCache = new Map(); // base64 data: URL -> download URL

/** Initialise Storage against the already-initialised Firebase app. Called once from auth.js. */
export async function initPhotoStore(app) {
  try {
    const mod = await import(`${FB}/firebase-storage.js`);
    _storage          = mod.getStorage(app);
    _refFn            = mod.ref;
    _uploadStringFn   = mod.uploadString;
    _getDownloadURLFn = mod.getDownloadURL;
    _deleteObjectFn   = mod.deleteObject;
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
  const cached = _uploadCache.get(dataUrl);
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
    _uploadCache.set(dataUrl, url);
    return url;
  } catch (err) {
    console.warn('[photostore] upload failed:', err.message);
    return null;
  }
}

/** Best-effort delete of a Storage photo by its download URL. Never throws. */
export async function deletePhoto(url) {
  if (!_storage || !url || !url.includes('firebasestorage')) return;
  try {
    await _deleteObjectFn(_refFn(_storage, url));
  } catch (_) { /* already gone, permission race, etc. — non-fatal */ }
}
