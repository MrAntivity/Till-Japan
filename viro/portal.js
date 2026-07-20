import { firebaseConfig, PORTAL_ACCOUNT_EMAIL } from './firebase-config.js';
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

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

function requestTabSwitch(tabName) {
  if (tabName === 'vault' && !vaultUnlocked) {
    openVaultUnlockPrompt(() => switchTab('vault'));
    return;
  }
  switchTab(tabName);
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
    deleteDoc(userDoc('birthdays', deleteBtn.dataset.deleteBirthday));
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
    deleteDoc(userDoc('todos', deleteBtn.dataset.deleteTodo));
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
    revealedVaultPayloads.delete(deleteBtn.dataset.deleteVault);
    deleteDoc(userDoc('vault', deleteBtn.dataset.deleteVault));
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
  const query = (document.getElementById('contact-search').value || '').toLowerCase();
  const items = contacts
    .filter((c) => c.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

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

document.getElementById('contact-search').addEventListener('input', renderContacts);

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
    deleteDoc(userDoc('contacts', deleteBtn.dataset.deleteContact));
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

function fileIcon(contentType) {
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf') return 'picture_as_pdf';
  if (contentType?.includes('word')) return 'description';
  if (contentType?.includes('sheet') || contentType?.includes('excel')) return 'table_chart';
  if (contentType?.startsWith('video/')) return 'videocam';
  if (contentType?.startsWith('audio/')) return 'audiotrack';
  return 'insert_drive_file';
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

function renderFiles() {
  const list = document.getElementById('file-list');
  const items = visibleFiles();

  if (!items.length) {
    list.innerHTML = '<p class="entry-empty">No files found.</p>';
    return;
  }

  list.innerHTML = items
    .map((f) => {
      const pages = f.pages || [];
      const multi = pages.length > 1;
      const icon = multi ? 'photo_library' : fileIcon(pages[0]?.contentType);
      return `
        <article class="file-card" data-preview-file="${f.id}" tabindex="0" role="button" aria-label="Preview ${escapeHtml(f.name)}">
          <div class="file-card-icon">
            <span class="material-symbols-outlined">${icon}</span>
            ${multi ? `<span class="file-card-pages-badge">${pages.length}</span>` : ''}
          </div>
          <div class="file-card-name">${escapeHtml(f.name)}</div>
          <p class="file-card-meta">${formatBytes(totalSize(pages))}${multi ? ` · ${pages.length} pages` : ''}${f.folderId ? ` · ${escapeHtml(folderName(f.folderId))}` : ''}</p>
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

document.getElementById('file-search').addEventListener('input', renderFiles);

document.getElementById('folder-chips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-folder-id]');
  if (!chip) return;
  currentFolderId = chip.dataset.folderId;
  renderFolderChips();
  renderFiles();
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
            await addDoc(userCollection('files'), {
              name: form.get('name').trim(),
              description,
              folderId,
              pages,
              createdAt: serverTimestamp()
            });
          } else {
            for (let i = 0; i < selected.length; i += 1) {
              const file = selected[i];
              statusEl.textContent = `Uploading ${i + 1} of ${selected.length}…`;
              progressBar.style.width = '0%';
              const pages = await uploadPages([file], (pct) => {
                progressBar.style.width = `${pct}%`;
              });
              await addDoc(userCollection('files'), {
                name: file.name.replace(/\.[^/.]+$/, ''),
                description,
                folderId,
                pages,
                createdAt: serverTimestamp()
              });
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

function previewBodyHtml(page, entryName) {
  if (page.contentType?.startsWith('image/')) {
    return `<img class="preview-image" src="${escapeHtml(page.downloadURL)}" alt="${escapeHtml(entryName)}" />`;
  }
  if (page.contentType === 'application/pdf') {
    return `<iframe class="preview-frame" src="${escapeHtml(page.downloadURL)}" title="${escapeHtml(entryName)}"></iframe>`;
  }
  return `
    <div class="preview-fallback">
      <span class="material-symbols-outlined" aria-hidden="true">${fileIcon(page.contentType)}</span>
      <p>Preview isn’t available for this file type.</p>
    </div>
  `;
}

function openFilePreview(file) {
  const pages = file.pages && file.pages.length ? file.pages : [{}];
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
  const pages = file.pages || [];
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
    if (file) deleteFile(file);
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
