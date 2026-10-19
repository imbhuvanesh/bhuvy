/* ============================================================
   BHUVY — cinematic preloader + site behaviour
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var body = doc.body;

  /* ---------------------------------------------------------
     Elements
  --------------------------------------------------------- */
  var preloader = doc.getElementById('preloader');
  var wordEl = doc.getElementById('preloadWord');
  var statusEl = doc.getElementById('loadStatus');
  var preloaderVideo = doc.getElementById('preloaderVideo');

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------
     Timer / rAF bookkeeping — everything is cleaned up on exit
  --------------------------------------------------------- */
  var timers = [];
  var rafs = [];
  var listeners = [];
  var observers = [];
  var finished = false;

  function later(fn, ms) {
    var id = setTimeout(function () { fn(); }, ms);
    timers.push(id);
    return id;
  }

  function wait(ms) {
    return new Promise(function (resolve) { later(resolve, ms); });
  }

  function loop(fn) {
    var id = requestAnimationFrame(function handle(t) {
      var i = rafs.indexOf(id);
      if (i !== -1) rafs.splice(i, 1);
      if (!finished) fn(t);
    });
    rafs.push(id);
    return id;
  }

  function on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    listeners.push([target, type, handler, opts]);
  }

  function cleanup() {
    finished = true;
    rafs.forEach(function (id) { cancelAnimationFrame(id); });
    rafs.length = 0;
    timers.forEach(function (id) { clearTimeout(id); });
    timers.length = 0;
    listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    listeners.length = 0;
    observers.forEach(function (o) { o.disconnect(); });
    observers.length = 0;
    if (window.__preloaderFailsafe) {
      clearTimeout(window.__preloaderFailsafe);
      window.__preloaderFailsafe = null;
    }
  }

  /* ---------------------------------------------------------
     Multilingual glyph pool for the scramble effect
  --------------------------------------------------------- */
  var GLYPHS = (
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' +
    'абвгдеёжзийклмноп' +
    'αβγδεζηθικλμνξοπρστυφχψω' +
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
    '가나다라마바사아자차카타파하' +
    'ابجدهوزحطيكلمنهوي' +
    'अआइईउऊएऐओऔकखगघचछजझटठडढणतथदधन' +
    'அஆஇஈஉஊஎஏஐஒஓஔகஙசஞடணதநபமயரலவழளறனஜஷஸஹ' +
    'กขคฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ' +
    '0123456789' +
    '!<>-/[]{}=+*^#%&@$?'
  ).split('');

  function randGlyph() {
    return GLYPHS[(Math.random() * GLYPHS.length) | 0];
  }

  /* Scripts such as Tamil combine base letters with vowel signs, so a word is
     split into grapheme clusters — each cell stays one visual unit. */
  var segmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

  function splitGraphemes(text) {
    if (!segmenter) return Array.from(text);
    var out = [];
    var iterator = segmenter.segment(text)[Symbol.iterator]();
    var step = iterator.next();
    while (!step.done) {
      out.push(step.value.segment);
      step = iterator.next();
    }
    return out;
  }

  /* ---------------------------------------------------------
     Scramble: animate the word into `target`, one char at a time
  --------------------------------------------------------- */
  function scrambleTo(target, duration) {
    return new Promise(function (resolve) {
      var chars = splitGraphemes(target);

      // rebuild the word
      wordEl.textContent = '';
      var spans = chars.map(function (c, i) {
        var span = doc.createElement('span');
        span.className = 'preloader__char is-scrambling';
        span.style.setProperty('--i', i);
        span.textContent = c === ' ' ? '\u00A0' : randGlyph();
        wordEl.appendChild(span);
        return span;
      });

      // reduced motion: land on the final word instantly
      if (reducedMotion.matches || duration <= 0) {
        spans.forEach(function (span, i) {
          span.textContent = chars[i];
          span.classList.remove('is-scrambling');
          span.classList.add('is-locked');
        });
        resolve();
        return;
      }

      var start = performance.now();
      var lastTick = 0;
      var stagger = (duration * 0.5) / Math.max(chars.length, 1);

      function frame(now) {
        var elapsed = now - start;
        var tick = now - lastTick > 42;
        if (tick) lastTick = now;

        var allLocked = true;

        for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          if (span.dataset.locked) continue;

          if (elapsed >= duration * 0.35 + i * stagger) {
            span.dataset.locked = '1';
            span.textContent = chars[i];
            span.classList.remove('is-scrambling');
            span.classList.add('is-locked');
          } else {
            allLocked = false;
            if (tick && chars[i] !== ' ') span.textContent = randGlyph();
          }
        }

        if (allLocked) resolve();
        else loop(frame);
      }

      loop(frame);
    });
  }

  /* ---------------------------------------------------------
     Intro timeline: HELLO → greetings → HELLO
     Paced to finish exactly when the background video does
     (see applyVideoDuration) — the last HELLO locks in on the
     video's final frame, then the curtain lifts.
  --------------------------------------------------------- */
  var GREETINGS = ['BONJOUR', 'HOLA', 'CIAO', 'NAMASTE', 'வணக்கம்', 'こんにちは'];

  function runIntro() {
    // HELLO + first hold + greetings + beat + final HELLO
    var NATURAL = 900 + 350 + GREETINGS.length * (400 + 130) + 220 + 800;

    // spread the slack the video gives us across the holds so the
    // whole timeline lands on INTRO_TARGET
    function pace() {
      var extra = Math.max(0, INTRO_TARGET - NATURAL);
      return {
        firstHold: 350 + extra * 0.25,
        greetPause: 130 + (extra * 0.45) / GREETINGS.length,
        preFinal: 220 + extra * 0.1,
        finalHold: extra * 0.2
      };
    }

    // first resolve into HELLO immediately; the pacing waits for the
    // video's metadata so both timelines stay in lockstep
    var chain = Promise.resolve()
      .then(function () { return scrambleTo('HELLO', 900); })
      .then(function () { return durationReady; });

    if (!reducedMotion.matches) {
      chain = chain.then(function () {
        var p = pace();
        var inner = Promise.resolve()
          .then(function () { return wait(p.firstHold); });

        GREETINGS.forEach(function (word) {
          inner = inner
            .then(function () { return scrambleTo(word, 400); })
            .then(function () { return wait(p.greetPause); });
        });

        return inner
          .then(function () { return wait(p.preFinal); })
          .then(function () { return scrambleTo('HELLO', 800); })
          .then(function () { return wait(p.finalHold); });
      });
    } else {
      chain = chain.then(function () { return wait(200); });
    }

    return chain.catch(function () {
      // on any failure, just show the final word
      wordEl.textContent = '';
      var span = doc.createElement('span');
      span.className = 'preloader__char is-locked';
      span.textContent = 'HELLO';
      wordEl.appendChild(span);
    });
  }

  /* ---------------------------------------------------------
     Real loading progress (images + fonts), smoothed over time
  --------------------------------------------------------- */
  // The preloader lives as long as the background video: exit fires on
  // the video's final frame (the video pauses there while the curtain
  // lifts). Fallbacks below are used until <video> metadata arrives.
  var VIDEO_FALLBACK = 9.1;
  var MIN_DURATION = VIDEO_FALLBACK * 1000; // preloader lives at least this long
  var HARD_CAP = MIN_DURATION + 2500;       // force resources "done" after this
  var INTRO_TARGET = MIN_DURATION - 250;    // last HELLO locks in just before exit

  var markDurationReady;
  var durationReady = new Promise(function (resolve) { markDurationReady = resolve; });

  function applyVideoDuration(dur) {
    if (!dur || !isFinite(dur) || dur <= 0) return;
    MIN_DURATION = Math.round(dur * 1000);
    HARD_CAP = MIN_DURATION + 2500;
    INTRO_TARGET = MIN_DURATION - 250;
    markDurationReady();
  }
  var startTime = performance.now();
  var fontsReady = false;
  var windowLoaded = false;
  var resourcesDone = false;
  var introDone = false;
  var shownProgress = 0;

  if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) {
    doc.fonts.ready.then(function () { fontsReady = true; }, function () { fontsReady = true; });
  } else {
    fontsReady = true;
  }

  function markLoaded() { windowLoaded = true; }
  if (doc.readyState === 'complete') markLoaded();
  on(window, 'load', markLoaded, { once: true });

  function imageRatio() {
    var imgs = doc.images;
    if (!imgs || !imgs.length) return 1;
    var done = 0;
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete && imgs[i].naturalWidth > 0) done++;
    }
    return done / imgs.length;
  }

  function progressTick(now) {
    var elapsed = now - startTime;
    var ratio = imageRatio();

    if (windowLoaded && fontsReady && ratio === 1) resourcesDone = true;
    if (elapsed > HARD_CAP) resourcesDone = true;

    var target;
    if (resourcesDone) {
      target = 100;
    } else {
      var resourceScore = 0.6 * ratio + 0.4 * (fontsReady ? 1 : 0);
      var timeScore = Math.min(1, elapsed / MIN_DURATION);
      target = Math.min(95, 8 + 87 * Math.max(resourceScore * 0.75, timeScore * 0.9));
    }

    shownProgress += (target - shownProgress) * 0.075;
    if (target === 100 && shownProgress > 99.3) shownProgress = 100;

    if (shownProgress >= 100 && introDone) {
      exit();
      return;
    }
    loop(progressTick);
  }

  /* ---------------------------------------------------------
     Exit: disperse characters, lift the curtain
  --------------------------------------------------------- */
  function exit() {
    if (!preloader || preloader.dataset.exiting) return;
    preloader.dataset.exiting = '1';

    if (statusEl) statusEl.textContent = 'Website loaded';

    if (preloaderVideo) {
      try {
        preloaderVideo.pause();
        preloaderVideo.currentTime = 0;
      } catch (e) {}
    }

    var quick = reducedMotion.matches;

    // Add random rotation to each char for center collapse feel
    var charSpans = wordEl.querySelectorAll('.preloader__char');
    for (var ci = 0; ci < charSpans.length; ci++) {
      var r = (Math.random() - 0.5) * 60;
      charSpans[ci].style.setProperty('--r', r + 'deg');
    }

    wait(quick ? 200 : 350)
      .then(function () {
        preloader.classList.add('is-exiting');
        return wait(quick ? 150 : 650);
      })
      .then(function () {
        body.classList.remove('is-loading');
        body.classList.add('is-revealed');
        preloader.classList.add('is-hidden');
        return wait(quick ? 200 : 600);
      })
      .then(function () {
        if (preloaderVideo) {
          try {
            preloaderVideo.removeAttribute('src');
            var sources = preloaderVideo.querySelectorAll('source');
            for (var s = 0; s < sources.length; s++) sources[s].removeAttribute('src');
            preloaderVideo.load();
          } catch (e) {}
        }
        if (preloader.parentNode) preloader.parentNode.removeChild(preloader);
        preloader = null;
        preloaderVideo = null;
        initSite();
        cleanup();
      });
  }

  /* ---------------------------------------------------------
     Small helpers
  --------------------------------------------------------- */
  function slice(list) {
    return Array.prototype.slice.call(list || []);
  }

  function clamp01(n) {
    return Math.min(1, Math.max(0, n));
  }

  /* ---------------------------------------------------------
     Scroll driver: one rAF-throttled ticker for every
     scroll-driven effect added below
  --------------------------------------------------------- */
  function initScrollDriver() {
    var tasks = [];
    var ticking = false;

    function frame() {
      ticking = false;
      var vh = window.innerHeight || doc.documentElement.clientHeight;
      for (var i = 0; i < tasks.length; i++) tasks[i](vh);
    }

    function request() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(frame);
    }

    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request);
    window.addEventListener('load', request);

    return {
      add: function (task) {
        tasks.push(task);
        task(window.innerHeight || doc.documentElement.clientHeight);
        request();
      },
      request: request
    };
  }

  /* ---------------------------------------------------------
     Reveal on scroll (staggered via data-reveal-delay)
  --------------------------------------------------------- */
  function initReveal() {
    var targets = slice(doc.querySelectorAll('[data-reveal]'));
    if (!targets.length) return;

    if (reducedMotion.matches || !('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    try {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

      // note: deliberately NOT pushed to `observers` — the preloader
      // cleanup() disconnects everything in that list right after boot
      targets.forEach(function (el) { io.observe(el); });
    } catch (e) {
      targets.forEach(function (el) { el.classList.add('is-visible'); });
    }
  }

  /* ---------------------------------------------------------
     Chapters: scrolling zooms each section in and back out
     of frame, using the same language as the hero words
  --------------------------------------------------------- */
  function initScrollFx(driver) {
    var chapters = slice(doc.querySelectorAll('.chapter'));
    var inners = chapters.map(function (c) { return c.firstElementChild; });
    var bgImg = doc.querySelector('.chapters__bg-img');
    var chaptersWrap = doc.querySelector('.chapters');

    driver.add(function (vh) {
      if (reducedMotion.matches) return;

      // zoom each section as it travels through the viewport
      for (var i = 0; i < chapters.length; i++) {
        var inner = inners[i];
        if (!inner) continue;

        var rect = chapters[i].getBoundingClientRect();

        // how much of a screen this section covers right now (0 → 1).
        // Using coverage instead of raw distance keeps tall sections
        // fully readable on small screens, where a section can be taller
        // than the viewport.
        var shown = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
        var coverage = shown / Math.max(1, Math.min(rect.height, vh));

        var fade = clamp01((0.85 - coverage) / 0.85);
        var below = rect.top + rect.height / 2 >= vh / 2;
        var scale = below ? 1 - 0.16 * fade : 1 + 0.13 * fade;

        inner.style.opacity = (1 - fade).toFixed(3);
        inner.style.transform = 'scale(' + scale.toFixed(3) + ')';
        inner.style.filter = fade > 0.02 ? 'blur(' + (fade * 7).toFixed(2) + 'px)' : 'none';
      }

      // slow parallax on the shared background photo
      if (bgImg && chaptersWrap) {
        var total = chaptersWrap.offsetHeight - vh;
        var scrolled = clamp01(-chaptersWrap.getBoundingClientRect().top / (total || 1)) * total;
        var shift = Math.max(-50, Math.min(50, scrolled * -0.012));
        bgImg.style.transform = 'translate3d(0,' + shift.toFixed(1) + 'px,0)';
      }
    });
  }

  /* ---------------------------------------------------------
     Project category filter
  --------------------------------------------------------- */
  function initFilters() {
    var buttons = slice(doc.querySelectorAll('.filter'));
    var works = slice(doc.querySelectorAll('.work'));
    if (!buttons.length) return;

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cat = btn.getAttribute('data-filter') || 'all';

        buttons.forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
        });

        works.forEach(function (work) {
          var show = cat === 'all' || work.getAttribute('data-category') === cat;
          work.classList.toggle('is-hidden', !show);
        });
      });
    });
  }

  /* ---------------------------------------------------------
     Lightbox for the visual showcase (images and muted video)
  --------------------------------------------------------- */
  function initLightbox() {
    var box = doc.getElementById('lightbox');
    if (!box) return;

    var media = box.querySelector('.lightbox__media');
    var closeBtn = box.querySelector('.lightbox__close');
    var lastFocus = null;

    function open(src, alt, type) {
      if (!src) return;
      media.textContent = '';
      var node;

      if (type === 'video') {
        node = doc.createElement('video');
        node.src = src;
        node.muted = true;          // previews never play audio
        node.autoplay = true;
        node.loop = true;
        node.playsInline = true;
        node.setAttribute('controls', '');
      } else {
        node = doc.createElement('img');
        node.src = src;
        node.alt = alt || '';
      }

      media.appendChild(node);
      lastFocus = doc.activeElement;
      box.classList.add('is-open');
      box.setAttribute('aria-hidden', 'false');
      doc.documentElement.style.overflow = 'hidden';
      if (closeBtn) closeBtn.focus();
    }

    function close() {
      if (!box.classList.contains('is-open')) return;
      box.classList.remove('is-open');
      box.setAttribute('aria-hidden', 'true');
      doc.documentElement.style.overflow = '';
      media.textContent = '';
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    doc.addEventListener('click', function (e) {
      var t = e.target;
      if (closeBtn && (t === closeBtn || closeBtn.contains(t))) {
        close();
        return;
      }
      if (t === box) { close(); return; }
      if (!t || !t.closest) return;

      var trigger = t.closest('[data-lightbox]');
      if (!trigger) return;

      e.preventDefault();
      var inner = trigger.querySelector('img, video');
      var src = trigger.getAttribute('data-src') || (inner ? inner.getAttribute('src') : '');
      var alt = trigger.getAttribute('data-alt') || (inner ? inner.getAttribute('alt') : '');
      open(src, alt, trigger.getAttribute('data-type'));
    });

    doc.addEventListener('keydown', function (e) {
      if (!box.classList.contains('is-open')) return;

      if (e.key === 'Escape' || e.key === 'Esc') close();

      if (e.key === 'Tab') {
        var focusables = slice(box.querySelectorAll('button, [href], video, [tabindex]:not([tabindex="-1"])'));
        if (focusables.length < 2) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];

        if (e.shiftKey && doc.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && doc.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  /* ---------------------------------------------------------
     Poster marquee: the tile set is cloned once so the
     right-to-left loop can translate -50% seamlessly
  --------------------------------------------------------- */
  function initMarquee() {
    var gallery = doc.querySelector('.gallery[data-marquee]');
    if (!gallery) return;

    var track = gallery.querySelector('.gallery__track');
    if (!track) return;

    var originals = slice(track.children);
    for (var i = 0; i < originals.length; i++) {
      var clone = originals[i].cloneNode(true);

      // the duplicate is decoration: hidden from assistive tech
      // and out of the tab order, but still clickable
      clone.setAttribute('aria-hidden', 'true');
      if (clone.tagName === 'BUTTON') {
        clone.setAttribute('tabindex', '-1');
      }
      var focusable = clone.querySelectorAll('button, a, [tabindex]');
      for (var f = 0; f < focusable.length; f++) {
        focusable[f].setAttribute('tabindex', '-1');
      }

      track.appendChild(clone);
    }
  }

  /* ---------------------------------------------------------
     Footer social links: split each label into characters so
     the CSS lift-on-hover gets a per-char stagger. Falls back
     gracefully when GSAP/SplitText or motion preference says no.
  --------------------------------------------------------- */
  function initSplitText() {
    var labels = slice(doc.querySelectorAll('.footer__label'));
    if (!labels.length) return;

    var gsap = window.gsap;
    var SplitText = window.SplitText;

    // no library, or the user prefers less motion: leave the plain labels
    if (reducedMotion.matches || !gsap || !SplitText) return;

    try {
      new SplitText(labels, {
        type: 'chars',
        tag: 'span',
        propIndex: true
      });
    } catch (e) {
      // any failure just leaves the unsplit labels in place
    }
  }

  /* ---------------------------------------------------------
     Footer flower trail — as the cursor travels across the footer,
     flower images are stamped along its path, pushed by the cursor
     direction, and shrunk away. Coordinates are footer-relative and
     the layer is clipped, so nothing escapes the footer.
  --------------------------------------------------------- */
  function initFooterTrail() {
    var footer = doc.getElementById('footer');
    var trail = doc.getElementById('footerTrail');
    if (!footer || !trail) return;

    var gsap = window.gsap;
    if (!gsap || reducedMotion.matches) return;

    var images = slice(trail.querySelectorAll('.footer__image'));
    if (!images.length) return;

    var GAP = 60;          // travel distance before the next flower spawns
    var index = 0;
    var wrap = gsap.utils.wrap(0, images.length);

    var mousePos = { x: 0, y: 0 };
    var lastMousePos = { x: 0, y: 0 };
    var cachedPos = { x: 0, y: 0 };
    var isOver = false;

    function toFooterSpace(e) {
      var rect = footer.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    footer.addEventListener('pointerenter', function (e) {
      var p = toFooterSpace(e);
      lastMousePos = { x: p.x, y: p.y };
      mousePos = { x: p.x, y: p.y };
      cachedPos = { x: p.x, y: p.y };
      isOver = true;
    }, { passive: true });

    footer.addEventListener('pointermove', function (e) {
      var p = toFooterSpace(e);
      mousePos = { x: p.x, y: p.y };
      isOver = true;
    }, { passive: true });

    footer.addEventListener('pointerleave', function () {
      isOver = false;
    }, { passive: true });

    function animateImage() {
      var img = images[wrap(index)];
      var deltaX = mousePos.x - lastMousePos.x;
      var deltaY = mousePos.y - lastMousePos.y;

      gsap.killTweensOf(img);
      gsap.set(img, { clearProps: 'all' });
      gsap.set(img, {
        rotation: 'random(-20,20)',
        left: mousePos.x,
        top: mousePos.y,
        xPercent: -50,
        yPercent: -50
      });

      gsap
        .timeline()
        .to(img, { opacity: 1, duration: 0.2 })
        .to(img, {
          x: '+=' + deltaX,
          y: '+=' + deltaY,
          ease: 'power4.out',
          duration: 1
        }, '<')
        .to(img, {
          scale: 0,
          ease: 'expo.in',
          duration: 1
        });

      index++;
    }

    gsap.ticker.add(function trailTick() {
      if (!isOver) return;

      var travelDistance = Math.hypot(lastMousePos.x - mousePos.x, lastMousePos.y - mousePos.y);

      cachedPos.x = gsap.utils.interpolate(cachedPos.x || mousePos.x, mousePos.x, 0.1);
      cachedPos.y = gsap.utils.interpolate(cachedPos.y || mousePos.y, mousePos.y, 0.1);

      if (travelDistance > GAP) {
        animateImage();
        lastMousePos = { x: mousePos.x, y: mousePos.y };
      }
    });
  }

  /* ---------------------------------------------------------
     Site behaviour (set up after the reveal so the curtain
     lifts first)
  --------------------------------------------------------- */
  function initSite() {
    initReveal();

    var driver = initScrollDriver();
    initScrollFx(driver);

    initFilters();
    initLightbox();
    initMarquee();
    initSplitText();
    initFooterTrail();
  }

  /* ---------------------------------------------------------
     Boot
  --------------------------------------------------------- */
  if (!preloader || !wordEl) {
    // no preloader in the DOM — just reveal the site
    body.classList.remove('is-loading');
    body.classList.add('is-revealed');
    initSite();
    cleanup();
    return;
  }

  // kick off the typographic intro and the progress tracking together
  runIntro().then(function () {
    introDone = true;
    if (shownProgress >= 100) exit();
  });

  // Sync the timeline to the video's real length (metadata may already
  // be buffered); never let a slow/failed load block the intro.
  if (preloaderVideo) {
    if (preloaderVideo.readyState > 0) applyVideoDuration(preloaderVideo.duration);
    on(preloaderVideo, 'loadedmetadata', function () {
      applyVideoDuration(preloaderVideo.duration);
    });
  }
  later(function () { markDurationReady(); }, 1500);

  // Try to play video (in case autoplay didn't trigger immediately)
  if (preloaderVideo) {
    preloaderVideo.muted = true;
    preloaderVideo.playsInline = true;
    var playPromise = preloaderVideo.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function () {});
    }
  }

  loop(progressTick);

  // absolute last resort — if anything above stalls, show the site
  later(function () { exit(); }, HARD_CAP + 2000);
})();


/* ==================== WORK SHOWCASE CAROUSEL ==================== */
(function () {
  'use strict';

  var workShowcase = document.querySelector('.workshowcase');
  if (!workShowcase) return;

  var projects = {
    portfolios: [
      {
        name: 'Ones',
        url: 'https://imbhuvanesh.github.io/Ones/'
      },
      {
        name: 'Maddy',
        url: 'https://imbhuvanesh.github.io/Maddy/'
      },
      {
        name: 'Dev Portfolio',
        url: 'https://imbhuvanesh.github.io/dev/'
      }
    ],
    landing: [
      {
        name: 'Sunflower',
        url: 'https://imbhuvanesh.github.io/sunflower/'
      },
      {
        name: 'Ifixon',
        url: 'https://imbhuvanesh.github.io/ifixon/'
      },
      {
        name: 'DG',
        url: 'https://imbhuvanesh.github.io/DG/'
      },
      {
        name: 'Duck.app',
        url: 'https://imbhuvanesh.github.io/Duck.app/'
      },
      {
        name: 'Bluedangle.in',
        url: 'https://imbhuvanesh.github.io/Bluedangle.in/'
      }
    ]
  };

  var iframe = workShowcase.querySelector('.workshowcase__iframe');
  var fallback = workShowcase.querySelector('.workshowcase__fallback');
  var fallbackLink = workShowcase.querySelector('.workshowcase__fallback-link');
  var projectName = workShowcase.querySelector('.workshowcase__project-name');
  var prevBtn = workShowcase.querySelector('.workshowcase__prev');
  var nextBtn = workShowcase.querySelector('.workshowcase__next');
  var tabs = workShowcase.querySelectorAll('.workshowcase__tab');

  var currentCategory = 'portfolios';
  var currentIndex = 0;
  var isTransitioning = false;
  var xStart = 0;
  var yStart = 0;

  function getCurrentProjects() {
    return projects[currentCategory] || [];
  }

  function updateButtons() {
    var currentProjects = getCurrentProjects();
    if (prevBtn) prevBtn.disabled = currentIndex === 0;
    if (nextBtn) nextBtn.disabled = currentIndex === currentProjects.length - 1;
  }

  function showFallback(url) {
    if (iframe) {
      iframe.classList.add('is-hidden');
    }
    if (fallback && fallbackLink) {
      fallbackLink.href = url;
      fallback.hidden = false;
    }
  }

  function hideFallback() {
    if (fallback) {
      fallback.hidden = true;
    }
    if (iframe) {
      iframe.classList.remove('is-hidden');
    }
  }

  function loadProject(index, animate) {
    var currentProjects = getCurrentProjects();
    if (index < 0 || index >= currentProjects.length) return;
    if (isTransitioning) return;

    currentIndex = index;
    var project = currentProjects[currentIndex];

    if (projectName) {
      projectName.textContent = project.name;
      if (projectName.tagName === 'A') {
        projectName.href = project.url;
      }
    }

    if (animate && iframe) {
      iframe.classList.add('is-fading');
      isTransitioning = true;

      setTimeout(function () {
        hideFallback();
        iframe.src = project.url;
        iframe.title = 'Live preview of ' + project.name;
        if (fallbackLink) fallbackLink.href = project.url;

        setTimeout(function () {
          iframe.classList.remove('is-fading');
          isTransitioning = false;
        }, 50);
      }, 250);
    } else {
      hideFallback();
      if (iframe) {
        iframe.src = project.url;
        iframe.title = 'Live preview of ' + project.name;
      }
      if (fallbackLink) fallbackLink.href = project.url;
    }

    updateButtons();
  }

  function switchCategory(category) {
    if (currentCategory === category) return;
    currentCategory = category;
    currentIndex = 0;
    loadProject(0, true);

    tabs.forEach(function (tab) {
      var isActive = tab.getAttribute('data-category') === category;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      loadProject(currentIndex - 1, true);
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      loadProject(currentIndex + 1, true);
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchCategory(tab.getAttribute('data-category'));
    });
  });

  document.addEventListener('keydown', function (e) {
    if (!workShowcase.matches(':hover') && !workShowcase.contains(document.activeElement)) {
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      loadProject(currentIndex - 1, true);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      loadProject(currentIndex + 1, true);
    }
  });

  if (iframe) {
    iframe.addEventListener('load', function () {
    });

    iframe.addEventListener('error', function () {
      showFallback(iframe.src);
    });
  }

  workShowcase.addEventListener('touchstart', function (e) {
    var touch = e.changedTouches[0];
    xStart = touch.screenX;
    yStart = touch.screenY;
  }, { passive: true });

  workShowcase.addEventListener('touchend', function (e) {
    var touch = e.changedTouches[0];
    var xDiff = touch.screenX - xStart;
    var yDiff = touch.screenY - yStart;

    if (Math.abs(xDiff) > Math.abs(yDiff) && Math.abs(xDiff) > 50) {
      if (xDiff > 0) {
        loadProject(currentIndex - 1, true);
      } else {
        loadProject(currentIndex + 1, true);
      }
    }
  }, { passive: true });

  loadProject(0, false);
})();