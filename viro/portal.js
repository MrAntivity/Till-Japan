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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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
  const minWait = prefersReducedMotion ? 0 : 550;

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
  subscribeCollections();
}

/* ==================== tab navigation ==================== */

portalNav.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-tab]');
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-goto-tab]');
  if (!link) return;
  event.preventDefault();
  switchTab(link.dataset.gotoTab);
});

function switchTab(tabName) {
  document.querySelectorAll('.portal-tab').forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });
  document.querySelectorAll('.portal-nav button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tabName);
  });
}

/* ==================== modal ==================== */

function openModal(html, onMount) {
  modalContent.innerHTML = html;
  modalBackdrop.hidden = false;
  if (onMount) onMount(modalContent);
}

function closeModal() {
  modalBackdrop.hidden = true;
  modalContent.innerHTML = '';
}

modalClose.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (event) => {
  if (event.target === modalBackdrop) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalBackdrop.hidden) closeModal();
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

document.getElementById('add-birthday-btn').addEventListener('click', () => {
  openModal(
    `
    <h2>Add birthday</h2>
    <form id="birthday-form">
      <label>Name<input type="text" name="name" required /></label>
      <label>Birthday<input type="date" name="date" required /></label>
      <label>Relationship
        <select name="relationship">
          <option>Family</option>
          <option>Friend</option>
          <option>Coworker</option>
          <option>Other</option>
        </select>
      </label>
      <label>Notes (optional)<textarea name="notes" rows="2"></textarea></label>
      <button class="button primary" type="submit">Save</button>
    </form>
  `,
    (root) => {
      root.querySelector('#birthday-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        await addDoc(userCollection('birthdays'), {
          name: form.get('name').trim(),
          date: form.get('date'),
          relationship: form.get('relationship'),
          notes: form.get('notes').trim(),
          createdAt: serverTimestamp()
        });
        closeModal();
      });
    }
  );
});

document.getElementById('birthday-list').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-delete-birthday]');
  if (!btn) return;
  deleteDoc(userDoc('birthdays', btn.dataset.deleteBirthday));
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
  btn.addEventListener('click', () => {
    const category = btn.dataset.addTodo;
    openModal(
      `
      <h2>Add ${CATEGORY_LABEL[category]} to-do</h2>
      <form id="todo-form">
        <label>Title<input type="text" name="title" required /></label>
        <label>Deadline (optional)<input type="date" name="deadline" /></label>
        <label>Description (optional)<textarea name="description" rows="3"></textarea></label>
        <button class="button primary" type="submit">Save</button>
      </form>
    `,
      (root) => {
        root.querySelector('#todo-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const form = new FormData(event.target);
          await addDoc(userCollection('todos'), {
            category,
            title: form.get('title').trim(),
            deadline: form.get('deadline') || null,
            description: form.get('description').trim(),
            completed: false,
            createdAt: serverTimestamp()
          });
          closeModal();
        });
      }
    );
  });
});

document.querySelector('.todo-columns').addEventListener('click', (event) => {
  const toggleBtn = event.target.closest('[data-toggle-todo]');
  if (toggleBtn) {
    const item = todos[toggleBtn.dataset.category].find((t) => t.id === toggleBtn.dataset.toggleTodo);
    updateDoc(userDoc('todos', toggleBtn.dataset.toggleTodo), { completed: !item.completed });
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
            <button class="icon-btn" data-delete-vault="${v.id}" aria-label="Delete"><span class="material-symbols-outlined">delete</span></button>
          </div>
        </article>
      `
    )
    .join('');
}

document.getElementById('vault-search').addEventListener('input', renderVault);

document.getElementById('vault-list').addEventListener('click', async (event) => {
  const revealBtn = event.target.closest('[data-reveal-vault]');
  if (revealBtn) {
    const id = revealBtn.dataset.revealVault;
    const fieldsEl = document.querySelector(`[data-vault-fields="${id}"]`);
    if (!fieldsEl.hidden) {
      fieldsEl.hidden = true;
      fieldsEl.innerHTML = '';
      revealBtn.querySelector('.material-symbols-outlined').textContent = 'visibility';
      return;
    }
    const entry = vaultEntries.find((v) => v.id === id);
    try {
      const payload = await decryptPayload(encryptionKey, entry.iv, entry.ciphertext);
      const def = VAULT_TYPES[entry.type];
      fieldsEl.innerHTML = def.fields
        .map((f) => `<div class="vault-field-row">${f.label}: <strong>${escapeHtml(payload[f.key] || '')}</strong></div>`)
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
  const deleteBtn = event.target.closest('[data-delete-vault]');
  if (deleteBtn) {
    deleteDoc(userDoc('vault', deleteBtn.dataset.deleteVault));
  }
});

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

function openVaultForm(type) {
  const def = VAULT_TYPES[type];
  openModal(
    `
    <h2>Add ${def.label}</h2>
    <form id="vault-form">
      <label>Name<input type="text" name="name" required placeholder="e.g. Netflix" /></label>
      ${def.fields
        .map(
          (f) =>
            `<label>${f.label}<input type="${f.type}" name="${f.key}" required placeholder="${f.placeholder || ''}" /></label>`
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
        await addDoc(userCollection('vault'), {
          type,
          name,
          iv,
          ciphertext,
          createdAt: serverTimestamp()
        });
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

  list.innerHTML = items
    .map(
      (c) => `
        <article class="entry-card" data-id="${c.id}">
          <div class="entry-main">
            <div class="entry-title">${escapeHtml(c.name)}</div>
            <p class="entry-meta">${escapeHtml(c.phone)}</p>
            ${c.description ? `<p class="entry-desc">${escapeHtml(c.description)}</p>` : ''}
          </div>
          <div class="entry-actions">
            <button class="icon-btn" data-delete-contact="${c.id}" aria-label="Delete"><span class="material-symbols-outlined">delete</span></button>
          </div>
        </article>
      `
    )
    .join('');
}

document.getElementById('contact-search').addEventListener('input', renderContacts);

document.getElementById('add-contact-btn').addEventListener('click', () => {
  openModal(
    `
    <h2>Add contact</h2>
    <form id="contact-form">
      <label>Name<input type="text" name="name" required /></label>
      <label>Phone number<input type="tel" name="phone" required /></label>
      <label>Description (optional)<textarea name="description" rows="2"></textarea></label>
      <button class="button primary" type="submit">Save</button>
    </form>
  `,
    (root) => {
      root.querySelector('#contact-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        await addDoc(userCollection('contacts'), {
          name: form.get('name').trim(),
          phone: form.get('phone').trim(),
          description: form.get('description').trim(),
          createdAt: serverTimestamp()
        });
        closeModal();
      });
    }
  );
});

document.getElementById('contact-list').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-delete-contact]');
  if (!btn) return;
  deleteDoc(userDoc('contacts', btn.dataset.deleteContact));
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
