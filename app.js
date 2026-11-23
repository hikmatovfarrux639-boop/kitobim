// ==================== STATE & STORAGE ====================
const SETTINGS_KEY = 'kitobim_settings_v2';
const ACTIVE_BOOK_KEY = 'kitobim_active_book_v1';
const DB_NAME = 'kitobim_user_books_db';
const DB_STORE = 'books';
const COL_GAP = 32;

const defaultSettings = {
  fontSize: 20,
  lineHeight: 1.42,
  fontFamily: 'serif',
  theme: 'amoled',
};

let settings = { ...defaultSettings, ...loadJson(SETTINGS_KEY, {}) };
let builtInCatalog = [];
let bookCache = new Map();
let currentBook = null;
let currentChapterIdx = 0;
let currentChapPageIdx = 0;
let currentChapTotalPages = 1;
let colW = 320;
let colH = 600;
let chapterCharCounts = [];
let chapterEstPages = [];
let chapterStartGlobal = [];
let totalGlobalPages = 1;

// ==================== DOM ELEMENTS ====================
const readerView = document.getElementById('readerView');
const libraryView = document.getElementById('libraryView');
const pageColumnMask = document.getElementById('pageColumnMask');
const pageContent = document.getElementById('pageContent');
const pageCounterText = document.getElementById('pageCounterText');

const readerHud = document.getElementById('readerHud');
const hudBookTitle = document.getElementById('hudBookTitle');
const hudChapterTitle = document.getElementById('hudChapterTitle');
const hudPageInfo = document.getElementById('hudPageInfo');
const hudPercentInfo = document.getElementById('hudPercentInfo');
const pageSlider = document.getElementById('pageSlider');
const fontSizeLabel = document.getElementById('fontSizeLabel');
const btnToggleBookmark = document.getElementById('btnToggleBookmark');

const tocDrawer = document.getElementById('tocDrawer');
const tocList = document.getElementById('tocList');
const bookmarksList = document.getElementById('bookmarksList');
const tabBtnChapters = document.getElementById('tabBtnChapters');
const tabBtnBookmarks = document.getElementById('tabBtnBookmarks');

const booksGrid = document.getElementById('booksGrid');
const importStatus = document.getElementById('importStatus');
const fileInput = document.getElementById('fileInput');
const pasteModal = document.getElementById('pasteModal');
const pasteTitleInput = document.getElementById('pasteTitleInput');
const pasteTextarea = document.getElementById('pasteTextarea');

// ==================== HELPERS & FAST SOFT-HYPHENATOR ====================
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const UZ_RU_VOWELS = new Set([
  'a', 'e', 'i', 'o', 'u',
  'а', 'е', 'ё', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я', 'ў',
]);
const SHY = '\u00AD';
const wordHyphCache = new Map();

function hyphenateWord(word) {
  if (word.length < 5) return word;
  const cached = wordHyphCache.get(word);
  if (cached !== undefined) return cached;

  const m = word.match(
    /^([^A-Za-z\u0400-\u04FF\u2018\u2019\u02BB']*)([A-Za-z\u0400-\u04FF\u2018\u2019\u02BB'-]+)([^A-Za-z\u0400-\u04FF\u2018\u2019\u02BB']*)$/
  );
  if (!m) {
    wordHyphCache.set(word, word);
    return word;
  }
  const [, pre, core, post] = m;
  if (core.includes('-')) {
    const res = pre + core.split('-').map(hyphenateWord).join('-') + post;
    wordHyphCache.set(word, res);
    return res;
  }

  const tokens = [];
  const lower = core.toLowerCase();
  let i = 0;
  while (i < core.length) {
    const two = lower.slice(i, i + 2);
    const nextChar = core[i + 1];
    if (
      (lower[i] === 'o' || lower[i] === 'g') &&
      (nextChar === '\u2018' || nextChar === "'" || nextChar === '\u02BB')
    ) {
      tokens.push({ t: core.slice(i, i + 2), v: lower[i] === 'o' });
      i += 2;
    } else if (two === 'sh' || two === 'ch' || two === 'ng') {
      tokens.push({ t: core.slice(i, i + 2), v: false });
      i += 2;
    } else if (
      (core[i] === '\u2019' || core[i] === "'" || lower[i] === 'ъ' || lower[i] === 'ь') &&
      tokens.length > 0
    ) {
      tokens[tokens.length - 1].t += core[i];
      i += 1;
    } else {
      tokens.push({ t: core[i], v: UZ_RU_VOWELS.has(lower[i]) });
      i += 1;
    }
  }

  if (tokens.length < 4) {
    wordHyphCache.set(word, word);
    return word;
  }

  const vIdx = [];
  for (let idx = 0; idx < tokens.length; idx++) {
    if (tokens[idx].v) vIdx.push(idx);
  }
  if (vIdx.length < 2) {
    wordHyphCache.set(word, word);
    return word;
  }

  const breaks = new Set();
  for (let k = 0; k < vIdx.length - 1; k++) {
    const v1 = vIdx[k];
    const v2 = vIdx[k + 1];
    const cCount = v2 - v1 - 1;
    let splitAfter;
    if (cCount <= 1) splitAfter = v1;
    else if (cCount === 2) splitAfter = v1 + 1;
    else splitAfter = v1 + 2;

    if (splitAfter >= 1 && splitAfter <= tokens.length - 3) {
      breaks.add(splitAfter);
    }
  }

  let out = '';
  for (let idx = 0; idx < tokens.length; idx++) {
    out += tokens[idx].t;
    if (breaks.has(idx)) out += SHY;
  }
  const result = pre + out + post;
  wordHyphCache.set(word, result);
  return result;
}

function hyphenateText(text) {
  return String(text)
    .split(/(\s+)/)
    .map((part) => (/\s/.test(part) ? part : hyphenateWord(part)))
    .join('');
}

function formatInline(str, useHyphens = true) {
  const src = useHyphens ? hyphenateText(str) : String(str);
  let s = escapeHtml(src);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  return s;
}

function getChapterHtml(chapter) {
  if (chapter._cachedHtml) return chapter._cachedHtml;
  const parts = [`<h1 class="reader-ch-title" data-b="-1">${formatInline(chapter.title, false)}</h1>`];
  const blocks = chapter.blocks || [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.type) {
      case 'subtitle':
        parts.push(`<div class="reader-ch-sub" data-b="${i}">${formatInline(b.text, false)}</div>`);
        break;
      case 'h2':
        parts.push(`<h2 class="reader-h2" data-b="${i}">${formatInline(b.text, false)}</h2>`);
        break;
      case 'hr':
        parts.push(`<div class="reader-hr" data-b="${i}">&#8226;&nbsp;&nbsp;&#8226;&nbsp;&nbsp;&#8226;</div>`);
        break;
      case 'li':
        parts.push(`<p class="reader-li" data-b="${i}">${formatInline(b.text, true)}</p>`);
        break;
      case 'p':
      default: {
        const isDlg = (b.text || '').startsWith('—') || (b.text || '').startsWith('– ');
        parts.push(
          `<p class="${isDlg ? 'dialogue' : ''}" data-b="${i}">${formatInline(b.text || '', true)}</p>`
        );
        break;
      }
    }
  }
  parts.push('<span id="colEndSentinel" class="col-end-sentinel">&nbsp;</span>');
  chapter._cachedHtml = parts.join('');
  return chapter._cachedHtml;
}

// ==================== INDEXEDDB FOR USER BOOKS ====================
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllUserBooks() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getUserBook(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function saveUserBook(book) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteUserBook(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ==================== INSTANT NATIVE MULTI-COLUMN ENGINE (< 5ms) ====================
function computeBookCharCounts(book) {
  chapterCharCounts = book.chapters.map((ch) => {
    let n = (ch.title || '').length;
    for (const b of ch.blocks || []) {
      n += (b.text || '').length + 12;
    }
    return Math.max(100, n);
  });
}

function updateGlobalPageEstimates() {
  if (!currentBook) return;
  const curChars = chapterCharCounts[currentChapterIdx] || 1000;
  const charsPerPage = Math.max(180, curChars / Math.max(1, currentChapTotalPages));

  let running = 0;
  chapterEstPages = [];
  chapterStartGlobal = [];
  for (let i = 0; i < currentBook.chapters.length; i++) {
    chapterStartGlobal.push(running);
    const est =
      i === currentChapterIdx
        ? currentChapTotalPages
        : Math.max(1, Math.round(chapterCharCounts[i] / charsPerPage));
    chapterEstPages.push(est);
    running += est;
  }
  totalGlobalPages = Math.max(1, running);
}

function measureCurrentChapterLayout(preserveRatio = null) {
  if (!currentBook) return;

  // Exact integer geometry so columns NEVER drift even by 0.5px
  const rect = pageColumnMask.getBoundingClientRect();
  colW = Math.max(180, Math.floor(rect.width));
  colH = Math.max(200, Math.floor(rect.height));

  pageContent.style.setProperty('--col-w', `${colW}px`);
  pageContent.style.setProperty('--col-h', `${colH}px`);
  pageContent.style.setProperty('--col-gap', `${COL_GAP}px`);

  // Temporarily reset transform to read exact column coordinates
  pageContent.style.transform = 'translate3d(0, 0, 0)';

  const stride = colW + COL_GAP;
  const sentinel = document.getElementById('colEndSentinel');
  let chapPages = 1;

  if (sentinel) {
    const trackRect = pageContent.getBoundingClientRect();
    const sentRect = sentinel.getBoundingClientRect();
    const relLeft = sentRect.left - trackRect.left;
    if (relLeft >= 0) {
      chapPages = Math.max(1, Math.floor((relLeft + 2) / stride) + 1);
    }
  } else {
    chapPages = Math.max(1, Math.round((pageContent.scrollWidth + COL_GAP) / stride));
  }

  currentChapTotalPages = chapPages;

  if (preserveRatio === 'end') {
    currentChapPageIdx = currentChapTotalPages - 1;
  } else if (typeof preserveRatio === 'number') {
    currentChapPageIdx = Math.min(
      currentChapTotalPages - 1,
      Math.max(0, Math.round(preserveRatio * (currentChapTotalPages - 1)))
    );
  } else {
    currentChapPageIdx = Math.min(currentChapTotalPages - 1, Math.max(0, currentChapPageIdx));
  }

  updateGlobalPageEstimates();
  applyColumnOffset();
}

function renderChapter(chapterIdx, position = 0) {
  if (!currentBook || !currentBook.chapters.length) return;
  currentChapterIdx = Math.min(currentBook.chapters.length - 1, Math.max(0, chapterIdx));
  const chapter = currentBook.chapters[currentChapterIdx];
  pageContent.innerHTML = getChapterHtml(chapter);

  if (position === 'end') {
    measureCurrentChapterLayout('end');
  } else if (typeof position === 'object' && position !== null && typeof position.ratio === 'number') {
    measureCurrentChapterLayout(position.ratio);
  } else {
    currentChapPageIdx = typeof position === 'number' ? position : 0;
    measureCurrentChapterLayout(null);
  }
}

function applyColumnOffset() {
  if (!currentBook) return;
  currentChapPageIdx = Math.min(currentChapTotalPages - 1, Math.max(0, currentChapPageIdx));
  const stride = colW + COL_GAP;
  pageContent.style.transform = `translate3d(${-currentChapPageIdx * stride}px, 0, 0)`;

  const globalPageIdx = (chapterStartGlobal[currentChapterIdx] || 0) + currentChapPageIdx;
  const humanPage = Math.min(totalGlobalPages, globalPageIdx + 1);
  const pct =
    totalGlobalPages <= 1 ? 100 : Math.min(100, Math.round((globalPageIdx / (totalGlobalPages - 1)) * 100));
  const chapTitle = currentBook.chapters[currentChapterIdx]?.title || '';

  pageCounterText.textContent = `${humanPage} / ${totalGlobalPages}`;

  hudBookTitle.textContent = currentBook.title || '';
  hudChapterTitle.textContent = chapTitle;
  hudPageInfo.textContent = `Bet ${humanPage} / ${totalGlobalPages}`;
  hudPercentInfo.textContent = `${pct}%`;
  pageSlider.max = String(totalGlobalPages);
  pageSlider.value = String(humanPage);

  const bms = loadBookmarks(currentBook.id);
  const isBookmarked = bms.some(
    (b) => b.chapterIdx === currentChapterIdx && b.chapPageIdx === currentChapPageIdx
  );
  btnToggleBookmark.classList.toggle('active', isBookmarked);

  const ratio =
    currentChapTotalPages <= 1 ? 0 : currentChapPageIdx / (currentChapTotalPages - 1);

  saveBookProgress(currentBook.id, {
    chapterIdx: currentChapterIdx,
    chapPageIdx: currentChapPageIdx,
    ratio,
    pageIdx: globalPageIdx,
    totalPages: totalGlobalPages,
    percent: pct,
    chapterTitle: chapTitle,
    updatedAt: Date.now(),
  });
}

// ==================== SETTINGS APPLICATION (INSTANT < 4ms!) ====================
function applySettings(relayout = true) {
  const prevRatio =
    currentChapTotalPages <= 1 ? 0 : currentChapPageIdx / (currentChapTotalPages - 1);

  document.documentElement.setAttribute('data-theme', settings.theme);
  document.documentElement.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--reader-line-height', String(settings.lineHeight));
  const ff =
    settings.fontFamily === 'sans'
      ? "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
      : "Georgia, 'Noto Serif', 'Times New Roman', Times, serif";
  document.documentElement.style.setProperty('--reader-font-family', ff);

  fontSizeLabel.textContent = `${settings.fontSize}px`;

  document.querySelectorAll('#lineHeightGroup button').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.lh) === Number(settings.lineHeight));
  });
  document.querySelectorAll('#fontFamilyGroup button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.ff === settings.fontFamily);
  });
  document.querySelectorAll('#themeGroup button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === settings.theme);
  });

  saveJson(SETTINGS_KEY, settings);

  if (relayout && currentBook && !readerView.classList.contains('hidden')) {
    measureCurrentChapterLayout(prevRatio);
  }
}

function loadBookProgress(bookId) {
  return loadJson(`kitobim_prog_${bookId}`, null);
}

function saveBookProgress(bookId, data) {
  saveJson(`kitobim_prog_${bookId}`, data);
}

function loadBookmarks(bookId) {
  return loadJson(`kitobim_bm_${bookId}`, []);
}

function saveBookmarks(bookId, list) {
  saveJson(`kitobim_bm_${bookId}`, list);
}

// ==================== NAVIGATION & GESTURES ====================
function goNextPage() {
  if (!readerHud.classList.contains('hidden')) {
    readerHud.classList.add('hidden');
    return;
  }
  if (!currentBook) return;
  if (currentChapPageIdx < currentChapTotalPages - 1) {
    currentChapPageIdx++;
    applyColumnOffset();
  } else if (currentChapterIdx < currentBook.chapters.length - 1) {
    renderChapter(currentChapterIdx + 1, 0);
  }
}

function goPrevPage() {
  if (!readerHud.classList.contains('hidden')) {
    readerHud.classList.add('hidden');
    return;
  }
  if (!currentBook) return;
  if (currentChapPageIdx > 0) {
    currentChapPageIdx--;
    applyColumnOffset();
  } else if (currentChapterIdx > 0) {
    renderChapter(currentChapterIdx - 1, 'end');
  }
}

function jumpToGlobalPage(humanPage) {
  if (!currentBook) return;
  const targetIdx = Math.min(totalGlobalPages - 1, Math.max(0, humanPage - 1));
  let targetChap = 0;
  for (let i = 0; i < chapterStartGlobal.length; i++) {
    if (chapterStartGlobal[i] <= targetIdx) targetChap = i;
    else break;
  }
  const offsetInChap = targetIdx - (chapterStartGlobal[targetChap] || 0);
  const estChapPages = Math.max(1, chapterEstPages[targetChap] || 1);
  if (targetChap === currentChapterIdx) {
    currentChapPageIdx = Math.min(currentChapTotalPages - 1, offsetInChap);
    applyColumnOffset();
  } else {
    const ratio = estChapPages <= 1 ? 0 : Math.min(1, offsetInChap / (estChapPages - 1));
    renderChapter(targetChap, { ratio });
  }
}

function toggleHud() {
  readerHud.classList.toggle('hidden');
}

document.getElementById('tapZoneLeft').addEventListener('click', goPrevPage);
document.getElementById('tapZoneRight').addEventListener('click', goNextPage);
document.getElementById('tapZoneCenter').addEventListener('click', toggleHud);

let touchStartX = null;
let touchStartY = null;

readerView.addEventListener(
  'touchstart',
  (e) => {
    if (!readerHud.classList.contains('hidden') || !tocDrawer.classList.contains('hidden')) return;
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
  },
  { passive: true }
);

readerView.addEventListener(
  'touchend',
  (e) => {
    if (touchStartX === null || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;

    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.35) {
      if (dx < 0) goNextPage();
      else goPrevPage();
    }
  },
  { passive: true }
);

window.addEventListener('keydown', (e) => {
  if (!readerView.classList.contains('hidden') && pasteModal.classList.contains('hidden')) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      if (currentChapPageIdx < currentChapTotalPages - 1) {
        currentChapPageIdx++;
        applyColumnOffset();
      } else if (currentBook && currentChapterIdx < currentBook.chapters.length - 1) {
        renderChapter(currentChapterIdx + 1, 0);
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (currentChapPageIdx > 0) {
        currentChapPageIdx--;
        applyColumnOffset();
      } else if (currentChapterIdx > 0) {
        renderChapter(currentChapterIdx - 1, 'end');
      }
    } else if (e.key === 'Escape') {
      readerHud.classList.add('hidden');
      tocDrawer.classList.add('hidden');
    }
  }
});

// ==================== HUD CONTROLS ====================
document.getElementById('btnPrevPageHud').addEventListener('click', () => {
  if (currentChapPageIdx > 0) {
    currentChapPageIdx--;
    applyColumnOffset();
  } else if (currentChapterIdx > 0) {
    renderChapter(currentChapterIdx - 1, 'end');
  }
});

document.getElementById('btnNextPageHud').addEventListener('click', () => {
  if (currentChapPageIdx < currentChapTotalPages - 1) {
    currentChapPageIdx++;
    applyColumnOffset();
  } else if (currentBook && currentChapterIdx < currentBook.chapters.length - 1) {
    renderChapter(currentChapterIdx + 1, 0);
  }
});

pageSlider.addEventListener('input', () => {
  jumpToGlobalPage(Number(pageSlider.value));
});

document.getElementById('btnFontMinus').addEventListener('click', () => {
  settings.fontSize = Math.max(15, settings.fontSize - 1);
  applySettings(true);
});

document.getElementById('btnFontPlus').addEventListener('click', () => {
  settings.fontSize = Math.min(36, settings.fontSize + 1);
  applySettings(true);
});

document.querySelectorAll('#lineHeightGroup button').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.lineHeight = Number(btn.dataset.lh);
    applySettings(true);
  });
});

document.querySelectorAll('#fontFamilyGroup button').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.fontFamily = btn.dataset.ff;
    applySettings(true);
  });
});

document.querySelectorAll('#themeGroup button').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.theme;
    applySettings(false);
  });
});

// ==================== TOC & BOOKMARKS ====================
function renderTocList() {
  if (!currentBook) return;
  tocList.innerHTML = '';
  currentBook.chapters.forEach((ch, idx) => {
    const startPage = (chapterStartGlobal[idx] ?? 0) + 1;
    const isCurrent = currentChapterIdx === idx;
    const li = document.createElement('li');
    li.className = `toc-item${isCurrent ? ' active' : ''}`;
    li.innerHTML = `
      <span class="toc-item-title">${escapeHtml(ch.title)}</span>
      <span class="toc-item-page">${startPage}-bet</span>
    `;
    li.addEventListener('click', () => {
      renderChapter(idx, 0);
      tocDrawer.classList.add('hidden');
      readerHud.classList.add('hidden');
    });
    tocList.appendChild(li);
  });
}

function renderBookmarksList() {
  if (!currentBook) return;
  const list = loadBookmarks(currentBook.id);
  bookmarksList.innerHTML = '';
  if (!list.length) {
    bookmarksList.innerHTML = `<li class="toc-item"><span class="toc-item-title">Hali xatcho‘p qo‘shilmagan (yuqoridagi 🔖 tugmasini bosing)</span></li>`;
    return;
  }
  list.forEach((bm) => {
    const li = document.createElement('li');
    li.className = 'toc-item';
    li.innerHTML = `
      <div>
        <div class="toc-item-title">${escapeHtml(bm.chapterTitle || '')}</div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:3px;">${escapeHtml(bm.snippet || '')}</div>
      </div>
      <span class="toc-item-page">${(bm.globalPage || 1)}-bet</span>
    `;
    li.addEventListener('click', () => {
      renderChapter(bm.chapterIdx || 0, { ratio: bm.ratio || 0 });
      tocDrawer.classList.add('hidden');
      readerHud.classList.add('hidden');
    });
    bookmarksList.appendChild(li);
  });
}

btnToggleBookmark.addEventListener('click', () => {
  if (!currentBook) return;
  const list = loadBookmarks(currentBook.id);
  const existingIdx = list.findIndex(
    (b) => b.chapterIdx === currentChapterIdx && b.chapPageIdx === currentChapPageIdx
  );
  if (existingIdx >= 0) {
    list.splice(existingIdx, 1);
  } else {
    const chap = currentBook.chapters[currentChapterIdx];
    const ratio =
      currentChapTotalPages <= 1 ? 0 : currentChapPageIdx / (currentChapTotalPages - 1);
    const globalPage = (chapterStartGlobal[currentChapterIdx] || 0) + currentChapPageIdx + 1;
    list.unshift({
      chapterIdx: currentChapterIdx,
      chapPageIdx: currentChapPageIdx,
      ratio,
      globalPage,
      chapterTitle: chap?.title || '',
      snippet: `Bob ichida ${currentChapPageIdx + 1} / ${currentChapTotalPages}-bet`,
      ts: Date.now(),
    });
  }
  saveBookmarks(currentBook.id, list);
  applyColumnOffset();
  renderBookmarksList();
});

document.getElementById('btnOpenToc').addEventListener('click', () => {
  renderTocList();
  renderBookmarksList();
  tocDrawer.classList.remove('hidden');
});

document.getElementById('btnCloseToc').addEventListener('click', () => {
  tocDrawer.classList.add('hidden');
});

document.getElementById('tocBackdrop').addEventListener('click', () => {
  tocDrawer.classList.add('hidden');
});

tabBtnChapters.addEventListener('click', () => {
  tabBtnChapters.classList.add('active');
  tabBtnBookmarks.classList.remove('active');
  tocList.classList.remove('hidden');
  bookmarksList.classList.add('hidden');
});

tabBtnBookmarks.addEventListener('click', () => {
  tabBtnBookmarks.classList.add('active');
  tabBtnChapters.classList.remove('active');
  bookmarksList.classList.remove('hidden');
  tocList.classList.add('hidden');
});

// ==================== LIBRARY & BOOK SWITCHING ====================
document.getElementById('btnOpenLibrary').addEventListener('click', () => {
  readerHud.classList.add('hidden');
  readerView.classList.add('hidden');
  libraryView.classList.remove('hidden');
  renderLibrary();
});

document.getElementById('btnResumeTop').addEventListener('click', () => {
  libraryView.classList.add('hidden');
  readerView.classList.remove('hidden');
  measureCurrentChapterLayout(null);
});

async function openBookById(bookId) {
  let bookData = bookCache.get(bookId) || null;
  if (!bookData) {
    const builtIn = builtInCatalog.find((b) => b.id === bookId);
    if (builtIn) {
      const res = await fetch(builtIn.url);
      bookData = await res.json();
    } else {
      bookData = await getUserBook(bookId);
    }
    if (bookData) bookCache.set(bookId, bookData);
  }

  if (!bookData) return;
  currentBook = bookData;
  saveJson(ACTIVE_BOOK_KEY, bookData.id);
  computeBookCharCounts(currentBook);

  libraryView.classList.add('hidden');
  readerView.classList.remove('hidden');
  readerHud.classList.add('hidden');

  const saved = loadBookProgress(currentBook.id);
  if (saved && typeof saved.chapterIdx === 'number') {
    renderChapter(saved.chapterIdx, { ratio: typeof saved.ratio === 'number' ? saved.ratio : 0 });
  } else {
    renderChapter(0, 0);
  }
}

async function renderLibrary() {
  const userBooks = await getAllUserBooks();
  booksGrid.innerHTML = '';

  const allItems = [
    ...builtInCatalog.map((b) => ({ ...b, isUser: false })),
    ...userBooks.map((b) => ({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle || '',
      author: b.author || 'Shaxsiy yuklanma',
      badge: b.badge || `Yuklangan • ${b.wordCount || 0} so‘z`,
      wordCount: b.wordCount || 0,
      chaptersCount: (b.chapters || []).length,
      isUser: true,
    })),
  ];

  for (const item of allItems) {
    const prog = loadBookProgress(item.id);
    const pct = prog ? prog.percent : 0;
    const pageStr = prog ? `Bet ${prog.pageIdx + 1} / ${prog.totalPages} (${pct}%)` : 'Hali boshlanmagan';
    const isActive = currentBook && currentBook.id === item.id;

    const card = document.createElement('div');
    card.className = `book-card${isActive ? ' active-book' : ''}`;
    card.innerHTML = `
      <span class="book-badge">${escapeHtml(item.badge || '')}</span>
      <div class="book-title">${escapeHtml(item.title)}</div>
      ${item.subtitle ? `<div class="book-sub">${escapeHtml(item.subtitle)}</div>` : ''}
      <div class="book-progress-bar">
        <div class="book-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="book-card-footer">
        <span>${escapeHtml(pageStr)}</span>
        <div class="book-card-actions">
          ${item.isUser ? `<button class="btn-secondary btn-del" type="button">🗑 O‘chirish</button>` : ''}
          <button class="btn-primary btn-open" type="button">${prog ? 'Davom ettirish →' : 'O‘qishni boshlash →'}</button>
        </div>
      </div>
    `;

    card.querySelector('.btn-open').addEventListener('click', () => openBookById(item.id));
    if (item.isUser) {
      card.querySelector('.btn-del').addEventListener('click', async () => {
        bookCache.delete(item.id);
        await deleteUserBook(item.id);
        renderLibrary();
      });
    }
    booksGrid.appendChild(card);
  }
}

// ==================== SMART TEXT & PDF IMPORTER ====================
function smartCleanAndStructureText(rawText, rawTitle = '') {
  const lines = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  const filtered = lines.filter((line) => {
    const s = line.trim();
    if (!s) return true;
    if (/^[—\-–\s]*\d{1,4}(\s*\/\s*\d{1,4})?[—\-–\s]*$/.test(s)) return false;
    return true;
  });

  const paragraphs = [];
  let buf = '';

  function flushBuf() {
    if (buf.trim()) {
      paragraphs.push(buf.trim());
      buf = '';
    }
  }

  for (const rawLine of filtered) {
    const line = rawLine.trim();
    if (!line) {
      flushBuf();
      continue;
    }

    if (/^#{1,3}\s+/.test(line) || /^(?:\d+-bob|Глава\s+\d+|Chapter\s+\d+|BOB\s+\d+)/i.test(line)) {
      flushBuf();
      paragraphs.push(line);
      continue;
    }

    const isAllCapsHeading =
      line.length >= 3 &&
      line.length <= 75 &&
      line === line.toUpperCase() &&
      /[A-ZА-ЯЁЎҚҒҲ]/.test(line) &&
      !/[.!?]$/.test(line);

    if (isAllCapsHeading) {
      flushBuf();
      paragraphs.push(`## ${line}`);
      continue;
    }

    if (/^[—–-]\s+/.test(line)) {
      flushBuf();
      buf = line;
      continue;
    }

    if (!buf) {
      buf = line;
    } else if (buf.endsWith('-') && /^[a-zа-яёўқғҳ]/.test(line)) {
      buf = buf.slice(0, -1) + line;
    } else if (!/[.!?:»"”]$/.test(buf)) {
      buf += ' ' + line;
    } else {
      flushBuf();
      buf = line;
    }
  }
  flushBuf();

  let title = rawTitle.trim();
  if (!title && paragraphs.length > 0) {
    title = paragraphs[0].replace(/^#+\s*/, '').slice(0, 75);
  }
  if (!title) title = 'Shaxsiy matn';

  const chapters = [];
  let curChapter = { title, blocks: [] };

  for (const p of paragraphs) {
    if (/^#\s+/.test(p) || /^(?:\d+-bob|Глава\s+\d+|Chapter\s+\d+)/i.test(p)) {
      const chName = p.replace(/^#\s+/, '').trim();
      if (curChapter.blocks.length > 0) {
        chapters.push(curChapter);
      }
      curChapter = { title: chName, blocks: [] };
    } else if (/^##+\s+/.test(p)) {
      curChapter.blocks.push({ type: 'h2', text: p.replace(/^##+\s+/, '').trim() });
    } else if (p === '***' || p === '* * *') {
      curChapter.blocks.push({ type: 'hr' });
    } else if (/^[-•*]\s+/.test(p)) {
      curChapter.blocks.push({ type: 'li', text: p.replace(/^[-•*]\s+/, '').trim() });
    } else {
      curChapter.blocks.push({ type: 'p', text: p });
    }

    if (curChapter.blocks.length >= 220) {
      chapters.push(curChapter);
      curChapter = {
        title: `${title} (${chapters.length + 1}-qism)`,
        blocks: [],
      };
    }
  }

  if (curChapter.blocks.length > 0 || chapters.length === 0) {
    chapters.push(curChapter);
  }

  const wordCount = rawText.trim() ? rawText.trim().split(/\s+/).length : 0;
  return {
    id: `user-${Date.now()}`,
    title,
    subtitle: `${chapters.length} bo‘lim • ${wordCount.toLocaleString()} so‘z`,
    author: 'Shaxsiy kutubxona',
    badge: `Shaxsiy • ${wordCount.toLocaleString()} so‘z`,
    wordCount,
    chapters,
  };
}

let pdfJsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error('PDF.js yuklanmadi'));
    document.head.appendChild(script);
  });
  return pdfJsPromise;
}

async function extractTextFromPdfFile(file, onProgress) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pageTexts = [];

  for (let pno = 1; pno <= pdf.numPages; pno++) {
    if (onProgress && pno % 5 === 0) {
      onProgress(`PDF o‘qilmoqda: ${pno} / ${pdf.numPages} bet...`);
    }
    const page = await pdf.getPage(pno);
    const content = await page.getTextContent();
    let lastY = null;
    const lines = [];
    let curLine = '';

    for (const item of content.items) {
      const str = item.str || '';
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        if (curLine.trim()) lines.push(curLine.trim());
        curLine = str;
      } else {
        curLine += (curLine && !curLine.endsWith(' ') && !str.startsWith(' ') ? ' ' : '') + str;
      }
      if (y !== null) lastY = y;
    }
    if (curLine.trim()) lines.push(curLine.trim());
    pageTexts.push(lines.join('\n'));
  }

  return pageTexts.join('\n\n');
}

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  fileInput.value = '';

  importStatus.classList.remove('hidden');
  importStatus.textContent = `"${file.name}" tayyorlanmoqda...`;

  try {
    let rawText = '';
    const cleanName = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');

    if (file.name.toLowerCase().endsWith('.pdf')) {
      rawText = await extractTextFromPdfFile(file, (msg) => {
        importStatus.textContent = msg;
      });
    } else {
      rawText = await file.text();
      if (file.name.toLowerCase().endsWith('.fb2')) {
        const doc = new DOMParser().parseFromString(rawText, 'text/xml');
        rawText = Array.from(doc.querySelectorAll('p, title'))
          .map((el) => (el.tagName === 'title' ? `# ${el.textContent.trim()}` : el.textContent.trim()))
          .join('\n\n');
      }
    }

    const book = smartCleanAndStructureText(rawText, cleanName);
    await saveUserBook(book);
    importStatus.classList.add('hidden');
    await openBookById(book.id);
  } catch (err) {
    importStatus.textContent = `Xatolik: ${err.message}`;
  }
});

// ==================== COPY-PASTE MODAL ====================
document.getElementById('btnOpenPasteModal').addEventListener('click', () => {
  pasteTitleInput.value = '';
  pasteTextarea.value = '';
  pasteModal.classList.remove('hidden');
  pasteTextarea.focus();
});

function closePasteModal() {
  pasteModal.classList.add('hidden');
}

document.getElementById('btnClosePasteModal').addEventListener('click', closePasteModal);
document.getElementById('btnCancelPaste').addEventListener('click', closePasteModal);
document.getElementById('pasteModalBackdrop').addEventListener('click', closePasteModal);

document.getElementById('btnClipboardPaste').addEventListener('click', async () => {
  try {
    const clip = await navigator.clipboard.readText();
    if (clip) pasteTextarea.value = clip;
  } catch {
    pasteTextarea.focus();
  }
});

document.getElementById('btnSavePaste').addEventListener('click', async () => {
  const raw = pasteTextarea.value.trim();
  if (!raw) return;
  const book = smartCleanAndStructureText(raw, pasteTitleInput.value.trim());
  await saveUserBook(book);
  closePasteModal();
  await openBookById(book.id);
});

// ==================== RESIZE HANDLER ====================
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentBook && !readerView.classList.contains('hidden')) {
      const ratio =
        currentChapTotalPages <= 1 ? 0 : currentChapPageIdx / (currentChapTotalPages - 1);
      measureCurrentChapterLayout(ratio);
    }
  }, 80);
});

// ==================== BOOTSTRAP ====================
async function init() {
  applySettings(false);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => reg.update()).catch(() => {});
  }

  try {
    const res = await fetch('/books/catalog.json');
    builtInCatalog = await res.json();
  } catch {
    builtInCatalog = [];
  }

  const lastBookId = loadJson(ACTIVE_BOOK_KEY, 'voss-uz');
  await openBookById(lastBookId || 'voss-uz');
}

init();
