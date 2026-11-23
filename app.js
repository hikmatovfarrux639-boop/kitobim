// ==================== STATE & STORAGE ====================
const SETTINGS_KEY = 'kitobim_settings_v1';
const ACTIVE_BOOK_KEY = 'kitobim_active_book_v1';
const DB_NAME = 'kitobim_user_books_db';
const DB_STORE = 'books';

const defaultSettings = {
  fontSize: 22,
  lineHeight: 1.58,
  fontFamily: 'serif',
  theme: 'amoled',
};

let settings = { ...defaultSettings, ...loadJson(SETTINGS_KEY, {}) };
let builtInCatalog = [];
let userBooksMeta = [];
let currentBook = null;
let pages = []; // Array of { chapterIdx, chapterTitle, anchor, html }
let chapterStartPages = []; // Array of page indices (0-based)
let currentPageIdx = 0;

// ==================== DOM ELEMENTS ====================
const readerView = document.getElementById('readerView');
const libraryView = document.getElementById('libraryView');
const pageViewport = document.getElementById('pageViewport');
const pageContent = document.getElementById('pageContent');
const pageMeasurerWrap = document.getElementById('pageMeasurerWrap');
const pageMeasurer = document.getElementById('pageMeasurer');
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

// ==================== HELPERS ====================
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

function formatInline(str) {
  let s = escapeHtml(str);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  return s;
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

// ==================== SETTINGS APPLICATION ====================
function applySettings(rePaginate = true) {
  const anchor = getCurrentAnchor();
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

  if (rePaginate && currentBook) {
    paginateCurrentBook(anchor);
  }
}

// ==================== EXACT WORD-BOUNDARY PAGINATION ENGINE ====================
function blockToHtml(block) {
  switch (block.type) {
    case 'ch_title':
      return `<h1 class="reader-ch-title">${formatInline(block.text)}</h1>`;
    case 'subtitle':
      return `<div class="reader-ch-sub">${formatInline(block.text)}</div>`;
    case 'h2':
      return `<h2 class="reader-h2">${formatInline(block.text)}</h2>`;
    case 'hr':
      return `<div class="reader-hr">&#8226;&nbsp;&nbsp;&#8226;&nbsp;&nbsp;&#8226;</div>`;
    case 'li':
      return `<p class="reader-li">${formatInline(block.text)}</p>`;
    case 'p':
    default: {
      const isDlg = block.text.startsWith('—') || block.text.startsWith('– ');
      return `<p class="${isDlg ? 'dialogue' : ''}">${formatInline(block.text)}</p>`;
    }
  }
}

function getCurrentAnchor() {
  if (!pages.length || !pages[currentPageIdx]) return null;
  return pages[currentPageIdx].anchor;
}

function paginateCurrentBook(targetAnchor = null) {
  if (!currentBook) return;

  // Match exact available inner width and height of pageViewport
  const styles = window.getComputedStyle(pageViewport);
  const availW =
    pageViewport.clientWidth -
    parseFloat(styles.paddingLeft || 0) -
    parseFloat(styles.paddingRight || 0);
  const availH =
    pageViewport.clientHeight -
    parseFloat(styles.paddingTop || 0) -
    parseFloat(styles.paddingBottom || 0);

  if (availW <= 40 || availH <= 60) return;

  pageMeasurerWrap.style.width = `${availW}px`;
  pageMeasurer.innerHTML = '';

  const newPages = [];
  const newChapterStarts = [];

  currentBook.chapters.forEach((chapter, cIdx) => {
    newChapterStarts[cIdx] = newPages.length;

    // Build block stream for this chapter
    const stream = [{ type: 'ch_title', text: chapter.title, blockIdx: -1, wordOffset: 0 }];
    (chapter.blocks || []).forEach((b, bIdx) => {
      stream.push({ ...b, blockIdx: bIdx, wordOffset: 0 });
    });

    let curHtmlParts = [];
    let pageAnchor = { chapterIdx: cIdx, blockIdx: 0, wordOffset: 0 };
    pageMeasurer.innerHTML = '';

    function flushPage() {
      if (!curHtmlParts.length) return;
      newPages.push({
        chapterIdx: cIdx,
        chapterTitle: chapter.title,
        anchor: { ...pageAnchor },
        html: curHtmlParts.join(''),
      });
      curHtmlParts = [];
      pageMeasurer.innerHTML = '';
    }

    let i = 0;
    while (i < stream.length) {
      const item = stream[i];
      if (!curHtmlParts.length) {
        pageAnchor = {
          chapterIdx: cIdx,
          blockIdx: Math.max(0, item.blockIdx),
          wordOffset: item.wordOffset || 0,
        };
      }

      const candidateHtml = blockToHtml(item);
      const prevHtml = curHtmlParts.join('');
      pageMeasurer.innerHTML = prevHtml + candidateHtml;

      if (pageMeasurer.scrollHeight <= availH) {
        curHtmlParts.push(candidateHtml);
        i++;
        continue;
      }

      // Doesn't fit completely. If it's a heading or short non-paragraph and page isn't empty, push to next page
      const words = (item.text || '').trim().split(/\s+/).filter(Boolean);
      const isSplittable = (item.type === 'p' || item.type === 'li') && words.length >= 14;

      if (!isSplittable) {
        if (curHtmlParts.length > 0) {
          flushPage();
          continue; // retry item on fresh page
        } else {
          // Force place even if tall
          curHtmlParts.push(candidateHtml);
          flushPage();
          i++;
          continue;
        }
      }

      // Binary search how many words of this paragraph fit on the current page
      let lo = 1;
      let hi = words.length - 1;
      let best = 0;

      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const subBlock = { ...item, text: words.slice(0, mid).join(' ') };
        pageMeasurer.innerHTML = prevHtml + blockToHtml(subBlock);
        if (pageMeasurer.scrollHeight <= availH) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      // Avoid leaving a tiny 1-4 word widow at bottom of page if page already has content
      if (best < 6 && curHtmlParts.length > 0) {
        flushPage();
        continue;
      }

      const takeCount = Math.max(1, best);
      const firstPart = { ...item, text: words.slice(0, takeCount).join(' ') };
      curHtmlParts.push(blockToHtml(firstPart));
      flushPage();

      // Replace current stream item with remaining words for the next page
      stream[i] = {
        ...item,
        type: 'p',
        text: words.slice(takeCount).join(' '),
        wordOffset: (item.wordOffset || 0) + takeCount,
      };
    }

    if (curHtmlParts.length > 0) {
      flushPage();
    }
  });

  pages = newPages.length
    ? newPages
    : [{ chapterIdx: 0, chapterTitle: currentBook.title, anchor: { chapterIdx: 0, blockIdx: 0, wordOffset: 0 }, html: '<p>Bo‘sh kitob</p>' }];
  chapterStartPages = newChapterStarts;

  // Restore exact reading position from targetAnchor or saved progress
  const saved = loadBookProgress(currentBook.id);
  const refAnchor = targetAnchor || saved?.anchor || null;

  if (refAnchor) {
    let bestIdx = 0;
    for (let idx = 0; idx < pages.length; idx++) {
      const a = pages[idx].anchor;
      if (
        a.chapterIdx < refAnchor.chapterIdx ||
        (a.chapterIdx === refAnchor.chapterIdx && a.blockIdx < refAnchor.blockIdx) ||
        (a.chapterIdx === refAnchor.chapterIdx &&
          a.blockIdx === refAnchor.blockIdx &&
          a.wordOffset <= (refAnchor.wordOffset || 0))
      ) {
        bestIdx = idx;
      } else {
        break;
      }
    }
    currentPageIdx = bestIdx;
  } else if (saved && typeof saved.pageIdx === 'number') {
    currentPageIdx = Math.min(pages.length - 1, Math.max(0, saved.pageIdx));
  } else {
    currentPageIdx = 0;
  }

  renderCurrentPage();
  renderTocList();
}

function renderCurrentPage() {
  if (!pages.length) return;
  currentPageIdx = Math.min(pages.length - 1, Math.max(0, currentPageIdx));
  const pg = pages[currentPageIdx];
  pageContent.innerHTML = pg.html;

  const total = pages.length;
  const humanPage = currentPageIdx + 1;
  const pct = total <= 1 ? 100 : Math.round((currentPageIdx / (total - 1)) * 100);

  // Exact screenshot footer: 213 / 484
  pageCounterText.textContent = `${humanPage} / ${total}`;

  // HUD labels
  hudBookTitle.textContent = currentBook?.title || '';
  hudChapterTitle.textContent = pg.chapterTitle || '';
  hudPageInfo.textContent = `Bet ${humanPage} / ${total}`;
  hudPercentInfo.textContent = `${pct}%`;
  pageSlider.max = String(total);
  pageSlider.value = String(humanPage);

  // Bookmark highlight
  const bms = loadBookmarks(currentBook.id);
  const isBookmarked = bms.some((b) => b.pageIdx === currentPageIdx);
  btnToggleBookmark.classList.toggle('active', isBookmarked);

  // Save reading progress automatically
  saveBookProgress(currentBook.id, {
    anchor: pg.anchor,
    pageIdx: currentPageIdx,
    totalPages: total,
    percent: pct,
    chapterTitle: pg.chapterTitle,
    updatedAt: Date.now(),
  });
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
  if (currentPageIdx < pages.length - 1) {
    currentPageIdx++;
    renderCurrentPage();
  }
}

function goPrevPage() {
  if (!readerHud.classList.contains('hidden')) {
    readerHud.classList.add('hidden');
    return;
  }
  if (currentPageIdx > 0) {
    currentPageIdx--;
    renderCurrentPage();
  }
}

function toggleHud() {
  readerHud.classList.toggle('hidden');
}

document.getElementById('tapZoneLeft').addEventListener('click', goPrevPage);
document.getElementById('tapZoneRight').addEventListener('click', goNextPage);
document.getElementById('tapZoneCenter').addEventListener('click', toggleHud);

// Touch swipe support on readerView
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

    if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0) goNextPage();
      else goPrevPage();
    }
  },
  { passive: true }
);

// Keyboard navigation
window.addEventListener('keydown', (e) => {
  if (!readerView.classList.contains('hidden') && pasteModal.classList.contains('hidden')) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      if (currentPageIdx < pages.length - 1) {
        currentPageIdx++;
        renderCurrentPage();
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (currentPageIdx > 0) {
        currentPageIdx--;
        renderCurrentPage();
      }
    } else if (e.key === 'Escape') {
      readerHud.classList.add('hidden');
      tocDrawer.classList.add('hidden');
    }
  }
});

// ==================== HUD CONTROLS ====================
document.getElementById('btnPrevPageHud').addEventListener('click', () => {
  if (currentPageIdx > 0) {
    currentPageIdx--;
    renderCurrentPage();
  }
});

document.getElementById('btnNextPageHud').addEventListener('click', () => {
  if (currentPageIdx < pages.length - 1) {
    currentPageIdx++;
    renderCurrentPage();
  }
});

pageSlider.addEventListener('input', () => {
  currentPageIdx = Number(pageSlider.value) - 1;
  renderCurrentPage();
});

document.getElementById('btnFontMinus').addEventListener('click', () => {
  settings.fontSize = Math.max(15, settings.fontSize - 2);
  applySettings(true);
});

document.getElementById('btnFontPlus').addEventListener('click', () => {
  settings.fontSize = Math.min(36, settings.fontSize + 2);
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
    const startPage = (chapterStartPages[idx] ?? 0) + 1;
    const isCurrent = pages[currentPageIdx]?.chapterIdx === idx;
    const li = document.createElement('li');
    li.className = `toc-item${isCurrent ? ' active' : ''}`;
    li.innerHTML = `
      <span class="toc-item-title">${escapeHtml(ch.title)}</span>
      <span class="toc-item-page">${startPage}-bet</span>
    `;
    li.addEventListener('click', () => {
      currentPageIdx = chapterStartPages[idx] ?? 0;
      renderCurrentPage();
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
  list.forEach((bm, idx) => {
    const li = document.createElement('li');
    li.className = 'toc-item';
    li.innerHTML = `
      <div>
        <div class="toc-item-title">${escapeHtml(bm.chapterTitle || '')}</div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:3px;">${escapeHtml(bm.snippet || '')}</div>
      </div>
      <span class="toc-item-page">${bm.pageIdx + 1}-bet</span>
    `;
    li.addEventListener('click', () => {
      currentPageIdx = Math.min(pages.length - 1, bm.pageIdx);
      renderCurrentPage();
      tocDrawer.classList.add('hidden');
      readerHud.classList.add('hidden');
    });
    bookmarksList.appendChild(li);
  });
}

btnToggleBookmark.addEventListener('click', () => {
  if (!currentBook || !pages[currentPageIdx]) return;
  const list = loadBookmarks(currentBook.id);
  const existingIdx = list.findIndex((b) => b.pageIdx === currentPageIdx);
  if (existingIdx >= 0) {
    list.splice(existingIdx, 1);
  } else {
    const tmp = document.createElement('div');
    tmp.innerHTML = pages[currentPageIdx].html;
    const snippet = (tmp.textContent || '').trim().slice(0, 90) + '…';
    list.unshift({
      pageIdx: currentPageIdx,
      chapterTitle: pages[currentPageIdx].chapterTitle,
      snippet,
      ts: Date.now(),
    });
  }
  saveBookmarks(currentBook.id, list);
  renderCurrentPage();
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
  paginateCurrentBook(getCurrentAnchor());
});

async function openBookById(bookId) {
  const builtIn = builtInCatalog.find((b) => b.id === bookId);
  let bookData = null;

  if (builtIn) {
    const res = await fetch(builtIn.url);
    bookData = await res.json();
  } else {
    bookData = await getUserBook(bookId);
  }

  if (!bookData) return;
  currentBook = bookData;
  saveJson(ACTIVE_BOOK_KEY, bookData.id);

  libraryView.classList.add('hidden');
  readerView.classList.remove('hidden');
  readerHud.classList.add('hidden');
  paginateCurrentBook();
}

async function renderLibrary() {
  userBooksMeta = await getAllUserBooks();
  booksGrid.innerHTML = '';

  const allItems = [
    ...builtInCatalog.map((b) => ({ ...b, isUser: false })),
    ...userBooksMeta.map((b) => ({
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

  // Step 1: Strip standalone page number lines (e.g. "213", "— 14 —", "213 / 484")
  const filtered = lines.filter((line) => {
    const s = line.trim();
    if (!s) return true;
    if (/^[—\-–\s]*\d{1,4}(\s*\/\s*\d{1,4})?[—\-–\s]*$/.test(s)) return false;
    return true;
  });

  // Step 2: Merge broken mid-sentence PDF lines into paragraphs
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

    // Markdown headings or clear chapter titles
    if (/^#{1,3}\s+/.test(line) || /^(?:\d+-bob|Глава\s+\d+|Chapter\s+\d+|BOB\s+\d+)/i.test(line)) {
      flushBuf();
      paragraphs.push(line);
      continue;
    }

    // Short ALL-CAPS heading line (like "ОСНОВЫ БИЗНЕСА" in screenshot)
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

    // Dialogue line starts a new paragraph
    if (/^[—–-]\s+/.test(line)) {
      flushBuf();
      buf = line;
      continue;
    }

    if (!buf) {
      buf = line;
    } else if (buf.endsWith('-') && /^[a-zа-яёўқғҳ]/.test(line)) {
      // Hyphenated word break across lines
      buf = buf.slice(0, -1) + line;
    } else if (!/[.!?:»"”]$/.test(buf)) {
      buf += ' ' + line;
    } else {
      flushBuf();
      buf = line;
    }
  }
  flushBuf();

  // Step 3: Build chapters & blocks
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

    // If a single chapter exceeds ~350 blocks without chapter headings, auto-split into parts
    if (curChapter.blocks.length >= 320) {
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
      paginateCurrentBook(getCurrentAnchor());
    }
  }, 150);
});

// ==================== BOOTSTRAP ====================
async function init() {
  applySettings(false);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
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
