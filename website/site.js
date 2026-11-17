// rikus.rocks — language switch, latest release, guide contents highlight. No dependencies.
(function () {
  'use strict';
  var REPO = 'rikusrocks/hqplayer-studio';
  var RELEASES = 'https://github.com/' + REPO + '/releases';
  var KEY = 'hqps.site.lang';

  // ---------- language ----------
  function store(get, v) {
    try {
      return get ? localStorage.getItem(KEY) : localStorage.setItem(KEY, v);
    } catch {
      return null;
    }
  }
  function pick() {
    var q = new URLSearchParams(location.search).get('lang');
    if (q === 'zh' || q === 'en') return q;
    var s = store(true);
    if (s === 'zh' || s === 'en') return s;
    var n = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
    return /^zh/i.test(n) ? 'zh' : 'en';
  }
  function apply(lang) {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    var t = document.querySelector('meta[name="title-' + lang + '"]');
    if (t) document.title = t.content;
    document.querySelectorAll('.lang').forEach(function (b) {
      b.textContent = lang === 'zh' ? 'English' : '中文';
      b.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到中文');
    });
  }
  var lang = pick();
  apply(lang);
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.lang');
    if (!b) return;
    lang = lang === 'zh' ? 'en' : 'zh';
    store(false, lang);
    apply(lang);
  });

  // ---------- latest release ----------
  function size(n) {
    return n >= 1048576
      ? (n / 1048576).toFixed(0) + ' MB'
      : Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function date(iso, l) {
    try {
      return new Date(iso).toLocaleDateString(l === 'zh' ? 'zh-CN' : 'en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return iso.slice(0, 10);
    }
  }
  function set(id, fn) {
    var el = document.getElementById(id);
    if (el) fn(el);
  }
  var box = document.getElementById('release');
  if (box) {
    fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=10', {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (list) {
        var rel = (list || []).filter(function (r) {
          return !r.draft;
        })[0];
        if (!rel) throw new Error('no release');
        var assets = rel.assets || [];
        function find(re) {
          return assets.filter(function (a) {
            return re.test(a.name);
          })[0];
        }
        var map = {
          'f-setup': find(/-setup-x64\.exe$/i),
          'f-portable': find(/-portable-x64\.exe$/i),
          'f-zip': find(/-win-x64\.zip$/i),
          'f-sums': find(/^SHA256SUMS/i),
        };
        Object.keys(map).forEach(function (id) {
          var a = map[id];
          set(id, function (el) {
            if (!a) {
              el.parentNode.style.display = id === 'f-setup' ? '' : 'none';
              return;
            }
            el.href = a.browser_download_url;
            var n = el.querySelector('.fname');
            if (n) n.textContent = a.name;
            var s = el.querySelector('.size');
            if (s) s.textContent = size(a.size);
          });
        });
        if (map['f-setup']) {
          document.querySelectorAll('[data-dl="setup"]').forEach(function (a) {
            a.href = map['f-setup'].browser_download_url;
          });
        }
        var v = (rel.tag_name || rel.name || '').replace(/^v/, '');
        document.querySelectorAll('[data-rel="version"]').forEach(function (el) {
          el.textContent = v;
        });
        set('rel-tag', function (el) {
          el.hidden = !rel.prerelease;
        });
        set('rel-date', function (el) {
          el.querySelector('[data-l="en"]').textContent =
            'Released ' + date(rel.published_at, 'en');
          el.querySelector('[data-l="zh"]').textContent = date(rel.published_at, 'zh') + ' 发布';
        });
        set('rel-notes', function (el) {
          el.href = rel.html_url;
        });
        box.classList.add('ready');
        set('rel-pending', function (el) {
          el.hidden = true;
        });
      })
      .catch(function () {
        // No published release yet, or GitHub's API rate limit: every link points to the Releases page.
        set('rel-pending', function (el) {
          el.hidden = false;
        });
        set('rel-files', function (el) {
          el.hidden = true;
        });
        document.querySelectorAll('[data-dl="setup"]').forEach(function (a) {
          a.href = RELEASES;
        });
      });
  }

  // ---------- guide: highlight the section in view ----------
  var links = document.querySelectorAll('.toc a[href^="#"]');
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) {
      byId[a.getAttribute('href').slice(1)] = a;
    });
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          links.forEach(function (a) {
            a.classList.remove('on');
          });
          var a = byId[en.target.id];
          if (a) a.classList.add('on');
        });
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    Object.keys(byId).forEach(function (id) {
      var s = document.getElementById(id);
      if (s) io.observe(s);
    });
  }
})();
