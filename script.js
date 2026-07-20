const year = document.getElementById('year');
if (year) {
  year.textContent = new Date().getFullYear();
}

const body = document.body;
const themeToggle = document.querySelector('.theme-toggle');
const themeIcon = themeToggle?.querySelector('.material-symbols-outlined');
const header = document.querySelector('.site-header');
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

/* -------------------- scroll header + progress -------------------- */

let lastScrollY = window.scrollY || 0;
let scrollRaf = null;

function updateScrollUI() {
  scrollRaf = null;
  const currentScroll = window.scrollY || 0;
  const maxScroll = Math.max(
    document.documentElement.scrollHeight - window.innerHeight,
    1
  );
  const progress = Math.min(Math.max(currentScroll / maxScroll, 0), 1);
  document.documentElement.style.setProperty(
    '--scroll-progress',
    progress.toFixed(3)
  );

  if (header) {
    header.classList.toggle('is-condensed', currentScroll > 40);
  }

  lastScrollY = currentScroll;
}

function onScroll() {
  if (scrollRaf !== null) return;
  scrollRaf = window.requestAnimationFrame(updateScrollUI);
}

window.addEventListener('scroll', onScroll, { passive: true });
updateScrollUI();

/* -------------------- entrance animation (hero-style blocks) -------------------- */

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(() => {
    document.querySelectorAll('.entrance, .fade-in-up').forEach((el) => {
      el.classList.add('is-visible');
    });
  });
});

/* -------------------- scroll reveal engine -------------------- */

if (!prefersReducedMotion) {
  const revealGroups = [
    '.about-content',
    '.quick-facts > div',
    '.timeline-item',
    '.project-card',
    '.section-heading'
  ];

  const revealTargets = [];
  revealGroups.forEach((selector) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    const byParent = new Map();
    nodes.forEach((node) => {
      const parent = node.parentElement;
      const index = byParent.get(parent) || 0;
      byParent.set(parent, index + 1);
      node.setAttribute('data-reveal', '');
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

/* -------------------- interactive cards: spotlight + tilt -------------------- */

if (!prefersReducedMotion && hasFinePointer) {
  const interactiveCards = document.querySelectorAll(
    '.project-card, .timeline-item, .quick-facts > div, .stat'
  );

  interactiveCards.forEach((card) => {
    card.addEventListener('mousemove', (event) => {
      const rect = card.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      card.style.setProperty('--x', `${(x / rect.width) * 100}%`);
      card.style.setProperty('--y', `${(y / rect.height) * 100}%`);

      const rotateX = ((y / rect.height) - 0.5) * -6;
      const rotateY = ((x / rect.width) - 0.5) * 6;
      card.style.transform = `perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
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
  let glowX = pointerX;
  let glowY = pointerY;

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
    glowX += (pointerX - glowX) * 0.14;
    glowY += (pointerY - glowY) * 0.14;
    cursorGlow.style.left = `${glowX}px`;
    cursorGlow.style.top = `${glowY}px`;
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

/* -------------------- background blob parallax -------------------- */

if (!prefersReducedMotion && hasFinePointer) {
  const glow = document.querySelector('.glow');
  if (glow) {
    window.addEventListener(
      'mousemove',
      (event) => {
        const relX = (event.clientX / window.innerWidth - 0.5) * 24;
        const relY = (event.clientY / window.innerHeight - 0.5) * 24;
        glow.style.transform = `translate3d(${relX}px, ${relY}px, 0)`;
      },
      { passive: true }
    );
  }
}

/* -------------------- nav indicator + active section -------------------- */

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

const navIndicator = setupNavIndicator();

if (sectionMap.size) {
  let activeLink = null;
  const sections = Array.from(sectionMap.keys());

  const activateLink = (nextLink) => {
    if (!nextLink || nextLink === activeLink) return;
    if (activeLink) {
      activeLink.removeAttribute('aria-current');
    }
    activeLink = nextLink;
    activeLink.setAttribute('aria-current', 'section');
    moveNavIndicator(activeLink);
  };

  activateLink(sectionMap.get(sections[0]));

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

      if (!visible.length) return;

      const candidate = sectionMap.get(visible[0].target);
      activateLink(candidate);
    },
    {
      rootMargin: '-45% 0px -40% 0px',
      threshold: [0.35, 0.6]
    }
  );

  sections.forEach((section) => observer.observe(section));
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
