/**
 * ============================================================
 * NicoList - 検索／タグページ対応（Fork版で追加）
 * ============================================================
 *
 * ニコニコ動画の検索結果・タグページで、各サムネイルに
 * 「NicoListに追加」ボタンを表示する。
 *
 * - 動画IDはリンクの href（/watch/sm...）から取る（クラス名には依存しない）
 * - クリックでデフォルトリストへ即追加。未設定の場合はリスト選択モーダル
 * - 動画情報の取得は background の fetchVideoInfo をそのまま使う
 * - 追加済みの動画は開いた時点でチェック表示にする
 */
(() => {
  'use strict';

  const BTN_CLASS = 'nl-search-add-btn';
  const ANCHOR_CLASS = 'nl-search-anchor';
  const WATCH_RE = /\/watch\/((?:sm|nm|so)?\d+)/;

  const ICON_PLUS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/><line x1="17" y1="15" x2="17" y2="21"/><line x1="14" y1="18" x2="20" y2="18"/></svg>';
  const ICON_CHECK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  // 注入したボタンの登録簿（タグミュートの判定に使う）
  const injected = [];

  // ─── 設定（キャッシュ） ─────────────────────────────
  let settingsCache = null;
  async function getSettings() {
    if (!settingsCache) {
      settingsCache = await chrome.runtime.sendMessage({ action: 'getSettings' }) || {};
    }
    return settingsCache;
  }

  // ─── トースト（取り消しボタンつき対応） ─────────────
  let toastTimer = null;
  function showToast(text, action) {
    let toast = document.querySelector('.nl-search-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'nl-search-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = '';
    const span = document.createElement('span');
    span.textContent = text;
    toast.appendChild(span);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nl-toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        toast.classList.remove('visible');
        await action.onAction();
      });
      toast.appendChild(btn);
    }
    toast.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), action ? 5000 : 2600);
  }

  function truncate(text, max) {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  // ─── 追加済み表示 ───────────────────────────────────
  function setAdded(btn) {
    btn.classList.add('nl-added');
    btn.innerHTML = ICON_CHECK;
    btn.title = 'NicoListに追加済み';
    btn.setAttribute('aria-label', 'NicoListに追加済み');
  }

  function unsetAdded(btn) {
    btn.classList.remove('nl-added');
    btn.innerHTML = ICON_PLUS;
    btn.title = 'NicoListに追加';
    btn.setAttribute('aria-label', 'NicoListに追加');
  }

  async function checkAddedState(btn, videoId) {
    try {
      const settings = await getSettings();
      if (!settings.defaultListId) return;
      const exists = await chrome.runtime.sendMessage({
        action: 'isVideoInList', listId: settings.defaultListId, videoId
      });
      if (exists) setAdded(btn);
    } catch (e) { /* 状態表示は補助なので失敗しても無視 */ }
  }

  // ─── セッション中の追加先（このページを開いている間だけ有効） ──
  // 一度リストを選ぶと、以降のクリックは同じリストへ即追加される。
  let sessionListId = null;
  let sessionListName = '';

  async function resolveTargetList(settings) {
    if (sessionListId) return { id: sessionListId, name: sessionListName };
    if (settings.defaultListId) {
      sessionListId = settings.defaultListId;
      const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' }) || [];
      const found = lists.find((l) => l.id === sessionListId);
      sessionListName = found ? found.name : '';
      return { id: sessionListId, name: sessionListName };
    }
    return null;
  }

  // ─── リストへ追加（トーストから取り消し可能） ───────
  async function addToList(btn, videoId, listId, listName) {
    const info = await chrome.runtime.sendMessage({ action: 'fetchVideoInfo', videoId });
    if (!info || info.error || !info.title) {
      showToast('動画情報を取得できませんでした');
      return false;
    }
    const result = await chrome.runtime.sendMessage({ action: 'addVideo', listId, videoInfo: info });
    if (result && result.success) {
      setAdded(btn);
      const dbId = result.video && result.video.id;
      const where = listName ? `「${listName}」に` : '';
      showToast(`「${truncate(info.title, 30)}」を${where}追加しました`, dbId ? {
        label: '取り消す',
        onAction: async () => {
          await chrome.runtime.sendMessage({ action: 'removeVideo', videoDbId: dbId });
          unsetAdded(btn);
          showToast('取り消しました');
        }
      } : null);
      return true;
    }
    if (result && /既に/.test(result.message || '')) {
      setAdded(btn);
      showToast('既にNicoListに追加されています');
      return true;
    }
    showToast('NicoListへの追加に失敗しました');
    return false;
  }

  // ─── リスト選択モーダル（デフォルトリスト未設定時） ──
  function closePicker() {
    const overlay = document.querySelector('.nl-picker-overlay');
    if (overlay) overlay.remove();
  }

  async function openPicker(btn, videoId) {
    closePicker();
    const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' }) || [];

    const overlay = document.createElement('div');
    overlay.className = 'nl-picker-overlay';

    const modal = document.createElement('div');
    modal.className = 'nl-picker-modal';

    const header = document.createElement('div');
    header.className = 'nl-picker-header';
    const title = document.createElement('span');
    title.textContent = 'NicoListに追加';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nl-picker-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closePicker);
    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    if (!lists.length) {
      const empty = document.createElement('div');
      empty.className = 'nl-picker-empty';
      empty.textContent = 'リストがありません。拡張機能のポップアップからリストを作成してください。';
      modal.appendChild(empty);
    } else {
      const listBox = document.createElement('div');
      listBox.className = 'nl-picker-list';
      lists.forEach((list) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'nl-picker-item';
        item.dataset.listId = list.id;
        const name = document.createElement('span');
        name.textContent = list.name;
        const count = document.createElement('span');
        count.className = 'nl-picker-count';
        count.textContent = `${list.videoCount || 0}動画`;
        item.appendChild(name);
        item.appendChild(count);
        item.addEventListener('click', async () => {
          sessionListId = list.id;
          sessionListName = list.name;
          const ok = await addToList(btn, videoId, list.id, list.name);
          if (ok) closePicker();
        });
        listBox.appendChild(item);
      });
      modal.appendChild(listBox);
    }

    const note = document.createElement('div');
    note.className = 'nl-picker-note';
    note.textContent = sessionListId
      ? `現在の追加先は「${sessionListName}」です。選ぶと切り替わります`
      : '選んだリストが、このページを開いている間の追加先になります';
    modal.appendChild(note);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePicker(); });
    document.body.appendChild(overlay);
  }

  // ─── ボタンのクリック ───────────────────────────────
  async function onBtnClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const videoId = btn.dataset.videoId;
    if (!videoId) return;
    if (btn.classList.contains('nl-added')) {
      showToast('既にNicoListに追加されています');
      return;
    }
    if (btn.dataset.nlBusy) return;
    btn.dataset.nlBusy = '1';
    try {
      const settings = await getSettings();
      const target = await resolveTargetList(settings);
      if (target) {
        await addToList(btn, videoId, target.id, target.name);
      } else {
        await openPicker(btn, videoId);
      }
    } catch (err) {
      showToast('NicoListへの追加に失敗しました');
    } finally {
      delete btn.dataset.nlBusy;
    }
  }

  // 右クリックでリスト選択を開く（追加先の切り替え用）
  function onBtnContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.classList.contains('nl-added')) return;
    openPicker(btn, btn.dataset.videoId);
  }

  // ─── ボタンの注入 ───────────────────────────────────
  function injectButton(anchor) {
    if (anchor.dataset.nlSearchInjected) return;
    const href = anchor.getAttribute('href') || anchor.href || '';
    // ニコニコ内の watch リンクだけを対象にする（広告などの外部リンクを除外）
    if (!href.startsWith('/watch/') && !href.includes('nicovideo.jp/watch/')) return;
    // 連続再生リンクは通常の動画リンクと重複するので対象外
    if (/[?&](continuous|playlist)=/.test(href)) return;
    const m = href.match(WATCH_RE);
    if (!m) return;
    const videoId = m[1];
    anchor.dataset.nlSearchInjected = '1';
    anchor.classList.add(ANCHOR_CLASS);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.dataset.videoId = videoId;
    btn.title = 'NicoListに追加';
    btn.setAttribute('aria-label', 'NicoListに追加');
    btn.innerHTML = ICON_PLUS;
    btn.addEventListener('click', onBtnClick);
    btn.addEventListener('contextmenu', onBtnContextMenu);
    // あとで見るでは行全体がリンクでボタンが文章に重なるため、サムネイルの上に置く
    let host = anchor;
    if (IS_WATCH_LATER) {
      const thumb = anchor.querySelector(THUMB_SEL);
      if (thumb) {
        host = thumb.tagName === 'IMG' ? (thumb.parentElement || anchor) : thumb;
        host.classList.add('nl-thumb-host');
        btn.classList.add('nl-on-thumb');
      }
    }
    host.appendChild(btn);
    injected.push({ anchor, btn, videoId });

    checkAddedState(btn, videoId);
  }

  // 通常のDOMに加えて、開いているシャドウDOMの中までリンクを探す
  function collectAnchors() {
    const out = [];
    const seen = new Set();
    const push = (a) => { if (!seen.has(a)) { seen.add(a); out.push(a); } };
    const walkRoot = (root) => {
      try {
        root.querySelectorAll('a[href*="/watch/"]').forEach(push);
        // 予備: 属性で拾えない場合は解決済みURL（hrefプロパティ）でも照合する
        root.querySelectorAll('a').forEach((a) => {
          const resolved = a.href || '';
          if (resolved.includes('nicovideo.jp/watch/')) push(a);
        });
        root.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) walkRoot(el.shadowRoot);
        });
      } catch (e) { /* 読めないルートは飛ばす */ }
    };
    walkRoot(document);
    return out;
  }

  // サムネイル相当の要素か見出しを含むリンクか（あとで見るの行リンク判定に使う。
  // あとで見るのサムネイルは img 要素ではなく、img だけでは1件も拾えない）
  const THUMB_SEL = 'img, picture, canvas, svg, [role="img"]';
  function hasThumbOrHeading(a) {
    return !!(a.querySelector(THUMB_SEL) || a.querySelector('h1, h2, h3, h4, h5, h6'));
  }

  function scan() {
    const anchors = collectAnchors();
    anchors.forEach((a) => {
      if (IS_WATCH_LATER) {
        if (!hasThumbOrHeading(a)) return; // 行リンクだけ（連続再生などのテキストリンクを除外）
      } else if (!a.querySelector('img')) {
        return; // サムネイルリンクだけ（タイトルリンクは除外）
      }
      injectButton(a);
    });
    if (IS_WATCH_LATER) {
      ensureBulkBar();
    } else {
      applyMutes();
      applyCounts();
      applyAds();
    }
  }

  const IS_WATCH_LATER = (location.pathname || '').startsWith('/my/watchlater');

  // ─── タグミュート（Fork版で追加） ───────────────────
  // 設定の mutedTags と各動画のタグを照合し、当てはまったカードを完全に隠す。
  const muteChecked = new Set();
  let muteFetching = false;

  function normalizeTag(t) {
    return String(t || '').trim().toLowerCase();
  }

  // サムネイルリンクを1つだけ含む一番上の祖先＝カード全体
  function findCard(anchor) {
    let card = anchor;
    let el = anchor;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      const parent = el.parentElement;
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
      const thumbs = Array.from(parent.querySelectorAll('a[href*="/watch/"]'))
        .filter((a) => a.querySelector('img'));
      if (thumbs.length !== 1) break;
      card = parent;
      el = parent;
    }
    return card;
  }

  function hideCard(anchor) {
    const card = findCard(anchor);
    card.style.display = 'none';
    card.dataset.nlMuted = '1';
  }

  async function applyMutes() {
    if (muteFetching) return;
    muteFetching = true;
    try {
      const settings = await getSettings();
      const muted = (settings.mutedTags || []).map(normalizeTag).filter(Boolean);
      if (!muted.length) return;
      const mutedSet = new Set(muted);

      const pending = injected.filter((r) => !muteChecked.has(r.videoId));
      if (!pending.length) return;

      const ids = [...new Set(pending.map((r) => r.videoId))];
      const res = await chrome.runtime.sendMessage({ action: 'fetchVideoTagsBatch', videoIds: ids });
      const tagsById = (res && res.tagsById) || {};
      ids.forEach((id) => muteChecked.add(id));
      for (const r of pending) {
        const tags = (tagsById[r.videoId] || []).map(normalizeTag);
        if (tags.some((t) => mutedSet.has(t))) hideCard(r.anchor);
      }
    } catch (e) {
      // 取得に失敗した時は隠さない（次回のスキャンで再試行する）
    } finally {
      muteFetching = false;
    }
  }

  // ─── ニコニ広告を隠す（Fork版で追加） ───────────────
  // 広告カードには「提供：」の表示があり、通常カードには無いことで判別する
  let adsFetching = false;
  async function applyAds() {
    if (adsFetching) return;
    adsFetching = true;
    try {
      const settings = await getSettings();
      if (settings.hideAds === false) return;
      for (const r of injected) {
        const card = findCard(r.anchor);
        if (!card || card.dataset.nlAdChecked) continue;
        card.dataset.nlAdChecked = '1';
        if (/提供[:：]/.test(card.textContent || '')) {
          card.style.display = 'none';
          card.dataset.nlAd = '1';
        }
      }
    } catch (e) {
      // 設定が取れない時は広告も隠さない
    } finally {
      adsFetching = false;
    }
  }

  // ─── マイリスト数の表示（Fork版で追加） ─────────────
  // サムネイル左下に「マイリスト N」のバッジを重ねる（クリックは透過）。
  const countsChecked = new Set();
  let countsFetching = false;

  async function applyCounts() {
    if (countsFetching) return;
    countsFetching = true;
    try {
      const pending = injected.filter((r) => !countsChecked.has(r.videoId) && !r.anchor.querySelector('.nl-mylist-badge'));
      if (!pending.length) { return; }

      const settings = await getSettings();
      const threshold = Math.max(0, parseInt(settings.mylistThreshold, 10) || 0);
      const ids = [...new Set(pending.map((r) => r.videoId))];
      const res = await chrome.runtime.sendMessage({ action: 'fetchVideoCountsBatch', videoIds: ids });
      const countsById = (res && res.countsById) || {};
      ids.forEach((id) => countsChecked.add(id));
      for (const r of pending) {
        const n = countsById[r.videoId];
        if (typeof n !== 'number') continue;
        // 足切り：しきい値未満はカードごと隠す（数が取れない動画は隠さない）
        if (threshold > 0 && n < threshold) {
          hideCard(r.anchor);
          continue;
        }
        if (r.anchor.querySelector('.nl-mylist-badge')) continue;
        const badge = document.createElement('span');
        badge.className = 'nl-mylist-badge';
        badge.textContent = `マイリスト ${n.toLocaleString('ja-JP')}`;
        r.anchor.appendChild(badge);
      }
    } catch (e) {
      // 取得に失敗した時は表示しない（次回のスキャンで再試行する）
    } finally {
      countsFetching = false;
    }
  }

  // ─── あとで見るページの一括追加（Fork版で追加） ────
  let bulkRunning = false;

  function ensureBulkBar() {
    let btn = document.querySelector('.nl-bulk-btn');
    if (!btn) {
      const bar = document.createElement('div');
      bar.className = 'nl-bulk-bar';
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nl-bulk-btn';
      btn.addEventListener('click', openBulkPicker);
      bar.appendChild(btn);
      document.body.appendChild(bar);
    }
    if (!bulkRunning) {
      btn.textContent = `このページの動画をNicoListへ一括追加（${injected.length}件）`;
    }
  }

  async function addQuiet(btn, videoId, listId) {
    try {
      const info = await chrome.runtime.sendMessage({ action: 'fetchVideoInfo', videoId });
      if (!info || info.error || !info.title) return 'failed';
      const result = await chrome.runtime.sendMessage({ action: 'addVideo', listId, videoInfo: info });
      if (result && result.success) { setAdded(btn); return 'added'; }
      if (result && /既に/.test(result.message || '')) { setAdded(btn); return 'exists'; }
      return 'failed';
    } catch (e) {
      return 'failed';
    }
  }

  async function openBulkPicker() {
    if (bulkRunning) return;
    if (!injected.length) {
      showToast('このページで動画リンクが見つかりませんでした');
      return;
    }
    closePicker();
    const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' }) || [];
    const overlay = document.createElement('div');
    overlay.className = 'nl-picker-overlay';
    const modal = document.createElement('div');
    modal.className = 'nl-picker-modal';
    const header = document.createElement('div');
    header.className = 'nl-picker-header';
    const title = document.createElement('span');
    title.textContent = '一括追加先のリストを選択';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nl-picker-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closePicker);
    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    if (!lists.length) {
      const empty = document.createElement('div');
      empty.className = 'nl-picker-empty';
      empty.textContent = 'リストがありません。拡張機能のポップアップからリストを作成してください。';
      modal.appendChild(empty);
    } else {
      const listBox = document.createElement('div');
      listBox.className = 'nl-picker-list';
      lists.forEach((list) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'nl-picker-item';
        const name = document.createElement('span');
        name.textContent = list.name;
        const count = document.createElement('span');
        count.className = 'nl-picker-count';
        count.textContent = `${list.videoCount || 0}動画`;
        item.appendChild(name);
        item.appendChild(count);
        item.addEventListener('click', async () => {
          closePicker();
          await runBulkAdd(list);
        });
        listBox.appendChild(item);
      });
      modal.appendChild(listBox);
      const note = document.createElement('div');
      note.className = 'nl-picker-note';
      note.textContent = `このページで見つかった ${injected.length} 件を、選んだリストへまとめて追加します。追加済みの動画はスキップされます`;
      modal.appendChild(note);
    }

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePicker(); });
    document.body.appendChild(overlay);
  }

  async function runBulkAdd(list) {
    if (bulkRunning) return;
    bulkRunning = true;
    const btn = document.querySelector('.nl-bulk-btn');
    const targets = injected.slice();
    let added = 0, exists = 0, failed = 0, done = 0;
    try {
      for (const r of targets) {
        const status = await addQuiet(r.btn, r.videoId, list.id);
        if (status === 'added') added++;
        else if (status === 'exists') exists++;
        else failed++;
        done++;
        if (btn) btn.textContent = `追加中… ${done}/${targets.length}`;
      }
      showToast(`一括追加が終わりました：${added}件を追加、${exists}件は追加済み、${failed}件は失敗`);
    } finally {
      bulkRunning = false;
      if (btn) btn.textContent = `このページの動画をNicoListへ一括追加（${injected.length}件）`;
    }
  }

  // ─── 再描画への追従（並び替え・ページ遷移はSPAで差し替わる） ──
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 250);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  scan();
})();
