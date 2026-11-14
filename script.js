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
    armFailsafe();
    markDurationReady();
  }

  /* The inline failsafe in index.html fires at 8s, but a 9s preloader
     video means the normal exit lands later than that. Re-arm it past the
     hard cap so it only ever rescues a genuinely broken load. */
  function armFailsafe() {
    if (window.__preloaderFailsafe) clearTimeout(window.__preloaderFailsafe);
    window.__preloaderFailsafe = (typeof window.__forceReveal === 'function')
      ? setTimeout(window.__forceReveal, HARD_CAP + 4000)
      : null;
  }
  var startTime = performance.now();
  var fontsReady = false;
  var windowLoaded = false;
  var resourcesDone = false;
  var introDone = false;
  var shownProgress = 0;
  var lastRatioCheck = -1000;
  var cachedRatio = 0;

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
    var total = 0;

    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (!img.complete && img.getAttribute('loading') === 'lazy') continue;
      total++;
      if (img.complete) done++;
    }

    return total ? done / total : 1;
  }

  function progressTick(now) {
    var elapsed = now - startTime;
    if (now - lastRatioCheck >= 150 || cachedRatio < 1) {
      if (now - lastRatioCheck >= 150) {
        cachedRatio = imageRatio();
        lastRatioCheck = now;
      }
    }
    var ratio = cachedRatio;

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
        initSiteOnce();
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
    var inners = chapters.map(function (c) { return c.querySelector('.chapter__inner') || c.firstElementChild; });
    var bgImg = doc.querySelector('.chapters__bg-img');
    var chaptersWrap = doc.querySelector('.chapters');
    var lastBgShift = null;

    driver.add(function (vh) {
      if (reducedMotion.matches) return;

      // Batch all DOM layout reads BEFORE mutating styles to avoid forced reflows
      var rects = new Array(chapters.length);
      var collapsed = new Array(chapters.length);
      for (var i = 0; i < chapters.length; i++) {
        collapsed[i] = chapters[i].id === 'about' && chapters[i].classList.contains('is-collapsed');
        rects[i] = collapsed[i] ? null : chapters[i].getBoundingClientRect();
      }
      var wrapTotal = chaptersWrap ? Math.max(1, chaptersWrap.offsetHeight - vh) : 1;
      var wrapTop = chaptersWrap ? chaptersWrap.getBoundingClientRect().top : 0;

      // Phase 2: write transforms & opacities in one pass
      for (var j = 0; j < chapters.length; j++) {
        var inner = inners[j];
        var rect = rects[j];
        if (!inner || !rect) continue;

        var shown = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
        var coverage = shown / Math.max(1, Math.min(rect.height, vh));

        var fade = clamp01((0.85 - coverage) / 0.85);
        var below = rect.top + rect.height / 2 >= vh / 2;
        var scale = below ? 1 - 0.14 * fade : 1 + 0.10 * fade;

        inner.style.opacity = (1 - fade).toFixed(3);
        inner.style.transform = 'scale(' + scale.toFixed(3) + ')';
      }

      if (bgImg && chaptersWrap) {
        var scrolled = clamp01(-wrapTop / wrapTotal) * wrapTotal;
        var shift = Math.max(-50, Math.min(50, scrolled * -0.012)).toFixed(1);
        if (shift !== lastBgShift) {
          lastBgShift = shift;
          bgImg.style.transform = 'translate3d(0,' + shift + 'px,0)';
        }
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

    var lowEnd = doc.documentElement.classList.contains('is-low-end');

    if (!reducedMotion.matches && !lowEnd) {
      var originals = slice(track.children);
      for (var i = 0; i < originals.length; i++) {
        var clone = originals[i].cloneNode(true);
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
    } else if (lowEnd) {
      gallery.style.overflowX = 'auto';
      track.style.animation = 'none';
    }

    gallery.classList.add('is-offscreen');

    var videos = slice(gallery.querySelectorAll('video[data-src]'));
    function setGalleryPlayback(active) {
      gallery.classList.toggle('is-offscreen', !active);
      for (var vi = 0; vi < videos.length; vi++) {
        var vid = videos[vi];
        if (active) {
          if (!vid.src && vid.dataset.src) {
            vid.src = vid.dataset.src;
          }
          if (!reducedMotion.matches && !lowEnd) {
            var p = vid.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }
        } else {
          try { vid.pause(); } catch (e) {}
        }
      }
    }

    if ('IntersectionObserver' in window) {
      var gIo = new IntersectionObserver(function (entries) {
        setGalleryPlayback(entries[0].isIntersecting);
      }, { rootMargin: '260px 0px' });
      gIo.observe(gallery);
    } else {
      setGalleryPlayback(true);
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

    var fine = window.matchMedia('(pointer: fine)').matches ||
               window.matchMedia('(any-pointer: fine)').matches;
    if (!fine) return;

    var gsap = window.gsap;
    if (!gsap || reducedMotion.matches) return;

    var images = slice(trail.querySelectorAll('.footer__image'));
    if (!images.length) return;

    var GAP = 60;
    var index = 0;
    var wrap = gsap.utils.wrap(0, images.length);
    var hydrated = false;
    var tickerActive = false;

    var mousePos = { x: 0, y: 0 };
    var lastMousePos = { x: 0, y: 0 };
    var isOver = false;
    var footerRect = null;

    function hydrateTrailImages() {
      if (hydrated) return;
      hydrated = true;
      for (var i = 0; i < images.length; i++) {
        (function (img) {
          var stem = img.dataset.stem;
          if (!stem || img.src) return;
          img.onerror = function () {
            img.onerror = null;
            img.src = 'flower/' + stem + '.png';
          };
          img.src = 'assets/flower/' + stem + '.webp';
        })(images[i]);
      }
    }

    function updateFooterRect() {
      footerRect = footer.getBoundingClientRect();
    }

    function toFooterSpace(e) {
      if (!footerRect) updateFooterRect();
      return { x: e.clientX - footerRect.left, y: e.clientY - footerRect.top };
    }

    function trailTick() {
      if (!isOver) return;
      var travelDistance = Math.hypot(lastMousePos.x - mousePos.x, lastMousePos.y - mousePos.y);
      if (travelDistance > GAP) {
        animateImage();
        lastMousePos = { x: mousePos.x, y: mousePos.y };
      }
    }

    function startTicker() {
      if (tickerActive) return;
      tickerActive = true;
      gsap.ticker.add(trailTick);
    }

    function stopTicker() {
      if (!tickerActive) return;
      tickerActive = false;
      gsap.ticker.remove(trailTick);
    }

    footer.addEventListener('pointerenter', function (e) {
      hydrateTrailImages();
      updateFooterRect();
      var p = toFooterSpace(e);
      lastMousePos = { x: p.x, y: p.y };
      mousePos = { x: p.x, y: p.y };
      isOver = true;
      startTicker();
    }, { passive: true });

    footer.addEventListener('pointermove', function (e) {
      var p = toFooterSpace(e);
      mousePos = { x: p.x, y: p.y };
      isOver = true;
    }, { passive: true });

    footer.addEventListener('pointerleave', function () {
      isOver = false;
      stopTicker();
    }, { passive: true });

    window.addEventListener('scroll', function () { footerRect = null; }, { passive: true });
    window.addEventListener('resize', function () { footerRect = null; }, { passive: true });

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
  }

  /* ---------------------------------------------------------
     Site behaviour (set up after the reveal so the curtain
     lifts first)
  --------------------------------------------------------- */
  /* ---------------------------------------------------------
     Cross-Platform Card Pull Engine (Mobile Touch + PC Mouse)
     Strictly hides card details on first launch.
     Provides smooth auto-pull peek teaser after hero effects.
     Supports bi-directional drag (drag up to expand, drag down
     to collapse), click/tap toggle, keyboard accessibility, and
     seamless scroll integration without layout shifts.
  --------------------------------------------------------- */
  var cardPullDismissed = false;
  var currentAutoLift = 0;

  function computeAdaptiveLift() {
    var vh = window.innerHeight || doc.documentElement.clientHeight || 740;
    var vw = window.innerWidth || doc.documentElement.clientWidth || 1024;
    var pullBtn = doc.getElementById('aboutCardPull');
    var pullBtnHeight = pullBtn ? Math.max(36, pullBtn.offsetHeight || 40) : 40;
    var clearanceRatio = vh < 660 ? 0.08 : (vw < 768 ? 0.062 : 0.052);
    var autoLift = Math.round(Math.max(36, Math.min(72, vh * clearanceRatio + pullBtnHeight * 0.25)));
    var peekHeight = Math.round(Math.max(82, Math.min(130, autoLift + Math.max(46, vh * 0.075))));
    return { autoLift: autoLift, peekHeight: peekHeight, pullBtnHeight: pullBtnHeight, vh: vh };
  }

  function publishBottomClearance(cardLiftPx) {
    var vh = window.innerHeight || doc.documentElement.clientHeight || 740;
    var pullBtn = doc.getElementById('aboutCardPull');
    var btnSize = pullBtn ? (pullBtn.offsetHeight || 40) : 40;
    var clearPx = Math.max(0, (cardLiftPx || 0) + btnSize + 18);
    var safePct = Math.max(68, Math.min(93, 100 - (clearPx / Math.max(1, vh)) * 100));
    try {
      window.dispatchEvent(new CustomEvent('bhuvy:bottomClearance', {
        detail: { pct: safePct, liftPx: cardLiftPx || 0 }
      }));
    } catch (e) {}
  }

  function dismissCardPull() {
    if (cardPullDismissed) return;
    cardPullDismissed = true;

    doc.body.classList.add('card-pull-dismissed');
    var about = doc.getElementById('about');
    if (about) {
      about.classList.remove('has-pull-hint');
      about.classList.remove('is-collapsed');
      about.classList.remove('is-pulled-up');
      about.classList.remove('is-dragging');
      about.style.removeProperty('--card-pull-y');
      about.style.removeProperty('--card-auto-lift');
      var inner = about.querySelector('.chapter__inner');
      if (inner) {
        inner.style.removeProperty('opacity');
        inner.style.removeProperty('visibility');
        inner.style.removeProperty('transform');
      }
    }

    var pull = doc.getElementById('aboutCardPull');
    if (pull) {
      pull.classList.add('is-dismissed');
      pull.classList.remove('is-nudging');
      pull.setAttribute('aria-expanded', 'true');
    }
    publishBottomClearance(0);
  }
  window.dismissCardPull = dismissCardPull;

  function showCardPullHint() {
    cardPullDismissed = false;
    doc.body.classList.remove('card-pull-dismissed');
    var about = doc.getElementById('about');
    if (about) {
      var dims = computeAdaptiveLift();
      currentAutoLift = 0;
      about.style.setProperty('--card-auto-lift', '0px');
      about.style.setProperty('--card-peek-height', dims.peekHeight + 'px');
      about.style.setProperty('--card-pull-y', '0px');
      about.classList.add('has-pull-hint');
      var pull = doc.getElementById('aboutCardPull') || about.querySelector('.card-pull');
      if (pull) {
        pull.classList.remove('is-dismissed');
        pull.classList.add('is-nudging');
        pull.setAttribute('aria-expanded', 'false');
        pull.setAttribute('aria-label', 'Pull to view details');
      }
      publishBottomClearance(0);
    }
  }

  function markHeroEffectsDone() {
    if (!doc.body.classList.contains('hero-effects-done')) {
      doc.body.classList.add('hero-effects-done');
    }

    var scrollY = window.pageYOffset || doc.documentElement.scrollTop;
    if (scrollY > 40) {
      dismissCardPull();
      return;
    }

    showCardPullHint();
  }
  window.markHeroEffectsDone = markHeroEffectsDone;

  function initCardPullEffect(driver) {
    var about = doc.getElementById('about');
    if (!about) return;

    var pull = doc.getElementById('aboutCardPull') || about.querySelector('.card-pull');
    var pullText = pull ? pull.querySelector('.card-pull__text') : null;

    var isPulledUp = false;
    var isDragging = false;
    var startY = 0;
    var startX = 0;
    var startTime = 0;
    var currentDiffY = 0;

    function getRestY() {
      return 0;
    }

    function getPeekY() {
      return -computeAdaptiveLift().peekHeight;
    }

    function syncAdaptiveDimensions() {
      if (cardPullDismissed || isDragging) return;
      var dims = computeAdaptiveLift();
      currentAutoLift = 0;
      about.style.setProperty('--card-auto-lift', '0px');
      about.style.setProperty('--card-peek-height', dims.peekHeight + 'px');
      if (isPulledUp) {
        about.style.setProperty('--card-pull-y', (-dims.peekHeight) + 'px');
        publishBottomClearance(dims.peekHeight);
      } else if (about.classList.contains('has-pull-hint')) {
        about.style.setProperty('--card-pull-y', '0px');
        publishBottomClearance(0);
      }
    }

    window.addEventListener('resize', syncAdaptiveDimensions, { passive: true });
    window.addEventListener('orientationchange', syncAdaptiveDimensions, { passive: true });

    function getSectionTop(el) {
      var top = 0;
      var node = el;
      while (node) {
        top += node.offsetTop || 0;
        node = node.offsetParent;
      }
      return top;
    }

    function expandFullStackCard() {
      isPulledUp = true;
      if (pull) pull.classList.remove('is-nudging');

      about.classList.remove('is-collapsed');
      about.classList.add('is-expanded', 'is-pulled-up');

      var reveals = about.querySelectorAll('[data-reveal]');
      for (var r = 0; r < reveals.length; r++) {
        reveals[r].classList.add('is-visible');
      }

      if (pull) {
        pull.setAttribute('aria-expanded', 'true');
        pull.setAttribute('aria-label', 'About section opened');
        if (pullText) pullText.textContent = 'Collapse';
      }

      var targetTop = getSectionTop(about);
      dismissCardPull();
      about.classList.add('is-expanded');

      window.scrollTo({
        top: targetTop,
        behavior: reducedMotion.matches ? 'auto' : 'smooth'
      });

      if (driver && driver.request) driver.request();
    }

    // Keep the pull button hidden until the hero flower reveal animation finishes
    if (driver && driver.add) {
      driver.add(function (vh) {
        var scrollY = window.pageYOffset || doc.documentElement.scrollTop;

        if (scrollY > 30 && about.classList.contains('is-collapsed')) {
          about.classList.remove('is-collapsed');
        }

        if (scrollY > vh * 0.35 && !cardPullDismissed && !isDragging) {
          dismissCardPull();
        } else if (scrollY <= vh * 0.15 && cardPullDismissed && !isDragging && doc.body.classList.contains('hero-effects-done')) {
          showCardPullHint();
        }
      });
    }

    if (pull) {
      function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;

        isDragging = true;
        startY = e.clientY;
        startX = e.clientX;
        startTime = Date.now();
        currentDiffY = 0;

        about.classList.add('is-dragging');
        if (pull.setPointerCapture) {
          try {
            pull.setPointerCapture(e.pointerId);
          } catch (err) {}
        }
      }

      function onPointerMove(e) {
        if (!isDragging) return;

        var dy = startY - e.clientY;
        var dx = Math.abs(startX - e.clientX);
        if (dx > Math.abs(dy) && Math.abs(dy) < 8) return;

        currentDiffY = dy;
        var vh = window.innerHeight || doc.documentElement.clientHeight || 800;
        var base = isPulledUp ? getPeekY() : getRestY();
        var nextY = Math.min(0, Math.max(-vh * 0.9, base - dy));
        about.style.setProperty('--card-pull-y', nextY + 'px');

        // Live preview reveal while dragging the full stack card upward
        if (dy > 36 && about.classList.contains('is-collapsed')) {
          about.classList.remove('is-collapsed');
          about.classList.add('is-expanded');
          var reveals = about.querySelectorAll('[data-reveal]');
          for (var r = 0; r < reveals.length; r++) {
            reveals[r].classList.add('is-visible');
          }
          if (driver && driver.request) driver.request();
        }
      }

      function onPointerUp(e) {
        if (!isDragging) return;
        isDragging = false;
        about.classList.remove('is-dragging');

        if (pull.releasePointerCapture) {
          try {
            pull.releasePointerCapture(e.pointerId);
          } catch (err) {}
        }

        var elapsed = Date.now() - startTime;
        var velocity = currentDiffY / (elapsed || 1);
        var distance = Math.abs(currentDiffY);

        // Tap/click or upward drag/flick directly pulls up the full container stack card
        if (distance < 8 || currentDiffY > 36 || velocity > 0.35) {
          lastPointerToggle = Date.now();
          expandFullStackCard();
          return;
        }

        // Did not reach upward threshold: spring back to resting hint state
        about.classList.remove('is-expanded');
        about.classList.add('is-collapsed');
        about.style.setProperty('--card-pull-y', getRestY() + 'px');
      }

      function onPointerCancel() {
        if (!isDragging) return;
        isDragging = false;
        about.classList.remove('is-dragging');
        about.style.setProperty('--card-pull-y', (isPulledUp ? getPeekY() : getRestY()) + 'px');
      }

      pull.addEventListener('pointerdown', onPointerDown);
      pull.addEventListener('pointermove', onPointerMove);
      pull.addEventListener('pointerup', onPointerUp);
      pull.addEventListener('pointercancel', onPointerCancel);

      var lastPointerToggle = 0;

      pull.addEventListener('click', function () {
        if (Date.now() - lastPointerToggle < 400) return;
        lastPointerToggle = Date.now();
        expandFullStackCard();
      });

      pull.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          lastPointerToggle = Date.now();
          expandFullStackCard();
        }
      });
    }
  }

  var siteInitialized = false;
  function initSite() {
    initReveal();

    var driver = initScrollDriver();
    initScrollFx(driver);
    initCardPullEffect(driver);

    initFilters();
    initLightbox();
    initMarquee();
    initSplitText();
    initFooterTrail();

    if (typeof window.startFloralHeroReveal === 'function') {
      window.startFloralHeroReveal();
    }
  }

  function initSiteOnce() {
    if (siteInitialized) return;
    siteInitialized = true;
    initSite();
  }
  window.__initSiteOnce = initSiteOnce;

  /* ---------------------------------------------------------
     Boot
  --------------------------------------------------------- */
  if (!preloader || !wordEl) {
    body.classList.remove('is-loading');
    body.classList.add('is-revealed');
    initSiteOnce();
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

  // own the failsafe from here on, sized to the video rather than a fixed 8s
  armFailsafe();

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
        name: 'DG',
        url: 'https://imbhuvanesh.github.io/DG/'
      },
      {
        name: 'Ifixon',
        url: 'https://imbhuvanesh.github.io/ifixon/'
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

  var currentCategory = 'landing';
  var currentIndex = 0;
  var fadeTimer = null;
  var swapTimer = null;
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

    hydrated = true;
    currentIndex = index;
    var project = currentProjects[currentIndex];

    // A newer request supersedes any fade/swap still in flight. Without
    // this, switching tabs (or clicking fast) during the 250ms fade was
    // dropped and left the frame showing the previous category.
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    if (swapTimer) {
      clearTimeout(swapTimer);
      swapTimer = null;
    }

    if (projectName) {
      projectName.textContent = project.name;
      if (projectName.tagName === 'A') {
        projectName.href = project.url;
      }
    }

    if (animate && iframe) {
      iframe.classList.add('is-fading');

      fadeTimer = setTimeout(function () {
        fadeTimer = null;
        hideFallback();
        iframe.src = project.url;
        iframe.title = 'Live preview of ' + project.name;
        if (fallbackLink) fallbackLink.href = project.url;

        swapTimer = setTimeout(function () {
          swapTimer = null;
          iframe.classList.remove('is-fading');
        }, 50);
      }, 250);
    } else {
      hideFallback();
      if (iframe) {
        iframe.classList.remove('is-fading');
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

  var hydrated = false;

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        io.disconnect();
        if (!hydrated) loadProject(0, false);
      }
    }, { rootMargin: '320px 0px' });
    io.observe(workShowcase);
  } else {
    loadProject(0, false);
  }
  updateButtons();
})();


/* ==================== SECTION-BY-SECTION UP BUTTON ==================== */
(function () {
  'use strict';

  var btn = document.getElementById('upBtn');
  if (!btn) return;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var SELECTOR = '.hero, .chapter, .footer';
  var cachedList = [];
  var cachedTops = [];
  var rafId = null;

  function docTop(el) {
    var top = 0;
    var node = el;
    while (node) {
      top += node.offsetTop || 0;
      node = node.offsetParent;
    }
    return top;
  }

  function measureSections() {
    cachedList = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
    cachedTops = new Array(cachedList.length);
    for (var i = 0; i < cachedList.length; i++) {
      cachedTops[i] = docTop(cachedList[i]);
    }
  }

  function getScrollY() {
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }

  function currentIndex() {
    if (!cachedList.length) measureSections();
    if (!cachedList.length) return -1;

    var vh = window.innerHeight || document.documentElement.clientHeight;
    var probe = getScrollY() + vh * 0.35;
    var index = 0;

    for (var i = 0; i < cachedTops.length; i++) {
      if (cachedTops[i] <= probe) index = i;
    }
    return index;
  }

  var anchor = -1;
  var settleTimer = null;

  function refresh() {
    rafId = null;
    var from = currentIndex();
    if (anchor !== -1 && anchor < from) from = anchor;
    btn.classList.toggle('is-visible', from > 0);
  }

  function requestRefresh() {
    if (rafId === null) rafId = requestAnimationFrame(refresh);
  }

  function goUp() {
    if (!cachedList.length) measureSections();
    var from = currentIndex();
    if (anchor !== -1 && anchor < from) from = anchor;
    if (from <= 0) return;

    anchor = from - 1;
    window.scrollTo({
      top: cachedTops[anchor] !== undefined ? cachedTops[anchor] : docTop(cachedList[anchor]),
      behavior: reducedMotion.matches ? 'auto' : 'smooth'
    });
    refresh();
  }

  btn.addEventListener('click', goUp);

  window.addEventListener('scroll', function () {
    requestRefresh();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(function () { anchor = -1; }, 140);
  }, { passive: true });

  window.addEventListener('resize', function () {
    measureSections();
    requestRefresh();
  }, { passive: true });

  window.addEventListener('load', function () {
    measureSections();
    refresh();
  });

  window.addEventListener('bhuvy:layoutchange', function () {
    measureSections();
    requestRefresh();
  });

  measureSections();
  refresh();
})();


/* ==================== MINIMAL FLORAL HERO REVEAL ====================
   Uses ONLY approved flower images: 1, 2, 4, 5, 6, 7, 8, 9
   Strictly excludes: 3, 10, 11, 12, 13, 14
   ==================================================================== */
(function () {
  'use strict';

  // Master Configuration
  const CONFIG = {
    initialDelay: 2000,         // Strict 2-second wait after hero reveal
    staggerInterval: 75,        // Lively, fluid progressive stagger delay between flowers (ms)
    jitter: 25,                 // Organic random variation (ms)
    minSizeDesktop: 205,        // Balanced medium size for desktop
    maxSizeDesktop: 265,        // Balanced medium size for desktop
    minSizeMobile: 125,         // Balanced medium size for mobile
    maxSizeMobile: 170,         // Balanced medium size for mobile
  };

  // ONLY approved flower stems (1, 2, 4, 5, 6, 7, 8, 9)
  // Strictly excluding 3, 10, 11, 12, 13, 14
  const APPROVED_FLOWER_STEMS = [
    'one',    // 1: White/Yellow Frangipani
    'two',    // 2: Pink Gerbera
    'four',   // 4: White/Yellow Daisy
    'five',   // 5: Pink/Yellow Plumeria
    'six',    // 6: Pink Lotus
    'seven',  // 7: Deep Red Rose
    'eight',  // 8: Blue Blossom
    'nine'    // 9: Bright Sunflower
  ];

  // Helper utilities
  const getRandom = (min, max) => Math.random() * (max - min) + min;
  const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const isMobile = () => window.innerWidth < 768;

  function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 48 stratified perimeter anchor sectors framing the hero with medium-sized blooms
  const STRATIFIED_ANCHORS = [
    // Top row: 10 flowers (y: 3% - 13%)
    { x: 4,  y: 7,  jx: 3, jy: 3, sizeMult: 1.08 },
    { x: 14, y: 6,  jx: 3, jy: 3, sizeMult: 1.02 },
    { x: 24, y: 6,  jx: 3, jy: 3, sizeMult: 1.04 },
    { x: 34, y: 5,  jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 44, y: 5,  jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 56, y: 5,  jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 66, y: 5,  jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 76, y: 6,  jx: 3, jy: 3, sizeMult: 1.04 },
    { x: 86, y: 6,  jx: 3, jy: 3, sizeMult: 1.02 },
    { x: 96, y: 7,  jx: 3, jy: 3, sizeMult: 1.08 },

    // Upper-mid row: 8 flowers (y: 17% - 27%)
    { x: 8,  y: 21, jx: 4, jy: 4, sizeMult: 1.06 },
    { x: 20, y: 19, jx: 4, jy: 3, sizeMult: 1.02 },
    { x: 32, y: 18, jx: 4, jy: 3, sizeMult: 1.00 },
    { x: 44, y: 17, jx: 4, jy: 3, sizeMult: 0.98 },
    { x: 56, y: 17, jx: 4, jy: 3, sizeMult: 0.98 },
    { x: 68, y: 18, jx: 4, jy: 3, sizeMult: 1.00 },
    { x: 80, y: 19, jx: 4, jy: 3, sizeMult: 1.02 },
    { x: 92, y: 21, jx: 4, jy: 4, sizeMult: 1.06 },

    // Left flank: 5 flowers (x: 4% - 15%, y: 33% - 67%)
    { x: 5,  y: 33, jx: 3, jy: 4, sizeMult: 1.08 },
    { x: 12, y: 42, jx: 3, jy: 4, sizeMult: 1.02 },
    { x: 5,  y: 50, jx: 3, jy: 4, sizeMult: 1.06 },
    { x: 12, y: 58, jx: 3, jy: 4, sizeMult: 1.02 },
    { x: 5,  y: 67, jx: 3, jy: 4, sizeMult: 1.08 },

    // Right flank: 5 flowers (x: 85% - 96%, y: 33% - 67%)
    { x: 95, y: 33, jx: 3, jy: 4, sizeMult: 1.08 },
    { x: 88, y: 42, jx: 3, jy: 4, sizeMult: 1.02 },
    { x: 95, y: 50, jx: 3, jy: 4, sizeMult: 1.06 },
    { x: 88, y: 58, jx: 3, jy: 4, sizeMult: 1.02 },
    { x: 95, y: 67, jx: 3, jy: 4, sizeMult: 1.08 },

    // Lower-mid row: 10 flowers (y: 73% - 83%)
    { x: 6,  y: 77, jx: 3, jy: 3, sizeMult: 1.06 },
    { x: 16, y: 78, jx: 3, jy: 3, sizeMult: 1.02 },
    { x: 26, y: 79, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 36, y: 80, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 46, y: 81, jx: 3, jy: 3, sizeMult: 0.98 },
    { x: 54, y: 81, jx: 3, jy: 3, sizeMult: 0.98 },
    { x: 64, y: 80, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 74, y: 79, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 84, y: 78, jx: 3, jy: 3, sizeMult: 1.02 },
    { x: 94, y: 77, jx: 3, jy: 3, sizeMult: 1.06 },

    // Bottom row: 10 flowers (y: 89% - 97%)
    { x: 4,  y: 93, jx: 3, jy: 3, sizeMult: 1.08 },
    { x: 14, y: 94, jx: 3, jy: 3, sizeMult: 1.02 },
    { x: 24, y: 95, jx: 3, jy: 3, sizeMult: 1.04 },
    { x: 34, y: 95, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 44, y: 96, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 56, y: 96, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 66, y: 95, jx: 3, jy: 3, sizeMult: 1.00 },
    { x: 76, y: 95, jx: 3, jy: 3, sizeMult: 1.04 },
    { x: 86, y: 94, jx: 3, jy: 3, sizeMult: 1.02 },
    { x: 96, y: 93, jx: 3, jy: 3, sizeMult: 1.08 },
  ];

  /**
   * Generates dynamic, organically jittered, non-overlapping coordinates.
   */
  function generateFlowerPositions() {
    const isMob = isMobile();
    const aspectWeight = isMob ? 1.05 : 1.35;
    const minDist = isMob ? 8.5 : 8.0;

    const positions = STRATIFIED_ANCHORS.map(a => ({
      x: Math.max(2.5, Math.min(97.5, a.x + getRandom(-a.jx, a.jx))),
      y: Math.max(2.5, Math.min(97.5, a.y + getRandom(-a.jy, a.jy))),
      sizeMult: a.sizeMult || 1.0,
    }));

    // Multi-pass relaxation to prevent overlaps
    for (let iter = 0; iter < 12; iter++) {
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const dx = positions[i].x - positions[j].x;
          const dy = (positions[i].y - positions[j].y) * aspectWeight;
          const d = Math.hypot(dx, dy);
          if (d < minDist && d > 0.001) {
            const push = (minDist - d) / 2;
            const nx = (dx / d) * push * 0.45;
            const ny = (dy / d) * push * 0.45;
            positions[i].x = Math.max(2, Math.min(98, positions[i].x + nx));
            positions[i].y = Math.max(2, Math.min(98, positions[i].y + ny / aspectWeight));
            positions[j].x = Math.max(2, Math.min(98, positions[j].x - nx));
            positions[j].y = Math.max(2, Math.min(98, positions[j].y - ny / aspectWeight));
          }
        }
      }
    }

    return positions;
  }

  /**
   * Assigns flower stems ensuring:
   * 1. Stems of the same type are placed far apart (no repetition/clustering).
   * 2. Stems are completely randomized and do not repeat the previous visit's placement.
   */
  function assignStemsToPositions(positions) {
    const stems = APPROVED_FLOWER_STEMS;
    const stemCounts = {};
    const quota = Math.ceil(positions.length / stems.length);
    stems.forEach(s => { stemCounts[s] = quota; });

    const placedByStem = {};
    stems.forEach(s => { placedByStem[s] = []; });

    let prevStems = [];
    try {
      const stored = sessionStorage.getItem('bhuvy_prev_flower_stems');
      if (stored) prevStems = JSON.parse(stored);
    } catch (e) {}

    const indices = shuffle(positions.map((_, i) => i));
    const assigned = new Array(positions.length);
    const aspectWeight = isMobile() ? 1.05 : 1.35;

    indices.forEach(idx => {
      const pos = positions[idx];
      const prevStemForThisSlot = prevStems && prevStems[idx];
      const candidates = [];

      shuffle(stems).forEach(stem => {
        if (stemCounts[stem] <= 0) return;
        const placed = placedByStem[stem];
        let dist = 9999;
        if (placed.length > 0) {
          dist = Math.min(...placed.map(p => Math.hypot(pos.x - p.x, (pos.y - p.y) * aspectWeight)));
        }
        // Penalize repeating the exact same flower in this position from previous reload
        if (prevStemForThisSlot && stem === prevStemForThisSlot) {
          dist *= 0.35;
        }
        candidates.push({ stem, dist });
      });

      candidates.sort((a, b) => b.dist - a.dist);
      const topDist = candidates[0].dist;
      const topPool = candidates.filter(c => c.dist >= topDist * 0.85);
      const chosen = topPool[getRandomInt(0, topPool.length - 1)].stem;

      assigned[idx] = chosen;
      stemCounts[chosen]--;
      placedByStem[chosen].push(pos);
    });

    try {
      sessionStorage.setItem('bhuvy_prev_flower_stems', JSON.stringify(assigned));
    } catch (e) {}

    return assigned;
  }

  /**
   * Creates a spatially distributed reveal sequence so sequential flower reveals
   * jump across disparate locations across the screen in an unpredictable, natural rhythm.
   */
  function createSpatialRevealSequence(elements) {
    const remaining = [...elements];
    const sequence = [];
    const aspectWeight = isMobile() ? 1.05 : 1.35;

    // Pick first flower at random
    const firstIdx = getRandomInt(0, remaining.length - 1);
    sequence.push(remaining.splice(firstIdx, 1)[0]);

    while (remaining.length > 0) {
      const last = sequence[sequence.length - 1];
      const lastX = parseFloat(last.style.left);
      const lastY = parseFloat(last.style.top);

      const scored = remaining.map((el, idx) => {
        const x = parseFloat(el.style.left);
        const y = parseFloat(el.style.top);
        const dist = Math.hypot(x - lastX, (y - lastY) * aspectWeight);
        return { el, idx, dist };
      });

      scored.sort((a, b) => b.dist - a.dist);
      // Select unpredictably from the farthest candidate flowers
      const poolSize = Math.max(1, Math.floor(scored.length * 0.45));
      const pick = scored[getRandomInt(0, poolSize - 1)];

      sequence.push(pick.el);
      remaining.splice(pick.idx, 1);
    }

    return sequence;
  }

  let flowerElements = [];

  /**
   * Builds the densely scattered flower elements across the entire webpage.
   * All flowers are initially completely hidden.
   */
  function createDenseFloralCanvas() {
    const container = document.getElementById('flowerContainer');
    if (!container) return;

    container.innerHTML = '';
    flowerElements = [];

    const positions = generateFlowerPositions();
    const assignedStems = assignStemsToPositions(positions);
    const frag = document.createDocumentFragment();

    positions.forEach((pos, idx) => {
      const stem = assignedStems[idx];

      // 1. Randomize rotation (-180deg to +180deg)
      const rotation = getRandomInt(-180, 180);
      const rotStart = rotation + getRandomInt(-30, 30);

      // 2. Flower size: prominently large so even the smaller flowers are bold & visible
      const minSize = isMobile() ? CONFIG.minSizeMobile : CONFIG.minSizeDesktop;
      const maxSize = isMobile() ? CONFIG.maxSizeMobile : CONFIG.maxSizeDesktop;
      const rawSize = getRandom(minSize, maxSize) * (pos.sizeMult || 1.05);
      const size = Math.round(rawSize);

      const opacity = getRandom(0.92, 1.0).toFixed(2);

      // Create DOM node
      const el = document.createElement('div');
      el.className = 'flower-node';
      el.style.left = `${pos.x.toFixed(1)}%`;
      el.style.top = `${pos.y.toFixed(1)}%`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.setProperty('--rot', `${rotation}deg`);
      el.style.setProperty('--rot-start', `${rotStart}deg`);
      el.style.setProperty('--final-opacity', opacity);

      const img = document.createElement('img');
      img.width = 500;
      img.height = 500;
      img.decoding = 'async';
      img.onerror = function () {
        img.onerror = null;
        img.src = `flower/${stem}.png`;
      };
      img.src = `assets/flower/${stem}.webp`;
      img.alt = 'Floral Bloom';
      img.draggable = false;

      el.appendChild(img);
      frag.appendChild(el);
      flowerElements.push(el);
    });

    container.appendChild(frag);
  }

  let dragInitialized = false;
  let highestZ = 30;

  /**
   * Simple, fluid drag interaction enabled on all flowers after
   * the preloader and bloom effects finish.
   */
  function enableFlowerDrag() {
    if (dragInitialized) return;
    dragInitialized = true;

    const container = document.getElementById('flowerContainer');

    flowerElements.forEach(el => {
      el.classList.add('is-draggable');
      el.setAttribute('data-draggable', 'true');

      let isDragging = false;
      let startPointerX = 0;
      let startPointerY = 0;
      let currentX = 0;
      let currentY = 0;

      function onPointerDown(e) {
        // Only primary button (left mouse) or touch/pen
        if (e.button !== undefined && e.button !== 0) return;

        isDragging = true;
        startPointerX = e.clientX;
        startPointerY = e.clientY;

        highestZ += 1;
        el.style.zIndex = highestZ;

        el.classList.add('is-dragging');
        if (container) container.classList.add('has-dragging');

        if (el.setPointerCapture) {
          try {
            el.setPointerCapture(e.pointerId);
          } catch (err) {}
        }

        e.preventDefault();
      }

      function onPointerMove(e) {
        if (!isDragging) return;

        const dx = e.clientX - startPointerX;
        const dy = e.clientY - startPointerY;

        const posX = currentX + dx;
        const posY = currentY + dy;

        el.style.setProperty('--drag-x', `${posX}px`);
        el.style.setProperty('--drag-y', `${posY}px`);
      }

      function onPointerUp(e) {
        if (!isDragging) return;
        isDragging = false;

        const dx = e.clientX - startPointerX;
        const dy = e.clientY - startPointerY;
        currentX += dx;
        currentY += dy;

        el.classList.remove('is-dragging');
        if (container) container.classList.remove('has-dragging');

        if (el.releasePointerCapture) {
          try {
            el.releasePointerCapture(e.pointerId);
          } catch (err) {}
        }
      }

      function onPointerCancel(e) {
        onPointerUp(e);
      }

      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('pointercancel', onPointerCancel);
    });
  }

  // Expose so it can also be manually triggered if desired
  window.enableFlowerDrag = enableFlowerDrag;

  /**
   * Orchestrates the reveal animation:
   * 1. Initially, keeps all flower images hidden.
   * 2. Waits 2 seconds after the hero is revealed.
   * 3. Gradually reveals the flowers one by one using smooth fade-in animations.
   * 4. Once revealed, they settle in place without floating.
   * 5. After the preloader and effects are finished, enables the simple drag interaction.
   */
  function startRevealAnimation() {
    flowerElements.forEach(el => {
      el.classList.remove('is-revealed');
    });

    // Spatially distributed sequence: reveals jump dynamically across disparate locations
    const sequence = createSpatialRevealSequence(flowerElements);

    let maxDelay = 0;

    // REQUIREMENT: Wait 2 seconds after page loads / reveal
    setTimeout(() => {
      // REQUIREMENT: Gradually reveal flowers one by one
      sequence.forEach((flower, index) => {
        const delay = (index * CONFIG.staggerInterval) + getRandom(0, CONFIG.jitter);
        if (delay > maxDelay) maxDelay = delay;

        setTimeout(() => {
          flower.classList.add('is-revealed');
        }, delay);
      });

      // Enable drag and smoothly reveal pull button ONLY after all flowers finish their bloom transition
      const isReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const cssBloomMs = isReduced ? 240 : 900;
      const remainingEffectsTime = maxDelay + cssBloomMs;
      setTimeout(() => {
        enableFlowerDrag();
        markHeroEffectsDone();
      }, remainingEffectsTime);
    }, CONFIG.initialDelay);
  }

  let animationTriggered = false;
  function triggerReveal() {
    if (animationTriggered) return;
    animationTriggered = true;
    startRevealAnimation();
  }

  // Expose globally so initSite() or preloader exit triggers it directly
  window.startFloralHeroReveal = triggerReveal;

  function init() {
    createDenseFloralCanvas();

    // Only start the effect once the preloader has lifted and the site is revealed.
    if (document.body.classList.contains('is-revealed') || !document.getElementById('preloader')) {
      triggerReveal();
    } else {
      const observer = new MutationObserver(() => {
        if (document.body.classList.contains('is-revealed')) {
          observer.disconnect();
          triggerReveal();
        }
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


/* ==================== HERO 3D PARALLAX ==================== */
(function () {
  'use strict';

  var hero = document.getElementById('hero');
  var scene = document.getElementById('heroScene') || (hero && hero.querySelector('.hero__scene'));
  if (!hero || !scene) return;

  var isHeroVisible = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      isHeroVisible = entries[0].isIntersecting;
      hero.classList.toggle('is-offscreen', !isHeroVisible);
      if (!isHeroVisible && typeof rest === 'function') rest();
    }, { threshold: 0 }).observe(hero);
  }

  var finePointer = window.matchMedia('(pointer: fine)').matches || window.matchMedia('(any-pointer: fine)').matches;
  if (!finePointer) return;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reducedMotion.matches) return;

  var nx = 0;
  var ny = 0;
  var tx = 0;
  var ty = 0;
  var raf = null;

  function write() {
    scene.style.setProperty('--hero-nx', nx.toFixed(3));
    scene.style.setProperty('--hero-ny', ny.toFixed(3));
  }

  function tick() {
    nx += (tx - nx) * 0.08;
    ny += (ty - ny) * 0.08;

    if (Math.abs(tx - nx) < 0.0005 && Math.abs(ty - ny) < 0.0005) {
      nx = tx;
      ny = ty;
      write();
      raf = null;
      return;
    }

    write();
    raf = requestAnimationFrame(tick);
  }

  function run() {
    if (raf === null) raf = requestAnimationFrame(tick);
  }

  function onMove(e) {
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;

    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    if (!vw || !vh) return;

    tx = Math.max(-1, Math.min(1, (e.clientX / vw) * 2 - 1));
    ty = Math.max(-1, Math.min(1, (e.clientY / vh) * 2 - 1));
    run();
  }

  function rest() {
    tx = 0;
    ty = 0;
    run();
  }

  function flatten() {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    scene.style.removeProperty('--hero-nx');
    scene.style.removeProperty('--hero-ny');
  }

  window.addEventListener('pointermove', function (e) {
    if (isHeroVisible) onMove(e);
  }, { passive: true });

  window.addEventListener('pointerleave', rest, { passive: true });
  document.addEventListener('mouseleave', rest, { passive: true });

  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener('change', function () {
      if (reducedMotion.matches) flatten();
    });
  }
})();


/* ==================== DESKTOP NOTICE ====================
   On phones and small tablets a glass toast suggests opening the
   site on a PC. It slides in once the preloader has lifted, hides
   itself again on wide viewports, and remembers a dismissal so it
   only ever nags once.
   ======================================================== */
(function () {
  'use strict';

  var notice = document.getElementById('pcNotice');
  if (!notice) return;

  var closeBtn = notice.querySelector('.pcnotice__close');
  var STORAGE_KEY = 'bhuvy:pcNoticeDismissed';
  /* the site reaches its full layout at 1100px — below that it is
     the cut-down version, which is what this toast is about */
  var small = window.matchMedia('(max-width: 1099px)');

  /* ?notice forces the toast on at any width so it can be checked on a
     desktop. In preview mode a dismissal is never remembered. */
  var preview = (function () {
    try {
      var q = new URLSearchParams(window.location.search);
      return q.has('notice') || q.has('preview-notice');
    } catch (err) {
      return false;
    }
  })();

  function isDismissed() {
    if (preview) return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (err) {
      return false; /* private mode / storage disabled */
    }
  }

  function rememberDismissal() {
    if (preview) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch (err) {
      /* nothing to do — the toast simply returns next visit */
    }
  }

  function show() {
    if (isDismissed() || (!preview && !small.matches)) return;
    notice.classList.add('is-visible');
  }

  function hide() {
    notice.classList.remove('is-visible');
  }

  function dismiss() {
    rememberDismissal();
    hide();
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      dismiss();
      closeBtn.blur(); /* the custom cursor keeps its own focus ring */
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && notice.classList.contains('is-visible')) {
      dismiss();
    }
  });

  /* wait for the preloader curtain to lift before sliding the toast in */
  function whenRevealed() {
    if (document.body.classList.contains('is-revealed')) {
      show();
      return;
    }
    if (!('MutationObserver' in window)) {
      window.setTimeout(show, 1200);
      return;
    }
    var observer = new MutationObserver(function () {
      if (!document.body.classList.contains('is-revealed')) return;
      observer.disconnect();
      show();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  whenRevealed();

  /* rotate a tablet or resize the window — the toast follows the viewport */
  function sync() {
    if (preview || small.matches) {
      show();
    } else {
      hide();
    }
  }

  if (typeof small.addEventListener === 'function') {
    small.addEventListener('change', sync);
  } else if (typeof small.addListener === 'function') {
    small.addListener(sync);
  }
})();


/* ==================== START A PROJECT FORM ====================
   Validates the enquiry locally, updates the price from the chosen
   project type, and opens WhatsApp with an encoded, pre-filled
   message. No backend, no storage — nothing is sent automatically.
   ============================================================ */
(function () {
  'use strict';

  var form = document.getElementById('projectForm');
  if (!form) return;

  var WA_NUMBER = '919944725379';
  var priceEl = document.getElementById('pfPrice');
  var choices = Array.prototype.slice.call(form.querySelectorAll('.pform__choice'));

  var fields = {
    name: form.querySelector('#pfName'),
    email: form.querySelector('#pfEmail'),
    phone: form.querySelector('#pfPhone'),
    description: form.querySelector('#pfDescription')
  };

  var errors = {
    name: form.querySelector('#pfNameError'),
    email: form.querySelector('#pfEmailError'),
    phone: form.querySelector('#pfPhoneError'),
    type: form.querySelector('#pfTypeError'),
    description: form.querySelector('#pfDescriptionError')
  };

  var typeGroup = form.querySelector('.pform__fieldset');

  function selectedType() {
    return form.querySelector('input[name="projectType"]:checked');
  }

  function priceFor(input) {
    return input ? input.getAttribute('data-price') : '';
  }

  /* ---------------------------------------------------------
     Price summary
  --------------------------------------------------------- */
  function updatePrice(animate) {
    if (!priceEl) return;

    var picked = selectedType();
    var value = picked ? priceFor(picked) : 'Select a project type';

    if (priceEl.textContent !== value) {
      priceEl.textContent = value;

      if (animate) {
        priceEl.classList.remove('is-updated');
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            priceEl.classList.add('is-updated');
          });
        });
      }
    }

    priceEl.classList.toggle('is-placeholder', !picked);
  }

  function syncChoices() {
    choices.forEach(function (choice) {
      var input = choice.querySelector('input');
      if (!input) return;
      choice.classList.toggle('is-checked', input.checked);
    });
  }

  /* ---------------------------------------------------------
     Inline errors
  --------------------------------------------------------- */
  function fieldWrap(key) {
    return key === 'type' ? typeGroup : fields[key].closest('.pform__field');
  }

  function setError(key, message) {
    var el = errors[key];
    var wrap = fieldWrap(key);

    if (el) el.textContent = message;
    if (wrap) wrap.classList.add('is-invalid');

    if (key !== 'type' && fields[key]) fields[key].setAttribute('aria-invalid', 'true');
    if (key === 'type') {
      Array.prototype.forEach.call(
        form.querySelectorAll('input[name="projectType"]'),
        function (input) { input.setAttribute('aria-invalid', 'true'); }
      );
    }
  }

  function clearError(key) {
    var el = errors[key];
    var wrap = fieldWrap(key);

    if (el) el.textContent = '';
    if (wrap) wrap.classList.remove('is-invalid');

    if (key !== 'type' && fields[key]) fields[key].removeAttribute('aria-invalid');
    if (key === 'type') {
      Array.prototype.forEach.call(
        form.querySelectorAll('input[name="projectType"]'),
        function (input) { input.removeAttribute('aria-invalid'); }
      );
    }
  }

  /* ---------------------------------------------------------
     Validation
  --------------------------------------------------------- */
  function isName(value) {
    return value.trim().length >= 2;
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
  }

  function isPhone(value) {
    var trimmed = value.trim();
    var digits = trimmed.replace(/\D/g, '');
    return /^[+()\d\s.-]+$/.test(trimmed) && digits.length >= 7 && digits.length <= 15;
  }

  function isDescription(value) {
    return value.trim().length >= 10;
  }

  function validate() {
    var firstInvalid = null;

    if (!isName(fields.name.value)) {
      setError('name', 'Please enter your name (at least 2 characters).');
      firstInvalid = firstInvalid || fields.name;
    } else {
      clearError('name');
    }

    if (!isEmail(fields.email.value)) {
      setError('email', 'Please enter a valid email address.');
      firstInvalid = firstInvalid || fields.email;
    } else {
      clearError('email');
    }

    if (!isPhone(fields.phone.value)) {
      setError('phone', 'Please enter a valid WhatsApp number (7–15 digits).');
      firstInvalid = firstInvalid || fields.phone;
    } else {
      clearError('phone');
    }

    if (!selectedType()) {
      setError('type', 'Please choose a project type.');
      firstInvalid = firstInvalid || form.querySelector('input[name="projectType"]');
    } else {
      clearError('type');
    }

    if (!isDescription(fields.description.value)) {
      setError('description', 'Please describe your project (at least 10 characters).');
      firstInvalid = firstInvalid || fields.description;
    } else {
      clearError('description');
    }

    if (firstInvalid) {
      firstInvalid.focus();
      if (firstInvalid.setSelectionRange && firstInvalid.type === 'tel') {
        try { firstInvalid.setSelectionRange(firstInvalid.value.length, firstInvalid.value.length); } catch (err) {}
      }
      return false;
    }

    return true;
  }

  /* ---------------------------------------------------------
     WhatsApp hand-off
  --------------------------------------------------------- */
  function buildMessage(picked) {
    return [
      'New Project Enquiry',
      '',
      'Client Details:',
      '- Name: ' + fields.name.value.trim(),
      '- Email: ' + fields.email.value.trim(),
      '- WhatsApp Number: ' + fields.phone.value.trim(),
      '',
      'Project Details:',
      '- Project Type: ' + picked.value,
      '- Estimated Price Range: ' + priceFor(picked),
      '- Project Description: ' + fields.description.value.trim(),
      '',
      'I’m interested in discussing this project further and would love to hear from you.'
    ].join('\n');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!validate()) return;

    var picked = selectedType();
    var url = 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(buildMessage(picked));

    /* opened straight from the submit handler so popup blockers allow it */
    var win = window.open(url, '_blank', 'noopener');
    if (!win) {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  });

  /* ---------------------------------------------------------
     Live feedback — never resets what the visitor typed
  --------------------------------------------------------- */
  Object.keys(fields).forEach(function (key) {
    var input = fields[key];
    if (!input) return;

    input.addEventListener('input', function () {
      if (!errors[key] || !errors[key].textContent) return;

      var valid = {
        name: isName,
        email: isEmail,
        phone: isPhone,
        description: isDescription
      }[key](input.value);

      if (valid) clearError(key);
    });
  });

  Array.prototype.forEach.call(
    form.querySelectorAll('input[name="projectType"]'),
    function (input) {
      input.addEventListener('change', function () {
        syncChoices();
        clearError('type');
        updatePrice(true);
      });

      input.addEventListener('focus', function () {
        var choice = input.closest('.pform__choice');
        if (!choice) return;
        try {
          if (input.matches(':focus-visible')) choice.classList.add('is-focus');
        } catch (err) {
          choice.classList.add('is-focus');
        }
      });

      input.addEventListener('blur', function () {
        var choice = input.closest('.pform__choice');
        if (choice) choice.classList.remove('is-focus');
      });
    }
  );

  /* initial paint */
  syncChoices();
  updatePrice(false);
})();
