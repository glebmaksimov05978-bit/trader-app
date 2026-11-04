/* Лендинг: движение и глубина без библиотек. Всё уважает «меньше движения» в системе. */
(function () {
  'use strict';
  var doc = document;
  var root = doc.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  // Название продукта в одном месте: поменять здесь — поменяется везде.
  var BRAND = 'TraderPro';
  [].forEach.call(doc.querySelectorAll('[data-brand]'), function (el) { el.textContent = BRAND; });
  doc.title = BRAND + ' — риск под контролем';

  // ---------- вход: включаем анимации после загрузки шрифтов/кадра ----------
  function start() { doc.body.classList.add('ready'); }
  if (doc.fonts && doc.fonts.ready) { Promise.race([doc.fonts.ready, new Promise(function (r) { setTimeout(r, 900); })]).then(function () { requestAnimationFrame(start); }); }
  else { requestAnimationFrame(start); }

  // ---------- слои, зависящие от прокрутки ----------
  var progress = doc.getElementById('progress');
  var nav = doc.getElementById('nav');
  var heroWord = doc.getElementById('heroWord');
  var hero = doc.getElementById('hero');
  var statement = doc.getElementById('statement');
  var steps = [].slice.call(doc.querySelectorAll('.step'));
  var scenes = [].slice.call(doc.querySelectorAll('.scene'));
  var dots = [].slice.call(doc.querySelectorAll('.stage-dots i'));

  // слова манифеста
  var words = [];
  if (statement) {
    var text = statement.textContent.trim();
    statement.textContent = '';
    text.split(/\s+/).forEach(function (w, i, arr) {
      var s = doc.createElement('span');
      s.className = 'w';
      s.textContent = w + (i < arr.length - 1 ? ' ' : '');
      statement.appendChild(s);
      words.push(s);
    });
  }

  var currentStep = -1;
  function setStep(i) {
    if (i === currentStep) return;
    currentStep = i;
    steps.forEach(function (el, k) { el.classList.toggle('is-on', k === i); });
    scenes.forEach(function (el, k) { el.classList.toggle('is-on', k === i); });
    dots.forEach(function (el, k) { el.classList.toggle('on', k === i); });
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var y = window.scrollY || root.scrollTop;
      var max = root.scrollHeight - window.innerHeight;
      if (progress) progress.style.setProperty('--p', max > 0 ? (y / max).toFixed(4) : 0);
      if (nav) nav.classList.toggle('scrolled', y > 40);
      if (heroWord && !reduced) heroWord.style.setProperty('--py', Math.min(y * 0.22, 220) + 'px');

      // манифест: слова зажигаются по мере прокрутки
      if (statement && words.length) {
        var r = statement.getBoundingClientRect();
        var vh = window.innerHeight;
        var p = clamp((vh * 0.9 - r.top) / (r.height + vh * 0.35), 0, 1);
        var n = Math.round(p * words.length);
        for (var i = 0; i < words.length; i++) words[i].classList.toggle('on', i < n);
      }

      // шаги «как это работает»: активен тот, чей центр ближе к середине экрана
      if (steps.length) {
        var mid = window.innerHeight * (window.innerWidth > 1000 ? 0.5 : 0.72), best = 0, bestD = 1e9;
        steps.forEach(function (el, k) {
          var b = el.getBoundingClientRect();
          var d = Math.abs(b.top + b.height / 2 - mid);
          if (d < bestD) { bestD = d; best = k; }
        });
        setStep(best);
      }
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  // на узком экране шаги идут подряд: активируем сцену по касанию/видимости
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) e.target.classList.add('in'); });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    [].forEach.call(doc.querySelectorAll('.card, .triple > div, .faq-list details, .final h2, .final .btn, .story-head, .features-head, .principles .big-serif, .manifesto .sub'), function (el, i) {
      el.classList.add('reveal');
      el.style.transitionDelay = ((i % 3) * 90) + 'ms';
      io.observe(el);
    });
  } else {
    [].forEach.call(doc.querySelectorAll('.reveal'), function (el) { el.classList.add('in'); });
  }

  // ---------- мышь: наклон устройства, плавающие карточки, свечение, подсветка карточек ----------
  var device = doc.getElementById('device');
  var floats = [].slice.call(doc.querySelectorAll('.float'));
  var glow = doc.getElementById('glow');
  if (fine && !reduced) {
    var tx = 0.5, ty = 0.4, cx = 0.5, cy = 0.4;
    window.addEventListener('mousemove', function (e) {
      tx = e.clientX / window.innerWidth; ty = e.clientY / window.innerHeight;
      if (glow) { glow.style.setProperty('--mx', e.clientX + 'px'); glow.style.setProperty('--my', e.clientY + 'px'); }
    }, { passive: true });
    (function loop() {
      cx += (tx - cx) * 0.06; cy += (ty - cy) * 0.06;
      if (device) {
        device.style.setProperty('--ry', (-13 + (cx - 0.5) * 9).toFixed(2) + 'deg');
        device.style.setProperty('--rx', (10 - (cy - 0.5) * 7).toFixed(2) + 'deg');
      }
      floats.forEach(function (f) {
        var d = Number(f.getAttribute('data-depth')) || 20;
        f.style.setProperty('--tx', ((cx - 0.5) * d).toFixed(1) + 'px');
        f.style.setProperty('--ty', ((cy - 0.5) * d).toFixed(1) + 'px');
      });
      requestAnimationFrame(loop);
    })();
    [].forEach.call(doc.querySelectorAll('.card'), function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--cx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--cy', (e.clientY - r.top) + 'px');
      });
    });
    // магнитные кнопки
    [].forEach.call(doc.querySelectorAll('.magnetic'), function (b) {
      b.addEventListener('mousemove', function (e) {
        var r = b.getBoundingClientRect();
        b.style.transform = 'translate(' + ((e.clientX - r.left - r.width / 2) * 0.18).toFixed(1) + 'px,' + ((e.clientY - r.top - r.height / 2) * 0.28).toFixed(1) + 'px)';
      });
      b.addEventListener('mouseleave', function () { b.style.transform = ''; });
    });
  }

  // ---------- живой график на фоне героя ----------
  var cv = doc.getElementById('heroChart');
  if (cv && cv.getContext) {
    var ctx = cv.getContext('2d');
    var W = 0, H = 0, dpr = 1, SLOT = 15, candles = [], price = 100, rnd = Math.random;
    var seed = 7; rnd = function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    var gauss = function () { return Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-9))) * Math.cos(2 * Math.PI * rnd()); };
    function make() {
      var o = price, c = o + gauss() * 0.9 - (o - 100) * 0.03;
      var h = Math.max(o, c) + Math.abs(gauss()) * 0.5, l = Math.min(o, c) - Math.abs(gauss()) * 0.5;
      price = c; return { o: o, c: c, h: h, l: l };
    }
    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var need = Math.ceil(W / SLOT) + 4;
      while (candles.length < need) candles.push(make());
    }
    var offset = 0, last = 0, visible = true;
    function draw(t) {
      ctx.clearRect(0, 0, W, H);
      var min = 1e9, max = -1e9, n = Math.ceil(W / SLOT) + 3, part = candles.slice(-n);
      part.forEach(function (c) { min = Math.min(min, c.l); max = Math.max(max, c.h); });
      var top = H * 0.2, bottom = H * 0.82, pad = (max - min) * 0.1 || 1;
      var y = function (v) { return bottom - ((v - (min - pad)) / (max - min + 2 * pad)) * (bottom - top); };
      var xr = W - 20;
      for (var i = 0; i < part.length; i++) {
        var c = part[i], x = xr - (part.length - 1 - i) * SLOT - offset;
        var up = c.c >= c.o; ctx.strokeStyle = ctx.fillStyle = up ? 'rgba(79,209,161,0.8)' : 'rgba(232,123,118,0.8)';
        ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
        var bt = y(Math.max(c.o, c.c)), bb = Math.max(bt + 2, y(Math.min(c.o, c.c)));
        ctx.fillRect(x - 4, bt, 8, bb - bt);
      }
    }
    function frame(t) {
      if (visible && !doc.hidden) {
        if (!last) last = t;
        var dt = Math.min(64, t - last); last = t;
        offset += dt * 0.012;
        if (offset >= SLOT) { offset -= SLOT; candles.push(make()); if (candles.length > 400) candles.shift(); }
        draw(t);
      } else last = 0;
      requestAnimationFrame(frame);
    }
    size(); window.addEventListener('resize', size);
    if (hero && 'IntersectionObserver' in window) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(hero);
    if (reduced) { draw(0); } else { requestAnimationFrame(frame); }
  }

  // ---------- для проверки: #y=1800 прокручивает страницу на нужную высоту ----------
  var m = /y=(\d+)/.exec(location.hash);
  if (m) { setTimeout(function () { window.scrollTo(0, Number(m[1])); onScroll(); }, 60); }
  onScroll();
})();
