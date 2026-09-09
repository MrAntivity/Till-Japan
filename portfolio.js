(() => {
  'use strict';
  const body = document.body;
  const root = document.documentElement;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const themeButton = document.querySelector('.theme-toggle');
  const header = document.querySelector('.site-header');
  const hero = document.querySelector('.hero');
  const keyboardStory = document.querySelector('.keyboard-story');
  const keyboardStage = document.querySelector('.keyboard-sticky');
  const storySteps = [...document.querySelectorAll('.story-step')];
  const storageKey = 'aidenyue-theme-preference';
  const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } }
  };
  function setTheme(theme) {
    body.dataset.theme = theme;
    themeButton.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    themeButton.setAttribute('aria-pressed', String(theme === 'light'));
    document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f3f2ee' : '#090909';
  }
  setTheme(storage.get(storageKey) === 'light' ? 'light' : 'dark');
  themeButton.addEventListener('click', () => {
    const next = body.dataset.theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    storage.set(storageKey, next);
  });
  document.getElementById('year').textContent = new Date().getFullYear();

  // Content stays visible when JavaScript or IntersectionObserver is unavailable.
  let revealObserver;
  function setMotion() {
    const animate = !motionQuery.matches;
    body.classList.toggle('motion-ready', animate);
    body.classList.toggle('keyboard-static', window.innerHeight < 740);
    revealObserver?.disconnect();
    body.classList.remove('reveal-ready');
    if (animate && 'IntersectionObserver' in window) {
      revealObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      }, { threshold: 0.07, rootMargin: '0px 0px 30px 0px' });
      document.querySelectorAll('[data-reveal]').forEach(el => revealObserver.observe(el));
      body.classList.add('reveal-ready');
    }
    queueFrame();
  }
  let activeStep = -1;
  let frame = 0;
  const navLinks = [...document.querySelectorAll('.site-nav a')];
  const navSections = navLinks.map(link => document.querySelector(link.hash));
  function renderScroll() {
    frame = 0;
    const y = window.scrollY;
    const viewport = window.innerHeight;
    const total = Math.max(1, root.scrollHeight - viewport);
    root.style.setProperty('--reading-progress', clamp(y / total));
    header.classList.toggle('scrolled', y > 30);
    let currentSection = -1;
    navSections.forEach((section, index) => {
      if (section.getBoundingClientRect().top <= viewport * 0.4) currentSection = index;
    });
    navLinks.forEach((link, index) => {
      if (index === currentSection) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    if (motionQuery.matches) {
      hero.style.setProperty('--hero-title-y', '0px');
      hero.style.setProperty('--portrait-y', '0px');
      hero.style.setProperty('--float-left-y', '0px');
      hero.style.setProperty('--float-right-y', '0px');
      return;
    }
    const heroProgress = clamp(y / (hero.offsetHeight * 0.7));
    hero.style.setProperty('--hero-title-y', `${-heroProgress * 140}px`);
    hero.style.setProperty('--portrait-y', `${heroProgress * 75}px`);
    hero.style.setProperty('--float-left-y', `${-heroProgress * 140}px`);
    hero.style.setProperty('--float-right-y', `${-heroProgress * 210}px`);
    const bounds = keyboardStory.getBoundingClientRect();
    if (bounds.top < viewport && bounds.bottom > 0 && !body.classList.contains('keyboard-static')) {
      const top = parseFloat(getComputedStyle(keyboardStage).top) || 0;
      const distance = Math.max(1, keyboardStory.offsetHeight - keyboardStage.offsetHeight);
      const progress = clamp((top - bounds.top) / distance);
      const mobile = window.innerWidth <= 760;
      keyboardStory.style.setProperty('--key-x', `${(progress - 0.5) * (mobile ? 25 : 80)}px`);
      keyboardStory.style.setProperty('--key-y', `${Math.sin(progress * Math.PI) * -35}px`);
      keyboardStory.style.setProperty('--key-rotate', `${-13 + progress * 21}deg`);
      keyboardStory.style.setProperty('--key-scale', `${0.91 + Math.sin(progress * Math.PI) * 0.15}`);
      keyboardStory.style.setProperty('--key-progress', String(Math.max(.07, progress)));
      const step = Math.min(2, Math.floor(progress * 3));
      if (step !== activeStep) {
        activeStep = step;
        storySteps.forEach((el, i) => el.classList.toggle('active', i === step));
      }
    }
  }
  function queueFrame() {
    if (!frame) frame = requestAnimationFrame(renderScroll);
  }
  storySteps[0].classList.add('active');
  window.addEventListener('scroll', queueFrame, { passive: true });
  window.addEventListener('resize', () => {
    body.classList.toggle('keyboard-static', window.innerHeight < 740);
    queueFrame();
  }, { passive: true });
  motionQuery.addEventListener('change', setMotion);
  setMotion();

  const cards = [...document.querySelectorAll('[data-photo]')];
  const dialog = document.querySelector('.photo-dialog');
  const fullPhoto = document.getElementById('full-photo');
  let selectedPhoto = 0;
  let photoTrigger;
  function showPhoto(index) {
    selectedPhoto = (index + cards.length) % cards.length;
    const card = cards[selectedPhoto];
    const img = card.querySelector('img');
    fullPhoto.src = img.getAttribute('src');
    fullPhoto.alt = img.alt;
    document.getElementById('photo-count').textContent = `${String(selectedPhoto + 1).padStart(2, '0')} / ${cards.length}`;
    document.getElementById('photo-description').textContent = card.querySelector('.photo-caption > span').textContent;
  }
  cards.forEach((card, index) => card.addEventListener('click', () => {
    if (!dialog.showModal) { window.open(card.querySelector('img').src, '_blank', 'noopener'); return; }
    photoTrigger = card;
    showPhoto(index);
    dialog.showModal();
    body.classList.add('modal-open');
    dialog.querySelector('[data-close]').focus();
  }));
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('.gallery-prev').addEventListener('click', () => showPhoto(selectedPhoto - 1));
  dialog.querySelector('.gallery-next').addEventListener('click', () => showPhoto(selectedPhoto + 1));
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); showPhoto(selectedPhoto + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); showPhoto(selectedPhoto - 1); }
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    body.classList.remove('modal-open');
    photoTrigger?.focus({ preventScroll: true });
  });

  // Retain the site's existing view counter and its cached fallback.
  const countElement = document.getElementById('view-count-value');
  const cachedCount = Number(storage.get('aidenyue-last-view-count'));
  countElement.textContent = (cachedCount >= 22394 ? cachedCount : 22394).toLocaleString('en-US');
  fetch('https://abacus.jasoncameron.dev/hit/aidenyue.com/homepage')
    .then(response => { if (!response.ok) throw new Error('Counter unavailable'); return response.json(); })
    .then(data => {
      const value = Number(data?.value);
      if (!Number.isFinite(value) || value < 0) return;
      const total = 22394 + Math.floor(value);
      countElement.textContent = total.toLocaleString('en-US');
      storage.set('aidenyue-last-view-count', String(total));
    }).catch(() => { /* Keep the existing count if the external service is unavailable. */ });
})();
