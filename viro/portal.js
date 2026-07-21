import { firebaseConfig, PORTAL_ACCOUNT_EMAIL, GOOGLE_CLIENT_ID, GOOGLE_PLACES_API_KEY } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app);
const callAiAssist = httpsCallable(functions, 'aiAssist');
const callGoogleCalendarConnect = httpsCallable(functions, 'googleCalendarConnect');
const callGoogleCalendarToken = httpsCallable(functions, 'googleCalendarToken');
const callGoogleCalendarDisconnect = httpsCallable(functions, 'googleCalendarDisconnect');

// Wraps the aiAssist Cloud Function call with a friendlier error for the
// (very likely, until it's deployed) case where the function doesn't exist
// yet on this Firebase project.
async function requestAi(task, text, context) {
  try {
    const { data } = await callAiAssist({ task, text, context });
    return data?.result;
  } catch (err) {
    console.error('AI request failed', err);
    throw new Error(
      err?.code === 'functions/not-found' || err?.code === 'not-found'
        ? 'AI isn’t set up on this project yet.'
        : 'AI request failed. Try again.'
    );
  }
}

/* ==================== crypto helpers ==================== */
/* Vault secrets (passwords, card numbers, PINs) are encrypted in the browser
   with a key derived from your PIN before they ever reach Firestore. The PIN
   itself is never stored anywhere. */

function bufToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return window.btoa(binary);
}

function b64ToBuf(b64) {
  const binary = window.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(pin, saltB64) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBuf(saltB64), iterations: 150000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    // Extractable so it can be persisted for "stay logged in on this device"
    // (see persistSessionKey) — the trade-off is spelled out there.
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptPayload(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return { iv: bufToB64(iv), ciphertext: bufToB64(ciphertext) };
}

async function decryptPayload(key, ivB64, ciphertextB64) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivB64) },
    key,
    b64ToBuf(ciphertextB64)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function getOrCreateSalt(uid) {
  const ref = doc(db, 'users', uid, 'meta', 'security');
  const snap = await getDoc(ref);
  if (snap.exists() && snap.data().salt) {
    return snap.data().salt;
  }
  const saltB64 = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
  await setDoc(ref, { salt: saltB64, createdAt: serverTimestamp() });
  return saltB64;
}

/* ==================== remembered session ==================== */
/* So a refresh doesn't ask for the PIN again on this device. Firebase Auth
   already persists its own session by default; this additionally persists
   the derived AES key so the vault can still decrypt without re-entering
   the PIN. Trade-off: anyone with access to this browser's local storage
   (not just anyone who finds the URL) could extract this key and, combined
   with the already-persisted Firebase session, read the vault — that's the
   cost of "stay logged in on this computer." Logging out clears it. */

const SESSION_KEY_STORAGE = 'viro-session-key';

async function persistSessionKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  window.localStorage.setItem(SESSION_KEY_STORAGE, bufToB64(raw));
}

async function restoreSessionKey() {
  const b64 = window.localStorage.getItem(SESSION_KEY_STORAGE);
  if (!b64) return null;
  try {
    return await crypto.subtle.importKey('raw', b64ToBuf(b64), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt'
    ]);
  } catch (err) {
    console.error(err);
    return null;
  }
}

function clearSessionKey() {
  window.localStorage.removeItem(SESSION_KEY_STORAGE);
}

/* ==================== state ==================== */

let currentUser = null;
let encryptionKey = null;
let birthdays = [];
let todos = { school: [], personal: [], business: [] };
let vaultEntries = [];
let contacts = [];
let folders = [];
let files = [];
let currentFolderId = '';
let aiSearchResultIds = null;
let noteFolders = [];
let notes = [];
let currentNoteFolderId = '';
let currentNoteId = null;
let aiNoteSearchResultIds = null;
let aiContactSearchResultIds = null;
let calendarConnected = false;
let calendarEmail = '';
let googleAccessToken = null;
let googleAccessTokenExpiryMs = 0;
let calendarWeekStart = startOfWeek(new Date());
let calendarEvents = [];
let calendarSummaryCache = null;
let knownPlaces = [];
let userGeoCoords = null;
const unsubscribers = [];

/* ==================== DOM refs ==================== */

const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const pinInput = document.getElementById('pin-input');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const loginSubmitLabel = document.getElementById('login-submit-label');
const greetingLoader = document.getElementById('greeting-loader');
const greetingText = document.getElementById('greeting-text');
const portalEl = document.getElementById('portal');
const portalNav = document.getElementById('portal-nav');
const logoutBtn = document.getElementById('logout-btn');
const modalEl = document.getElementById('modal');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalContent = document.getElementById('modal-content');
const modalClose = document.getElementById('modal-close');

/* ==================== theme ==================== */
/* Shares the same localStorage key and view-transition reveal animation as
   the main site (see ../script.js) so light/dark preference and the
   click-origin circle-wipe are identical across both. */

const THEME_STORAGE_KEY = 'aidenyue-theme-preference';
const themeToggleBtn = document.getElementById('theme-toggle');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function setTheme(theme) {
  document.body.dataset.theme = theme;
}

const savedTheme = window.localStorage?.getItem(THEME_STORAGE_KEY);
setTheme(savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark');

themeToggleBtn?.addEventListener('click', (event) => {
  const nextTheme = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  window.localStorage?.setItem(THEME_STORAGE_KEY, nextTheme);

  const originX = event.clientX || themeToggleBtn.getBoundingClientRect().left;
  const originY = event.clientY || themeToggleBtn.getBoundingClientRect().top;
  document.documentElement.style.setProperty('--theme-x', `${originX}px`);
  document.documentElement.style.setProperty('--theme-y', `${originY}px`);

  if (!prefersReducedMotion && document.startViewTransition) {
    document.startViewTransition(() => setTheme(nextTheme));
  } else {
    setTheme(nextTheme);
  }
});

/* ==================== login ==================== */

let manualLoginInProgress = false;

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = pinInput.value.trim();
  if (!pin) return;

  manualLoginInProgress = true;
  loginError.hidden = true;
  loginSubmit.disabled = true;
  loginSubmitLabel.textContent = 'Checking…';

  try {
    const user = await loginWithPin(pin);
    const saltB64 = await getOrCreateSalt(user.uid);
    encryptionKey = await deriveKey(pin, saltB64);
    currentUser = user;
    await persistSessionKey(encryptionKey);
    pinInput.value = '';
    enterPortal();
  } catch (err) {
    console.error(err);
    loginError.hidden = false;
    pinInput.value = '';
    pinInput.focus();
  } finally {
    manualLoginInProgress = false;
    loginSubmit.disabled = false;
    loginSubmitLabel.textContent = 'Unlock';
  }
});

async function loginWithPin(pin) {
  try {
    // First run: no account exists yet, so this PIN becomes the password.
    const cred = await createUserWithEmailAndPassword(auth, PORTAL_ACCOUNT_EMAIL, pin);
    return cred.user;
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      const cred = await signInWithEmailAndPassword(auth, PORTAL_ACCOUNT_EMAIL, pin);
      return cred.user;
    }
    throw err;
  }
}

// Resumes an existing session on page load (e.g. after a refresh) so the PIN
// only has to be entered once per device, until Log out is pressed. Skips
// itself entirely while a manual PIN submit is in flight to avoid a race
// where this fires mid-login and signs the user right back out.
onAuthStateChanged(auth, async (user) => {
  if (manualLoginInProgress || currentUser) return;

  if (!user) {
    loginScreen.hidden = false;
    return;
  }

  const storedKey = await restoreSessionKey();
  if (!storedKey) {
    // Authenticated but we don't have the key to decrypt the vault (e.g.
    // storage was cleared on this device) — force a clean re-login instead
    // of leaving the portal in a half-usable state.
    await signOut(auth);
    loginScreen.hidden = false;
    return;
  }

  currentUser = user;
  encryptionKey = storedKey;
  enterPortal();
});

logoutBtn.addEventListener('click', async () => {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers.length = 0;
  encryptionKey = null;
  currentUser = null;
  vaultUnlocked = false;
  clearSessionKey();
  await signOut(auth);
  portalEl.hidden = true;
  loginScreen.hidden = false;
  pinInput.focus();
});

/* ==================== greeting + entrance ==================== */

function getGreeting() {
  const hour = new Date().getHours();
  let part = 'evening';
  if (hour >= 8 && hour < 12) part = 'morning';
  else if (hour >= 12 && hour < 18) part = 'afternoon';
  return `Good ${part}, Aiden`;
}

function enterPortal() {
  loginScreen.hidden = true;
  greetingText.textContent = getGreeting();
  greetingLoader.hidden = false;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const minWait = prefersReducedMotion ? 0 : 1700;

  window.setTimeout(() => {
    greetingLoader.classList.add('is-exiting');
    portalEl.hidden = false;
    startPortal();
    window.setTimeout(() => {
      greetingLoader.hidden = true;
      greetingLoader.classList.remove('is-exiting');
    }, 650);
  }, minWait);
}

function startPortal() {
  startClock();
  startWeather();
  renderFolderChips();
  renderNoteFolderChips();
  updateCalendarWeekLabel();
  subscribeCollections();
}

/* ==================== tab navigation ==================== */
/* Vault gets an extra step-up password on top of the portal PIN + the
   client-side encryption already protecting its contents — mainly to stop
   casual access if the portal is left open on this device. It resets on
   every fresh page load/login, unlike the PIN, so it doesn't just become a
   second copy of the same "stay logged in" convenience. */

const VAULT_PASSWORD = 'Aiden1loves$';
let vaultUnlocked = false;

portalNav.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-tab]');
  if (!btn) return;
  requestTabSwitch(btn.dataset.tab);
});

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-goto-tab]');
  if (!link) return;
  event.preventDefault();
  requestTabSwitch(link.dataset.gotoTab);
});

function requestTabSwitch(tabName, onArrive) {
  if (tabName === 'vault' && !vaultUnlocked) {
    openVaultUnlockPrompt(() => {
      switchTab('vault');
      onArrive?.();
    });
    return;
  }
  switchTab(tabName);
  onArrive?.();
}

// Briefly flashes and scrolls to the card for `id` - used when jumping to a
// result from the Overview universal search, since that search spans every
// tab and the matching card might be off-screen or the tab just switched to.
function highlightEntry(id) {
  const el = document.querySelector(`.entry-card[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('entry-highlight');
  setTimeout(() => el.classList.remove('entry-highlight'), 1800);
}

function openVaultUnlockPrompt(onSuccess) {
  openModal(
    `
    <h2>Vault locked</h2>
    <form id="vault-unlock-form">
      <label>Password<input type="password" name="password" required autocomplete="off" /></label>
      <p class="form-error" id="vault-unlock-error" hidden>Incorrect password.</p>
      <button class="button primary" type="submit">Unlock</button>
    </form>
  `,
    (root) => {
      const input = root.querySelector('[name="password"]');
      const errorEl = root.querySelector('#vault-unlock-error');
      input.focus();
      root.querySelector('#vault-unlock-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (input.value === VAULT_PASSWORD) {
          vaultUnlocked = true;
          closeModal();
          onSuccess();
        } else {
          errorEl.hidden = false;
          input.value = '';
          input.focus();
        }
      });
    }
  );
}

function switchTab(tabName) {
  document.querySelectorAll('.portal-tab').forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });
  document.querySelectorAll('.portal-nav button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tabName);
  });
}

/* ==================== modal ==================== */

function openModal(html, onMount, extraClass) {
  modalEl.className = extraClass ? `modal ${extraClass}` : 'modal';
  modalContent.innerHTML = html;
  modalBackdrop.hidden = false;
  if (onMount) onMount(modalContent);
}

// Set by openFilePreview while a multi-page entry is open, so the single
// persistent keydown listener below can page through it. Cleared on close
// rather than attaching/detaching a listener per preview open.
let activePager = null;

function closeModal() {
  modalBackdrop.hidden = true;
  modalContent.innerHTML = '';
  activePager = null;
}

function confirmAction(title, message, confirmLabel, onConfirm) {
  openModal(
    `
    <h2>${escapeHtml(title)}</h2>
    <p class="confirm-message">${escapeHtml(message)}</p>
    <div class="confirm-actions">
      <button class="button ghost" type="button" id="confirm-cancel-btn">Cancel</button>
      <button class="button danger" type="button" id="confirm-delete-btn">${escapeHtml(confirmLabel)}</button>
    </div>
  `,
    (root) => {
      root.querySelector('#confirm-cancel-btn').addEventListener('click', closeModal);
      root.querySelector('#confirm-delete-btn').addEventListener('click', () => {
        closeModal();
        onConfirm();
      });
    }
  );
}

function confirmDelete(message, onConfirm) {
  confirmAction('Delete?', message, 'Delete', onConfirm);
}

modalClose.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (event) => {
  if (event.target === modalBackdrop) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (modalBackdrop.hidden) return;
  if (event.key === 'Escape') {
    closeModal();
    return;
  }
  if (!activePager) return;
  if (event.key === 'ArrowLeft') activePager.prev();
  if (event.key === 'ArrowRight') activePager.next();
});

/* ==================== firestore helpers ==================== */

function userCollection(name) {
  return collection(db, 'users', currentUser.uid, name);
}

function userDoc(name, id) {
  return doc(db, 'users', currentUser.uid, name, id);
}

function subscribeCollections() {
  unsubscribers.push(
    onSnapshot(userCollection('birthdays'), (snap) => {
      birthdays = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderBirthdays();
      renderOverviewBirthdays();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('todos'), (snap) => {
      todos = { school: [], personal: [], business: [] };
      snap.docs.forEach((d) => {
        const data = { id: d.id, ...d.data() };
        if (todos[data.category]) todos[data.category].push(data);
      });
      renderTodos();
      renderOverviewTodos();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('vault'), (snap) => {
      vaultEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderVault();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('contacts'), (snap) => {
      contacts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderContacts();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('folders'), (snap) => {
      folders = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      renderFolderChips();
      renderFiles();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('files'), (snap) => {
      files = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderFiles();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('noteFolders'), (snap) => {
      noteFolders = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      renderNoteFolderChips();
      populateNoteFolderSelect();
      renderNotes();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('notes'), (snap) => {
      notes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderNotes();
    })
  );

  unsubscribers.push(
    onSnapshot(userCollection('knownPlaces'), (snap) => {
      knownPlaces = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    })
  );

  // The Cloud Function keeps this token-free "status" doc in sync whenever it connects/
  // disconnects Google Calendar - the client never reads the doc that actually holds the
  // refresh token, so this is the only way it knows whether it's connected.
  unsubscribers.push(
    onSnapshot(userDoc('googleCalendar', 'status'), (snap) => {
      const wasConnected = calendarConnected;
      calendarConnected = !!snap.data()?.connected;
      calendarEmail = snap.data()?.email || '';
      updateCalendarConnectionUI();
      if (calendarConnected && !wasConnected) {
        loadWeekEvents();
      }
    })
  );
}

/* ==================== birthdays ==================== */

function nextOccurrence(isoDate) {
  const [, month, day] = isoDate.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let next = new Date(today.getFullYear(), month - 1, day);
  if (next < today) {
    next = new Date(today.getFullYear() + 1, month - 1, day);
  }
  return next;
}

function daysUntil(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date - today) / 86400000);
}

function formatDaysUntil(n) {
  if (n === 0) return 'Today!';
  if (n === 1) return 'Tomorrow';
  if (n < 14) return `In ${n} days`;
  const weeks = Math.round(n / 7);
  return `In ${weeks} week${weeks === 1 ? '' : 's'}`;
}

function sortedBirthdays() {
  return [...birthdays].sort((a, b) => nextOccurrence(a.date) - nextOccurrence(b.date));
}

function renderBirthdays() {
  const list = document.getElementById('birthday-list');
  const query = (document.getElementById('birthday-search').value || '').toLowerCase();
  const items = sortedBirthdays().filter((b) => b.name.toLowerCase().includes(query));

  if (!items.length) {
    list.innerHTML = '<p class="entry-empty">No birthdays found.</p>';
    return;
  }

  list.innerHTML = items
    .map((b) => {
      const next = nextOccurrence(b.date);
      const turning = next.getFullYear() - Number(b.date.split('-')[0]);
      return `
        <article class="entry-card" data-id="${b.id}">
          <div class="entry-main">
            <div class="entry-title">${escapeHtml(b.name)} <span class="tag tag--personal">${formatDaysUntil(daysUntil(next))}</span></div>
            <p class="entry-meta">${escapeHtml(b.relationship || 'Friend')} · Turning ${turning} · ${next.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</p>
            ${b.notes ? `<p class="entry-desc">${escapeHtml(b.notes)}</p>` : ''}
          </div>
          <div class="entry-actions">
            <button class="icon-btn" data-edit-birthday="${b.id}" aria-label="Edit"><span class="material-symbols-outlined">edit</span></button>
            <button class="icon-btn" data-delete-birthday="${b.id}" aria-label="Delete"><span class="material-symbols-outlined">delete</span></button>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderOverviewBirthdays() {
  const list = document.getElementById('overview-birthdays');
  const upcoming = sortedBirthdays()
    .map((b) => ({ ...b, next: nextOccurrence(b.date) }))
    .filter((b) => daysUntil(b.next) <= 14)
    .slice(0, 5);

  if (!upcoming.length) {
    list.innerHTML = '<li class="entry-empty">Nothing in the next two weeks.</li>';
    return;
  }

  list.innerHTML = upcoming
    .map(
      (b) => `
        <li class="entry-card entry-card--compact">
          <div class="entry-main">
            <div class="entry-title">${escapeHtml(b.name)}</div>
            <p class="entry-meta">${formatDaysUntil(daysUntil(b.next))}</p>
          </div>
        </li>
      `
    )
    .join('');
}

document.getElementById('birthday-search').addEventListener('input', renderBirthdays);

document.getElementById('add-birthday-btn').addEventListener('click', () => openBirthdayForm());

const BIRTHDAY_RELATIONSHIPS = ['Family', 'Friend', 'Coworker', 'Other'];

function openBirthdayForm(existing = null) {
  openModal(
    `
    <h2>${existing ? 'Edit' : 'Add'} birthday</h2>
    <form id="birthday-form">
      <label>Name<input type="text" name="name" required value="${escapeHtml(existing?.name || '')}" /></label>
      <label>Birthday<input type="date" name="date" required value="${existing?.date || ''}" /></label>
      <label>Relationship
        <select name="relationship">
          ${BIRTHDAY_RELATIONSHIPS.map(
            (r) => `<option ${existing?.relationship === r ? 'selected' : ''}>${r}</option>`
          ).join('')}
        </select>
      </label>
      <label>Notes (optional)<textarea name="notes" rows="2">${escapeHtml(existing?.notes || '')}</textarea></label>
      <button class="button primary" type="submit">Save</button>
    </form>
  `,
    (root) => {
      root.querySelector('#birthday-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const data = {
          name: form.get('name').trim(),
          date: form.get('date'),
          relationship: form.get('relationship'),
          notes: form.get('notes').trim()
        };
        if (existing) {
          await updateDoc(userDoc('birthdays', existing.id), data);
        } else {
          await addDoc(userCollection('birthdays'), { ...data, createdAt: serverTimestamp() });
        }
        closeModal();
      });
    }
  );
}

document.getElementById('birthday-list').addEventListener('click', (event) => {
  const editBtn = event.target.closest('[data-edit-birthday]');
  if (editBtn) {
    const item = birthdays.find((b) => b.id === editBtn.dataset.editBirthday);
    if (item) openBirthdayForm(item);
    return;
  }
  const deleteBtn = event.target.closest('[data-delete-birthday]');
  if (deleteBtn) {
    const item = birthdays.find((b) => b.id === deleteBtn.dataset.deleteBirthday);
    confirmDelete(`Delete ${item ? `“${item.name}”` : 'this birthday'}? This can’t be undone.`, () => {
      deleteDoc(userDoc('birthdays', deleteBtn.dataset.deleteBirthday));
    });
  }
});

/* ==================== to-do ==================== */

const CATEGORY_LABEL = { school: 'School', personal: 'Personal', business: 'Business' };

function renderTodos() {
  Object.keys(todos).forEach((category) => {
    const container = document.querySelector(`[data-todo-list="${category}"]`);
    const items = [...todos[category]].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });

    if (!items.length) {
      container.innerHTML = '<p class="entry-empty">Nothing here yet.</p>';
      return;
    }

    container.innerHTML = items
      .map(
        (item) => `
          <article class="entry-card ${item.completed ? 'todo-done' : ''}" data-id="${item.id}">
            <div class="entry-main">
              <div class="entry-title">${escapeHtml(item.title)}</div>
              ${item.deadline ? `<p class="entry-meta">Due ${new Date(item.deadline + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>` : ''}
              ${item.description ? `<p class="entry-desc">${escapeHtml(item.description)}</p>` : ''}
            </div>
            <div class="entry-actions">
              <button class="icon-btn" data-toggle-todo="${item.id}" data-category="${category}" aria-label="Toggle complete">
                <span class="material-symbols-outlined">${item.completed ? 'undo' : 'check'}</span>
              </button>
              <button class="icon-btn" data-edit-todo="${item.id}" data-category="${category}" aria-label="Edit">
                <span class="material-symbols-outlined">edit</span>
              </button>
              <button class="icon-btn" data-delete-todo="${item.id}" data-category="${category}" aria-label="Delete">
                <span class="material-symbols-outlined">delete</span>
              </button>
            </div>
          </article>
        `
      )
      .join('');
  });
}

function renderOverviewTodos() {
  const list = document.getElementById('overview-todos');
  const all = Object.entries(todos).flatMap(([category, items]) =>
    items.filter((i) => !i.completed && i.deadline).map((i) => ({ ...i, category }))
  );
  all.sort((a, b) => a.deadline.localeCompare(b.deadline));
  const upcoming = all.slice(0, 6);

  if (!upcoming.length) {
    list.innerHTML = '<li class="entry-empty">Nothing due soon.</li>';
    return;
  }

  list.innerHTML = upcoming
    .map(
      (item) => `
        <li class="entry-card entry-card--compact">
          <div class="entry-main">
            <div class="entry-title">${escapeHtml(item.title)} <span class="tag tag--${item.category}">${CATEGORY_LABEL[item.category]}</span></div>
            <p class="entry-meta">Due ${new Date(item.deadline + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>
          </div>
        </li>
      `
    )
    .join('');
}

document.querySelectorAll('[data-add-todo]').forEach((btn) => {
  btn.addEventListener('click', () => openTodoForm(btn.dataset.addTodo));
});

function openTodoForm(category, existing = null) {
  openModal(
    `
    <h2>${existing ? 'Edit' : 'Add'} ${CATEGORY_LABEL[category]} to-do</h2>
    <form id="todo-form">
      <label>Title<input type="text" name="title" required value="${escapeHtml(existing?.title || '')}" /></label>
      <label>Deadline (optional)<input type="date" name="deadline" value="${existing?.deadline || ''}" /></label>
      <label>Description (optional)<textarea name="description" rows="3">${escapeHtml(existing?.description || '')}</textarea></label>
      <button class="button primary" type="submit">Save</button>
    </form>
  `,
    (root) => {
      root.querySelector('#todo-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const data = {
          title: form.get('title').trim(),
          deadline: form.get('deadline') || null,
          description: form.get('description').trim()
        };
        if (existing) {
          await updateDoc(userDoc('todos', existing.id), data);
        } else {
          await addDoc(userCollection('todos'), {
            category,
            ...data,
            completed: false,
            createdAt: serverTimestamp()
          });
        }
        closeModal();
      });
    }
  );
}

document.querySelector('.todo-columns').addEventListener('click', (event) => {
  const toggleBtn = event.target.closest('[data-toggle-todo]');
  if (toggleBtn) {
    const item = todos[toggleBtn.dataset.category].find((t) => t.id === toggleBtn.dataset.toggleTodo);
    updateDoc(userDoc('todos', toggleBtn.dataset.toggleTodo), { completed: !item.completed });
    return;
  }
  const editBtn = event.target.closest('[data-edit-todo]');
  if (editBtn) {
    const item = todos[editBtn.dataset.category].find((t) => t.id === editBtn.dataset.editTodo);
    if (item) openTodoForm(editBtn.dataset.category, item);
    return;
  }
  const deleteBtn = event.target.closest('[data-delete-todo]');
  if (deleteBtn) {
    const item = todos[deleteBtn.dataset.category]?.find((t) => t.id === deleteBtn.dataset.deleteTodo);
    confirmDelete(`Delete ${item ? `“${item.title}”` : 'this to-do'}? This can’t be undone.`, () => {
      deleteDoc(userDoc('todos', deleteBtn.dataset.deleteTodo));
    });
  }
});

/* ==================== vault (passwords) ==================== */

const VAULT_TYPES = {
  email_password: {
    label: 'Email / Password',
    hint: 'A login you access with an email address.',
    fields: [
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'password', label: 'Password', type: 'text' }
    ]
  },
  username_password: {
    label: 'Username / Password',
    hint: 'A login you access with a username.',
    fields: [
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'text' }
    ]
  },
  card: {
    label: 'Card number',
    hint: 'A debit/credit card or similar.',
    fields: [
      { key: 'cardNumber', label: 'Card number', type: 'text' },
      { key: 'cardPin', label: 'Card PIN', type: 'text' },
      { key: 'expDate', label: 'Expiration date', type: 'text', placeholder: 'MM/YY' }
    ]
  }
};

function renderVault() {
  const list = document.getElementById('vault-list');
  const query = (document.getElementById('vault-search').value || '').toLowerCase();
  const items = vaultEntries
    .filter((v) => v.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!items.length) {
    list.innerHTML = '<p class="entry-empty">Nothing saved yet.</p>';
    return;
  }

  list.innerHTML = items
    .map(
      (v) => `
        <article class="entry-card" data-id="${v.id}">
          <div class="entry-main">
            <div class="entry-title">${escapeHtml(v.name)} <span class="tag tag--personal">${VAULT_TYPES[v.type]?.label || v.type}</span></div>
            <div class="vault-fields" data-vault-fields="${v.id}" hidden></div>
          </div>
          <div class="entry-actions">
            <button class="icon-btn" data-reveal-vault="${v.id}" aria-label="Reveal"><span class="material-symbols-outlined">visibility</span></button>
            <button class="icon-btn" data-edit-vault="${v.id}" aria-label="Edit"><span class="material-symbols-outlined">edit</span></button>
            <button class="icon-btn" data-delete-vault="${v.id}" aria-label="Delete"><span class="material-symbols-outlined">delete</span></button>
          </div>
        </article>
      `
    )
    .join('');
}

document.getElementById('vault-search').addEventListener('input', renderVault);

// Decrypted payloads are only kept in memory while their entry is expanded,
// keyed by vault doc id, so the copy buttons can grab a value without
// re-decrypting or scraping it back out of escaped HTML text.
const revealedVaultPayloads = new Map();

document.getElementById('vault-list').addEventListener('click', async (event) => {
  const copyBtn = event.target.closest('[data-copy-vault]');
  if (copyBtn) {
    const payload = revealedVaultPayloads.get(copyBtn.dataset.copyVault);
    const value = payload ? payload[copyBtn.dataset.copyKey] || '' : '';
    copyToClipboard(value, copyBtn);
    return;
  }

  const revealBtn = event.target.closest('[data-reveal-vault]');
  if (revealBtn) {
    const id = revealBtn.dataset.revealVault;
    const fieldsEl = document.querySelector(`[data-vault-fields="${id}"]`);
    if (!fieldsEl.hidden) {
      fieldsEl.hidden = true;
      fieldsEl.innerHTML = '';
      revealedVaultPayloads.delete(id);
      revealBtn.querySelector('.material-symbols-outlined').textContent = 'visibility';
      return;
    }
    const entry = vaultEntries.find((v) => v.id === id);
    try {
      const payload = await decryptPayload(encryptionKey, entry.iv, entry.ciphertext);
      revealedVaultPayloads.set(id, payload);
      const def = VAULT_TYPES[entry.type];
      fieldsEl.innerHTML = def.fields
        .map(
          (f) => `
            <div class="vault-field-row">
              <span>${f.label}: <strong>${escapeHtml(payload[f.key] || '')}</strong></span>
              <button
                type="button"
                class="icon-btn icon-btn--sm"
                data-copy-vault="${id}"
                data-copy-key="${f.key}"
                aria-label="Copy ${f.label}"
              >
                <span class="material-symbols-outlined">content_copy</span>
              </button>
            </div>
          `
        )
        .join('');
      fieldsEl.hidden = false;
      revealBtn.querySelector('.material-symbols-outlined').textContent = 'visibility_off';
    } catch (err) {
      console.error(err);
      fieldsEl.innerHTML = '<div class="vault-field-row">Could not decrypt this entry.</div>';
      fieldsEl.hidden = false;
    }
    return;
  }
  const editBtn = event.target.closest('[data-edit-vault]');
  if (editBtn) {
    const entry = vaultEntries.find((v) => v.id === editBtn.dataset.editVault);
    try {
      const payload = await decryptPayload(encryptionKey, entry.iv, entry.ciphertext);
      openVaultForm(entry.type, { id: entry.id, name: entry.name, payload });
    } catch (err) {
      console.error(err);
    }
    return;
  }

  const deleteBtn = event.target.closest('[data-delete-vault]');
  if (deleteBtn) {
    const item = vaultEntries.find((v) => v.id === deleteBtn.dataset.deleteVault);
    confirmDelete(`Delete ${item ? `“${item.name}”` : 'this entry'}? This can’t be undone.`, () => {
      revealedVaultPayloads.delete(deleteBtn.dataset.deleteVault);
      deleteDoc(userDoc('vault', deleteBtn.dataset.deleteVault));
    });
  }
});

async function copyToClipboard(text, btn) {
  const icon = btn.querySelector('.material-symbols-outlined');
  const original = icon.textContent;
  let ok = false;

  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (err) {
    // Fall back for cases the async Clipboard API refuses (e.g. the
    // "Document is not focused" error some browsers throw on rapid clicks).
    ok = legacyCopy(text);
    if (!ok) console.error(err);
  }

  icon.textContent = ok ? 'check' : 'error';
  btn.classList.toggle('icon-btn--copied', ok);
  window.setTimeout(() => {
    icon.textContent = original;
    btn.classList.remove('icon-btn--copied');
  }, 1200);
}

function legacyCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let success = false;
  try {
    success = document.execCommand('copy');
  } catch (err) {
    success = false;
  }
  document.body.removeChild(textarea);
  return success;
}

document.getElementById('add-vault-btn').addEventListener('click', openVaultTypePicker);

function openVaultTypePicker() {
  openModal(
    `
    <h2>What are you saving?</h2>
    <div class="type-picker">
      ${Object.entries(VAULT_TYPES)
        .map(
          ([key, def]) => `
            <button type="button" data-vault-type="${key}">${def.label}<span>${def.hint}</span></button>
          `
        )
        .join('')}
    </div>
  `,
    (root) => {
      root.querySelectorAll('[data-vault-type]').forEach((btn) => {
        btn.addEventListener('click', () => openVaultForm(btn.dataset.vaultType));
      });
    }
  );
}

function openVaultForm(type, existing = null) {
  const def = VAULT_TYPES[type];
  openModal(
    `
    <h2>${existing ? 'Edit' : 'Add'} ${def.label}</h2>
    <form id="vault-form">
      <label>Name<input type="text" name="name" required placeholder="e.g. Netflix" value="${escapeHtml(existing?.name || '')}" /></label>
      ${def.fields
        .map(
          (f) =>
            `<label>${f.label}<input type="${f.type}" name="${f.key}" required placeholder="${f.placeholder || ''}" value="${escapeHtml(existing?.payload?.[f.key] || '')}" /></label>`
        )
        .join('')}
      <button class="button primary" type="submit">Save</button>
    </form>
  `,
    (root) => {
      root.querySelector('#vault-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const name = form.get('name').trim();
        const payload = {};
        def.fields.forEach((f) => {
          payload[f.key] = (form.get(f.key) || '').trim();
        });
        const { iv, ciphertext } = await encryptPayload(encryptionKey, payload);
        if (existing) {
          revealedVaultPayloads.delete(existing.id);
          await updateDoc(userDoc('vault', existing.id), { name, iv, ciphertext });
        } else {
          await addDoc(userCollection('vault'), {
            type,
            name,
            iv,
            ciphertext,
            createdAt: serverTimestamp()
          });
        }
        closeModal();
      });
    }
  );
}

/* ==================== contacts ==================== */

function renderContacts() {
  const list = document.getElementById('contact-list');
  let items;
  if (aiContactSearchResultIds) {
    const byId = new Map(contacts.map((c) => [c.id, c]));
    items = aiContactSearchResultIds.map((id) => byId.get(id)).filter(Boolean);
  } else {
    const query = (document.getElementById('contact-search').value || '').toLowerCase();
    items = contacts.filter((c) => c.name.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name));
  }

  if (!items.length) {
    list.innerHTML = '<p class="entry-empty">No contacts found.</p>';
    return;
  }

  function copyableField(value, label) {
    return `
      <span class="copyable-field">
        ${escapeHtml(value)}
        <button type="button" class="icon-btn icon-btn--sm" data-copy-text="${escapeHtml(value)}" aria-label="Copy ${label}">
          <span class="material-symbols-outlined">content_copy</span>
        </button>
      </span>
    `;
  }

  list.innerHTML = items
    .map((c) => {
      const metaBits = [];
      if (c.company) metaBits.push(`<span>${escapeHtml(c.company)}</span>`);
      if (c.phone) metaBits.push(copyableField(c.phone, 'phone number'));
      if (c.email) metaBits.push(copyableField(c.email, 'email'));

      const urlLinks = String(c.urls || '')
        .split(/[\n,]+/)
        .map((u) => u.trim())
        .filter(Boolean)
        .map((u) => {
          const href = /^https?:\/\//i.test(u) ? u : `https://${u}`;
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`;
        })
        .join(', ');

      return `
        <article class="entry-card" data-id="${c.id}">
          <div class="entry-main">
            <div class="entry-title">${escapeHtml(c.name)}</div>
            ${metaBits.length ? `<p class="entry-meta contact-meta">${metaBits.join('')}</p>` : ''}
            ${urlLinks ? `<p class="entry-desc">${urlLinks}</p>` : ''}
          </div>
          <div class="entry-actions">
            <button class="icon-btn" data-edit-contact="${c.id}" aria-label="Edit"><span class="material-symbols-outlined">edit</span></button>
            <button class="icon-btn" data-delete-contact="${c.id}" aria-label="Delete"><span class="material-symbols-outlined">delete</span></button>
          </div>
        </article>
      `;
    })
    .join('');
}

const aiContactSearchBtn = document.getElementById('ai-contact-search-btn');
const aiContactSearchStatus = document.getElementById('ai-contact-search-status');
const contactSearchInput = document.getElementById('contact-search');

function clearAiContactSearch() {
  if (!aiContactSearchResultIds) return;
  aiContactSearchResultIds = null;
  aiContactSearchStatus.hidden = true;
  aiContactSearchBtn.classList.remove('is-active');
}

contactSearchInput.addEventListener('input', () => {
  clearAiContactSearch();
  renderContacts();
});

aiContactSearchStatus.addEventListener('click', (event) => {
  if (event.target.closest('[data-clear-ai-search]')) {
    clearAiContactSearch();
    renderContacts();
  }
});

aiContactSearchBtn.addEventListener('click', async () => {
  const query = contactSearchInput.value.trim();
  if (!query) {
    aiContactSearchStatus.hidden = false;
    aiContactSearchStatus.textContent = 'Type what you’re looking for first.';
    return;
  }

  aiContactSearchStatus.hidden = false;
  aiContactSearchStatus.textContent = 'Asking AI…';
  aiContactSearchBtn.disabled = true;

  try {
    const items = contacts.map((c) => ({
      id: c.id,
      type: 'contact',
      title: c.name,
      subtitle: [c.company, c.phone, c.email].filter(Boolean).join(' · '),
      date: ''
    }));
    const result = await requestAi('smart_search', query, { items });
    const ids = result?.ids || [];
    if (!ids.length) {
      aiContactSearchResultIds = null;
      aiContactSearchBtn.classList.remove('is-active');
      aiContactSearchStatus.textContent = 'No AI matches found.';
    } else {
      aiContactSearchResultIds = ids;
      aiContactSearchBtn.classList.add('is-active');
      aiContactSearchStatus.innerHTML = `AI found ${ids.length} match${ids.length === 1 ? '' : 'es'}. <button type="button" data-clear-ai-search>Clear</button>`;
    }
    renderContacts();
  } catch (err) {
    aiContactSearchStatus.textContent = err.message || 'AI search failed.';
  } finally {
    aiContactSearchBtn.disabled = false;
  }
});

document.getElementById('add-contact-btn').addEventListener('click', () => openContactForm());

function openContactForm(existing = null) {
  openModal(
    `
    <h2>${existing ? 'Edit' : 'Add'} contact</h2>
    <form id="contact-form">
      <label>Name<input type="text" name="name" required value="${escapeHtml(existing?.name || '')}" /></label>
      <label>Company (optional)<input type="text" name="company" value="${escapeHtml(existing?.company || '')}" /></label>
      <label>Phone (optional)<input type="tel" name="phone" value="${escapeHtml(existing?.phone || '')}" /></label>
      <label>Email (optional)<input type="email" name="email" value="${escapeHtml(existing?.email || '')}" /></label>
      <label>URLs (optional)<textarea name="urls" rows="2" placeholder="One per line">${escapeHtml(existing?.urls || '')}</textarea></label>
      <button class="button primary" type="submit">Save</button>
    </form>
  `,
    (root) => {
      root.querySelector('#contact-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const data = {
          name: form.get('name').trim(),
          company: form.get('company').trim(),
          phone: form.get('phone').trim(),
          email: form.get('email').trim(),
          urls: form.get('urls').trim()
        };
        if (existing) {
          await updateDoc(userDoc('contacts', existing.id), data);
        } else {
          await addDoc(userCollection('contacts'), { ...data, createdAt: serverTimestamp() });
        }
        closeModal();
      });
    }
  );
}

document.getElementById('contact-list').addEventListener('click', (event) => {
  const copyBtn = event.target.closest('[data-copy-text]');
  if (copyBtn) {
    copyToClipboard(copyBtn.dataset.copyText, copyBtn);
    return;
  }
  const editBtn = event.target.closest('[data-edit-contact]');
  if (editBtn) {
    const item = contacts.find((c) => c.id === editBtn.dataset.editContact);
    if (item) openContactForm(item);
    return;
  }
  const deleteBtn = event.target.closest('[data-delete-contact]');
  if (deleteBtn) {
    const item = contacts.find((c) => c.id === deleteBtn.dataset.deleteContact);
    confirmDelete(`Delete ${item ? `“${item.name}”` : 'this contact'}? This can’t be undone.`, () => {
      deleteDoc(userDoc('contacts', deleteBtn.dataset.deleteContact));
    });
  }
});

/* ==================== files ==================== */
/* Every entry stores a `pages` array (usually just one). Uploading several
   images "together" (e.g. a driver's license front and back) fills that
   array with multiple pages under one entry, browsable with the pager in
   the preview modal; uploading them "separate" instead creates one entry
   per file. */

function folderName(folderId) {
  const f = folders.find((x) => x.id === folderId);
  return f ? f.name : '';
}

// Files uploaded before the multi-page feature existed stored their storage
// path/URL/contentType directly on the file document instead of inside a
// `pages` array. This normalizes either shape into a pages array so every
// other function (render, preview, delete) only has to handle one format.
function filePages(file) {
  if (file.pages && file.pages.length) return file.pages;
  if (file.storagePath) {
    return [
      {
        fileName: file.fileName || file.name,
        contentType: file.contentType,
        size: file.size,
        storagePath: file.storagePath,
        downloadURL: file.downloadURL
      }
    ];
  }
  return [];
}

const FILE_EXT_KIND = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'tif', 'tiff'],
  pdf: ['pdf'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'],
  text: ['txt', 'md', 'csv', 'json', 'log', 'xml'],
  word: ['doc', 'docx'],
  sheet: ['xls', 'xlsx'],
  design: ['psd', 'ai', 'eps', 'indd', 'sketch', 'fig', 'xd'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz']
};

// Browser-reported contentType is the primary signal, but it's often blank
// or generic (application/octet-stream) for less common formats - the file
// extension is a reliable fallback for those.
function classifyFile(contentType, fileName) {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
  if (contentType?.startsWith('image/') || FILE_EXT_KIND.image.includes(ext)) return 'image';
  if (contentType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (contentType?.startsWith('video/') || FILE_EXT_KIND.video.includes(ext)) return 'video';
  if (contentType?.startsWith('audio/') || FILE_EXT_KIND.audio.includes(ext)) return 'audio';
  if (FILE_EXT_KIND.design.includes(ext)) return 'design';
  if (contentType?.startsWith('text/') || FILE_EXT_KIND.text.includes(ext)) return 'text';
  if (contentType?.includes('word') || FILE_EXT_KIND.word.includes(ext)) return 'word';
  if (contentType?.includes('sheet') || contentType?.includes('excel') || FILE_EXT_KIND.sheet.includes(ext)) return 'sheet';
  if (FILE_EXT_KIND.archive.includes(ext)) return 'archive';
  return 'other';
}

function fileIcon(contentType, fileName) {
  switch (classifyFile(contentType, fileName)) {
    case 'image':
      return 'image';
    case 'pdf':
      return 'picture_as_pdf';
    case 'video':
      return 'videocam';
    case 'audio':
      return 'audiotrack';
    case 'word':
      return 'description';
    case 'sheet':
      return 'table_chart';
    case 'design':
      return 'palette';
    case 'archive':
      return 'folder_zip';
    case 'text':
      return 'article';
    default:
      return 'insert_drive_file';
  }
}

function totalSize(pages) {
  return (pages || []).reduce((sum, p) => sum + (p.size || 0), 0);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function renderFolderChips() {
  const container = document.getElementById('folder-chips');
  const chips = [
    { id: '', name: 'All files' },
    { id: 'unfiled', name: 'Unfiled' },
    ...folders
  ];
  container.innerHTML = chips
    .map(
      (f) => `
        <button type="button" class="folder-chip ${currentFolderId === f.id ? 'is-active' : ''}" data-folder-id="${f.id}">
          <span class="material-symbols-outlined" aria-hidden="true">${f.id ? 'folder' : 'apps'}</span>
          ${escapeHtml(f.name)}
        </button>
      `
    )
    .join('');
}

function visibleFiles() {
  if (aiSearchResultIds) {
    const byId = new Map(files.map((f) => [f.id, f]));
    return aiSearchResultIds.map((id) => byId.get(id)).filter(Boolean);
  }

  const query = (document.getElementById('file-search').value || '').toLowerCase();
  return files
    .filter((f) => {
      if (currentFolderId === 'unfiled' && f.folderId) return false;
      if (currentFolderId && currentFolderId !== 'unfiled' && f.folderId !== currentFolderId) return false;
      if (!query) return true;
      return f.name.toLowerCase().includes(query) || (f.description || '').toLowerCase().includes(query);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fileUploadedLabel(f) {
  if (!f.createdAt?.toDate) return '';
  return f.createdAt.toDate().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderFiles() {
  const list = document.getElementById('file-list');
  const items = visibleFiles();

  if (!items.length) {
    list.innerHTML = '<p class="entry-empty">No files found.</p>';
    return;
  }

  list.innerHTML = items
    .map((f) => {
      const pages = filePages(f);
      const multi = pages.length > 1;
      const icon = multi ? 'photo_library' : fileIcon(pages[0]?.contentType, pages[0]?.fileName || f.name);
      return `
        <article class="file-card" data-preview-file="${f.id}" tabindex="0" role="button" aria-label="Preview ${escapeHtml(f.name)}">
          <div class="file-card-icon">
            <span class="material-symbols-outlined">${icon}</span>
            ${multi ? `<span class="file-card-pages-badge">${pages.length}</span>` : ''}
          </div>
          <div class="file-card-name">${escapeHtml(f.name)}</div>
          <p class="file-card-meta">${formatBytes(totalSize(pages))}${multi ? ` · ${pages.length} pages` : ''}${f.folderId ? ` · ${escapeHtml(folderName(f.folderId))}` : ''}</p>
          ${fileUploadedLabel(f) ? `<p class="file-card-date">Uploaded ${fileUploadedLabel(f)}</p>` : ''}
          ${f.description ? `<p class="file-card-desc">${escapeHtml(f.description)}</p>` : ''}
          <div class="file-card-actions">
            ${
              multi
                ? ''
                : `<a class="icon-btn icon-btn--sm" href="${escapeHtml(pages[0]?.downloadURL || '')}" target="_blank" rel="noopener" download="${escapeHtml(pages[0]?.fileName || f.name)}" aria-label="Download">
                    <span class="material-symbols-outlined">download</span>
                  </a>`
            }
            <button type="button" class="icon-btn icon-btn--sm" data-edit-file="${f.id}" aria-label="Edit">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button type="button" class="icon-btn icon-btn--sm" data-delete-file="${f.id}" aria-label="Delete">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </article>
      `;
    })
    .join('');
}

const aiSearchBtn = document.getElementById('ai-search-btn');
const aiSearchStatus = document.getElementById('ai-search-status');
const fileSearchInput = document.getElementById('file-search');

function clearAiSearch() {
  if (!aiSearchResultIds) return;
  aiSearchResultIds = null;
  aiSearchStatus.hidden = true;
  aiSearchBtn.classList.remove('is-active');
}

aiSearchStatus.addEventListener('click', (event) => {
  if (event.target.closest('[data-clear-ai-search]')) {
    clearAiSearch();
    renderFiles();
  }
});

fileSearchInput.addEventListener('input', () => {
  clearAiSearch();
  renderFiles();
});

document.getElementById('folder-chips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-folder-id]');
  if (!chip) return;
  clearAiSearch();
  currentFolderId = chip.dataset.folderId;
  renderFolderChips();
  renderFiles();
});

aiSearchBtn.addEventListener('click', async () => {
  const query = fileSearchInput.value.trim();
  if (!query) {
    aiSearchStatus.hidden = false;
    aiSearchStatus.textContent = 'Type what you’re looking for first.';
    return;
  }

  aiSearchStatus.hidden = false;
  aiSearchStatus.textContent = 'Asking AI…';
  aiSearchBtn.disabled = true;

  try {
    const items = files.map((f) => ({
      id: f.id,
      type: 'file',
      title: f.name,
      subtitle: [f.description, f.folderId ? folderName(f.folderId) : ''].filter(Boolean).join(' · '),
      date: fileUploadedLabel(f)
    }));
    const result = await requestAi('smart_search', query, { items });
    const ids = result?.ids || [];
    if (!ids.length) {
      aiSearchResultIds = null;
      aiSearchBtn.classList.remove('is-active');
      aiSearchStatus.textContent = 'No AI matches found.';
    } else {
      aiSearchResultIds = ids;
      aiSearchBtn.classList.add('is-active');
      aiSearchStatus.innerHTML = `AI found ${ids.length} match${ids.length === 1 ? '' : 'es'}. <button type="button" data-clear-ai-search>Clear</button>`;
    }
    renderFiles();
  } catch (err) {
    aiSearchStatus.textContent = err.message || 'AI search failed.';
  } finally {
    aiSearchBtn.disabled = false;
  }
});

document.getElementById('add-folder-btn').addEventListener('click', () => {
  openModal(
    `
    <h2>New folder</h2>
    <form id="folder-form">
      <label>Folder name<input type="text" name="name" required /></label>
      <button class="button primary" type="submit">Create</button>
    </form>
  `,
    (root) => {
      root.querySelector('#folder-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        await addDoc(userCollection('folders'), {
          name: form.get('name').trim(),
          createdAt: serverTimestamp()
        });
        closeModal();
      });
    }
  );
});

function folderOptionsHtml(selectedId) {
  return `
    <option value="" ${!selectedId ? 'selected' : ''}>No folder</option>
    ${folders
      .map((f) => `<option value="${f.id}" ${selectedId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
      .join('')}
  `;
}

// Uploads each file in `fileList` to Storage and resolves with their page
// metadata. Shared by both "separate" (called once per file) and "together"
// (called once with every selected file) upload modes below.
async function uploadPages(fileList, onProgress) {
  const totals = fileList.map((f) => f.size || 0);
  const transferred = fileList.map(() => 0);
  const overallTotal = totals.reduce((a, b) => a + b, 0) || 1;

  function reportProgress() {
    const sum = transferred.reduce((a, b) => a + b, 0);
    onProgress((sum / overallTotal) * 100);
  }

  const pages = [];
  for (let i = 0; i < fileList.length; i += 1) {
    const file = fileList[i];
    const safeFileName = file.name.replace(/[/\\]/g, '_');
    const path = `users/${currentUser.uid}/files/${crypto.randomUUID()}-${safeFileName}`;
    const fileRef = storageRef(storage, path);
    const task = uploadBytesResumable(fileRef, file);

    await new Promise((resolve, reject) => {
      task.on(
        'state_changed',
        (snap) => {
          transferred[i] = snap.bytesTransferred;
          reportProgress();
        },
        reject,
        resolve
      );
    });

    const downloadURL = await getDownloadURL(fileRef);
    pages.push({
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      storagePath: path,
      downloadURL
    });
  }
  return pages;
}

function openUploadModal(initialFiles) {
  openModal(
    `
    <h2>Upload files</h2>
    <form id="upload-form">
      <label>Files<input type="file" name="files" multiple required /></label>
      <div class="upload-mode-row" id="upload-mode-row" hidden>
        <label class="upload-mode-option">
          <input type="radio" name="mode" value="separate" checked />
          Upload as separate files
        </label>
        <label class="upload-mode-option">
          <input type="radio" name="mode" value="together" />
          Group into one file (e.g. front &amp; back)
        </label>
      </div>
      <label id="upload-name-row">Name<input type="text" name="name" /></label>
      <label>Description (optional)<textarea name="description" rows="2"></textarea></label>
      <label>Folder<select name="folderId">${folderOptionsHtml('')}</select></label>
      <div class="upload-progress" id="upload-progress" hidden>
        <div class="upload-progress-bar" id="upload-progress-bar"></div>
      </div>
      <p class="upload-status" id="upload-status" hidden></p>
      <p class="form-error" id="upload-error" hidden>Upload failed. Try again.</p>
      <button class="button primary" type="submit" id="upload-submit">Upload</button>
    </form>
  `,
    (root) => {
      const fileInput = root.querySelector('[name="files"]');
      const nameRow = root.querySelector('#upload-name-row');
      const nameInput = root.querySelector('[name="name"]');
      const modeRow = root.querySelector('#upload-mode-row');

      function currentMode() {
        return root.querySelector('input[name="mode"]:checked')?.value || 'separate';
      }

      function syncNameField() {
        const count = fileInput.files.length;
        const showName = count <= 1 || currentMode() === 'together';
        nameRow.hidden = !showName;
        nameInput.required = showName;
      }

      fileInput.addEventListener('change', () => {
        const selected = Array.from(fileInput.files);
        modeRow.hidden = selected.length <= 1;
        if (selected.length === 1 && !nameInput.value) {
          nameInput.value = selected[0].name.replace(/\.[^/.]+$/, '');
        }
        syncNameField();
      });

      modeRow.addEventListener('change', syncNameField);

      if (initialFiles && initialFiles.length) {
        fileInput.files = initialFiles;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      root.querySelector('#upload-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const selected = Array.from(fileInput.files);
        if (!selected.length) return;

        const form = new FormData(event.target);
        const mode = selected.length > 1 ? currentMode() : 'together';
        const folderId = form.get('folderId') || null;
        const description = form.get('description').trim();

        const submitBtn = root.querySelector('#upload-submit');
        const progressWrap = root.querySelector('#upload-progress');
        const progressBar = root.querySelector('#upload-progress-bar');
        const statusEl = root.querySelector('#upload-status');
        const errorEl = root.querySelector('#upload-error');

        errorEl.hidden = true;
        submitBtn.disabled = true;
        progressWrap.hidden = false;
        statusEl.hidden = false;

        try {
          if (mode === 'together') {
            statusEl.textContent = `Uploading ${selected.length} file${selected.length === 1 ? '' : 's'}…`;
            const pages = await uploadPages(selected, (pct) => {
              progressBar.style.width = `${pct}%`;
            });
            const name = form.get('name').trim();
            const ref = await addDoc(userCollection('files'), {
              name,
              description,
              folderId,
              pages,
              createdAt: serverTimestamp()
            });
            if (!description) maybeDescribeFile(ref.id, name, pages);
          } else {
            for (let i = 0; i < selected.length; i += 1) {
              const file = selected[i];
              statusEl.textContent = `Uploading ${i + 1} of ${selected.length}…`;
              progressBar.style.width = '0%';
              const pages = await uploadPages([file], (pct) => {
                progressBar.style.width = `${pct}%`;
              });
              const name = file.name.replace(/\.[^/.]+$/, '');
              const ref = await addDoc(userCollection('files'), {
                name,
                description,
                folderId,
                pages,
                createdAt: serverTimestamp()
              });
              if (!description) maybeDescribeFile(ref.id, name, pages);
            }
          }

          closeModal();
        } catch (err) {
          console.error(err);
          errorEl.hidden = false;
          submitBtn.disabled = false;
        }
      });
    }
  );
}

// Best-effort AI description: only runs when the user left the description
// blank, never blocks the upload UI, and silently gives up on failure (the
// Cloud Function isn't deployed on every checkout of this repo).
function maybeDescribeFile(docId, name, pages) {
  const imageUrl = pages[0]?.contentType?.startsWith('image/') ? pages[0].downloadURL : undefined;
  requestAi('describe_file', name, imageUrl ? { imageUrl } : {})
    .then((description) => {
      if (description) return updateDoc(userDoc('files', docId), { description });
    })
    .catch(() => {});
}

document.getElementById('add-file-btn').addEventListener('click', () => openUploadModal());

// Drag a file in from anywhere in the portal (any tab) to open the upload
// modal with it pre-attached. dragenter/dragleave fire repeatedly as the
// cursor crosses child elements, so a counter tracks real enter/exit of the
// whole portal rather than toggling the overlay on every bubbled event.
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;

function dragHasFiles(event) {
  return !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
}

portalEl.addEventListener('dragenter', (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  dragCounter += 1;
  dropOverlay.hidden = false;
});

portalEl.addEventListener('dragover', (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
});

portalEl.addEventListener('dragleave', (event) => {
  if (!dragHasFiles(event)) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.hidden = true;
});

portalEl.addEventListener('drop', (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  dragCounter = 0;
  dropOverlay.hidden = true;
  const droppedFiles = event.dataTransfer.files;
  if (!droppedFiles.length) return;
  requestTabSwitch('files');
  openUploadModal(droppedFiles);
});

function openFileEditForm(file) {
  openModal(
    `
    <h2>Edit file</h2>
    <form id="file-edit-form">
      <label>Name<input type="text" name="name" required value="${escapeHtml(file.name)}" /></label>
      <label>Description (optional)<textarea name="description" rows="2">${escapeHtml(file.description || '')}</textarea></label>
      <label>Folder<select name="folderId">${folderOptionsHtml(file.folderId)}</select></label>
      <button class="button primary" type="submit">Save</button>
    </form>
  `,
    (root) => {
      root.querySelector('#file-edit-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        await updateDoc(userDoc('files', file.id), {
          name: form.get('name').trim(),
          description: form.get('description').trim(),
          folderId: form.get('folderId') || null
        });
        closeModal();
      });
    }
  );
}

const DESIGN_FILE_LABEL = {
  psd: 'Photoshop',
  ai: 'Illustrator',
  eps: 'Illustrator/EPS',
  indd: 'InDesign',
  sketch: 'Sketch',
  fig: 'Figma',
  xd: 'Adobe XD'
};

function fallbackPreviewHtml(icon, message) {
  return `
    <div class="preview-fallback">
      <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
      <p>${message}</p>
    </div>
  `;
}

function previewBodyHtml(page, entryName) {
  const fileName = page.fileName || entryName || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const kind = classifyFile(page.contentType, fileName);

  switch (kind) {
    case 'image':
      return `<img class="preview-image" src="${escapeHtml(page.downloadURL)}" alt="${escapeHtml(entryName)}" data-preview-media />`;
    case 'pdf':
      return `<iframe class="preview-frame" src="${escapeHtml(page.downloadURL)}" title="${escapeHtml(entryName)}"></iframe>`;
    case 'video':
      return `<video class="preview-video" src="${escapeHtml(page.downloadURL)}" controls data-preview-media></video>`;
    case 'audio':
      return `<audio class="preview-audio" src="${escapeHtml(page.downloadURL)}" controls data-preview-media></audio>`;
    case 'design':
      return fallbackPreviewHtml(
        'palette',
        `${DESIGN_FILE_LABEL[ext] || ext.toUpperCase()} files can’t be rendered in a browser — download it to open in the original app.`
      );
    default:
      return fallbackPreviewHtml(fileIcon(page.contentType, fileName), 'Preview isn’t available for this file type — you can still download it below.');
  }
}

function openFilePreview(file) {
  const pages = filePages(file);
  if (!pages.length) pages.push({});
  let index = 0;

  const pagerHtml =
    pages.length > 1
      ? `
        <div class="preview-pager">
          <button type="button" class="icon-btn" id="preview-prev-btn" aria-label="Previous page">
            <span class="material-symbols-outlined">chevron_left</span>
          </button>
          <span id="preview-pager-label"></span>
          <button type="button" class="icon-btn" id="preview-next-btn" aria-label="Next page">
            <span class="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      `
      : '';

  openModal(
    `
    <h2>${escapeHtml(file.name)}</h2>
    ${file.description ? `<p class="preview-description">${escapeHtml(file.description)}</p>` : ''}
    ${pagerHtml}
    <div id="preview-body"></div>
    <div class="preview-actions">
      <a class="button primary" id="preview-download-btn" target="_blank" rel="noopener">Download</a>
      <button class="button ghost" type="button" id="preview-close-btn">Close</button>
    </div>
  `,
    (root) => {
      const bodyEl = root.querySelector('#preview-body');
      const downloadBtn = root.querySelector('#preview-download-btn');
      const pagerLabel = root.querySelector('#preview-pager-label');

      function renderPage() {
        const page = pages[index];
        bodyEl.innerHTML = previewBodyHtml(page, file.name);
        downloadBtn.href = page.downloadURL || '#';
        downloadBtn.setAttribute('download', page.fileName || file.name);
        if (pagerLabel) pagerLabel.textContent = `${index + 1} / ${pages.length}`;

        // Some formats (HEIC, TIFF, etc.) report as image/* but most browsers
        // can't actually decode them - fall back gracefully instead of
        // showing a broken-image icon with no explanation.
        const media = bodyEl.querySelector('img[data-preview-media]');
        media?.addEventListener('error', () => {
          bodyEl.innerHTML = fallbackPreviewHtml(
            'broken_image',
            'This image format can’t be displayed in the browser — download it to view.'
          );
        });
      }

      root.querySelector('#preview-close-btn').addEventListener('click', closeModal);

      if (pages.length > 1) {
        const prev = () => {
          index = (index - 1 + pages.length) % pages.length;
          renderPage();
        };
        const next = () => {
          index = (index + 1) % pages.length;
          renderPage();
        };
        root.querySelector('#preview-prev-btn').addEventListener('click', prev);
        root.querySelector('#preview-next-btn').addEventListener('click', next);
        activePager = { prev, next };
      }

      renderPage();
    },
    'modal--wide'
  );
}

async function deleteFile(file) {
  const pages = filePages(file);
  await Promise.all(
    pages.map((p) =>
      deleteObject(storageRef(storage, p.storagePath)).catch((err) => {
        // If the storage object is already gone, still remove the metadata below.
        console.error(err);
      })
    )
  );
  await deleteDoc(userDoc('files', file.id));
}

document.getElementById('file-list').addEventListener('click', (event) => {
  const deleteBtn = event.target.closest('[data-delete-file]');
  if (deleteBtn) {
    const file = files.find((f) => f.id === deleteBtn.dataset.deleteFile);
    if (file) {
      confirmDelete(`Delete “${file.name}”? This can’t be undone.`, () => deleteFile(file));
    }
    return;
  }

  const editBtn = event.target.closest('[data-edit-file]');
  if (editBtn) {
    const file = files.find((f) => f.id === editBtn.dataset.editFile);
    if (file) openFileEditForm(file);
    return;
  }

  if (event.target.closest('a[href]')) {
    // Let the browser handle the download link natively.
    return;
  }

  const card = event.target.closest('[data-preview-file]');
  if (card) {
    const file = files.find((f) => f.id === card.dataset.previewFile);
    if (file) openFilePreview(file);
  }
});

document.getElementById('file-list').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-preview-file]');
  if (!card) return;
  event.preventDefault();
  const file = files.find((f) => f.id === card.dataset.previewFile);
  if (file) openFilePreview(file);
});

/* ==================== drive (notes) ==================== */

const driveListView = document.getElementById('drive-list-view');
const driveEditorView = document.getElementById('drive-editor-view');
const editorSurface = document.getElementById('editor-surface');
const editorTitleInput = document.getElementById('editor-title');
const editorFolderSelect = document.getElementById('editor-folder-select');
const editorStatus = document.getElementById('editor-status');

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return div.textContent || '';
}

function noteFolderName(folderId) {
  const f = noteFolders.find((x) => x.id === folderId);
  return f ? f.name : '';
}

function renderNoteFolderChips() {
  const container = document.getElementById('note-folder-chips');
  const chips = [
    { id: '', name: 'All notes' },
    { id: 'unfiled', name: 'Unfiled' },
    ...noteFolders
  ];
  container.innerHTML = chips
    .map(
      (f) => `
        <button type="button" class="folder-chip ${currentNoteFolderId === f.id ? 'is-active' : ''}" data-note-folder-id="${f.id}">
          <span class="material-symbols-outlined" aria-hidden="true">${f.id ? 'folder' : 'apps'}</span>
          ${escapeHtml(f.name)}
        </button>
      `
    )
    .join('');
}

function populateNoteFolderSelect() {
  editorFolderSelect.innerHTML = `
    <option value="">No folder</option>
    ${noteFolders.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}
  `;
}

const aiNoteSearchBtn = document.getElementById('ai-note-search-btn');
const aiNoteSearchStatus = document.getElementById('ai-note-search-status');
const noteSearchInput = document.getElementById('note-search');

function clearAiNoteSearch() {
  if (!aiNoteSearchResultIds) return;
  aiNoteSearchResultIds = null;
  aiNoteSearchStatus.hidden = true;
  aiNoteSearchBtn.classList.remove('is-active');
}

aiNoteSearchStatus.addEventListener('click', (event) => {
  if (event.target.closest('[data-clear-ai-search]')) {
    clearAiNoteSearch();
    renderNotes();
  }
});

document.getElementById('note-folder-chips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-note-folder-id]');
  if (!chip) return;
  clearAiNoteSearch();
  currentNoteFolderId = chip.dataset.noteFolderId;
  renderNoteFolderChips();
  renderNotes();
});

aiNoteSearchBtn.addEventListener('click', async () => {
  const query = noteSearchInput.value.trim();
  if (!query) {
    aiNoteSearchStatus.hidden = false;
    aiNoteSearchStatus.textContent = 'Type what you’re looking for first.';
    return;
  }

  aiNoteSearchStatus.hidden = false;
  aiNoteSearchStatus.textContent = 'Asking AI…';
  aiNoteSearchBtn.disabled = true;

  try {
    const items = notes.map((n) => ({
      id: n.id,
      type: 'note',
      title: n.title || 'Untitled note',
      subtitle: [stripHtml(n.contentHtml).slice(0, 140), n.folderId ? noteFolderName(n.folderId) : ''].filter(Boolean).join(' · '),
      date: n.updatedAt?.toDate ? n.updatedAt.toDate().toLocaleDateString() : ''
    }));
    const result = await requestAi('smart_search', query, { items });
    const ids = result?.ids || [];
    if (!ids.length) {
      aiNoteSearchResultIds = null;
      aiNoteSearchBtn.classList.remove('is-active');
      aiNoteSearchStatus.textContent = 'No AI matches found.';
    } else {
      aiNoteSearchResultIds = ids;
      aiNoteSearchBtn.classList.add('is-active');
      aiNoteSearchStatus.innerHTML = `AI found ${ids.length} match${ids.length === 1 ? '' : 'es'}. <button type="button" data-clear-ai-search>Clear</button>`;
    }
    renderNotes();
  } catch (err) {
    aiNoteSearchStatus.textContent = err.message || 'AI search failed.';
  } finally {
    aiNoteSearchBtn.disabled = false;
  }
});

document.getElementById('add-note-folder-btn').addEventListener('click', () => {
  openModal(
    `
    <h2>New folder</h2>
    <form id="note-folder-form">
      <label>Folder name<input type="text" name="name" required /></label>
      <button class="button primary" type="submit">Create</button>
    </form>
  `,
    (root) => {
      root.querySelector('#note-folder-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        await addDoc(userCollection('noteFolders'), {
          name: form.get('name').trim(),
          createdAt: serverTimestamp()
        });
        closeModal();
      });
    }
  );
});

function visibleNotes() {
  if (aiNoteSearchResultIds) {
    const byId = new Map(notes.map((n) => [n.id, n]));
    return aiNoteSearchResultIds.map((id) => byId.get(id)).filter(Boolean);
  }

  const query = (document.getElementById('note-search').value || '').toLowerCase();
  return notes
    .filter((n) => {
      if (currentNoteFolderId === 'unfiled' && n.folderId) return false;
      if (currentNoteFolderId && currentNoteFolderId !== 'unfiled' && n.folderId !== currentNoteFolderId) return false;
      if (!query) return true;
      const title = (n.title || '').toLowerCase();
      const body = stripHtml(n.contentHtml).toLowerCase();
      return title.includes(query) || body.includes(query);
    })
    .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
}

function renderNotes() {
  const list = document.getElementById('note-list');
  const items = visibleNotes();

  if (!items.length) {
    list.innerHTML = '<p class="entry-empty">No notes found.</p>';
    return;
  }

  list.innerHTML = items
    .map((n) => {
      const snippet = stripHtml(n.contentHtml).trim();
      const updated = n.updatedAt?.toDate
        ? n.updatedAt.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '';
      return `
        <article class="note-card" data-open-note="${n.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(n.title || 'Untitled note')}">
          <div class="note-card-title">${escapeHtml(n.title || 'Untitled note')}</div>
          <p class="note-card-snippet">${escapeHtml(snippet) || '<em>Empty note</em>'}</p>
          <p class="note-card-meta">${updated ? `Updated ${updated}` : ''}${n.folderId ? ` · ${escapeHtml(noteFolderName(n.folderId))}` : ''}</p>
        </article>
      `;
    })
    .join('');
}

noteSearchInput.addEventListener('input', () => {
  clearAiNoteSearch();
  renderNotes();
});

document.getElementById('note-list').addEventListener('click', (event) => {
  const card = event.target.closest('[data-open-note]');
  if (!card) return;
  const note = notes.find((n) => n.id === card.dataset.openNote);
  if (note) openNoteEditor(note);
});

document.getElementById('note-list').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-open-note]');
  if (!card) return;
  event.preventDefault();
  const note = notes.find((n) => n.id === card.dataset.openNote);
  if (note) openNoteEditor(note);
});

document.getElementById('add-note-btn').addEventListener('click', async () => {
  const ref = await addDoc(userCollection('notes'), {
    title: '',
    contentHtml: '',
    folderId: currentNoteFolderId && currentNoteFolderId !== 'unfiled' ? currentNoteFolderId : null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  openNoteEditor({ id: ref.id, title: '', contentHtml: '', folderId: currentNoteFolderId });
});

function openNoteEditor(note) {
  currentNoteId = note.id;
  editorTitleInput.value = note.title || '';
  editorSurface.innerHTML = note.contentHtml || '';
  editorFolderSelect.value = note.folderId || '';
  editorStatus.textContent = '';
  driveListView.hidden = true;
  driveEditorView.hidden = false;
  editorTitleInput.focus();
}

document.getElementById('editor-back-btn').addEventListener('click', () => {
  flushAutosave();
  currentNoteId = null;
  driveEditorView.hidden = true;
  driveListView.hidden = false;
});

document.getElementById('editor-delete-btn').addEventListener('click', () => {
  if (!currentNoteId) return;
  const title = editorTitleInput.value.trim() || 'this note';
  confirmDelete(`Delete “${title}”? This can’t be undone.`, async () => {
    await deleteDoc(userDoc('notes', currentNoteId));
    currentNoteId = null;
    driveEditorView.hidden = true;
    driveListView.hidden = false;
  });
});

// Debounced autosave: fires ~1s after the last edit, and can be flushed
// immediately (e.g. before navigating away) via flushAutosave().
let autosaveTimer = null;
function scheduleAutosave() {
  editorStatus.textContent = 'Saving…';
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(flushAutosave, 900);
}

function flushAutosave() {
  window.clearTimeout(autosaveTimer);
  if (!currentNoteId) return;
  updateDoc(userDoc('notes', currentNoteId), {
    title: editorTitleInput.value.trim(),
    contentHtml: editorSurface.innerHTML,
    folderId: editorFolderSelect.value || null,
    updatedAt: serverTimestamp()
  })
    .then(() => {
      editorStatus.textContent = 'Saved';
    })
    .catch((err) => {
      console.error(err);
      editorStatus.textContent = 'Could not save.';
    });
}

editorTitleInput.addEventListener('input', scheduleAutosave);
editorFolderSelect.addEventListener('change', scheduleAutosave);
editorSurface.addEventListener('input', scheduleAutosave);

// Toolbar: bold/underline/lists via execCommand - still the simplest,
// dependency-free way to drive contenteditable formatting, and every major
// browser continues to support this exact set of commands.
document.querySelectorAll('#editor-toolbar [data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => {
    editorSurface.focus();
    document.execCommand(btn.dataset.cmd, false, null);
    scheduleAutosave();
  });
});

function buildSwatchGroup(containerId, command, colors) {
  const container = document.getElementById(containerId);
  container.innerHTML = colors
    .map(
      (c) =>
        `<button type="button" class="color-swatch" data-color="${c}" style="background:${c === 'transparent' ? 'repeating-conic-gradient(#888 0% 25%, transparent 0% 50%) 0 0 / 8px 8px' : c}" aria-label="${c}"></button>`
    )
    .join('');
  container.querySelectorAll('.color-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      editorSurface.focus();
      document.execCommand(command, false, btn.dataset.color === 'transparent' ? 'inherit' : btn.dataset.color);
      scheduleAutosave();
    });
  });
}

buildSwatchGroup('text-color-group', 'foreColor', ['#f6f4ff', '#ff2b2b', '#ff7a1a', '#4da6ff', '#b388ff', '#3ddc84']);
buildSwatchGroup('highlight-color-group', 'hiliteColor', ['transparent', '#fff59d', '#ffab91', '#80d8ff', '#c5e1a5', '#e1bee7']);

const fontSizeMap = { 1: '12px', 2: '14px', 3: '16px', 4: '18px', 5: '24px', 6: '32px', 7: '40px' };

document.getElementById('font-size-select').addEventListener('change', (event) => {
  editorSurface.focus();
  document.execCommand('fontSize', false, event.target.value);
  editorSurface.querySelectorAll('font[size]').forEach((el) => {
    const span = document.createElement('span');
    span.style.fontSize = fontSizeMap[el.getAttribute('size')] || '16px';
    span.innerHTML = el.innerHTML;
    el.replaceWith(span);
  });
  scheduleAutosave();
});

// Auto-format "- " / "* " into a bullet list and "1. " into a numbered
// list as soon as the trigger space is typed, like most note apps do.
editorSurface.addEventListener('keydown', (event) => {
  if (event.key !== ' ') return;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const before = node.textContent.slice(0, range.startOffset);

  if (before === '-' || before === '*') {
    event.preventDefault();
    node.textContent = node.textContent.slice(range.startOffset);
    document.execCommand('insertUnorderedList');
    scheduleAutosave();
    return;
  }
  if (before === '1.') {
    event.preventDefault();
    node.textContent = node.textContent.slice(range.startOffset);
    document.execCommand('insertOrderedList');
    scheduleAutosave();
  }
});

// Insert image: uploads to Storage, inserts inline. Repositioning it
// afterward is native browser behavior for images inside contenteditable -
// no extra drag/drop code needed.
const editorImageInput = document.getElementById('editor-image-input');
document.getElementById('editor-insert-image-btn').addEventListener('click', () => editorImageInput.click());

editorImageInput.addEventListener('change', async () => {
  const file = editorImageInput.files[0];
  editorImageInput.value = '';
  if (!file || !currentNoteId) return;

  editorStatus.textContent = 'Uploading image…';
  try {
    const safeName = file.name.replace(/[/\\]/g, '_');
    const path = `users/${currentUser.uid}/notes/${currentNoteId}/${crypto.randomUUID()}-${safeName}`;
    const imgRef = storageRef(storage, path);
    await new Promise((resolve, reject) => {
      uploadBytesResumable(imgRef, file).on('state_changed', null, reject, resolve);
    });
    const url = await getDownloadURL(imgRef);
    editorSurface.focus();
    document.execCommand('insertHTML', false, `<img src="${url}" alt="${escapeHtml(file.name)}" />`);
    scheduleAutosave();
  } catch (err) {
    console.error(err);
    editorStatus.textContent = 'Image upload failed.';
  }
});

// AI menu
const aiMenuBtn = document.getElementById('ai-menu-btn');
const aiMenuDropdown = document.getElementById('ai-menu-dropdown');

aiMenuBtn.addEventListener('click', () => {
  aiMenuDropdown.hidden = !aiMenuDropdown.hidden;
});

document.addEventListener('click', (event) => {
  if (aiMenuDropdown.hidden) return;
  if (event.target === aiMenuBtn || aiMenuDropdown.contains(event.target)) return;
  aiMenuDropdown.hidden = true;
});

aiMenuDropdown.querySelectorAll('[data-ai-task]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    aiMenuDropdown.hidden = true;
    const task = btn.dataset.aiTask;

    const sel = window.getSelection();
    const hasSelection = !!sel && !sel.isCollapsed && editorSurface.contains(sel.anchorNode);
    const sourceText = (hasSelection ? sel.toString() : editorSurface.innerText).trim();
    if (!sourceText) return;

    editorStatus.textContent = 'AI is thinking…';
    try {
      const result = await requestAi(task, sourceText);
      if (!result) throw new Error('Empty AI response');

      editorSurface.focus();
      if (task === 'continue') {
        if (hasSelection) {
          sel.collapseToEnd();
        } else {
          document.execCommand('selectAll', false, null);
          document.getSelection().collapseToEnd();
        }
        document.execCommand('insertText', false, ' ' + result);
      } else if (task === 'format' && !hasSelection) {
        editorSurface.innerHTML = result;
      } else if (hasSelection) {
        document.execCommand('insertText', false, result);
      } else {
        editorSurface.innerText = result;
      }
      scheduleAutosave();
    } catch (err) {
      editorStatus.textContent = err.message || 'AI request failed.';
    }
  });
});

/* ==================== overview: universal search + add ==================== */

const UNIVERSAL_TYPE_ICON = {
  todo: 'checklist',
  birthday: 'cake',
  contact: 'person',
  vault: 'key',
  file: 'description',
  note: 'article'
};

const UNIVERSAL_TYPE_LABEL = {
  todo: 'To-do',
  birthday: 'Birthday',
  contact: 'Contact',
  vault: 'Vault',
  file: 'File',
  note: 'Note'
};

const UNIVERSAL_TYPE_TAB = {
  todo: 'todos',
  birthday: 'birthdays',
  contact: 'contacts',
  vault: 'vault',
  file: 'files',
  note: 'drive'
};

function buildGlobalSearchItems() {
  const items = [];

  ['school', 'personal', 'business'].forEach((category) => {
    (todos[category] || []).forEach((t) => {
      items.push({
        id: t.id,
        type: 'todo',
        category,
        title: t.title,
        subtitle: [CATEGORY_LABEL[category], t.description].filter(Boolean).join(' · '),
        date: t.deadline || ''
      });
    });
  });

  birthdays.forEach((b) => {
    items.push({ id: b.id, type: 'birthday', title: b.name, subtitle: b.relationship || '', date: b.date });
  });

  contacts.forEach((c) => {
    items.push({
      id: c.id,
      type: 'contact',
      title: c.name,
      subtitle: [c.company, c.phone, c.email].filter(Boolean).join(' · '),
      date: ''
    });
  });

  vaultEntries.forEach((v) => {
    items.push({ id: v.id, type: 'vault', title: v.name, subtitle: VAULT_TYPES[v.type]?.label || v.type, date: '' });
  });

  files.forEach((f) => {
    items.push({
      id: f.id,
      type: 'file',
      title: f.name,
      subtitle: [f.description, f.folderId ? folderName(f.folderId) : ''].filter(Boolean).join(' · '),
      date: fileUploadedLabel(f)
    });
  });

  notes.forEach((n) => {
    items.push({
      id: n.id,
      type: 'note',
      title: n.title || 'Untitled note',
      subtitle: stripHtml(n.contentHtml).slice(0, 140),
      date: n.updatedAt?.toDate ? n.updatedAt.toDate().toLocaleDateString() : ''
    });
  });

  return items;
}

const universalSearchInput = document.getElementById('universal-search-input');
const universalSearchBtn = document.getElementById('universal-search-btn');
const universalSearchStatus = document.getElementById('universal-search-status');
const universalSearchResults = document.getElementById('universal-search-results');

function renderUniversalResults(ids, items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const matched = ids.map((id) => byId.get(id)).filter(Boolean);

  if (!matched.length) {
    universalSearchResults.hidden = true;
    universalSearchResults.innerHTML = '';
    return;
  }

  universalSearchResults.hidden = false;
  universalSearchResults.innerHTML = matched
    .map(
      (it) => `
        <button type="button" class="universal-result" data-type="${it.type}" data-id="${it.id}" data-category="${it.category || ''}">
          <span class="material-symbols-outlined" aria-hidden="true">${UNIVERSAL_TYPE_ICON[it.type] || 'search'}</span>
          <span class="universal-result-text">
            <span class="universal-result-title">${escapeHtml(it.title)}</span>
            ${it.subtitle ? `<span class="universal-result-subtitle">${escapeHtml(it.subtitle)}</span>` : ''}
          </span>
          <span class="universal-result-type">${UNIVERSAL_TYPE_LABEL[it.type] || ''}</span>
        </button>
      `
    )
    .join('');
}

universalSearchResults.addEventListener('click', (event) => {
  const btn = event.target.closest('.universal-result');
  if (!btn) return;
  const { type, id } = btn.dataset;
  const tab = UNIVERSAL_TYPE_TAB[type];
  if (!tab) return;

  requestTabSwitch(tab, () => {
    if (type === 'note') {
      const note = notes.find((n) => n.id === id);
      if (note) openNoteEditor(note);
    } else if (type === 'file') {
      const file = files.find((f) => f.id === id);
      if (file) openFilePreview(file);
    } else {
      highlightEntry(id);
    }
  });
});

async function runUniversalSearch(query) {
  universalSearchStatus.hidden = false;
  universalSearchStatus.textContent = 'Searching…';
  const items = buildGlobalSearchItems();
  const result = await requestAi('smart_search', query, { items });
  const ids = result?.ids || [];
  renderUniversalResults(ids, items);
  universalSearchStatus.textContent = ids.length
    ? `Found ${ids.length} match${ids.length === 1 ? '' : 'es'}.`
    : 'No matches found.';
}

async function runUniversalCommand(text) {
  universalSearchStatus.hidden = false;
  universalSearchStatus.textContent = 'Thinking…';
  universalSearchResults.hidden = true;

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const result = await requestAi('smart_command', text, { today: todayIso });

  if (result?.intent === 'add' && result.type === 'todo' && result.todo?.title) {
    const list = ['school', 'personal', 'business'].includes(result.todo.list) ? result.todo.list : 'personal';
    await addDoc(userCollection('todos'), {
      category: list,
      title: result.todo.title,
      deadline: result.todo.deadline || null,
      description: '',
      completed: false,
      createdAt: serverTimestamp()
    });
    universalSearchStatus.textContent = `Added “${result.todo.title}” to ${CATEGORY_LABEL[list]} to-dos${
      result.todo.deadline ? ` — due ${new Date(result.todo.deadline + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''
    }.`;
    universalSearchInput.value = '';
    return;
  }

  if (result?.intent === 'add' && result.type === 'birthday' && result.birthday?.name && result.birthday?.date) {
    await addDoc(userCollection('birthdays'), {
      name: result.birthday.name,
      date: result.birthday.date,
      relationship: 'Other',
      notes: '',
      createdAt: serverTimestamp()
    });
    universalSearchStatus.textContent = `Added ${result.birthday.name}’s birthday.`;
    universalSearchInput.value = '';
    return;
  }

  if (result?.intent === 'add' && result.type === 'contact' && result.contact?.name) {
    await addDoc(userCollection('contacts'), {
      name: result.contact.name,
      company: '',
      phone: result.contact.phone || '',
      email: result.contact.email || '',
      urls: '',
      createdAt: serverTimestamp()
    });
    universalSearchStatus.textContent = `Added ${result.contact.name} to contacts.`;
    universalSearchInput.value = '';
    return;
  }

  if (result?.intent === 'add' && result.type === 'event' && result.event?.title && result.event?.date) {
    if (!calendarConnected) {
      universalSearchStatus.textContent = 'Connect Google Calendar first (in the Calendar tab) to add events this way.';
      return;
    }

    universalSearchStatus.textContent = result.event.location ? 'Figuring out the location…' : 'Adding to your calendar…';
    const location = result.event.location ? await resolveLocation(result.event.location) : '';
    universalSearchStatus.textContent = 'Adding to your calendar…';

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const body = { summary: result.event.title, location };

    if (result.event.time) {
      const start = new Date(`${result.event.date}T${result.event.time}:00`);
      const end = new Date(start.getTime() + (result.event.durationMinutes || 60) * 60000);
      body.start = { dateTime: `${result.event.date}T${result.event.time}:00`, timeZone: tz };
      body.end = {
        dateTime: `${toIsoDate(end)}T${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}:00`,
        timeZone: tz
      };
    } else {
      body.start = { date: result.event.date };
      body.end = { date: toIsoDate(addDays(new Date(`${result.event.date}T00:00`), 1)) };
    }

    try {
      await calendarApiFetch('/calendars/primary/events', { method: 'POST', body: JSON.stringify(body) });
      universalSearchStatus.textContent = `Added “${result.event.title}” to your calendar${location ? ` at ${location}` : ''}.`;
      universalSearchInput.value = '';
      loadWeekEvents();
    } catch (err) {
      universalSearchStatus.textContent = err.message || 'Could not add that to your calendar.';
    }
    return;
  }

  if (result?.intent === 'search') {
    await runUniversalSearch(result.query || text);
    return;
  }

  universalSearchStatus.textContent = 'Not sure what you meant — try rephrasing, or search by keyword.';
}

async function handleUniversalSubmit() {
  const text = universalSearchInput.value.trim();
  if (!text) return;

  universalSearchBtn.disabled = true;
  try {
    await runUniversalCommand(text);
  } catch (err) {
    universalSearchStatus.hidden = false;
    universalSearchStatus.textContent = err.message || 'Something went wrong.';
  } finally {
    universalSearchBtn.disabled = false;
  }
}

universalSearchBtn.addEventListener('click', handleUniversalSubmit);
universalSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleUniversalSubmit();
  }
});

/* ==================== calendar: date helpers ==================== */

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addMinutesToTimeString(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/* ==================== calendar: Google OAuth ==================== */

function updateCalendarConnectionUI() {
  document.getElementById('calendar-connect-view').hidden = calendarConnected;
  document.getElementById('calendar-connected-view').hidden = !calendarConnected;
}

const calendarConnectBtn = document.getElementById('calendar-connect-btn');
const calendarConnectError = document.getElementById('calendar-connect-error');

calendarConnectBtn.addEventListener('click', () => {
  calendarConnectError.hidden = true;

  if (typeof google === 'undefined' || !google.accounts?.oauth2) {
    calendarConnectError.hidden = false;
    calendarConnectError.textContent = 'Google sign-in script hasn’t loaded yet — check your connection and try again.';
    return;
  }

  const codeClient = google.accounts.oauth2.initCodeClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    ux_mode: 'popup',
    access_type: 'offline',
    prompt: 'consent',
    callback: async (response) => {
      if (response.error) {
        calendarConnectError.hidden = false;
        calendarConnectError.textContent = 'Google sign-in was cancelled or failed. Try again.';
        return;
      }
      calendarConnectBtn.disabled = true;
      try {
        await callGoogleCalendarConnect({ code: response.code });
        // The googleCalendar/status listener flips calendarConnected and loads the week.
      } catch (err) {
        calendarConnectError.hidden = false;
        calendarConnectError.textContent = err.message || 'Could not connect to Google Calendar.';
      } finally {
        calendarConnectBtn.disabled = false;
      }
    }
  });
  codeClient.requestCode();
});

document.getElementById('calendar-disconnect-btn').addEventListener('click', () => {
  confirmAction(
    'Disconnect Google Calendar?',
    'Your events stay on your real calendar — the portal just stops showing or syncing them until you reconnect.',
    'Disconnect',
    async () => {
      await callGoogleCalendarDisconnect();
      calendarEvents = [];
      calendarSummaryCache = null;
      googleAccessToken = null;
    }
  );
});

async function ensureGoogleAccessToken() {
  const now = Date.now();
  if (googleAccessToken && now < googleAccessTokenExpiryMs - 60000) {
    return googleAccessToken;
  }
  const { data } = await callGoogleCalendarToken();
  googleAccessToken = data.accessToken;
  googleAccessTokenExpiryMs = now + (data.expiresIn || 3600) * 1000;
  return googleAccessToken;
}

async function calendarApiFetch(path, options = {}) {
  const token = await ensureGoogleAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || 'Google Calendar request failed.');
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ==================== calendar: weekly view ==================== */

const CALENDAR_START_HOUR = 6;
const CALENDAR_END_HOUR = 23;
const PX_PER_HOUR = 56;

function updateCalendarWeekLabel() {
  const end = addDays(calendarWeekStart, 6);
  const startStr = calendarWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const endStr = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  document.getElementById('calendar-week-label').textContent = `${startStr} – ${endStr}`;
}

async function loadWeekEvents() {
  if (!calendarConnected) return;
  const weekEnd = addDays(calendarWeekStart, 7);
  const params = new URLSearchParams({
    timeMin: calendarWeekStart.toISOString(),
    timeMax: weekEnd.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250'
  });

  try {
    const data = await calendarApiFetch(`/calendars/primary/events?${params}`);
    calendarEvents = data.items || [];
  } catch (err) {
    console.error('loadWeekEvents failed', err);
    calendarEvents = [];
  }
  renderCalendarGrid();
  maybeLoadTodaySummary();
}

function eventDateIso(e) {
  if (e.start?.date) return e.start.date;
  if (e.start?.dateTime) return toIsoDate(new Date(e.start.dateTime));
  return '';
}

function formatHourLabel(h) {
  const period = h < 12 ? 'AM' : 'PM';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12} ${period}`;
}

function minutesSinceStart(dateTimeStr) {
  const d = new Date(dateTimeStr);
  return (d.getHours() - CALENDAR_START_HOUR) * 60 + d.getMinutes();
}

function eventBlockHtml(e) {
  const isAllDay = !!e.start?.date;
  let top = 0;
  let height = PX_PER_HOUR;
  let timeLabel = 'All day';

  if (!isAllDay) {
    const totalMin = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 60;
    const startMin = minutesSinceStart(e.start.dateTime);
    const endMin = e.end?.dateTime ? minutesSinceStart(e.end.dateTime) : startMin + 60;
    const clampedStart = Math.max(0, Math.min(startMin, totalMin));
    const clampedEnd = Math.max(clampedStart + 20, Math.min(endMin, totalMin));
    top = (clampedStart / 60) * PX_PER_HOUR;
    height = ((clampedEnd - clampedStart) / 60) * PX_PER_HOUR;
    timeLabel = new Date(e.start.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  return `
    <button type="button" class="calendar-event" style="top:${top}px;height:${height}px" data-event-id="${e.id}">
      <span class="calendar-event-time">${escapeHtml(timeLabel)}</span>
      <span class="calendar-event-title">${escapeHtml(e.summary || 'Untitled event')}</span>
    </button>
  `;
}

function renderCalendarGrid() {
  const grid = document.getElementById('calendar-grid');
  const days = Array.from({ length: 7 }, (_, i) => addDays(calendarWeekStart, i));
  const todayIso = toIsoDate(new Date());
  const totalHeight = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * PX_PER_HOUR;

  const headerHtml = `
    <div class="calendar-grid-header">
      <div></div>
      ${days
        .map(
          (d) => `
            <div class="calendar-day-header ${toIsoDate(d) === todayIso ? 'is-today' : ''}">
              <span class="calendar-day-name">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
              <span class="calendar-day-date">${d.getDate()}</span>
            </div>
          `
        )
        .join('')}
    </div>
  `;

  const hourLabels = Array.from({ length: CALENDAR_END_HOUR - CALENDAR_START_HOUR + 1 }, (_, i) => CALENDAR_START_HOUR + i)
    .map((h) => `<div class="calendar-time-label" style="top:${(h - CALENDAR_START_HOUR) * PX_PER_HOUR}px">${formatHourLabel(h)}</div>`)
    .join('');

  const dayTracksHtml = days
    .map((d) => {
      const iso = toIsoDate(d);
      const dayEvents = calendarEvents.filter((e) => eventDateIso(e) === iso);
      return `<div class="calendar-day-track ${iso === todayIso ? 'is-today' : ''}" style="height:${totalHeight}px" data-date="${iso}">${dayEvents.map(eventBlockHtml).join('')}</div>`;
    })
    .join('');

  grid.innerHTML = `
    ${headerHtml}
    <div class="calendar-grid-body">
      <div class="calendar-time-gutter" style="height:${totalHeight}px">${hourLabels}</div>
      ${dayTracksHtml}
    </div>
  `;
}

document.getElementById('calendar-prev-week-btn').addEventListener('click', () => {
  calendarWeekStart = addDays(calendarWeekStart, -7);
  updateCalendarWeekLabel();
  loadWeekEvents();
});

document.getElementById('calendar-next-week-btn').addEventListener('click', () => {
  calendarWeekStart = addDays(calendarWeekStart, 7);
  updateCalendarWeekLabel();
  loadWeekEvents();
});

document.getElementById('calendar-today-btn').addEventListener('click', () => {
  calendarWeekStart = startOfWeek(new Date());
  updateCalendarWeekLabel();
  loadWeekEvents();
});

document.getElementById('calendar-grid').addEventListener('click', (event) => {
  const eventBtn = event.target.closest('.calendar-event');
  if (eventBtn) {
    const ev = calendarEvents.find((e) => e.id === eventBtn.dataset.eventId);
    if (ev) openEventForm(ev);
    return;
  }
  const track = event.target.closest('.calendar-day-track');
  if (track) openEventForm(null, new Date(`${track.dataset.date}T00:00`));
});

document.getElementById('calendar-add-event-btn').addEventListener('click', () => openEventForm());

/* ==================== calendar: AI daily summary ==================== */

function updateOverviewScheduleCard(summary) {
  document.getElementById('overview-schedule-text').textContent = summary;
}

async function refreshCalendarSummary() {
  const todayIso = toIsoDate(new Date());
  const todaysEvents = calendarEvents
    .filter((e) => eventDateIso(e) === todayIso)
    .map((e) => ({
      title: e.summary || 'Untitled event',
      start: e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '',
      end: e.end?.dateTime ? new Date(e.end.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
    }));

  const banner = document.getElementById('calendar-summary-banner');
  const textEl = document.getElementById('calendar-summary-text');
  banner.hidden = false;
  textEl.textContent = 'Thinking…';

  try {
    const summary = (await requestAi('calendar_summary', '', { events: todaysEvents })) || 'Nothing on your calendar today.';
    textEl.textContent = summary;
    calendarSummaryCache = summary;
    updateOverviewScheduleCard(summary);
  } catch (err) {
    textEl.textContent = err.message || 'Could not summarize your day.';
  }
}

function maybeLoadTodaySummary() {
  const isCurrentWeek = toIsoDate(calendarWeekStart) === toIsoDate(startOfWeek(new Date()));
  const banner = document.getElementById('calendar-summary-banner');
  if (!isCurrentWeek) {
    banner.hidden = true;
    return;
  }
  if (calendarSummaryCache) {
    banner.hidden = false;
    document.getElementById('calendar-summary-text').textContent = calendarSummaryCache;
    return;
  }
  refreshCalendarSummary();
}

/* ==================== calendar: location memory + Places search ==================== */

function normalizePlaceText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function matchKnownPlace(rawText) {
  const norm = normalizePlaceText(rawText);
  if (!norm) return null;
  const matches = knownPlaces.filter((p) => {
    const nameNorm = normalizePlaceText(p.name);
    const aliasHit = (p.aliases || []).some((a) => {
      const aNorm = normalizePlaceText(a);
      return aNorm === norm || aNorm.includes(norm) || norm.includes(aNorm);
    });
    return aliasHit || nameNorm.includes(norm) || norm.includes(nameNorm);
  });
  if (!matches.length) return null;
  matches.sort((a, b) => (b.lastUsed?.toMillis?.() || 0) - (a.lastUsed?.toMillis?.() || 0));
  return matches[0];
}

function ensureUserLocation() {
  if (userGeoCoords) return Promise.resolve(userGeoCoords);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userGeoCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        resolve(userGeoCoords);
      },
      (err) => reject(err),
      { timeout: 8000 }
    );
  });
}

async function placesTextSearch(query, coords) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.id'
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: { circle: { center: { latitude: coords.lat, longitude: coords.lng }, radius: 8000 } },
      maxResultCount: 5
    })
  });
  if (!res.ok) throw new Error('Location search failed.');
  const data = await res.json();
  return (data.places || []).map((p) => ({
    name: p.displayName?.text || query,
    address: p.formattedAddress || '',
    placeId: p.id,
    lat: p.location?.latitude,
    lng: p.location?.longitude
  }));
}

function pickPlace(results, rawText) {
  return new Promise((resolve) => {
    openModal(
      `
      <h2>Which “${escapeHtml(rawText)}”?</h2>
      <div class="place-picker-list">
        ${results
          .map(
            (r, i) => `
              <button type="button" class="place-picker-option" data-index="${i}">
                <span class="place-picker-option-name">${escapeHtml(r.name)}</span>
                <span class="place-picker-option-address">${escapeHtml(r.address)}</span>
              </button>
            `
          )
          .join('')}
      </div>
      <button class="button ghost" type="button" id="place-picker-skip-btn" style="margin-top:14px;">Just use “${escapeHtml(rawText)}” as typed</button>
    `,
      (root) => {
        root.querySelectorAll('.place-picker-option').forEach((btn) => {
          btn.addEventListener('click', () => {
            closeModal();
            resolve(results[Number(btn.dataset.index)]);
          });
        });
        root.querySelector('#place-picker-skip-btn').addEventListener('click', () => {
          closeModal();
          resolve(null);
        });
      }
    );
  });
}

async function rememberPlace(rawText, place) {
  const alias = rawText.trim().toLowerCase();
  const existing = knownPlaces.find((p) => p.placeId === place.placeId);
  if (existing) {
    const aliases = new Set(existing.aliases || []);
    aliases.add(alias);
    await updateDoc(userDoc('knownPlaces', existing.id), { aliases: Array.from(aliases), lastUsed: serverTimestamp() });
  } else {
    await addDoc(userCollection('knownPlaces'), {
      placeId: place.placeId,
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      aliases: [alias],
      lastUsed: serverTimestamp()
    });
  }
}

// The core of "remember which McDonald's I mean": check places used before first, and only
// fall back to a live nearby search (with a picker) when nothing matches. Returns a resolved
// address string, or the original text if search fails/isn't available/the user skips.
async function resolveLocation(rawText) {
  if (!rawText.trim()) return '';

  const remembered = matchKnownPlace(rawText);
  if (remembered) return remembered.address;

  let coords;
  try {
    coords = await ensureUserLocation();
  } catch (err) {
    return rawText;
  }

  let results = [];
  try {
    results = await placesTextSearch(rawText, coords);
  } catch (err) {
    return rawText;
  }
  if (!results.length) return rawText;

  const chosen = await pickPlace(results, rawText);
  if (!chosen) return rawText;

  await rememberPlace(rawText, chosen);
  return chosen.address;
}

/* ==================== calendar: add/edit event ==================== */

function openEventForm(existing = null, presetDate = null) {
  const isEdit = !!existing;
  const startDate = existing?.start?.dateTime ? new Date(existing.start.dateTime) : presetDate || new Date();
  const endDate = existing?.end?.dateTime ? new Date(existing.end.dateTime) : null;
  const isAllDay = isEdit && !!existing?.start?.date;

  const startTimeVal = existing?.start?.dateTime
    ? `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`
    : '';
  const endTimeVal = endDate ? `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}` : '';

  openModal(
    `
    <h2>${isEdit ? 'Edit' : 'Add'} event</h2>
    <form id="event-form">
      <label>Title<input type="text" name="title" required value="${escapeHtml(existing?.summary || '')}" /></label>
      <label>Date<input type="date" name="date" required value="${toIsoDate(startDate)}" /></label>
      <div class="two-col">
        <label>Start time (optional)<input type="time" name="startTime" value="${isAllDay ? '' : startTimeVal}" /></label>
        <label>End time<input type="time" name="endTime" value="${isAllDay ? '' : endTimeVal}" /></label>
      </div>
      <label>Location (optional)
        <div class="location-search-row">
          <input type="text" name="location" value="${escapeHtml(existing?.location || '')}" placeholder="e.g. McDonald’s" />
          <button type="button" class="icon-btn" id="event-location-search-btn" aria-label="Find location" title="Find location">
            <span class="material-symbols-outlined">place</span>
          </button>
        </div>
      </label>
      <label>Description (optional)<textarea name="description" rows="2">${escapeHtml(existing?.description || '')}</textarea></label>
      <p class="form-error" id="event-form-error" hidden></p>
      <button class="button primary" type="submit">${isEdit ? 'Save' : 'Add to calendar'}</button>
      ${isEdit ? '<button class="button ghost" type="button" id="event-delete-btn">Delete event</button>' : ''}
    </form>
  `,
    (root) => {
      const errorEl = root.querySelector('#event-form-error');

      root.querySelector('#event-location-search-btn').addEventListener('click', async (clickEvent) => {
        const btn = clickEvent.currentTarget;
        const input = root.querySelector('[name="location"]');
        const raw = input.value.trim();
        if (!raw) return;
        btn.disabled = true;
        try {
          input.value = await resolveLocation(raw);
        } finally {
          btn.disabled = false;
        }
      });

      root.querySelector('#event-form').addEventListener('submit', async (submitEvent) => {
        submitEvent.preventDefault();
        errorEl.hidden = true;
        const form = new FormData(submitEvent.target);
        const date = form.get('date');
        const startTime = form.get('startTime');
        const endTime = form.get('endTime');
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const body = {
          summary: form.get('title').trim(),
          location: form.get('location').trim(),
          description: form.get('description').trim()
        };

        if (startTime) {
          body.start = { dateTime: `${date}T${startTime}:00`, timeZone: tz };
          body.end = { dateTime: `${date}T${endTime || addMinutesToTimeString(startTime, 60)}:00`, timeZone: tz };
        } else {
          body.start = { date };
          body.end = { date: toIsoDate(addDays(new Date(`${date}T00:00`), 1)) };
        }

        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
          if (isEdit) {
            await calendarApiFetch(`/calendars/primary/events/${existing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
          } else {
            await calendarApiFetch('/calendars/primary/events', { method: 'POST', body: JSON.stringify(body) });
          }
          closeModal();
          loadWeekEvents();
        } catch (err) {
          errorEl.hidden = false;
          errorEl.textContent = err.message || 'Could not save this event.';
          submitBtn.disabled = false;
        }
      });

      root.querySelector('#event-delete-btn')?.addEventListener('click', () => {
        confirmDelete(`Delete “${existing.summary}”? This removes it from your real Google Calendar too.`, async () => {
          await calendarApiFetch(`/calendars/primary/events/${existing.id}`, { method: 'DELETE' });
          loadWeekEvents();
        });
      });
    }
  );
}

/* ==================== overview: clock ==================== */

function startClock() {
  const dateEl = document.getElementById('overview-date');
  const timeEl = document.getElementById('overview-time');
  function tick() {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
    timeEl.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  tick();
  window.setInterval(tick, 15000);
}

/* ==================== overview: weather ==================== */

const WEATHER_CODES = {
  0: 'Clear sky',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Foggy',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Heavy rain showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail'
};

function dressAdvice(maxF, rainChance) {
  let dress;
  if (maxF < 45) dress = 'Dress heavy — it’s cold out.';
  else if (maxF < 62) dress = 'Dress warm today.';
  else if (maxF < 82) dress = 'Dress light — mild weather.';
  else dress = 'Dress light and stay hydrated — hot today.';

  if (rainChance >= 40) {
    dress += ' Bring an umbrella, rain’s likely.';
  }
  return dress;
}

async function startWeather() {
  const locEl = document.getElementById('weather-loc');
  const tempEl = document.getElementById('weather-temp');
  const descEl = document.getElementById('weather-desc');
  const adviceEl = document.getElementById('weather-advice');

  if (!navigator.geolocation) {
    locEl.textContent = 'Location unavailable';
    descEl.textContent = 'This browser can’t share location.';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        const [weatherRes, placeRes] = await Promise.all([
          fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto`
          ),
          fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`)
        ]);
        const weather = await weatherRes.json();
        const place = await placeRes.json().catch(() => null);

        locEl.textContent = place?.city
          ? `${place.city}${place.principalSubdivisionCode ? ', ' + place.principalSubdivisionCode.split('-').pop() : ''}`
          : 'Current location';

        const temp = Math.round(weather.current.temperature_2m);
        tempEl.textContent = `${temp}°`;
        descEl.textContent = WEATHER_CODES[weather.current.weather_code] || 'Weather unavailable';

        const maxF = weather.daily.temperature_2m_max[0];
        const rainChance = weather.daily.precipitation_probability_max[0] || 0;
        adviceEl.textContent = dressAdvice(maxF, rainChance);
      } catch (err) {
        console.error(err);
        descEl.textContent = 'Weather unavailable right now.';
      }
    },
    () => {
      locEl.textContent = 'Location unavailable';
      descEl.textContent = 'Allow location access to see local weather.';
    },
    { maximumAge: 15 * 60 * 1000, timeout: 10000 }
  );
}

/* ==================== utils ==================== */

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

pinInput.focus();
