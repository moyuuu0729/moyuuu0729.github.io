// ==UserScript==
// @name         Asmrgay 自訂強化播放器 (進退5秒 + 大標題列表 + 子資料夾斷點續掃 + 搜尋連播)
// @namespace    https://www.asmrgay.com/
// @version      2.1.0
// @description  為 asmrgay.com 打造手機與電腦皆適用的自訂音訊播放器，支援子資料夾斷點續掃與獨立儲存、搜尋相關度排序連播、進退5秒、完整多行標題大列表、倍速與睡眠定時。
// @match        https://www.asmrgay.com/*
// @match        https://asmrgay.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://moyuuu0729.github.io/asmrgay.user.js
// @downloadURL  https://moyuuu0729.github.io/asmrgay.user.js
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'asmrgay_custom_player_cfg_v2';
    const DEEP_LIST_STORAGE_KEY = 'asmrgay_deep_playlist_v1';
    const SCAN_STATE_STORAGE_KEY = 'asmrgay_scan_checkpoint_v1';

    const DEFAULT_CFG = {
        minimized: false,
        hideOriginal: false,
        loopMode: 'list', // 'list' | 'single' | 'none'
        playbackRate: 1.0,
        customListSelector: '',
        listMode: 'page' // 'page' | 'deep'
    };

    const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|ogg|aac|opus|webm)(\?.*)?$/i;
    const SKIP_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico|txt|lrc|vtt|srt|pdf|zip|rar|7z|tar|gz|css|js|json|xml|mp4|mkv|avi|mov)(\?.*)?$/i;

    const SCAN_MAX_DEPTH = 6;
    const SCAN_BATCH_FOLDERS = 300; // 每次連掃上限，達上限自動暫停存檔可繼續掃

    let cfg = loadConfig();
    let currentMedia = null;

    // 兩份獨立清單：本頁列表 vs. 另外持久儲存的子資料夾掃描庫
    let pagePlaylist = []; // [{ id, title, folder, el, type: 'click'|'audio', active }]
    let deepPlaylist = []; // [{ id, title, folder, path, sign, url, type: 'alist'|'url' }]
    let deepIdSet = new Set();

    // 斷點續掃狀態：{ rootPath, engine: 'pending'|'alist'|'html', queue: [], visited: [], scannedFolders: 0, completed: false, updatedAt }
    let scanState = null;

    // 列表視圖與實際播放狀態
    let listMode = cfg.listMode === 'deep' ? 'deep' : 'page';
    let playingSource = 'page'; // 'page' | 'deep'
    let currentTrackId = '';
    // 搜尋連播佇列：{ source: 'page'|'deep', keyword: string, ids: string[] } | null
    let searchPlayQueue = null;

    let isSeeking = false;
    let isPickingMode = false;
    let isScanning = false;
    let scanAbortCtrl = null;
    let lastSaveTs = 0;
    let sleepTimerId = null;
    let sleepEndTime = 0;
    let lastUrl = location.href;
    let ui = {};

    function loadConfig() {
        try {
            return Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
        } catch {
            return Object.assign({}, DEFAULT_CFG);
        }
    }

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        } catch {}
    }

    function makeTrackId(item, fallbackIdx = 0) {
        if (item.type === 'alist' && item.path) return `alist:${item.path}`;
        if (item.type === 'url' && item.url) return `url:${item.url}`;
        const href = item.el && item.el.href ? item.el.href : '';
        return `page:${item.type || 'click'}:${href || item.title || fallbackIdx}:${fallbackIdx}`;
    }

    function loadDeepStorage() {
        try {
            const rawList = JSON.parse(localStorage.getItem(DEEP_LIST_STORAGE_KEY) || 'null');
            if (rawList && Array.isArray(rawList.items)) {
                deepPlaylist = rawList.items
                    .filter(it => it && it.title && (it.path || it.url))
                    .map((it, idx) => ({
                        id: it.id || makeTrackId(it, idx),
                        title: it.title,
                        folder: it.folder || '',
                        path: it.path || '',
                        sign: it.sign || '',
                        url: it.url || '',
                        type: it.type || (it.path ? 'alist' : 'url')
                    }));
                deepIdSet = new Set(deepPlaylist.map(it => it.id));
            }
        } catch {
            deepPlaylist = [];
            deepIdSet = new Set();
        }

        try {
            const rawState = JSON.parse(localStorage.getItem(SCAN_STATE_STORAGE_KEY) || 'null');
            if (rawState && typeof rawState === 'object' && rawState.rootPath) {
                scanState = {
                    rootPath: rawState.rootPath,
                    engine: rawState.engine || 'pending',
                    queue: Array.isArray(rawState.queue) ? rawState.queue : [],
                    visited: Array.isArray(rawState.visited) ? rawState.visited : [],
                    scannedFolders: Number(rawState.scannedFolders) || 0,
                    completed: Boolean(rawState.completed),
                    updatedAt: Number(rawState.updatedAt) || Date.now()
                };
            }
        } catch {
            scanState = null;
        }
    }

    function saveDeepStorage(force = false) {
        const now = Date.now();
        if (!force && now - lastSaveTs < 700) return;
        lastSaveTs = now;

        try {
            const compactItems = deepPlaylist.map(it => ({
                id: it.id,
                title: it.title,
                folder: it.folder || '',
                path: it.path || '',
                sign: it.sign || '',
                url: it.url || '',
                type: it.type
            }));
            localStorage.setItem(DEEP_LIST_STORAGE_KEY, JSON.stringify({
                rootPath: scanState ? scanState.rootPath : '',
                updatedAt: now,
                items: compactItems
            }));
        } catch {
            if (force) showToast('⚠️ 子資料夾列表過大，瀏覽器儲存空間不足');
        }

        try {
            if (scanState) {
                scanState.updatedAt = now;
                localStorage.setItem(SCAN_STATE_STORAGE_KEY, JSON.stringify(scanState));
            } else {
                localStorage.removeItem(SCAN_STATE_STORAGE_KEY);
            }
        } catch {}
    }

    function hasPendingCheckpoint() {
        return Boolean(scanState && !scanState.completed && Array.isArray(scanState.queue) && scanState.queue.length > 0);
    }

    function getListBySource(source) {
        return source === 'deep' ? deepPlaylist : pagePlaylist;
    }

    function getActiveList() {
        return getListBySource(listMode);
    }

    function findTrackById(id, preferredSource) {
        if (!id) return null;
        const first = getListBySource(preferredSource || playingSource);
        let found = first.find(it => it.id === id);
        if (found) return { track: found, source: preferredSource || playingSource };
        const otherSource = (preferredSource || playingSource) === 'deep' ? 'page' : 'deep';
        found = getListBySource(otherSource).find(it => it.id === id);
        return found ? { track: found, source: otherSource } : null;
    }

    function getCurrentTrack() {
        const res = findTrackById(currentTrackId, playingSource);
        return res ? res.track : null;
    }

    // 載入已儲存的子資料夾庫與斷點進度
    loadDeepStorage();

    // 頁面關閉、重整或切背景時強制落盤保存斷點與列表
    const flushOnLeave = () => {
        if (isScanning || deepPlaylist.length > 0 || scanState) {
            saveDeepStorage(true);
        }
    };
    window.addEventListener('beforeunload', flushOnLeave);
    window.addEventListener('pagehide', flushOnLeave);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnLeave();
    });

    // ==========================================
    // 1. 音訊引擎 (內建獨立播放器 + 原站音訊攔截)
    // ==========================================
    const OrigAudio = window.Audio;
    const origPlay = HTMLMediaElement.prototype.play;

    const customAudio = new OrigAudio();
    customAudio.preload = 'metadata';

    HTMLMediaElement.prototype.play = function (...args) {
        if (this !== customAudio && (this.tagName === 'AUDIO' || this.tagName === 'VIDEO')) {
            if (!customAudio.paused) customAudio.pause();
            bindMedia(this);
        }
        return origPlay.apply(this, args);
    };

    if (typeof OrigAudio === 'function') {
        window.Audio = function (...args) {
            const instance = new OrigAudio(...args);
            bindMedia(instance);
            return instance;
        };
        window.Audio.prototype = OrigAudio.prototype;
    }

    function bindMedia(media) {
        if (!media || media === currentMedia) return;

        if (currentMedia) {
            unbindMediaEvents(currentMedia);
        }

        currentMedia = media;
        currentMedia.playbackRate = cfg.playbackRate || 1.0;

        currentMedia.addEventListener('timeupdate', onMediaUpdate);
        currentMedia.addEventListener('loadedmetadata', onMediaUpdate);
        currentMedia.addEventListener('durationchange', onMediaUpdate);
        currentMedia.addEventListener('play', onMediaPlayState);
        currentMedia.addEventListener('pause', onMediaPlayState);
        currentMedia.addEventListener('ended', onMediaEnded);
        currentMedia.addEventListener('volumechange', onVolumeUpdate);

        onMediaUpdate();
        onMediaPlayState();
        onVolumeUpdate();
        syncCurrentTrackHighlight();
        applyHideOriginal();
    }

    function unbindMediaEvents(media) {
        media.removeEventListener('timeupdate', onMediaUpdate);
        media.removeEventListener('loadedmetadata', onMediaUpdate);
        media.removeEventListener('durationchange', onMediaUpdate);
        media.removeEventListener('play', onMediaPlayState);
        media.removeEventListener('pause', onMediaPlayState);
        media.removeEventListener('ended', onMediaEnded);
        media.removeEventListener('volumechange', onVolumeUpdate);
    }

    function findExistingMedia() {
        if (currentMedia === customAudio && !customAudio.paused) return;
        const medias = Array.from(document.querySelectorAll('audio, video'));
        if (!medias.length) return;
        const playing = medias.find(m => !m.paused && m.currentTime > 0);
        const withSrc = medias.find(m => m.currentSrc || m.src);
        const target = playing || withSrc || medias[0];
        if (target && target !== currentMedia) {
            bindMedia(target);
        }
    }

    function updateMediaSession() {
        if (!('mediaSession' in navigator)) return;
        const item = getCurrentTrack();
        const title = item ? item.title : getFallbackTitle();
        const artist = (item && item.folder) ? item.folder : 'ASMRgay 自訂播放器';
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title,
                artist,
                album: searchPlayQueue ? `搜尋連播：${searchPlayQueue.keyword}` : 'ASMR 播放清單'
            });
            navigator.mediaSession.setActionHandler('play', () => togglePlay());
            navigator.mediaSession.setActionHandler('pause', () => togglePlay());
            navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-5));
            navigator.mediaSession.setActionHandler('seekforward', () => seekBy(5));
            navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
            navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
        } catch {}
    }

    // ==========================================
    // 2. 搜尋相關度排序 & 播放佇列管理
    // ==========================================
    function scoreSearchMatch(item, rawKeyword) {
        const q = (rawKeyword || '').trim().toLowerCase();
        if (!q) return 1;

        const tokens = q.split(/\s+/).filter(Boolean);
        const titleLower = (item.title || '').toLowerCase();
        const titleStem = titleLower.replace(AUDIO_EXT_RE, '');
        const folderLower = (item.folder || '').toLowerCase();
        const combined = `${titleLower} ${folderLower}`;

        // 每個關鍵字都必須出現在標題或資料夾中
        for (const tok of tokens) {
            if (!combined.includes(tok)) return 0;
        }

        let score = 10;

        // 1. 標題完整相符 / 開頭相符 / 完整片語命中
        if (titleStem === q || titleLower === q) {
            score += 1000;
        } else if (titleLower.startsWith(q)) {
            score += 650;
        } else {
            const fullIdx = titleLower.indexOf(q);
            if (fullIdx !== -1) {
                score += 420 - Math.min(160, fullIdx * 2);
            }
        }

        // 2. 所有關鍵字皆命中在標題內
        let allInTitle = true;
        for (const tok of tokens) {
            const tIdx = titleLower.indexOf(tok);
            if (tIdx !== -1) {
                score += 80 - Math.min(40, tIdx);
            } else {
                allInTitle = false;
                const fIdx = folderLower.indexOf(tok);
                if (fIdx !== -1) score += 25 - Math.min(15, Math.floor(fIdx / 4));
            }
        }
        if (allInTitle) score += 180;

        // 3. 資料夾完整片語加權
        if (folderLower.includes(q)) {
            score += 120;
        }

        // 4. 同等命中程度下，標題較精簡者略為優先
        score += Math.max(0, 40 - Math.floor(titleStem.length / 4));

        return score;
    }

    function getFilteredSortedEntries(list, rawKeyword) {
        const kw = (rawKeyword || '').trim();
        if (!kw) {
            return list.map((item, idx) => ({ item, idx, score: 0 }));
        }

        const matched = [];
        for (let idx = 0; idx < list.length; idx++) {
            const item = list[idx];
            const score = scoreSearchMatch(item, kw);
            if (score > 0) {
                matched.push({ item, idx, score });
            }
        }

        matched.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.idx - b.idx;
        });

        return matched;
    }

    function getLiveSearchKeyword() {
        return (ui.searchInput ? ui.searchInput.value : '').trim();
    }

    function clearSearchPlayQueue() {
        searchPlayQueue = null;
        updateHeaderTitle();
        updateMediaSession();
    }

    // 取得目前「上一首 / 下一首 / 自動連播」實際採用的曲目 ID 順序
    function getActivePlaybackQueueInfo() {
        const liveKw = getLiveSearchKeyword();

        // 若搜尋框有輸入關鍵字，且尚未鎖定或關鍵字已變更，直接即時同步為該搜尋結果排序
        if (liveKw) {
            if (!searchPlayQueue || searchPlayQueue.keyword !== liveKw || searchPlayQueue.source !== listMode) {
                const entries = getFilteredSortedEntries(getActiveList(), liveKw);
                if (entries.length > 0) {
                    searchPlayQueue = {
                        source: listMode,
                        keyword: liveKw,
                        ids: entries.map(e => e.item.id)
                    };
                }
            }
        }

        if (searchPlayQueue && searchPlayQueue.ids.length > 0) {
            const list = getListBySource(searchPlayQueue.source);
            const idSet = new Set(list.map(it => it.id));
            const validIds = searchPlayQueue.ids.filter(id => idSet.has(id));
            if (validIds.length > 0) {
                return {
                    source: searchPlayQueue.source,
                    ids: validIds,
                    isSearchQueue: true,
                    keyword: searchPlayQueue.keyword
                };
            }
        }

        const list = getListBySource(playingSource);
        if (list.length > 0) {
            return {
                source: playingSource,
                ids: list.map(it => it.id),
                isSearchQueue: false,
                keyword: ''
            };
        }

        const fallbackList = getActiveList();
        return {
            source: listMode,
            ids: fallbackList.map(it => it.id),
            isSearchQueue: false,
            keyword: ''
        };
    }

    // ==========================================
    // 3. 路徑工具 & 子資料夾斷點遞迴掃描引擎
    // ==========================================
    function normalizePath(pathname) {
        let p = pathname || '/';
        try { p = decodeURIComponent(p); } catch {}
        if (!p.startsWith('/')) p = '/' + p;
        if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
        return p;
    }

    function encodePathSegments(path) {
        return path.split('/').map(seg => encodeURIComponent(seg)).join('/');
    }

    function joinPath(base, name) {
        const cleanBase = base === '/' ? '' : base.replace(/\/+$/, '');
        const cleanName = name.replace(/^\/+/, '');
        return `${cleanBase}/${cleanName}`;
    }

    function naturalSort(a, b) {
        return a.localeCompare(b, 'zh-Hant', { numeric: true, sensitivity: 'base' });
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(t);
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            }
        });
    }

    function getAuthHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        try {
            const token = localStorage.getItem('token');
            if (token) headers['Authorization'] = token;
        } catch {}
        return headers;
    }

    async function alistPost(endpoint, payload, signal) {
        const res = await fetch(`${location.origin}${endpoint}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(payload),
            credentials: 'same-origin',
            signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }

    async function fetchAlistFolderAll(dirPath, signal) {
        const first = await alistPost('/api/fs/list', {
            path: dirPath,
            password: '',
            page: 1,
            per_page: 0,
            refresh: false
        }, signal);

        if (!first || first.code !== 200 || !first.data) {
            throw new Error(first ? `AList code ${first.code}` : 'Invalid AList response');
        }

        let content = Array.isArray(first.data.content) ? first.data.content.slice() : [];
        const total = first.data.total || content.length;

        if (total > content.length && content.length > 0) {
            const pageSize = content.length;
            const totalPages = Math.ceil(total / pageSize);
            for (let page = 2; page <= totalPages; page++) {
                if (signal && signal.aborted) break;
                const next = await alistPost('/api/fs/list', {
                    path: dirPath,
                    password: '',
                    page,
                    per_page: pageSize,
                    refresh: false
                }, signal);
                if (next && next.code === 200 && next.data && Array.isArray(next.data.content)) {
                    content = content.concat(next.data.content);
                } else {
                    break;
                }
            }
        }
        return content;
    }

    async function resolveAlistAudioUrl(item) {
        if (item.resolvedUrl && Date.now() - (item.resolvedAt || 0) < 20 * 60 * 1000) {
            return item.resolvedUrl;
        }

        try {
            const res = await alistPost('/api/fs/get', {
                path: item.path,
                password: ''
            });
            if (res && res.code === 200 && res.data && (res.data.raw_url || res.data.url)) {
                item.resolvedUrl = res.data.raw_url || res.data.url;
                item.resolvedAt = Date.now();
                return item.resolvedUrl;
            }
        } catch {}

        const signQuery = item.sign ? `?sign=${encodeURIComponent(item.sign)}` : '';
        return `${location.origin}/d${encodePathSegments(item.path)}${signQuery}`;
    }

    function addDeepTrack(track) {
        const id = track.id || makeTrackId(track);
        if (deepIdSet.has(id)) return false;
        deepIdSet.add(id);
        deepPlaylist.push(Object.assign({}, track, { id }));
        return true;
    }

    function updateScanControlsUI(liveText = '') {
        const pending = hasPendingCheckpoint();
        const pendingCount = pending ? scanState.queue.length : 0;

        if (ui.scanDockBtn) {
            if (isScanning) {
                ui.scanDockBtn.textContent = '⏹ 停止掃描';
                ui.scanDockBtn.classList.add('active');
            } else if (pending) {
                ui.scanDockBtn.textContent = `▶ 繼續掃描 (餘${pendingCount})`;
                ui.scanDockBtn.classList.remove('active');
            } else {
                ui.scanDockBtn.textContent = '📂 掃描子資料夾';
                ui.scanDockBtn.classList.remove('active');
            }
        }

        if (ui.scanDrawerBtn) {
            if (isScanning) {
                ui.scanDrawerBtn.textContent = '⏹ 停止掃描';
                ui.scanDrawerBtn.classList.add('active');
            } else if (pending) {
                ui.scanDrawerBtn.textContent = `▶ 繼續掃描 (餘${pendingCount})`;
                ui.scanDrawerBtn.classList.remove('active');
            } else {
                ui.scanDrawerBtn.textContent = '📂 掃描子資料夾';
                ui.scanDrawerBtn.classList.remove('active');
            }
        }

        if (!ui.scanBar) return;

        const shouldShowBar = isScanning || pending || (listMode === 'deep' && deepPlaylist.length > 0);
        ui.scanBar.classList.toggle('hidden', !shouldShowBar);

        if (ui.stopScanBtn) ui.stopScanBtn.classList.toggle('hidden', !isScanning);
        if (ui.resumeScanBtn) ui.resumeScanBtn.classList.toggle('hidden', isScanning || !pending);
        if (ui.restartScanBtn) ui.restartScanBtn.classList.toggle('hidden', isScanning || (!pending && deepPlaylist.length === 0));
        if (ui.clearDeepBtn) ui.clearDeepBtn.classList.toggle('hidden', isScanning || (deepPlaylist.length === 0 && !scanState));

        if (ui.scanStatusText) {
            if (isScanning) {
                ui.scanStatusText.textContent = liveText || '正在掃描子資料夾...';
            } else if (pending) {
                ui.scanStatusText.textContent = `⏸ 已記錄斷點（${scanState.rootPath}）：已掃 ${scanState.scannedFolders} 夾 · 剩餘 ${pendingCount} 夾 · 已存 ${deepPlaylist.length} 首`;
            } else if (deepPlaylist.length > 0) {
                const rootLabel = scanState && scanState.rootPath ? `（${scanState.rootPath}）` : '';
                ui.scanStatusText.textContent = `✅ 子資料夾庫已儲存${rootLabel}：共 ${deepPlaylist.length} 首`;
            }
        }

        updateTabBadges();
    }

    function stopSubfolderScan() {
        if (scanAbortCtrl) {
            scanAbortCtrl.abort();
            scanAbortCtrl = null;
        }
        isScanning = false;
        saveDeepStorage(true);
        updateScanControlsUI();
        const remain = hasPendingCheckpoint() ? `，已記錄斷點（剩餘 ${scanState.queue.length} 夾），下次可繼續掃` : '';
        showToast(`已停止掃描，保留 ${deepPlaylist.length} 個音檔${remain}`, 3200);
    }

    function clearDeepLibrary() {
        if (isScanning) stopSubfolderScan();
        if (deepPlaylist.length > 0 && !confirm(`確定要清空已儲存的 ${deepPlaylist.length} 首子資料夾清單與掃描斷點嗎？`)) {
            return;
        }
        deepPlaylist = [];
        deepIdSet.clear();
        scanState = null;
        if (searchPlayQueue && searchPlayQueue.source === 'deep') {
            searchPlayQueue = null;
        }
        saveDeepStorage(true);
        updateScanControlsUI();
        renderPlaylistUI();
        updateHeaderTitle();
        showToast('已清空子資料夾庫與斷點紀錄');
    }

    function handlePrimaryScanButtonClick() {
        if (isScanning) {
            stopSubfolderScan();
            return;
        }
        if (hasPendingCheckpoint()) {
            startSubfolderScan({ resume: true });
        } else {
            startSubfolderScan({ resume: false });
        }
    }

    async function startSubfolderScan({ resume = false, clearExisting = false } = {}) {
        if (isScanning) {
            stopSubfolderScan();
            return;
        }

        const currentPath = normalizePath(location.pathname);
        const canResume = resume && hasPendingCheckpoint() && scanState.engine !== 'pending';

        if (!canResume) {
            if (clearExisting && deepPlaylist.length > 0) {
                deepPlaylist = [];
                deepIdSet.clear();
            }
            scanState = {
                rootPath: currentPath,
                engine: 'pending',
                queue: [],
                visited: [currentPath],
                scannedFolders: 0,
                completed: false,
                updatedAt: Date.now()
            };
            saveDeepStorage(true);
        }

        // 自動切換到「子資料夾庫」分頁並開啟抽屜
        setListMode('deep', false);
        toggleDrawer(true, true);

        isScanning = true;
        scanAbortCtrl = new AbortController();
        const signal = scanAbortCtrl.signal;

        const visitedSet = new Set(scanState.visited);
        let batchScanned = 0;
        let lastRenderTime = 0;

        const flushUI = (force = false) => {
            const now = Date.now();
            if (force || now - lastRenderTime > 260) {
                lastRenderTime = now;
                renderPlaylistUI();
                updateHeaderTitle();
                updateTabBadges();
            }
            saveDeepStorage(force);
        };

        updateScanControlsUI(
            canResume
                ? `▶ 從斷點繼續掃描（已掃 ${scanState.scannedFolders} 夾，待掃 ${scanState.queue.length} 夾）...`
                : '正在偵測目錄架構並開始掃描子資料夾...'
        );

        try {
            // === 初次啟動：決定引擎並掃描根目錄 ===
            if (!canResume || scanState.engine === 'pending') {
                let rootContent = null;
                let useHtmlFallback = false;
                try {
                    rootContent = await fetchAlistFolderAll(scanState.rootPath, signal);
                } catch (err) {
                    if (err && err.name === 'AbortError') throw err;
                    useHtmlFallback = true;
                }

                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

                if (!useHtmlFallback && rootContent) {
                    scanState.engine = 'alist';
                    const dirs = rootContent.filter(e => e.is_dir).sort((a, b) => naturalSort(a.name, b.name));
                    const files = rootContent.filter(e => !e.is_dir && AUDIO_EXT_RE.test(e.name)).sort((a, b) => naturalSort(a.name, b.name));

                    for (const f of files) {
                        addDeepTrack({
                            title: f.name,
                            folder: '目前資料夾',
                            path: joinPath(scanState.rootPath, f.name),
                            sign: f.sign || '',
                            type: 'alist'
                        });
                    }

                    for (const d of dirs) {
                        const childPath = joinPath(scanState.rootPath, d.name);
                        if (!visitedSet.has(childPath)) {
                            visitedSet.add(childPath);
                            scanState.visited.push(childPath);
                            scanState.queue.push({
                                path: childPath,
                                relFolder: d.name,
                                depth: 1
                            });
                        }
                    }

                    scanState.scannedFolders++;
                    batchScanned++;
                    flushUI(true);
                } else {
                    scanState.engine = 'html';
                    extractHtmlDocToDeepQueue(document, location.href, scanState.rootPath, scanState.rootPath, 0, visitedSet);
                    scanState.scannedFolders++;
                    batchScanned++;
                    flushUI(true);
                }
            }

            // === 依引擎繼續掃描剩餘佇列 ===
            if (scanState.engine === 'alist') {
                while (scanState.queue.length > 0 && batchScanned < SCAN_BATCH_FOLDERS) {
                    if (signal.aborted) break;
                    // 先讀取佇列頭但不移出，確保中途停止或重整不會遺漏此資料夾
                    const node = scanState.queue[0];

                    let entries = null;
                    try {
                        entries = await fetchAlistFolderAll(node.path, signal);
                    } catch (err) {
                        if (err && err.name === 'AbortError') break;
                        // 單一資料夾讀取失敗（例如無權限）則跳過並移出佇列
                        scanState.queue.shift();
                        scanState.scannedFolders++;
                        batchScanned++;
                        saveDeepStorage(false);
                        continue;
                    }

                    if (signal.aborted) break;

                    const dirs = entries.filter(e => e.is_dir).sort((a, b) => naturalSort(a.name, b.name));
                    const files = entries.filter(e => !e.is_dir && AUDIO_EXT_RE.test(e.name)).sort((a, b) => naturalSort(a.name, b.name));

                    for (const f of files) {
                        addDeepTrack({
                            title: f.name,
                            folder: node.relFolder || '目前資料夾',
                            path: joinPath(node.path, f.name),
                            sign: f.sign || '',
                            type: 'alist'
                        });
                    }

                    if (node.depth < SCAN_MAX_DEPTH) {
                        for (const d of dirs) {
                            const childPath = joinPath(node.path, d.name);
                            if (!visitedSet.has(childPath)) {
                                visitedSet.add(childPath);
                                scanState.visited.push(childPath);
                                scanState.queue.push({
                                    path: childPath,
                                    relFolder: node.relFolder ? `${node.relFolder} / ${d.name}` : d.name,
                                    depth: node.depth + 1
                                });
                            }
                        }
                    }

                    // 完整處理完該資料夾後才移出佇列並推進計數
                    scanState.queue.shift();
                    scanState.scannedFolders++;
                    batchScanned++;

                    updateScanControlsUI(`⏳ 已掃 ${scanState.scannedFolders} 夾（待掃 ${scanState.queue.length} 夾），子資料夾庫 ${deepPlaylist.length} 首...`);
                    flushUI();

                    if (scanState.queue.length > 0 && batchScanned < SCAN_BATCH_FOLDERS) {
                        await sleep(90, signal);
                    }
                }
            } else if (scanState.engine === 'html') {
                const parser = new DOMParser();
                while (scanState.queue.length > 0 && batchScanned < 150) {
                    if (signal.aborted) break;
                    const batch = scanState.queue.slice(0, 3);
                    const finishedPaths = new Set();

                    await Promise.all(batch.map(async (item) => {
                        if (signal.aborted) return;
                        try {
                            const res = await fetch(item.url, { credentials: 'same-origin', signal });
                            if (signal.aborted) return;
                            const ct = res.headers.get('content-type') || '';
                            if (res.ok && ct.includes('text/html')) {
                                const html = await res.text();
                                if (signal.aborted) return;
                                const doc = parser.parseFromString(html, 'text/html');
                                extractHtmlDocToDeepQueue(doc, item.url, item.path, scanState.rootPath, item.depth, visitedSet);
                            }
                            finishedPaths.add(item.path);
                            scanState.scannedFolders++;
                            batchScanned++;
                        } catch (err) {
                            if (err && err.name === 'AbortError') return;
                            finishedPaths.add(item.path);
                            scanState.scannedFolders++;
                            batchScanned++;
                        }
                    }));

                    scanState.queue = scanState.queue.filter(q => !finishedPaths.has(q.path));
                    updateScanControlsUI(`⏳ 網頁爬蟲已掃 ${scanState.scannedFolders} 頁（待掃 ${scanState.queue.length} 頁），共 ${deepPlaylist.length} 首...`);
                    flushUI();

                    if (scanState.queue.length > 0 && batchScanned < 150) {
                        await sleep(120, signal);
                    }
                }
            }

            if (!signal.aborted) {
                if (scanState.queue.length === 0) {
                    scanState.completed = true;
                    flushUI(true);
                    if (deepPlaylist.length > 0) {
                        showToast(`掃描完成！共掃 ${scanState.scannedFolders} 夾，子資料夾庫共 ${deepPlaylist.length} 首`, 3500);
                    } else {
                        showToast(`已掃描 ${scanState.scannedFolders} 個資料夾，未發現支援格式的音檔`, 3500);
                    }
                } else {
                    // 達到單次掃描上限，自動保存斷點
                    scanState.completed = false;
                    flushUI(true);
                    showToast(`本輪已掃 ${batchScanned} 夾，已保存斷點（剩餘 ${scanState.queue.length} 夾），點「▶ 繼續掃描」可接續`, 4000);
                }
            }
        } catch (err) {
            if (err && err.name !== 'AbortError') {
                showToast(`掃描發生錯誤：${err.message || '無法讀取子資料夾'}（已保存目前進度）`, 3500);
            }
        } finally {
            isScanning = false;
            scanAbortCtrl = null;
            saveDeepStorage(true);
            updateScanControlsUI();
            renderPlaylistUI();
            updateHeaderTitle();
        }
    }

    function extractHtmlDocToDeepQueue(doc, baseUrl, currentNormPath, startPath, depth, visitedSet) {
        const folderLabel = currentNormPath === startPath
            ? '目前資料夾'
            : currentNormPath.slice(startPath.length).replace(/^\/+/, '');

        doc.querySelectorAll('audio[src], audio source[src]').forEach(node => {
            const rawSrc = node.getAttribute('src');
            if (!rawSrc) return;
            try {
                const abs = new URL(rawSrc, baseUrl).href;
                const name = decodeURIComponent(abs.split('/').pop().split('?')[0]) || '音檔';
                addDeepTrack({ title: name, folder: folderLabel, url: abs, type: 'url' });
            } catch {}
        });

        doc.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href');
            if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
            let urlObj;
            try {
                urlObj = new URL(href, baseUrl);
            } catch {
                return;
            }
            if (urlObj.origin !== location.origin) return;

            const linkPath = normalizePath(urlObj.pathname);
            const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();

            if (AUDIO_EXT_RE.test(linkPath) || AUDIO_EXT_RE.test(text)) {
                const abs = urlObj.href;
                const fileName = text && text.length > 1
                    ? text
                    : decodeURIComponent(linkPath.split('/').pop() || '音檔');
                addDeepTrack({ title: fileName, folder: folderLabel, url: abs, type: 'url' });
                return;
            }

            const isChildOfStart = startPath === '/'
                ? linkPath !== '/'
                : linkPath.startsWith(startPath + '/');

            if (
                depth < SCAN_MAX_DEPTH &&
                isChildOfStart &&
                !SKIP_EXT_RE.test(linkPath) &&
                !visitedSet.has(linkPath)
            ) {
                visitedSet.add(linkPath);
                scanState.visited.push(linkPath);
                scanState.queue.push({ url: urlObj.href, path: linkPath, depth: depth + 1 });
            }
        });
    }

    // ==========================================
    // 4. 當前頁面播放清單自動掃描器 (獨立於子資料夾庫)
    // ==========================================
    const PRESET_SELECTORS = [
        '.aplayer-list ol li',
        '.wp-playlist-item',
        '.playlist-item',
        '[class*="playlist"] li',
        '[class*="audio-list"] li',
        '[class*="track-list"] li',
        '[class*="song-list"] li',
        '.obj-box a',
        '.list-item'
    ];

    function cleanTitle(el) {
        if (!el) return '';
        const titleEl = el.querySelector('.aplayer-list-title, .wp-playlist-item-title, .title, .name, [class*="title"], [class*="name"]');
        let text =
            (titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) ||
            el.getAttribute('title') ||
            el.getAttribute('data-title') ||
            el.innerText ||
            el.textContent ||
            '';
        return text.replace(/\s+/g, ' ').trim();
    }

    function isElementActive(el) {
        if (!el) return false;
        const cls = (el.className || '').toString().toLowerCase();
        return (
            cls.includes('aplayer-list-light') ||
            cls.includes('active') ||
            cls.includes('playing') ||
            cls.includes('current') ||
            cls.includes('selected') ||
            el.getAttribute('aria-current') === 'true'
        );
    }

    function scanPagePlaylist() {
        let items = [];

        if (cfg.customListSelector) {
            try {
                const nodes = Array.from(document.querySelectorAll(cfg.customListSelector)).filter(n => n.offsetParent !== null || n.textContent.trim());
                if (nodes.length > 0) {
                    items = nodes.map(el => ({
                        title: cleanTitle(el),
                        folder: '',
                        el,
                        type: 'click',
                        active: isElementActive(el)
                    })).filter(i => i.title);
                }
            } catch {}
        }

        if (items.length === 0) {
            for (const sel of PRESET_SELECTORS) {
                const nodes = Array.from(document.querySelectorAll(sel));
                if (nodes.length >= 1) {
                    const parsed = nodes
                        .map(el => ({
                            title: cleanTitle(el),
                            folder: '',
                            el,
                            type: 'click',
                            active: isElementActive(el)
                        }))
                        .filter(i => i.title && i.title.length > 1);

                    if (sel === '.obj-box a' || sel === '.list-item') {
                        const audioOnly = parsed.filter(i => AUDIO_EXT_RE.test(i.title) || AUDIO_EXT_RE.test(i.el.href || ''));
                        if (audioOnly.length > 0) {
                            items = audioOnly;
                            break;
                        }
                    } else if (parsed.length > 0) {
                        items = parsed;
                        break;
                    }
                }
            }
        }

        if (items.length === 0) {
            const links = Array.from(document.querySelectorAll('a[href]')).filter(a => AUDIO_EXT_RE.test(a.href) || AUDIO_EXT_RE.test(a.textContent));
            if (links.length > 0) {
                items = links.map(el => ({
                    title: cleanTitle(el) || decodeURIComponent(el.href.split('/').pop()),
                    folder: '',
                    el,
                    type: 'click',
                    active: isElementActive(el)
                }));
            }
        }

        if (items.length === 0) {
            const audios = Array.from(document.querySelectorAll('audio'));
            if (audios.length > 0) {
                items = audios.map((el, idx) => {
                    const src = el.currentSrc || el.src || '';
                    let guessTitle = '';
                    const prev = el.previousElementSibling;
                    if (prev && prev.textContent.trim().length > 1 && prev.textContent.trim().length < 150) {
                        guessTitle = prev.textContent.trim();
                    } else if (src) {
                        try {
                            guessTitle = decodeURIComponent(src.split('/').pop().split('?')[0]);
                        } catch {
                            guessTitle = src.split('/').pop();
                        }
                    }
                    return {
                        title: guessTitle || `音檔 #${idx + 1}`,
                        folder: '',
                        el,
                        type: 'audio',
                        active: el === currentMedia
                    };
                });
            }
        }

        pagePlaylist = items.map((it, idx) => Object.assign({}, it, { id: makeTrackId(it, idx) }));

        if (playingSource === 'page' && (!currentMedia || currentMedia !== customAudio)) {
            const activeItem = pagePlaylist.find(i => i.active);
            if (activeItem) currentTrackId = activeItem.id;
        }

        updateTabBadges();
        if (listMode === 'page') {
            renderPlaylistUI();
        }
        updateHeaderTitle();
    }

    async function playTrack(item, source, newSearchQueue = undefined) {
        if (!item) return;

        playingSource = source || listMode;
        currentTrackId = item.id;

        if (newSearchQueue !== undefined) {
            searchPlayQueue = newSearchQueue;
        }

        updateHeaderTitle();
        renderPlaylistUI();
        updateMediaSession();

        if (item.type === 'alist' || item.type === 'url') {
            if (currentMedia && currentMedia !== customAudio && !currentMedia.paused) {
                currentMedia.pause();
            }
            bindMedia(customAudio);

            let targetUrl = item.url;
            if (item.type === 'alist') {
                showToast('正在載入音檔連結...', 1500);
                targetUrl = await resolveAlistAudioUrl(item);
                if (currentTrackId !== item.id) return;
            }

            if (!targetUrl) {
                showToast('無法取得此音檔的播放連結');
                return;
            }

            customAudio.src = targetUrl;
            customAudio.playbackRate = cfg.playbackRate || 1.0;
            try {
                await origPlay.call(customAudio);
            } catch {
                showToast('播放失敗或瀏覽器阻擋，請再點擊播放鍵一次');
            }
            return;
        }

        if (item.type === 'audio') {
            if (!customAudio.paused) customAudio.pause();
            if (currentMedia && currentMedia !== item.el) {
                currentMedia.pause();
            }
            bindMedia(item.el);
            item.el.play().catch(() => {});
        } else if (item.el) {
            if (!customAudio.paused) customAudio.pause();
            item.el.click();
            setTimeout(() => {
                findExistingMedia();
                if (currentMedia && currentMedia.paused) {
                    currentMedia.play().catch(() => {});
                }
                syncCurrentTrackHighlight();
            }, 350);
        }
    }

    function syncCurrentTrackHighlight() {
        if (!pagePlaylist.length || currentMedia === customAudio) return;
        let changed = false;
        pagePlaylist.forEach((item) => {
            const act = item.type === 'audio' ? item.el === currentMedia : isElementActive(item.el);
            if (act && (playingSource !== 'page' || currentTrackId !== item.id)) {
                playingSource = 'page';
                currentTrackId = item.id;
                changed = true;
            }
            item.active = act;
        });
        if (changed) {
            renderPlaylistUI();
            updateHeaderTitle();
            updateMediaSession();
        }
    }

    function getFallbackTitle() {
        const apTitle = document.querySelector('.aplayer-title');
        if (apTitle && apTitle.textContent.trim()) return apTitle.textContent.trim();

        const h1 = document.querySelector('h1, .entry-title, .post-title');
        if (h1 && h1.textContent.trim()) return h1.textContent.trim();

        if (currentMedia && (currentMedia.currentSrc || currentMedia.src)) {
            try {
                return decodeURIComponent((currentMedia.currentSrc || currentMedia.src).split('/').pop().split('?')[0]);
            } catch {}
        }
        return document.title || '等待音檔載入（可點「📂 掃描子資料夾」）';
    }

    // ==========================================
    // 5. 播放控制動作 (完整支援搜尋佇列連播)
    // ==========================================
    function togglePlay() {
        if (!currentMedia) findExistingMedia();
        if (!currentMedia) {
            const qInfo = getActivePlaybackQueueInfo();
            if (qInfo.ids.length > 0) {
                const targetId = qInfo.ids.includes(currentTrackId) ? currentTrackId : qInfo.ids[0];
                const found = findTrackById(targetId, qInfo.source);
                if (found) {
                    playTrack(found.track, found.source);
                    return;
                }
            }
            showToast('尚未偵測到音檔，請點「📂 掃描子資料夾」或原站播放鍵');
            return;
        }
        if (currentMedia.paused) {
            const playFn = currentMedia === customAudio ? origPlay.call(customAudio) : currentMedia.play();
            Promise.resolve(playFn).catch(() => showToast('瀏覽器阻擋自動播放，請再點一次'));
        } else {
            currentMedia.pause();
        }
    }

    function seekBy(seconds) {
        if (!currentMedia) findExistingMedia();
        if (!currentMedia) return;
        const dur = isFinite(currentMedia.duration) ? currentMedia.duration : Infinity;
        const target = Math.max(0, Math.min(dur, currentMedia.currentTime + seconds));
        currentMedia.currentTime = target;
        onMediaUpdate();
        showToast(seconds > 0 ? `快進 +${seconds} 秒` : `倒退 ${seconds} 秒`);
    }

    function stepTrack(delta) {
        const qInfo = getActivePlaybackQueueInfo();
        if (!qInfo.ids.length) {
            seekBy(delta > 0 ? 15 : -15);
            return;
        }

        const curPos = qInfo.ids.indexOf(currentTrackId);
        let nextPos;
        if (curPos === -1) {
            nextPos = delta > 0 ? 0 : qInfo.ids.length - 1;
        } else {
            nextPos = (curPos + delta + qInfo.ids.length) % qInfo.ids.length;
        }

        const nextId = qInfo.ids[nextPos];
        const found = findTrackById(nextId, qInfo.source);
        if (found) {
            playTrack(found.track, found.source);
        }
    }

    function playPrev() {
        stepTrack(-1);
    }

    function playNext() {
        stepTrack(1);
    }

    function onMediaEnded() {
        if (!currentMedia) return;
        const endedSrc = currentMedia.currentSrc || currentMedia.src;

        if (cfg.loopMode === 'single') {
            currentMedia.currentTime = 0;
            const p = currentMedia === customAudio ? origPlay.call(customAudio) : currentMedia.play();
            Promise.resolve(p).catch(() => {});
            return;
        }

        const qInfo = getActivePlaybackQueueInfo();
        if (cfg.loopMode === 'list' && qInfo.ids.length > 1) {
            if (currentMedia === customAudio) {
                playNext();
                return;
            }
            setTimeout(() => {
                if (!currentMedia) return;
                const nowSrc = currentMedia.currentSrc || currentMedia.src;
                if (nowSrc === endedSrc && currentMedia.paused) {
                    playNext();
                }
            }, 800);
        }
    }

    function cycleSpeed() {
        const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];
        const idx = speeds.indexOf(cfg.playbackRate);
        cfg.playbackRate = speeds[(idx + 1) % speeds.length];
        if (currentMedia) currentMedia.playbackRate = cfg.playbackRate;
        saveConfig();
        if (ui.speedBtn) ui.speedBtn.textContent = `${cfg.playbackRate}x`;
        showToast(`播放速度：${cfg.playbackRate}x`);
    }

    function cycleLoopMode() {
        const modes = ['list', 'single', 'none'];
        const labels = { list: '🔁 列表', single: '🔂 單曲', none: '➡️ 單次' };
        const idx = modes.indexOf(cfg.loopMode);
        cfg.loopMode = modes[(idx + 1) % modes.length];
        saveConfig();
        if (ui.loopBtn) ui.loopBtn.textContent = labels[cfg.loopMode];
        showToast(`循環模式：${labels[cfg.loopMode]}`);
    }

    function cycleSleepTimer() {
        const remainingMin = sleepEndTime > Date.now() ? Math.ceil((sleepEndTime - Date.now()) / 60000) : 0;
        let nextMin = 15;
        if (remainingMin === 0) nextMin = 15;
        else if (remainingMin <= 15) nextMin = 30;
        else if (remainingMin <= 30) nextMin = 60;
        else nextMin = 0;

        if (sleepTimerId) {
            clearInterval(sleepTimerId);
            sleepTimerId = null;
        }

        if (nextMin === 0) {
            sleepEndTime = 0;
            if (ui.sleepBtn) ui.sleepBtn.textContent = '🌙 定時';
            showToast('已關閉睡眠定時');
            return;
        }

        sleepEndTime = Date.now() + nextMin * 60000;
        showToast(`已設定 ${nextMin} 分鐘後自動暫停`);
        updateSleepBtn();
        sleepTimerId = setInterval(() => {
            if (Date.now() >= sleepEndTime) {
                clearInterval(sleepTimerId);
                sleepTimerId = null;
                sleepEndTime = 0;
                if (currentMedia && !currentMedia.paused) currentMedia.pause();
                if (ui.sleepBtn) ui.sleepBtn.textContent = '🌙 定時';
                showToast('睡眠定時時間到，已自動暫停');
            } else {
                updateSleepBtn();
            }
        }, 15000);
    }

    function updateSleepBtn() {
        if (!ui.sleepBtn) return;
        const left = Math.max(1, Math.ceil((sleepEndTime - Date.now()) / 60000));
        ui.sleepBtn.textContent = `🌙 ${left}m`;
    }

    function applyHideOriginal() {
        const styleId = 'asmr-cp-hide-original-style';
        let styleEl = document.getElementById(styleId);
        if (cfg.hideOriginal) {
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = styleId;
                styleEl.textContent = `
                    .aplayer, audio, .wp-audio-shortcode, .mejs-container {
                        opacity: 0 !important;
                        max-height: 0 !important;
                        min-height: 0 !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        overflow: hidden !important;
                        pointer-events: none !important;
                    }
                `;
                document.head.appendChild(styleEl);
            }
        } else if (styleEl) {
            styleEl.remove();
        }
        if (ui.hideOrigBtn) {
            ui.hideOrigBtn.classList.toggle('active', cfg.hideOriginal);
            ui.hideOrigBtn.textContent = cfg.hideOriginal ? '👁️ 顯示原版' : '🙈 隱藏原版';
        }
    }

    // ==========================================
    // 6. 手動定位本頁列表模式
    // ==========================================
    function startPickListMode() {
        isPickingMode = true;
        toggleDrawer(false);
        showToast('請直接點擊網頁原本的「任一首曲目」，腳本將自動擷取本頁清單', 5000);

        const onPickClick = (e) => {
            if (!isPickingMode) return;
            if (e.target && e.target.id === 'asmr-cp-host') return;

            e.preventDefault();
            e.stopPropagation();
            isPickingMode = false;
            document.removeEventListener('click', onPickClick, true);

            const selector = inferListSelector(e.target);
            if (selector) {
                cfg.customListSelector = selector;
                saveConfig();
                setListMode('page', false);
                scanPagePlaylist();
                toggleDrawer(true, true);
                showToast(`已成功綁定本頁清單（共偵測到 ${pagePlaylist.length} 筆）`);
            } else {
                showToast('無法辨識該區塊為清單，請點擊曲目標題文字處再試一次');
            }
        };

        document.addEventListener('click', onPickClick, true);
    }

    function inferListSelector(target) {
        let el = target;
        for (let depth = 0; depth < 6 && el && el !== document.body; depth++) {
            const parent = el.parentElement;
            if (!parent) break;
            const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (sameTagSiblings.length >= 2) {
                return `${buildElementSelector(parent)} > ${el.tagName.toLowerCase()}`;
            }
            el = parent;
        }
        return '';
    }

    function buildElementSelector(el) {
        if (el.id && !/^\d/.test(el.id)) return `#${CSS.escape(el.id)}`;
        const classes = Array.from(el.classList || []).filter(c => c && !/active|open|show|hover|focus|selected/i.test(c));
        const tag = el.tagName.toLowerCase();
        if (classes.length > 0) {
            return `${tag}.${classes.slice(0, 2).map(c => CSS.escape(c)).join('.')}`;
        }
        if (el.parentElement && el.parentElement !== document.body) {
            return `${buildElementSelector(el.parentElement)} > ${tag}`;
        }
        return tag;
    }

    // ==========================================
    // 7. Shadow DOM 介面建構與渲染
    // ==========================================
    function formatTime(sec) {
        if (!isFinite(sec) || sec < 0) return '00:00';
        const total = Math.floor(sec);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = n => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function onMediaUpdate() {
        if (!currentMedia || !ui.progress) return;
        const cur = currentMedia.currentTime || 0;
        const dur = isFinite(currentMedia.duration) ? currentMedia.duration : 0;

        if (!isSeeking) {
            ui.progress.value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
            const pct = dur > 0 ? (cur / dur) * 100 : 0;
            ui.progress.style.setProperty('--pct', `${pct}%`);
        }
        ui.timeCur.textContent = formatTime(cur);
        ui.timeDur.textContent = formatTime(dur);
    }

    function onMediaPlayState() {
        if (!ui.playBtn) return;
        const paused = !currentMedia || currentMedia.paused;
        ui.playBtn.textContent = paused ? '▶' : '⏸';
        ui.miniPlayBtn.textContent = paused ? '▶' : '⏸';
        ui.miniPill.classList.toggle('playing', !paused);
    }

    function onVolumeUpdate() {
        if (!currentMedia || !ui.volRange) return;
        ui.volRange.value = Math.round((currentMedia.muted ? 0 : currentMedia.volume) * 100);
    }

    function setListMode(mode, shouldRender = true) {
        listMode = mode === 'deep' ? 'deep' : 'page';
        cfg.listMode = listMode;
        saveConfig();
        updateTabBadges();
        updateScanControlsUI();
        if (shouldRender) {
            renderPlaylistUI();
            updateHeaderTitle();
        }
    }

    function updateTabBadges() {
        if (ui.tabPageBtn) {
            ui.tabPageBtn.textContent = `📄 本頁 (${pagePlaylist.length})`;
            ui.tabPageBtn.classList.toggle('active', listMode === 'page');
        }
        if (ui.tabDeepBtn) {
            const pendingMark = hasPendingCheckpoint() ? ' · 未完' : '';
            ui.tabDeepBtn.textContent = `📂 子資料夾庫 (${deepPlaylist.length}${pendingMark})`;
            ui.tabDeepBtn.classList.toggle('active', listMode === 'deep');
        }
        if (ui.listBadge) {
            const activeCount = getActiveList().length;
            const prefix = listMode === 'deep' ? '📂 子夾庫' : '📋 列表';
            ui.listBadge.textContent = `${prefix} (${activeCount})`;
        }
    }

    function updateHeaderTitle() {
        if (!ui.titleText) return;
        const item = getCurrentTrack();
        const trackTitle = item ? item.title : getFallbackTitle();
        ui.titleText.textContent = trackTitle;
        ui.miniTitle.textContent = trackTitle;

        if (ui.folderSubText) {
            const parts = [];
            if (searchPlayQueue && searchPlayQueue.ids.length > 0) {
                const pos = searchPlayQueue.ids.indexOf(currentTrackId);
                const posText = pos >= 0 ? ` ${pos + 1}/${searchPlayQueue.ids.length}` : ` (${searchPlayQueue.ids.length}首)`;
                parts.push(`🔍 搜尋連播「${searchPlayQueue.keyword}」${posText}`);
            }
            if (item && item.folder) {
                parts.push(`📁 ${item.folder}`);
            }
            if (parts.length > 0) {
                ui.folderSubText.textContent = parts.join(' ｜ ');
                ui.folderSubText.classList.remove('hidden');
            } else {
                ui.folderSubText.classList.add('hidden');
            }
        }
        updateTabBadges();
    }

    function renderPlaylistUI() {
        if (!ui.listContainer) return;
        const activeList = getActiveList();
        const keyword = getLiveSearchKeyword();
        const entries = getFilteredSortedEntries(activeList, keyword);

        if (ui.clearSearchBtn) {
            ui.clearSearchBtn.classList.toggle('hidden', !keyword);
        }
        if (ui.searchHint) {
            if (keyword) {
                ui.searchHint.textContent = `🔍 已依相關度排序（符合 ${entries.length} 首）· 點擊播放將照此搜尋順序往下連播`;
                ui.searchHint.classList.remove('hidden');
            } else {
                ui.searchHint.classList.add('hidden');
            }
        }

        if (ui.drawerCount) {
            const label = listMode === 'deep' ? '子資料夾庫' : '本頁';
            ui.drawerCount.textContent = `${label}共 ${activeList.length} 首${keyword ? `（符合 ${entries.length} 首）` : ''}`;
        }

        ui.listContainer.innerHTML = '';

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-tip';
            if (activeList.length === 0) {
                empty.innerHTML = listMode === 'deep'
                    ? '子資料夾庫目前為空。<br>請點擊上方 <b>「📂 掃描子資料夾」</b>，掃描進度與曲目都會自動獨立儲存！'
                    : '目前頁面未直接偵測到音檔。<br>如果這裡是母資料夾，請切換或點擊 <b>「📂 掃描子資料夾」</b> 一次拉取所有下層音檔！';
            } else {
                empty.textContent = '找不到符合關鍵字的曲目或資料夾';
            }
            ui.listContainer.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();
        const sourceForClick = listMode;
        const searchIdsSnapshot = keyword ? entries.map(e => e.item.id) : null;

        entries.forEach(({ item }, displayIdx) => {
            const row = document.createElement('div');
            const isCurrent = item.id === currentTrackId && playingSource === sourceForClick;
            row.className = `track-row${isCurrent ? ' active' : ''}`;
            row.innerHTML = `
                <div class="track-num">${isCurrent ? '🔊' : String(displayIdx + 1).padStart(2, '0')}</div>
                <div class="track-body">
                    ${item.folder ? '<div class="track-folder"></div>' : ''}
                    <div class="track-title"></div>
                </div>
            `;
            if (item.folder) {
                row.querySelector('.track-folder').textContent = `📁 ${item.folder}`;
            }
            row.querySelector('.track-title').textContent = item.title;
            row.addEventListener('click', () => {
                const queueObj = searchIdsSnapshot
                    ? { source: sourceForClick, keyword, ids: searchIdsSnapshot }
                    : null;
                playTrack(item, sourceForClick, queueObj);
            });
            frag.appendChild(row);
        });
        ui.listContainer.appendChild(frag);
    }

    function toggleDrawer(forceState, skipAutoRescan = false) {
        if (!ui.drawerBackdrop) return;
        const isOpen = typeof forceState === 'boolean'
            ? forceState
            : !ui.drawerBackdrop.classList.contains('open');
        ui.drawerBackdrop.classList.toggle('open', isOpen);

        if (isOpen) {
            if (!skipAutoRescan && listMode === 'page' && !isScanning) {
                scanPagePlaylist();
            }
            updateScanControlsUI();
            renderPlaylistUI();
            setTimeout(() => {
                const activeRow = ui.listContainer.querySelector('.track-row.active');
                if (activeRow) activeRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }, 80);
        }
    }

    function setMinimized(val) {
        cfg.minimized = val;
        saveConfig();
        ui.dock.classList.toggle('hidden', val);
        ui.miniPill.classList.toggle('hidden', !val);
    }

    let toastTimer = null;
    function showToast(msg, duration = 2200) {
        if (!ui.toast) return;
        ui.toast.textContent = msg;
        ui.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => ui.toast.classList.remove('show'), duration);
    }

    function mountUI() {
        if (document.getElementById('asmr-cp-host')) return;

        const host = document.createElement('div');
        host.id = 'asmr-cp-host';
        host.style.cssText = 'position:fixed;z-index:2147483640;inset:0;pointer-events:none;';
        document.body.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });

        shadow.innerHTML = `
<style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft JhengHei", sans-serif; }
    .hidden { display: none !important; }

    .toast {
        position: fixed;
        top: 18px;
        left: 50%;
        transform: translateX(-50%) translateY(-16px);
        background: rgba(15, 23, 42, 0.95);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.28);
        padding: 10px 18px;
        border-radius: 999px;
        font-size: 14px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.45);
        opacity: 0;
        transition: all 0.22s ease;
        pointer-events: none;
        max-width: 90vw;
        text-align: center;
        z-index: 30;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    .mini-pill {
        pointer-events: auto;
        position: fixed;
        right: 14px;
        bottom: calc(16px + env(safe-area-inset-bottom, 0px));
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(17, 24, 39, 0.92);
        backdrop-filter: blur(14px);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 999px;
        padding: 8px 14px 8px 10px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
        cursor: pointer;
        max-width: 260px;
    }
    .mini-pill.playing { border-color: #ec4899; box-shadow: 0 0 18px rgba(236, 72, 153, 0.35); }
    .mini-play-btn {
        width: 34px; height: 34px; border-radius: 50%; border: none;
        background: linear-gradient(135deg, #ec4899, #8b5cf6);
        color: #fff; font-size: 14px; cursor: pointer; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
    }
    .mini-title {
        font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: #e2e8f0;
    }

    .dock {
        pointer-events: auto;
        position: fixed;
        left: 50%;
        bottom: calc(10px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%);
        width: min(780px, calc(100vw - 16px));
        background: rgba(15, 23, 42, 0.94);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 18px;
        padding: 12px 14px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
        display: flex;
        flex-direction: column;
        gap: 9px;
    }

    .top-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
    }
    .title-wrap {
        flex: 1;
        min-width: 0;
        cursor: pointer;
    }
    .folder-sub {
        font-size: 11px;
        color: #f472b6;
        margin-bottom: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .title-text {
        font-size: 14px;
        font-weight: 600;
        line-height: 1.4;
        color: #f8fafc;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
    }
    .title-wrap:hover .title-text { color: #f472b6; }
    .top-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
    }
    .chip-btn {
        background: rgba(51, 65, 85, 0.72);
        color: #e2e8f0;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 8px;
        padding: 5px 9px;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s;
    }
    .chip-btn:hover { background: rgba(71, 85, 105, 0.95); }
    .chip-btn.active { background: #be185d; border-color: #f472b6; color: #fff; }
    .chip-btn.scan-btn {
        background: rgba(14, 165, 233, 0.22);
        border-color: rgba(56, 189, 248, 0.5);
        color: #e0f2fe;
        font-weight: 600;
    }
    .chip-btn.scan-btn:hover { background: rgba(14, 165, 233, 0.4); }
    .chip-btn.scan-btn.active {
        background: #dc2626;
        border-color: #f87171;
        color: #fff;
    }
    .chip-btn.danger-btn {
        background: rgba(220, 38, 38, 0.22);
        border-color: rgba(248, 113, 113, 0.45);
        color: #fecaca;
    }
    .chip-btn.danger-btn:hover { background: rgba(220, 38, 38, 0.42); }

    .progress-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .time-label {
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: #cbd5e1;
        min-width: 42px;
    }
    .time-label.right { text-align: right; }
    input[type="range"].progress {
        -webkit-appearance: none;
        appearance: none;
        flex: 1;
        height: 8px;
        border-radius: 999px;
        background: linear-gradient(to right, #ec4899 0%, #8b5cf6 var(--pct, 0%), rgba(148, 163, 184, 0.3) var(--pct, 0%));
        outline: none;
        cursor: pointer;
    }
    input[type="range"].progress::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 18px; height: 18px;
        border-radius: 50%;
        background: #fff;
        border: 2px solid #ec4899;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    }

    .controls-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
    }
    .main-btns {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        justify-content: center;
    }
    .ctrl-btn {
        background: rgba(51, 65, 85, 0.78);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 12px;
        height: 42px;
        padding: 0 12px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        transition: transform 0.1s, background 0.15s;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
    }
    .ctrl-btn:active { transform: scale(0.94); }
    .ctrl-btn:hover { background: rgba(71, 85, 105, 0.95); }
    .ctrl-btn.seek {
        background: rgba(139, 92, 246, 0.25);
        border-color: rgba(167, 139, 250, 0.45);
        color: #ede9fe;
        min-width: 64px;
    }
    .ctrl-btn.seek:hover { background: rgba(139, 92, 246, 0.45); }
    .ctrl-btn.play {
        width: 48px; height: 48px;
        border-radius: 50%;
        background: linear-gradient(135deg, #ec4899, #8b5cf6);
        border: none;
        font-size: 18px;
        box-shadow: 0 4px 14px rgba(236, 72, 153, 0.4);
    }

    .sub-tools {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding-top: 6px;
        border-top: 1px solid rgba(148, 163, 184, 0.14);
        flex-wrap: wrap;
    }
    .sub-left, .sub-right {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .vol-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #cbd5e1;
    }
    .vol-range {
        width: 74px;
        accent-color: #ec4899;
        cursor: pointer;
    }

    /* 超大標題列表抽屜 */
    .drawer-backdrop {
        pointer-events: none;
        position: fixed;
        inset: 0;
        background: rgba(2, 6, 23, 0.65);
        backdrop-filter: blur(4px);
        opacity: 0;
        transition: opacity 0.2s ease;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        z-index: 20;
    }
    .drawer-backdrop.open {
        pointer-events: auto;
        opacity: 1;
    }
    .drawer {
        width: min(860px, 98vw);
        height: min(86vh, 820px);
        background: #0f172a;
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-bottom: none;
        border-radius: 20px 20px 0 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transform: translateY(30px);
        transition: transform 0.22s ease;
        box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.65);
    }
    .drawer-backdrop.open .drawer { transform: translateY(0); }
    .drawer-header {
        padding: 12px 16px 10px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: #1e293b;
    }
    .drawer-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
    }
    .drawer-title { font-size: 16px; font-weight: 700; color: #f8fafc; }
    .drawer-count { font-size: 12.5px; color: #94a3b8; margin-left: 8px; font-weight: 400; }
    .drawer-btns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

    .drawer-tabs {
        display: flex;
        gap: 6px;
    }
    .tab-btn {
        flex: 1;
        padding: 7px 10px;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background: rgba(15, 23, 42, 0.65);
        color: #cbd5e1;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
    }
    .tab-btn.active {
        background: linear-gradient(135deg, rgba(236, 72, 153, 0.32), rgba(139, 92, 246, 0.35));
        border-color: #f472b6;
        color: #ffffff;
    }

    .scan-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        padding: 8px 11px;
        border-radius: 10px;
        background: rgba(14, 165, 233, 0.15);
        border: 1px solid rgba(56, 189, 248, 0.35);
        font-size: 12.5px;
        color: #bae6fd;
    }
    .scan-bar-actions {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: wrap;
    }

    .search-wrap {
        position: relative;
        display: flex;
        align-items: center;
    }
    .search-input {
        width: 100%;
        background: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 10px;
        padding: 9px 36px 9px 12px;
        color: #f8fafc;
        font-size: 14px;
        outline: none;
    }
    .search-input:focus { border-color: #ec4899; }
    .clear-search-btn {
        position: absolute;
        right: 8px;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: none;
        background: rgba(148, 163, 184, 0.25);
        color: #e2e8f0;
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .clear-search-btn:hover { background: rgba(236, 72, 153, 0.6); }
    .search-hint {
        font-size: 12px;
        color: #f9a8d4;
        padding: 0 2px;
    }

    .list-container {
        flex: 1;
        overflow-y: auto;
        padding: 8px 10px 24px;
        -webkit-overflow-scrolling: touch;
    }
    .track-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 13px 14px;
        margin-bottom: 6px;
        border-radius: 12px;
        background: rgba(30, 41, 59, 0.55);
        border: 1px solid transparent;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
    }
    .track-row:hover { background: rgba(51, 65, 85, 0.78); }
    .track-row.active {
        background: rgba(236, 72, 153, 0.18);
        border-color: rgba(244, 114, 182, 0.65);
    }
    .track-num {
        font-size: 13px;
        font-weight: 700;
        color: #94a3b8;
        min-width: 28px;
        padding-top: 2px;
        text-align: center;
        flex-shrink: 0;
    }
    .track-row.active .track-num { color: #f472b6; }
    .track-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
    }
    .track-folder {
        font-size: 12px;
        color: #38bdf8;
        line-height: 1.35;
        word-break: break-word;
    }
    .track-title {
        font-size: 15px;
        line-height: 1.55;
        color: #f1f5f9;
        white-space: normal;
        word-break: break-word;
    }
    .track-row.active .track-title {
        color: #ffffff;
        font-weight: 600;
    }
    .empty-tip {
        text-align: center;
        color: #94a3b8;
        padding: 40px 18px;
        font-size: 14px;
        line-height: 1.8;
    }

    @media (max-width: 560px) {
        .dock { padding: 10px; gap: 7px; border-radius: 14px; }
        .ctrl-btn { height: 40px; padding: 0 9px; font-size: 13px; }
        .ctrl-btn.seek { min-width: 56px; }
        .ctrl-btn.play { width: 44px; height: 44px; }
        .vol-wrap { display: none; }
        .track-title { font-size: 15px; }
    }
</style>

<div class="toast" id="toast"></div>

<div class="mini-pill hidden" id="miniPill" title="點擊展開自訂播放器">
    <button class="mini-play-btn" id="miniPlayBtn">▶</button>
    <div class="mini-title" id="miniTitle">ASMR 播放器</div>
</div>

<div class="dock" id="dock">
    <div class="top-row">
        <div class="title-wrap" id="titleWrap" title="點擊開啟完整大列表">
            <div class="folder-sub hidden" id="folderSubText"></div>
            <div class="title-text" id="titleText">等待音檔載入...</div>
        </div>
        <div class="top-actions">
            <button class="chip-btn" id="listBadge">📋 列表 (0)</button>
            <button class="chip-btn" id="minBtn" title="收合為小膠囊">⬇ 收合</button>
        </div>
    </div>

    <div class="progress-row">
        <span class="time-label" id="timeCur">00:00</span>
        <input type="range" class="progress" id="progress" min="0" max="1000" value="0">
        <span class="time-label right" id="timeDur">00:00</span>
    </div>

    <div class="controls-row">
        <div class="main-btns">
            <button class="ctrl-btn" id="prevBtn" title="上一首">⏮</button>
            <button class="ctrl-btn seek" id="back5Btn" title="倒退 5 秒 (鍵盤 ←)">⏪ -5s</button>
            <button class="ctrl-btn play" id="playBtn" title="播放 / 暫停 (空白鍵)">▶</button>
            <button class="ctrl-btn seek" id="fwd5Btn" title="快進 5 秒 (鍵盤 →)">+5s ⏩</button>
            <button class="ctrl-btn" id="nextBtn" title="下一首">⏭</button>
        </div>
    </div>

    <div class="sub-tools">
        <div class="sub-left">
            <button class="chip-btn scan-btn" id="scanDockBtn" title="掃描或從斷點繼續掃描子資料夾">📂 掃描子資料夾</button>
            <button class="chip-btn" id="speedBtn" title="切換播放倍速">1x</button>
            <button class="chip-btn" id="loopBtn" title="切換循環模式">🔁 列表</button>
            <button class="chip-btn" id="sleepBtn" title="設定睡眠自動暫停">🌙 定時</button>
            <button class="chip-btn" id="hideOrigBtn" title="隱藏或顯示網站原播放器">🙈 隱藏原版</button>
        </div>
        <div class="sub-right">
            <div class="vol-wrap">
                <span>🔊</span>
                <input type="range" class="vol-range" id="volRange" min="0" max="100" value="100">
            </div>
        </div>
    </div>
</div>

<div class="drawer-backdrop" id="drawerBackdrop">
    <div class="drawer" id="drawer">
        <div class="drawer-header">
            <div class="drawer-top">
                <div>
                    <span class="drawer-title">音檔播放列表</span>
                    <span class="drawer-count" id="drawerCount"></span>
                </div>
                <div class="drawer-btns">
                    <button class="chip-btn scan-btn" id="scanDrawerBtn">📂 掃描子資料夾</button>
                    <button class="chip-btn" id="rescanBtn" title="重掃目前這一頁">🔄 掃本頁</button>
                    <button class="chip-btn" id="pickBtn" title="手動點擊網頁上的任一曲目來綁定本頁清單">🎯 手動定位</button>
                    <button class="chip-btn" id="closeDrawerBtn">✕ 關閉</button>
                </div>
            </div>

            <div class="drawer-tabs">
                <button class="tab-btn" id="tabPageBtn">📄 本頁 (0)</button>
                <button class="tab-btn" id="tabDeepBtn">📂 子資料夾庫 (0)</button>
            </div>

            <div class="scan-bar hidden" id="scanBar">
                <span id="scanStatusText">準備掃描...</span>
                <div class="scan-bar-actions">
                    <button class="chip-btn scan-btn active hidden" id="stopScanBtn">⏹ 停止並記錄</button>
                    <button class="chip-btn scan-btn hidden" id="resumeScanBtn">▶ 繼續掃描</button>
                    <button class="chip-btn hidden" id="restartScanBtn" title="從目前所在目錄重新掃描（保留不重複曲目）">🔄 掃目前目錄</button>
                    <button class="chip-btn danger-btn hidden" id="clearDeepBtn" title="清空已儲存的子資料夾列表與斷點">🗑 清空庫</button>
                </div>
            </div>

            <div class="search-wrap">
                <input type="text" class="search-input" id="searchInput" placeholder="搜尋曲目標題或資料夾（支援空白多關鍵字，依相關度連播）...">
                <button class="clear-search-btn hidden" id="clearSearchBtn" title="清除搜尋">✕</button>
            </div>
            <div class="search-hint hidden" id="searchHint"></div>
        </div>
        <div class="list-container" id="listContainer"></div>
    </div>
</div>
        `;

        const $ = id => shadow.getElementById(id);
        ui = {
            toast: $('toast'),
            miniPill: $('miniPill'),
            miniPlayBtn: $('miniPlayBtn'),
            miniTitle: $('miniTitle'),
            dock: $('dock'),
            titleWrap: $('titleWrap'),
            folderSubText: $('folderSubText'),
            titleText: $('titleText'),
            listBadge: $('listBadge'),
            minBtn: $('minBtn'),
            timeCur: $('timeCur'),
            timeDur: $('timeDur'),
            progress: $('progress'),
            prevBtn: $('prevBtn'),
            back5Btn: $('back5Btn'),
            playBtn: $('playBtn'),
            fwd5Btn: $('fwd5Btn'),
            nextBtn: $('nextBtn'),
            scanDockBtn: $('scanDockBtn'),
            scanDrawerBtn: $('scanDrawerBtn'),
            tabPageBtn: $('tabPageBtn'),
            tabDeepBtn: $('tabDeepBtn'),
            scanBar: $('scanBar'),
            scanStatusText: $('scanStatusText'),
            stopScanBtn: $('stopScanBtn'),
            resumeScanBtn: $('resumeScanBtn'),
            restartScanBtn: $('restartScanBtn'),
            clearDeepBtn: $('clearDeepBtn'),
            speedBtn: $('speedBtn'),
            loopBtn: $('loopBtn'),
            sleepBtn: $('sleepBtn'),
            hideOrigBtn: $('hideOrigBtn'),
            volRange: $('volRange'),
            drawerBackdrop: $('drawerBackdrop'),
            drawerCount: $('drawerCount'),
            rescanBtn: $('rescanBtn'),
            pickBtn: $('pickBtn'),
            closeDrawerBtn: $('closeDrawerBtn'),
            searchInput: $('searchInput'),
            clearSearchBtn: $('clearSearchBtn'),
            searchHint: $('searchHint'),
            listContainer: $('listContainer')
        };

        ui.speedBtn.textContent = `${cfg.playbackRate}x`;
        const loopLabels = { list: '🔁 列表', single: '🔂 單曲', none: '➡️ 單次' };
        ui.loopBtn.textContent = loopLabels[cfg.loopMode] || '🔁 列表';
        setMinimized(cfg.minimized);
        applyHideOriginal();

        ui.playBtn.addEventListener('click', togglePlay);
        ui.miniPlayBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });
        ui.miniPill.addEventListener('click', () => setMinimized(false));
        ui.minBtn.addEventListener('click', () => setMinimized(true));

        ui.back5Btn.addEventListener('click', () => seekBy(-5));
        ui.fwd5Btn.addEventListener('click', () => seekBy(5));
        ui.prevBtn.addEventListener('click', playPrev);
        ui.nextBtn.addEventListener('click', playNext);

        ui.scanDockBtn.addEventListener('click', handlePrimaryScanButtonClick);
        ui.scanDrawerBtn.addEventListener('click', handlePrimaryScanButtonClick);
        ui.stopScanBtn.addEventListener('click', stopSubfolderScan);
        ui.resumeScanBtn.addEventListener('click', () => startSubfolderScan({ resume: true }));
        ui.restartScanBtn.addEventListener('click', () => startSubfolderScan({ resume: false, clearExisting: false }));
        ui.clearDeepBtn.addEventListener('click', clearDeepLibrary);

        ui.tabPageBtn.addEventListener('click', () => setListMode('page', true));
        ui.tabDeepBtn.addEventListener('click', () => setListMode('deep', true));

        ui.speedBtn.addEventListener('click', cycleSpeed);
        ui.loopBtn.addEventListener('click', cycleLoopMode);
        ui.sleepBtn.addEventListener('click', cycleSleepTimer);
        ui.hideOrigBtn.addEventListener('click', () => {
            cfg.hideOriginal = !cfg.hideOriginal;
            saveConfig();
            applyHideOriginal();
        });

        ui.listBadge.addEventListener('click', () => toggleDrawer(true));
        ui.titleWrap.addEventListener('click', () => toggleDrawer(true));
        ui.closeDrawerBtn.addEventListener('click', () => toggleDrawer(false));
        ui.drawerBackdrop.addEventListener('click', (e) => {
            if (e.target === ui.drawerBackdrop) toggleDrawer(false);
        });
        ui.rescanBtn.addEventListener('click', () => {
            cfg.customListSelector = '';
            saveConfig();
            setListMode('page', false);
            scanPagePlaylist();
            showToast(`已重掃目前頁面，共 ${pagePlaylist.length} 筆`);
        });
        ui.pickBtn.addEventListener('click', startPickListMode);

        ui.searchInput.addEventListener('input', () => {
            const kw = getLiveSearchKeyword();
            if (!kw && searchPlayQueue) {
                clearSearchPlayQueue();
            }
            renderPlaylistUI();
        });

        ui.clearSearchBtn.addEventListener('click', () => {
            ui.searchInput.value = '';
            clearSearchPlayQueue();
            renderPlaylistUI();
            ui.searchInput.focus();
        });

        ui.progress.addEventListener('pointerdown', () => { isSeeking = true; });
        ui.progress.addEventListener('input', () => {
            const pct = ui.progress.value / 10;
            ui.progress.style.setProperty('--pct', `${pct}%`);
            if (currentMedia && isFinite(currentMedia.duration)) {
                ui.timeCur.textContent = formatTime((ui.progress.value / 1000) * currentMedia.duration);
            }
        });
        const finishSeek = () => {
            if (currentMedia && isFinite(currentMedia.duration)) {
                currentMedia.currentTime = (ui.progress.value / 1000) * currentMedia.duration;
            }
            isSeeking = false;
        };
        ui.progress.addEventListener('change', finishSeek);
        ui.progress.addEventListener('pointerup', finishSeek);

        ui.volRange.addEventListener('input', () => {
            if (!currentMedia) findExistingMedia();
            if (!currentMedia) return;
            const v = ui.volRange.value / 100;
            currentMedia.volume = v;
            currentMedia.muted = v === 0;
        });

        window.addEventListener('keydown', (e) => {
            const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable)) {
                return;
            }
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                seekBy(-5);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                seekBy(5);
            } else if (e.code === 'Space' && currentMedia) {
                e.preventDefault();
                togglePlay();
            }
        });

        updateScanControlsUI();
    }

    // ==========================================
    // 8. 啟動與頁面變動監聽
    // ==========================================
    function boot() {
        mountUI();
        findExistingMedia();
        scanPagePlaylist();

        // 若本頁沒有音檔但已有儲存的子資料夾庫或未完斷點，自動切到子資料夾庫分頁方便使用
        if (pagePlaylist.length === 0 && (deepPlaylist.length > 0 || hasPendingCheckpoint())) {
            setListMode('deep', true);
        } else {
            setListMode(listMode, true);
        }

        let debounceTimer = null;
        const observer = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                findExistingMedia();
                if (isScanning) return;

                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    scanPagePlaylist();
                } else {
                    if (pagePlaylist.length === 0) scanPagePlaylist();
                    else syncCurrentTrackHighlight();
                }
            }, 400);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            if (!currentMedia) findExistingMedia();
            if (!isScanning && location.href !== lastUrl) {
                lastUrl = location.href;
                scanPagePlaylist();
            }
        }, 1800);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
