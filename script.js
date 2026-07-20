const year = document.getElementById('year');
if (year) {
  year.textContent = new Date().getFullYear();
}

const body = document.body;
const themeToggle = document.querySelector('.theme-toggle');
const themeIcon = themeToggle?.querySelector('.material-symbols-outlined');
const header = document.querySelector('.site-header');
const glow = document.querySelector('.glow');
const THEME_STORAGE_KEY = 'aidenyue-theme-preference';

const prefersReducedMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)'
).matches;
const hasFinePointer = window.matchMedia('(pointer: fine)').matches;

const savedTheme = window.localStorage?.getItem(THEME_STORAGE_KEY);
const initialTheme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark';
setTheme(initialTheme);

themeToggle?.addEventListener('click', (event) => {
  const nextTheme = body.dataset.theme === 'light' ? 'dark' : 'light';
  window.localStorage?.setItem(THEME_STORAGE_KEY, nextTheme);

  const originX = event.clientX || themeToggle.getBoundingClientRect().left;
  const originY = event.clientY || themeToggle.getBoundingClientRect().top;
  document.documentElement.style.setProperty('--theme-x', `${originX}px`);
  document.documentElement.style.setProperty('--theme-y', `${originY}px`);

  if (!prefersReducedMotion && document.startViewTransition) {
    document.startViewTransition(() => setTheme(nextTheme));
  } else {
    setTheme(nextTheme);
  }
});

function setTheme(theme) {
  body.dataset.theme = theme;
  if (!themeIcon || !themeToggle) return;
  const nextMode = theme === 'light' ? 'dark' : 'light';
  themeIcon.textContent = theme === 'light' ? 'light_mode' : 'dark_mode';
  themeToggle.setAttribute('aria-label', `Activate ${nextMode} mode`);
}

/* -------------------- intro loader -------------------- */
/* Shows briefly, then slides down to reveal the page. The hero's entrance
   animation is deliberately held back until the loader dismisses so the two
   choreograph together instead of both firing at once behind the loader. */

const loader = document.getElementById('loader');
const LOADER_MIN_MS = prefersReducedMotion ? 0 : 500;
const loaderStartedAt = performance.now();
let loaderDismissed = false;

function triggerHeroEntrance() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.querySelectorAll('.entrance, .fade-in-up').forEach((el) => {
        el.classList.add('is-visible');
      });
    });
  });
}

function dismissLoader() {
  if (loaderDismissed) return;
  loaderDismissed = true;

  if (!loader) {
    triggerHeroEntrance();
    return;
  }

  const elapsed = performance.now() - loaderStartedAt;
  const remaining = Math.max(LOADER_MIN_MS - elapsed, 0);

  window.setTimeout(() => {
    loader.classList.add('is-exiting');
    triggerHeroEntrance();
    window.setTimeout(() => loader.remove(), 650);
  }, remaining);
}

if (document.readyState === 'complete') {
  dismissLoader();
} else {
  window.addEventListener('load', dismissLoader, { once: true });
}
// Safety net in case 'load' is held up by slow external resources (fonts, etc.)
window.setTimeout(dismissLoader, 2000);

/* -------------------- age counter -------------------- */

const BIRTHDATE = new Date(2006, 8, 7);

function getAge(from = new Date()) {
  let age = from.getFullYear() - BIRTHDATE.getFullYear();
  const hasHadBirthdayThisYear =
    from.getMonth() > BIRTHDATE.getMonth() ||
    (from.getMonth() === BIRTHDATE.getMonth() && from.getDate() >= BIRTHDATE.getDate());
  if (!hasHadBirthdayThisYear) {
    age -= 1;
  }
  return age;
}

const ageCounter = document.getElementById('age-counter');
if (ageCounter) {
  ageCounter.dataset.target = String(getAge());
}

/* -------------------- view counter -------------------- */
/* Static site with no backend, so a real global counter needs a third-party
   hit-counter API. VIEW_COUNT_OFFSET accounts for views this site already
   had before the counter existed; the API only needs to track the delta. */

const VIEW_COUNT_OFFSET = 22394;
const VIEW_COUNT_ENDPOINT = 'https://abacus.jasoncameron.dev/hit/aidenyue.com/homepage';
const VIEW_COUNT_CACHE_KEY = 'aidenyue-last-view-count';
const viewCountEl = document.getElementById('view-count-value');

if (viewCountEl) {
  fetch(VIEW_COUNT_ENDPOINT)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad response'))))
    .then((data) => {
      const total = VIEW_COUNT_OFFSET + (Number(data?.value) || 0);
      viewCountEl.textContent = total.toLocaleString('en-US');
      window.localStorage?.setItem(VIEW_COUNT_CACHE_KEY, String(total));
    })
    .catch(() => {
      const cached = window.localStorage?.getItem(VIEW_COUNT_CACHE_KEY);
      const fallback = cached ? Number(cached) : VIEW_COUNT_OFFSET;
      viewCountEl.textContent = fallback.toLocaleString('en-US');
    });
}

/* -------------------- scroll reveal engine (varied entrance directions) -------------------- */

if (!prefersReducedMotion) {
  const revealGroups = [
    { selector: '.about-content', variant: 'up' },
    { selector: '.quick-facts > div', variant: 'up' },
    { selector: '.timeline-item', variant: 'alternate' },
    { selector: '.project-card', variant: 'scale' },
    { selector: '.stat', variant: 'scale' },
    { selector: '.section-heading', variant: 'up' }
  ];

  const revealTargets = [];
  revealGroups.forEach(({ selector, variant }) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    const byParent = new Map();
    nodes.forEach((node) => {
      const parent = node.parentElement;
      const index = byParent.get(parent) || 0;
      byParent.set(parent, index + 1);
      const resolvedVariant =
        variant === 'alternate' ? (index % 2 === 0 ? 'left' : 'right') : variant;
      node.setAttribute('data-reveal', resolvedVariant);
      node.style.setProperty('--reveal-index', Math.min(index, 6));
      revealTargets.push(node);
    });
  });

  if (revealTargets.length) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }
    );

    revealTargets.forEach((target) => revealObserver.observe(target));
  }

  animateCounters();
} else {
  document.querySelectorAll('[data-counter]').forEach((el) => {
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    el.textContent = `${prefix}${el.dataset.target || ''}${suffix}`;
  });
}

function animateCounters() {
  const counters = Array.from(document.querySelectorAll('[data-counter]'));
  if (!counters.length) return;

  const counterObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        counterObserver.unobserve(entry.target);
        runCounter(entry.target);
      });
    },
    { threshold: 0.6 }
  );

  counters.forEach((el) => counterObserver.observe(el));
}

function runCounter(el) {
  const target = parseFloat(el.dataset.target || '0');
  const prefix = el.dataset.prefix || '';
  const suffix = el.dataset.suffix || '';
  const decimals = el.dataset.decimals ? parseInt(el.dataset.decimals, 10) : 0;
  const duration = 1600;
  const start = performance.now();

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = target * eased;
    el.textContent = `${prefix}${value.toFixed(decimals)}${suffix}`;
    if (progress < 1) {
      window.requestAnimationFrame(tick);
    } else {
      el.textContent = `${prefix}${target.toFixed(decimals)}${suffix}`;
    }
  }

  window.requestAnimationFrame(tick);
}

/* -------------------- magnetic buttons -------------------- */

if (!prefersReducedMotion && hasFinePointer) {
  const magneticEls = document.querySelectorAll('.button, .theme-toggle');

  magneticEls.forEach((el) => {
    el.addEventListener('mousemove', (event) => {
      const rect = el.getBoundingClientRect();
      const relX = event.clientX - rect.left - rect.width / 2;
      const relY = event.clientY - rect.top - rect.height / 2;
      el.style.transform = `translate(${relX * 0.22}px, ${relY * 0.32}px)`;
    });

    el.addEventListener('mouseleave', () => {
      el.style.transform = '';
    });
  });
}

/* -------------------- custom cursor -------------------- */

if (!prefersReducedMotion && hasFinePointer) {
  const cursorDot = document.createElement('div');
  cursorDot.className = 'cursor-dot';
  const cursorGlow = document.createElement('div');
  cursorGlow.className = 'cursor-glow';
  document.body.append(cursorGlow, cursorDot);
  body.classList.add('cursor-ready');

  let pointerX = window.innerWidth / 2;
  let pointerY = window.innerHeight / 2;
  let glowFollowX = pointerX;
  let glowFollowY = pointerY;

  window.addEventListener(
    'mousemove',
    (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      cursorDot.style.left = `${pointerX}px`;
      cursorDot.style.top = `${pointerY}px`;
    },
    { passive: true }
  );

  function renderCursorGlow() {
    glowFollowX += (pointerX - glowFollowX) * 0.14;
    glowFollowY += (pointerY - glowFollowY) * 0.14;
    cursorGlow.style.left = `${glowFollowX}px`;
    cursorGlow.style.top = `${glowFollowY}px`;
    window.requestAnimationFrame(renderCursorGlow);
  }
  window.requestAnimationFrame(renderCursorGlow);

  document.addEventListener('mouseover', (event) => {
    if (event.target.closest('a, button, input, textarea, label')) {
      cursorDot.classList.add('cursor-dot--active');
    }
  });
  document.addEventListener('mouseout', (event) => {
    if (event.target.closest('a, button, input, textarea, label')) {
      cursorDot.classList.remove('cursor-dot--active');
    }
  });
}

/* -------------------- nav indicator + active section (scrollspy) -------------------- */
/* Uses a reference line rather than IntersectionObserver ratio thresholds:
   tall sections rarely fill 35%+ of the viewport at once, so ratio-based
   detection could get stuck on whichever section activated first. */

const sectionLinks = Array.from(
  document.querySelectorAll('.site-nav a[href^="#"]')
);

const sectionMap = new Map();

sectionLinks.forEach((link) => {
  const hash = link.getAttribute('href')?.slice(1);
  if (!hash) return;
  const section = document.getElementById(hash);
  if (!section) return;
  sectionMap.set(section, link);
});

const sections = Array.from(sectionMap.keys());
const navIndicator = setupNavIndicator();
let activeLink = null;

function activateLink(nextLink) {
  if (!nextLink || nextLink === activeLink) return;
  if (activeLink) {
    activeLink.removeAttribute('aria-current');
  }
  activeLink = nextLink;
  activeLink.setAttribute('aria-current', 'section');
  moveNavIndicator(activeLink);
}

function updateActiveSection() {
  if (!sections.length) return;
  const referenceY = window.innerHeight * 0.35;
  let current = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= referenceY) {
      current = section;
    }
  }
  activateLink(sectionMap.get(current));
}

if (sections.length) {
  activateLink(sectionMap.get(sections[0]));
}

function setupNavIndicator() {
  const nav = document.querySelector('.site-nav');
  if (!nav) return null;
  const indicator = document.createElement('span');
  indicator.className = 'nav-indicator';
  nav.prepend(indicator);
  window.addEventListener('resize', () => {
    const current = nav.querySelector('a[aria-current]');
    if (current) moveNavIndicator(current);
  });
  return indicator;
}

function moveNavIndicator(link) {
  if (!navIndicator || !link) return;
  const nav = link.parentElement;
  if (!nav) return;
  const navRect = nav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  navIndicator.style.left = `${linkRect.left - navRect.left}px`;
  navIndicator.style.width = `${linkRect.width}px`;
  navIndicator.style.opacity = '1';
}

/* -------------------- scroll-linked motion: parallax + tilt + background drift -------------------- */
/* Cards/headings drift continuously as the page scrolls (not just a one-time
   fade-in), and cards additionally tilt/spotlight on mouse hover. Both write
   into a shared per-element state so the transforms compose instead of
   clobbering each other. Tilt is reset every scroll frame so a stationary
   cursor riding over a card that scrolls out from under it (no mouseleave
   ever fires) can't leave the card stuck at a stale angle. */

const motionEls = Array.from(
  document.querySelectorAll('.timeline-item, .project-card, .stat, .quick-facts > div')
);
const headingEls = Array.from(document.querySelectorAll('section h2, .hero-name'));

const motionState = new Map();
motionEls.forEach((el, index) => {
  motionState.set(el, {
    speed: 0.045 + (index % 3) * 0.02,
    tiltX: 0,
    tiltY: 0,
    parallax: 0
  });
});

function applyMotion(el) {
  const state = motionState.get(el);
  if (!state) return;
  el.style.transform = `translateY(${state.parallax.toFixed(2)}px) perspective(900px) rotateX(${state.tiltX.toFixed(2)}deg) rotateY(${state.tiltY.toFixed(2)}deg)`;
}

let motionRaf = null;

function updateScrollMotion() {
  motionRaf = null;
  const currentScroll = window.scrollY || 0;
  const viewportHeight = window.innerHeight;
  const maxScroll = Math.max(document.documentElement.scrollHeight - viewportHeight, 1);
  const progress = Math.min(Math.max(currentScroll / maxScroll, 0), 1);

  document.documentElement.style.setProperty('--scroll-progress', progress.toFixed(3));

  if (header) {
    header.classList.toggle('is-condensed', currentScroll > 40);
  }

  if (glow && !hasFinePointer) {
    glow.style.transform = `translate3d(0, ${(currentScroll * -0.06).toFixed(2)}px, 0)`;
  } else if (glow) {
    glow.dataset.scrollY = String(currentScroll * -0.06);
    applyGlowTransform();
  }

  if (!prefersReducedMotion) {
    const viewportCenter = viewportHeight / 2;
    const mobileScale = viewportHeight < 700 || window.innerWidth < 640 ? 0.55 : 1;

    motionEls.forEach((el) => {
      if (el.hasAttribute('data-reveal') && !el.classList.contains('is-visible')) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -300 || rect.top > viewportHeight + 300) return;
      const state = motionState.get(el);
      const distance = rect.top + rect.height / 2 - viewportCenter;
      state.parallax = distance * -state.speed * mobileScale;
      // Reset tilt every frame: prevents a stale rotation sticking around
      // when the card scrolls out from under a cursor that never moved.
      state.tiltX = 0;
      state.tiltY = 0;
      applyMotion(el);
    });

    headingEls.forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -300 || rect.top > viewportHeight + 300) return;
      const distance = rect.top + rect.height / 2 - viewportCenter;
      const speed = (0.05 + (index % 2) * 0.015) * mobileScale;
      el.style.transform = `translateY(${(distance * -speed).toFixed(2)}px)`;
    });
  }

  updateActiveSection();
}

function onScroll() {
  if (motionRaf !== null) return;
  motionRaf = window.requestAnimationFrame(updateScrollMotion);
}

window.addEventListener('scroll', onScroll, { passive: true });
updateScrollMotion();

/* Tilt + spotlight (mouse-driven, desktop only) shares the same state map.
   Since updateScrollMotion() zeroes tilt every scroll frame, hover-driven
   tilt only "wins" while the pointer is actively moving over a settled
   card, which is exactly the state it should reflect. */
if (!prefersReducedMotion && hasFinePointer) {
  motionEls.forEach((el) => {
    el.addEventListener('mousemove', (event) => {
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      el.style.setProperty('--x', `${(x / rect.width) * 100}%`);
      el.style.setProperty('--y', `${(y / rect.height) * 100}%`);

      const state = motionState.get(el);
      state.tiltX = ((y / rect.height) - 0.5) * -6;
      state.tiltY = ((x / rect.width) - 0.5) * 6;
      applyMotion(el);
    });

    el.addEventListener('mouseleave', () => {
      const state = motionState.get(el);
      state.tiltX = 0;
      state.tiltY = 0;
      applyMotion(el);
    });
  });
}

/* Background glow blobs: combine mouse parallax with the scroll drift above */
if (glow) {
  glow.dataset.scrollY = '0';
  glow.dataset.mouseX = '0';
  glow.dataset.mouseY = '0';
}

function applyGlowTransform() {
  if (!glow) return;
  const mx = glow.dataset.mouseX || 0;
  const my = glow.dataset.mouseY || 0;
  const sy = glow.dataset.scrollY || 0;
  glow.style.transform = `translate3d(${mx}px, ${Number(my) + Number(sy)}px, 0)`;
}

if (!prefersReducedMotion && hasFinePointer && glow) {
  window.addEventListener(
    'mousemove',
    (event) => {
      const relX = (event.clientX / window.innerWidth - 0.5) * 24;
      const relY = (event.clientY / window.innerHeight - 0.5) * 24;
      glow.dataset.mouseX = String(relX);
      glow.dataset.mouseY = String(relY);
      applyGlowTransform();
    },
    { passive: true }
  );
}
