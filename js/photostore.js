/* ============================================================
   CARNET DE VOYAGES — Photo storage (Firebase Cloud Storage)
   ============================================================
   Trip photos are uploaded here as real files instead of being embedded as
   base64 inside Firestore documents (which cap at ~1 MB total per document).
   This is what lets the personal sync document (users/{uid}) stay tiny no
   matter how large the photo library grows — it only ever stores each
   photo's download URL, never its content.
   ============================================================ */

const FB = 'https://www.gstatic.com/firebasejs/11.1.0';

let _storage = null;
let _refFn, _uploadStringFn, _getDownloadURLFn, _deleteObjectFn;

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
  try {
    const id      = 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const fileRef = _refFn(_storage, `users/${uid}/photos/${id}.jpg`);
    await _uploadStringFn(fileRef, dataUrl, 'data_url');
    return await _getDownloadURLFn(fileRef);
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
