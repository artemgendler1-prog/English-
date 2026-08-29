/* ===========================================================================
   engine.js — движок курса. Подключается классическим <script src>,
   не модулем: модули блокируются CORS при открытии из file://.

   Что здесь есть:
     EN.tts    — синтез речи (аудиодиктанты, регулировка скорости)
     EN.asr    — распознавание речи (проверка произношения)
     EN.store  — прогресс в localStorage + экспорт в JSON
     EN.srs    — интервальное повторение (SM-2 lite)
     EN.text   — нормализация и пословный разбор ответа
     EN.ui     — виджеты заданий
     EN.run    — раннер: прогоняет список заданий и собирает результат
   =========================================================================== */

(function (global) {
  'use strict';

  var EN = {};
  var STORE_KEY = 'english-course-v1';

  /* =========================================================================
     Синтез речи
     ------------------------------------------------------------------------
     Важно: TTS сам не редуцирует. Скормишь ему "want to" — произнесёт обе
     гласные. Поэтому в заданиях поле say содержит редуцированную орфографию
     ("whaddaya", "musta"), а ученик восстанавливает нормальную форму.
     ========================================================================= */

  EN.tts = (function () {
    var voices = [];
    var preferred = null;

    function load() {
      if (!global.speechSynthesis) return;
      voices = global.speechSynthesis.getVoices() || [];
      preferred = pick('en-US');
    }

    function pick(lang) {
      if (!voices.length) return null;
      var want = lang.toLowerCase();
      var en = voices.filter(function (v) {
        return (v.lang || '').toLowerCase().replace('_', '-').indexOf(want) === 0;
      });
      if (!en.length) {
        en = voices.filter(function (v) { return (v.lang || '').toLowerCase().indexOf('en') === 0; });
      }
      if (!en.length) return null;
      // Голоса Google/Microsoft Natural звучат заметно живее системных.
      var nice = en.filter(function (v) { return /google|natural|samantha|aria|jenny|ava/i.test(v.name); });
      return (nice[0] || en[0]);
    }

    if (global.speechSynthesis) {
      load();
      global.speechSynthesis.addEventListener('voiceschanged', load);
    }

    return {
      supported: function () { return !!global.speechSynthesis; },
      voices: function () { return voices; },
      voiceName: function () { return preferred ? preferred.name : '—'; },

      /** Произнести текст. Возвращает Promise, который резолвится по окончании. */
      speak: function (text, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
          if (!global.speechSynthesis) return resolve(false);
          try { global.speechSynthesis.cancel(); } catch (e) { /* no-op */ }
          if (!voices.length) load();
          var u = new global.SpeechSynthesisUtterance(text);
          u.lang = opts.lang || 'en-US';
          u.rate = opts.rate == null ? 1 : opts.rate;
          u.pitch = opts.pitch == null ? 1 : opts.pitch;
          var v = opts.lang ? pick(opts.lang) : preferred;
          if (v) u.voice = v;
          var done = false;
          function finish() { if (!done) { done = true; resolve(true); } }
          u.onend = finish;
          u.onerror = finish;
          // Chrome изредка теряет onend — подстраховываемся по длине текста.
          setTimeout(finish, 1200 + text.length * 90 / (u.rate || 1));
          global.speechSynthesis.speak(u);
        });
      },

      stop: function () {
        if (global.speechSynthesis) { try { global.speechSynthesis.cancel(); } catch (e) { /* no-op */ } }
      }
    };
  })();

  /* =========================================================================
     Распознавание речи — проверка того, что твою речь вообще разбирают.
     Chrome/Edge. Требует интернета. Из file:// может не запуститься —
     тогда везде есть фолбэк на ввод текстом.
     ========================================================================= */

  EN.asr = (function () {
    var Ctor = global.SpeechRecognition || global.webkitSpeechRecognition || null;

    return {
      supported: function () { return !!Ctor; },

      /**
       * Слушать микрофон. resolve({transcript, seconds, error}).
       * Никогда не reject — урок не должен ломаться из-за отказа микрофона.
       */
      listen: function (opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
          if (!Ctor) return resolve({ transcript: '', seconds: 0, error: 'unsupported' });

          var rec = new Ctor();
          rec.lang = opts.lang || 'en-US';
          rec.continuous = true;
          rec.interimResults = true;

          var finalText = '';
          var started = Date.now();
          var stopped = false;
          var timer = null;

          rec.onresult = function (ev) {
            var interim = '';
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
              var r = ev.results[i];
              if (r.isFinal) finalText += r[0].transcript + ' ';
              else interim += r[0].transcript;
            }
            if (opts.onPartial) opts.onPartial((finalText + interim).trim());
          };

          function done(err) {
            if (stopped) return;
            stopped = true;
            if (timer) clearTimeout(timer);
            try { rec.stop(); } catch (e) { /* no-op */ }
            resolve({
              transcript: finalText.trim(),
              seconds: Math.round((Date.now() - started) / 1000),
              error: err || null
            });
          }

          rec.onerror = function (ev) { done(ev.error || 'error'); };
          rec.onend = function () { done(null); };

          try { rec.start(); } catch (e) { return resolve({ transcript: '', seconds: 0, error: 'start-failed' }); }

          if (opts.seconds) timer = setTimeout(function () { done(null); }, opts.seconds * 1000);
          if (opts.handle) opts.handle({ stop: function () { done(null); } });
        });
      }
    };
  })();

  /* =========================================================================
     Текст: нормализация и пословный разбор
     ========================================================================= */

  EN.text = (function () {
    function norm(s) {
      return String(s == null ? '' : s)
        .toLowerCase()
        .replace(/[‘’ʼ`]/g, "'")   // кудрявые апострофы → прямой
        .replace(/[“”]/g, '"')
        .replace(/[^a-z0-9'\s]/g, ' ')            // пунктуация не считается ошибкой
        .replace(/\s+/g, ' ')
        .trim();
    }

    function words(s) {
      var n = norm(s);
      return n ? n.split(' ') : [];
    }

    /** Пословное сравнение через наибольшую общую подпоследовательность. */
    function diff(expected, actual) {
      var a = words(expected), b = words(actual);
      var n = a.length, m = b.length;
      var dp = [];
      for (var i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
      for (i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      var out = [], hits = 0;
      i = 0; j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ w: a[i], s: 'hit' }); hits++; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ w: a[i], s: 'miss' }); i++; }
        else { out.push({ w: b[j], s: 'add' }); j++; }
      }
      while (i < n) { out.push({ w: a[i++], s: 'miss' }); }
      while (j < m) { out.push({ w: b[j++], s: 'add' }); }
      return { tokens: out, hits: hits, total: n, ratio: n ? hits / n : 0 };
    }

    return { norm: norm, words: words, diff: diff };
  })();

  /* =========================================================================
     Хранилище прогресса
     ------------------------------------------------------------------------
     localStorage — рабочая копия в браузере. Источник правды —
     progress/profile.json в репозитории: только его видит преподаватель
     между сессиями. Поэтому после каждого занятия нужен экспорт.
     ========================================================================= */

  EN.store = (function () {
    function blank() {
      return {
        version: 1,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        placement: null,
        sessions: [],
        errors: [],
        srs: {}
      };
    }

    function read() {
      try {
        var raw = global.localStorage.getItem(STORE_KEY);
        if (!raw) return blank();
        var d = JSON.parse(raw);
        return (d && d.version) ? d : blank();
      } catch (e) {
        return blank();   // приватный режим, отключённые куки, повреждённый JSON
      }
    }

    function write(d) {
      d.updated = new Date().toISOString();
      try { global.localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) { /* no-op */ }
      return d;
    }

    return {
      get: read,
      save: function (mutator) { var d = read(); mutator(d); return write(d); },

      /** Записать прохождение урока и все допущенные в нём ошибки. */
      addSession: function (session) {
        return this.save(function (d) {
          d.sessions.push(session);
          (session.items || []).forEach(function (it) {
            if (it.correct === false) {
              d.errors.push({
                date: session.date,
                lesson: session.lesson,
                id: it.id,
                type: it.type,
                level: it.level || null,
                tags: it.tags || [],
                prompt: it.prompt || it.say || '',
                expected: it.expected || '',
                given: it.given || ''
              });
            }
          });
        });
      },

      setPlacement: function (p) { return this.save(function (d) { d.placement = p; }); },

      /** Ошибки, сгруппированные по тегу, — из этого строятся следующие уроки. */
      errorsByTag: function () {
        var d = read(), map = {};
        d.errors.forEach(function (e) {
          (e.tags && e.tags.length ? e.tags : ['untagged']).forEach(function (t) {
            (map[t] = map[t] || []).push(e);
          });
        });
        return map;
      },

      exportJSON: function () { return JSON.stringify(read(), null, 2); },

      importJSON: function (txt) {
        var d = JSON.parse(txt);
        if (!d || !d.version) throw new Error('Не похоже на файл прогресса.');
        return write(d);
      },

      reset: function () {
        try { global.localStorage.removeItem(STORE_KEY); } catch (e) { /* no-op */ }
        return blank();
      }
    };
  })();

  /* =========================================================================
     Интервальное повторение (SM-2 lite)
     Всё, что разобрано, возвращается через растущие промежутки.
     ========================================================================= */

  EN.srs = (function () {
    var DAY = 86400000;

    function today() { return new Date().toISOString().slice(0, 10); }

    return {
      /** quality: 0 — не вспомнил, 3 — с трудом, 5 — мгновенно. */
      review: function (id, quality, meta) {
        return EN.store.save(function (d) {
          var c = d.srs[id] || { ease: 2.5, interval: 0, reps: 0 };
          if (quality < 3) {
            c.reps = 0;
            c.interval = 1;
          } else {
            c.reps += 1;
            c.interval = c.reps === 1 ? 1 : (c.reps === 2 ? 3 : Math.round(c.interval * c.ease));
            c.ease = Math.max(1.3, c.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
          }
          c.last = today();
          c.due = new Date(Date.now() + c.interval * DAY).toISOString().slice(0, 10);
          if (meta) { c.tags = meta.tags || c.tags; c.text = meta.text || c.text; }
          d.srs[id] = c;
        });
      },

      due: function () {
        var d = EN.store.get(), t = today(), out = [];
        Object.keys(d.srs).forEach(function (id) {
          if (!d.srs[id].due || d.srs[id].due <= t) out.push(Object.assign({ id: id }, d.srs[id]));
        });
        return out;
      }
    };
  })();

  /* =========================================================================
     Мелочи
     ========================================================================= */

  /** Ссылка на YouGlish: услышать фразу у реальных носителей, а не у синтеза. */
  EN.youglish = function (phrase) {
    return 'https://youglish.com/pronounce/' + encodeURIComponent(phrase) + '/english/us';
  };

  EN.el = function (tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { if (k) e.appendChild(k); });
    return e;
  };

  EN.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* =========================================================================
     Виджеты заданий
     ------------------------------------------------------------------------
     Каждый виджет рисует себя в контейнер и зовёт done(result), где result —
     { correct, given, expected, ... }. Раннер сам решает, что дальше.
     ========================================================================= */

  EN.ui = {};

  /** Кнопки прослушивания: обычная скорость, медленно, повтор. */
  EN.ui.audioBar = function (say, opts) {
    opts = opts || {};
    var plays = { n: 0 };
    var row = EN.el('div', { class: 'btn-row' });

    var main = EN.el('button', {
      class: 'btn primary', type: 'button',
      html: '&#9658;&nbsp; Прослушать',
      onclick: function () { plays.n++; EN.tts.speak(say, { rate: opts.rate || 1 }); }
    });

    var slow = EN.el('button', {
      class: 'btn', type: 'button',
      html: '&#9209;&nbsp; Помедленнее',
      onclick: function () { plays.n++; EN.tts.speak(say, { rate: 0.7 }); }
    });

    row.appendChild(main);
    row.appendChild(slow);

    if (!EN.tts.supported()) {
      row.appendChild(EN.el('span', {
        class: 'tag', text: 'Синтез речи недоступен в этом браузере'
      }));
    }
    return { node: row, plays: plays, play: function () { main.click(); } };
  };

  /**
   * Диктант: слушаешь и записываешь, что услышал.
   * item: { id, level, say, expect, accept[], tags[], note }
   */
  EN.ui.dictation = function (host, item, done) {
    host.innerHTML = '';

    host.appendChild(EN.el('div', { class: 'eyebrow', text: 'Диктант' + (item.level ? ' · ' + item.level : '') }));
    host.appendChild(EN.el('p', { text: 'Прослушай и запиши обычной орфографией то, что услышал. Пунктуация не важна.' }));

    var audio = EN.ui.audioBar(item.say);
    host.appendChild(audio.node);

    var input = EN.el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Что ты услышал?' });
    host.appendChild(input);

    var fb = EN.el('div');
    host.appendChild(fb);

    var actions = EN.el('div', { class: 'btn-row' });
    var check = EN.el('button', { class: 'btn primary', type: 'button', text: 'Проверить' });
    actions.appendChild(check);
    host.appendChild(actions);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !check.disabled) { e.preventDefault(); check.click(); }
    });

    check.addEventListener('click', function () {
      check.disabled = true;
      input.disabled = true;

      var given = input.value;
      var best = EN.text.diff(item.expect, given);
      (item.accept || []).forEach(function (alt) {
        var d = EN.text.diff(alt, given);
        if (d.ratio > best.ratio) best = d;
      });

      var correct = best.ratio >= 0.85;

      var strip = best.tokens.map(function (t) {
        return '<span class="w ' + t.s + '">' + EN.esc(t.w) + '</span>';
      }).join(' ');

      var html = '<b>' + (correct ? 'Верно' : 'Не совсем') + ' — ' +
        Math.round(best.ratio * 100) + '% слов.</b><br>' + strip +
        '<br><br>Эталон: <b>' + EN.esc(item.expect) + '</b>';

      if (item.note) html += '<br><br>' + item.note;
      html += '<br><br><a href="' + EN.youglish(item.expect.split(' ').slice(0, 4).join(' ')) +
        '" target="_blank" rel="noopener">Послушать у настоящих носителей &rarr;</a>';

      fb.appendChild(EN.el('div', { class: 'feedback ' + (correct ? 'ok' : 'no'), html: html }));

      var next = EN.el('button', {
        class: 'btn primary', type: 'button', text: 'Дальше',
        onclick: function () {
          done({
            id: item.id, type: 'dictation', level: item.level, tags: item.tags || [],
            correct: correct, ratio: best.ratio, plays: audio.plays.n,
            say: item.say, expected: item.expect, given: given
          });
        }
      });
      actions.innerHTML = '';
      actions.appendChild(next);
      next.focus();
    });

    setTimeout(function () { input.focus(); }, 60);
  };

  /**
   * Выбор из вариантов. Если есть item.say — вопрос звучит, а не пишется.
   * item: { id, level, say?, text?, prompt, options[], answer, tags[], note }
   */
  EN.ui.choice = function (host, item, done) {
    host.innerHTML = '';

    host.appendChild(EN.el('div', { class: 'eyebrow', text: (item.eyebrow || 'Вопрос') + (item.level ? ' · ' + item.level : '') }));

    var audio = null;
    if (item.say) {
      host.appendChild(EN.el('p', { text: item.prompt || 'Прослушай и выбери верный вариант.' }));
      audio = EN.ui.audioBar(item.say);
      host.appendChild(audio.node);
    } else {
      if (item.text) host.appendChild(EN.el('p', { class: 'en', html: item.text }));
      host.appendChild(EN.el('p', { html: item.prompt || '' }));
    }

    var box = EN.el('div', { class: 'choices' });
    host.appendChild(box);
    var fb = EN.el('div');
    host.appendChild(fb);
    var actions = EN.el('div', { class: 'btn-row' });
    host.appendChild(actions);

    var buttons = item.options.map(function (opt, i) {
      var b = EN.el('button', { class: 'choice', type: 'button', text: opt });
      b.addEventListener('click', function () {
        buttons.forEach(function (x) { x.disabled = true; });
        var correct = i === item.answer;
        buttons[item.answer].classList.add('correct');
        if (!correct) b.classList.add('wrong');

        var html = '<b>' + (correct ? 'Верно.' : 'Мимо.') + '</b>';
        if (item.say) html += ' Прозвучало: <b>' + EN.esc(item.say) + '</b>';
        if (item.note) html += '<br><br>' + item.note;

        fb.appendChild(EN.el('div', { class: 'feedback ' + (correct ? 'ok' : 'no'), html: html }));

        var next = EN.el('button', {
          class: 'btn primary', type: 'button', text: 'Дальше',
          onclick: function () {
            done({
              id: item.id, type: item.kind || 'choice', level: item.level, tags: item.tags || [],
              correct: correct, plays: audio ? audio.plays.n : 0,
              say: item.say || '', prompt: item.prompt || item.text || '',
              expected: item.options[item.answer], given: opt
            });
          }
        });
        actions.appendChild(next);
        next.focus();
      });
      box.appendChild(b);
      return b;
    });
  };

  /**
   * Говорение: записываем речь, сверяем расшифровку с целевой фразой.
   * item: { id, prompt, target?, seconds }
   * Без микрофона деградирует в текстовое поле — задание не блокируется.
   */
  EN.ui.speak = function (host, item, done) {
    host.innerHTML = '';

    host.appendChild(EN.el('div', { class: 'eyebrow', text: 'Говорение' + (item.level ? ' · ' + item.level : '') }));
    host.appendChild(EN.el('p', { html: item.prompt }));
    if (item.target) {
      host.appendChild(EN.el('div', { class: 'card' }, [
        EN.el('p', { class: 'en', text: item.target }),
        EN.el('div', { class: 'btn-row' }, [
          EN.el('button', {
            class: 'btn', type: 'button', html: '&#9658;&nbsp; Образец',
            onclick: function () { EN.tts.speak(item.target, { rate: 1 }); }
          })
        ])
      ]));
    }

    var live = EN.el('div', { class: 'feedback info', text: 'Нажми «Говорить» и произнеси вслух.' });
    host.appendChild(live);

    var actions = EN.el('div', { class: 'btn-row' });
    host.appendChild(actions);
    var fb = EN.el('div');
    host.appendChild(fb);

    function finish(transcript, seconds, viaText) {
      var result = {
        id: item.id, type: 'speak', level: item.level, tags: item.tags || [],
        transcript: transcript, seconds: seconds, viaText: !!viaText,
        words: EN.text.words(transcript).length
      };

      if (item.target) {
        var d = EN.text.diff(item.target, transcript);
        result.ratio = d.ratio;
        result.correct = d.ratio >= 0.8;
        result.expected = item.target;
        result.given = transcript;
        var strip = d.tokens.map(function (t) { return '<span class="w ' + t.s + '">' + EN.esc(t.w) + '</span>'; }).join(' ');
        fb.appendChild(EN.el('div', {
          class: 'feedback ' + (result.correct ? 'ok' : 'no'),
          html: '<b>Распознано ' + Math.round(d.ratio * 100) + '% слов.</b><br>' + strip +
            '<br><br>Это проверка разборчивости, а не акцента: если машина не разобрала слово, ' +
            'носитель, скорее всего, тоже переспросит.'
        }));
      } else {
        result.correct = null;   // свободный ответ — оценивает преподаватель
        fb.appendChild(EN.el('div', {
          class: 'feedback info',
          html: '<b>Записано: ' + result.words + ' слов за ' + (seconds || 0) + ' с.</b><br>' +
            '<em>' + EN.esc(transcript || '(тишина)') + '</em><br><br>' +
            'Это свободный ответ — он уйдёт в отчёт, разберём его вместе.'
        }));
      }

      actions.innerHTML = '';
      var next = EN.el('button', {
        class: 'btn primary', type: 'button', text: 'Дальше',
        onclick: function () { done(result); }
      });
      actions.appendChild(next);
      next.focus();
    }

    function textFallback(reason) {
      live.className = 'feedback no';
      live.innerHTML = '<b>Микрофон недоступен' + (reason ? ' (' + EN.esc(reason) + ')' : '') + '.</b><br>' +
        'Произнеси фразу вслух сам, а затем впиши её сюда — задание засчитается.';
      var ta = EN.el('textarea', { placeholder: 'Напиши то, что произнёс вслух' });
      host.insertBefore(ta, actions);
      actions.innerHTML = '';
      actions.appendChild(EN.el('button', {
        class: 'btn primary', type: 'button', text: 'Готово',
        onclick: function () { finish(ta.value, 0, true); }
      }));
    }

    if (!EN.asr.supported()) { textFallback('нужен Chrome или Edge'); return; }

    var recBtn = EN.el('button', { class: 'btn primary big', type: 'button', html: '&#9679;&nbsp; Говорить' });
    var stopBtn = EN.el('button', { class: 'btn', type: 'button', text: 'Стоп', disabled: 'disabled' });
    actions.appendChild(recBtn);
    actions.appendChild(stopBtn);
    actions.appendChild(EN.el('button', {
      class: 'btn', type: 'button', text: 'Ввести текстом',
      onclick: function () { EN.tts.stop(); textFallback(null); }
    }));

    recBtn.addEventListener('click', function () {
      recBtn.disabled = true;
      stopBtn.disabled = false;
      live.className = 'feedback info';
      live.textContent = 'Слушаю…';

      var handle = null;
      EN.asr.listen({
        seconds: item.seconds || 45,
        onPartial: function (t) { live.textContent = t || 'Слушаю…'; },
        handle: function (h) { handle = h; }
      }).then(function (res) {
        stopBtn.disabled = true;
        if (res.error && !res.transcript) {
          textFallback(res.error === 'not-allowed' ? 'доступ к микрофону запрещён' : res.error);
          return;
        }
        finish(res.transcript, res.seconds, false);
      });

      stopBtn.onclick = function () { if (handle) handle.stop(); };
    });
  };

  /* =========================================================================
     Раннер — прогоняет список заданий и отдаёт итог
     ========================================================================= */

  EN.run = function (opts) {
    var host = typeof opts.host === 'string' ? document.querySelector(opts.host) : opts.host;
    var items = opts.items;
    var results = [];
    var idx = 0;

    var bar = EN.el('div', { class: 'progress' }, [EN.el('i', { style: 'width:0%' })]);
    var stage = EN.el('div');
    host.innerHTML = '';
    host.appendChild(bar);
    host.appendChild(stage);

    function step() {
      if (idx >= items.length) {
        bar.firstChild.style.width = '100%';
        opts.onFinish(results);
        return;
      }
      bar.firstChild.style.width = Math.round((idx / items.length) * 100) + '%';
      var item = items[idx];
      var widget = EN.ui[item.type === 'dictation' ? 'dictation' : (item.type === 'speak' ? 'speak' : 'choice')];

      stage.innerHTML = '';
      var counter = EN.el('div', {
        class: 'tag', text: 'Задание ' + (idx + 1) + ' из ' + items.length
      });
      stage.appendChild(counter);
      var slot = EN.el('div');
      stage.appendChild(slot);

      widget(slot, item, function (res) {
        results.push(res);
        idx++;
        if (opts.onStep) opts.onStep(res, idx, items.length);
        stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
        step();
      });
    }

    step();
  };

  /* =========================================================================
     Оценка уровня по CEFR
     Отдельно по каждому навыку: разрыв между ними — главный диагноз.
     Дескрипторы: https://www.coe.int/en/web/common-european-framework-reference-languages/table-2-cefr-3.3-common-reference-levels-self-assessment-grid
     ========================================================================= */

  EN.cefr = function (ratio) {
    if (ratio >= 0.90) return 'C1';
    if (ratio >= 0.75) return 'B2';
    if (ratio >= 0.55) return 'B1';
    if (ratio >= 0.35) return 'A2';
    return 'A1';
  };

  global.EN = EN;
})(window);
