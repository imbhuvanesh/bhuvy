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
  --------------------------------------------------------- */
  var GREETINGS = ['BONJOUR', 'HOLA', 'CIAO', 'NAMASTE', 'வணக்கம்', 'こんにちは'];

  function runIntro() {
    var chain = Promise.resolve();

    // first resolve into HELLO
    chain = chain
      .then(function () { return scrambleTo('HELLO', 900); })
      .then(function () { return wait(reducedMotion.matches ? 200 : 350); });

    if (!reducedMotion.matches) {
      GREETINGS.forEach(function (word) {
        chain = chain
          .then(function () { return scrambleTo(word, 400); })
          .then(function () { return wait(130); });
      });
      chain = chain
        .then(function () { return wait(220); })
        .then(function () { return scrambleTo('HELLO', 800); });
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
  var MIN_DURATION = 3800;   // preloader lives at least this long
  var HARD_CAP = 6200;       // force resources "done" after this
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

    var quick = reducedMotion.matches;

    wait(quick ? 250 : 450)
      .then(function () {
        preloader.classList.add('is-exiting');
        return wait(quick ? 150 : 720);
      })
      .then(function () {
        body.classList.remove('is-loading');
        body.classList.add('is-revealed');
        preloader.classList.add('is-hidden');
        return wait(quick ? 250 : 1100);
      })
      .then(function () {
        if (preloader.parentNode) preloader.parentNode.removeChild(preloader);
        preloader = null;
        initSite();
        cleanup();
      });
  }

  /* ---------------------------------------------------------
     Site behaviour (set up after the reveal so the hero
     animates in as the curtain lifts)
  --------------------------------------------------------- */
  function initSite() {
    // staggered reveal-on-scroll
    var targets = doc.querySelectorAll('[data-reveal]');
    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

    observers.push(io);
    targets.forEach(function (el) { io.observe(el); });
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

  loop(progressTick);

  // absolute last resort — if anything above stalls, show the site
  later(function () { exit(); }, HARD_CAP + 2000);
})();
