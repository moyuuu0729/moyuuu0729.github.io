// ==UserScript==
// @name         X (Twitter) 全能增強：抖音模式 / 快轉預覽 / 橫豎屏篩選 / 時長過濾 / 去廣告
// @namespace    https://x.com/
// @version      1.2.0
// @description  為 X (Twitter) 打造抖音上下滑動連刷模式，支援主頁直連 API 攔截＋Redux 記憶體掃描、快轉即時畫面預覽、精準橫屏/豎屏/全部切換、最低片長與 GIF 過濾、自動翻頁續刷與隱藏推廣廣告。
// @match        *://x.com/*
// @match        *://*.x.com/*
// @match        *://twitter.com/*
// @match        *://*.twitter.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://moyuuu0729.github.io/x-plus.user.js
// @downloadURL  https://moyuuu0729.github.io/x-plus.user.js
// ==/UserScript==

(function () {
    'use strict';

    const CFG_KEY = 'xp_tiktok_cfg_v1';

    const DEFAULT_CFG = {
        blockAds: true,
        orientation: 'all', // 'all' | 'landscape' | 'portrait'
        showGif: true,
        minSeconds: 0, // 0 = 不限
        scopeMode: 'page', // 'page' | 'all'
        playbackRate: 1.0,
        feedMuted: false,
        autoScrollLoad: true,
        panelCollapsed: false
    };

    const DUR_PRESETS = [
        { sec: 0, label: '不限' },
        { sec: 10, label: '≥10秒' },
        { sec: 30, label: '≥30秒' },
        { sec: 60, label: '≥1分' },
        { sec: 180, label: '≥3分' },
        { sec: 300, label: '≥5分' },
        { sec: 600, label: '≥10分' }
    ];

    const AD_TEXT_RE = /^(?:Ad|Promoted|廣告|广告|推廣|推广|プロモーション|Publicidad|Anzeige|Sponsorisé)$/i;

    let cfg = loadCfg();
    let toastTimer = null;
    let cachedReduxStore = null;

    let currentRouteKey = computeRouteKey();
    const routeBuckets = new Map(); // routeKey -> Map(mediaKey -> item)
    const allMediaMap = new Map();  // mediaKey -> item

    let feedOpen = false;
    let feedItems = [];
    let feedIdSet = new Set();
    let feedIndex = 0;
    let feedClockTimer = null;
    let feedProgressTimer = null;
    let feedGoToSlide = null;
    let feedCleanupPreview = null;
    let feedOnNewMedia = null;
    let feedResizeCleanup = null;
    let feedClockShowSeconds = false;
    let lastBgScrollTs = 0;
    let consecutiveAutoSkips = 0;

    function loadCfg() {
        try {
            const raw = localStorage.getItem(CFG_KEY);
            const saved = raw ? JSON.parse(raw) : {};
            return Object.assign({}, DEFAULT_CFG, saved, {
                minSeconds: Math.max(0, Number(saved.minSeconds) || 0)
            });
        } catch {
            return Object.assign({}, DEFAULT_CFG);
        }
    }

    function saveCfg() {
        try {
            localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
        } catch {}
    }

    function computeRouteKey() {
        const path = location.pathname || '/';
        if (path.startsWith('/search')) {
            const sp = new URLSearchParams(location.search);
            return `/search?q=${sp.get('q') || ''}&f=${sp.get('f') || ''}`;
        }
        return path;
    }

    function syncRouteKey() {
        const nextKey = computeRouteKey();
        if (/\/status\/\d+/.test(location.pathname) && routeBuckets.has(currentRouteKey) && routeBuckets.get(currentRouteKey).size > 0) {
            return;
        }
        if (nextKey !== currentRouteKey) {
            currentRouteKey = nextKey;
            updatePanelCounts();
        }
    }

    function getCurrentRouteBucket() {
        if (!routeBuckets.has(currentRouteKey)) {
            routeBuckets.set(currentRouteKey, new Map());
        }
        return routeBuckets.get(currentRouteKey);
    }

    function getPoolItems() {
        if (cfg.scopeMode === 'all') {
            return Array.from(allMediaMap.values());
        }
        const pageMap = getCurrentRouteBucket();
        if (pageMap.size > 0) return Array.from(pageMap.values());
        return Array.from(allMediaMap.values());
    }

    // ==================== 1. 基礎樣式注入 ====================
    const BASE_CSS = `
        .xp-ad-hidden {
            display: none !important;
        }

        #xp-float-panel,
        #xp-float-panel * {
            box-sizing: border-box !important;
        }
        #xp-float-panel {
            position: fixed !important;
            right: 12px;
            bottom: calc(16px + env(safe-area-inset-bottom, 0px));
            z-index: 2147483640 !important;
            width: min(332px, calc(100vw - 24px));
            border-radius: 16px;
            background: rgba(15, 20, 28, 0.96);
            border: 1px solid rgba(29, 155, 240, 0.58);
            box-shadow: 0 12px 34px rgba(0, 0, 0, 0.72);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
            font-size: 12.5px;
            overflow: hidden;
            user-select: none;
        }
        #xp-float-panel.collapsed {
            width: auto !important;
            border-radius: 999px;
        }
        #xp-float-panel.collapsed .xp-panel-body {
            display: none !important;
        }
        .xp-panel-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 12px;
            background: linear-gradient(135deg, rgba(29, 155, 240, 0.28), rgba(6, 182, 212, 0.16));
            cursor: grab;
            touch-action: none;
            font-weight: 800;
            font-size: 12.5px;
        }
        .xp-panel-body {
            padding: 10px 12px 12px;
            display: flex;
            flex-direction: column;
            gap: 9px;
            max-height: min(76vh, 620px);
            overflow-y: auto;
        }
        .xp-top-action-row {
            display: flex;
            gap: 6px;
        }
        .xp-section {
            display: flex;
            flex-direction: column;
            gap: 5px;
            padding-top: 7px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .xp-section-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11.5px;
            font-weight: 700;
            color: #cbd5e1;
        }
        .xp-seg-3 {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 5px;
        }
        .xp-grid-2 {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 5px;
        }
        .xp-dur-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 5px;
        }
        .xp-btn {
            padding: 6px 8px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.14);
            background: rgba(255, 255, 255, 0.06);
            color: #d1d5db;
            font-size: 11.5px;
            font-weight: 700;
            text-align: center;
            cursor: pointer;
            line-height: 1.25;
            transition: background 0.15s, border-color 0.15s, transform 0.1s;
        }
        .xp-btn:active {
            transform: scale(0.96);
        }
        .xp-btn.accent {
            background: linear-gradient(135deg, #1d9bf0, #06b6d4);
            border-color: transparent;
            color: #fff;
        }
        .xp-btn.on {
            background: rgba(29, 155, 240, 0.28);
            border-color: rgba(56, 189, 248, 0.85);
            color: #fff;
        }
        .xp-stats-line {
            font-size: 11px;
            color: #9ca3af;
            text-align: center;
            padding-top: 5px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            font-variant-numeric: tabular-nums;
        }

        /* ==================== 抖音模式全螢幕沉浸視窗 ==================== */
        #xp-feed-overlay,
        #xp-feed-overlay * {
            box-sizing: border-box !important;
        }
        #xp-feed-overlay {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 100vw !important;
            height: var(--xp-slide-h, 100dvh) !important;
            z-index: 2147483644 !important;
            background: #040609 !important;
            color: #f3f4f6 !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif !important;
            overflow: hidden !important;
            overscroll-behavior: contain !important;
            user-select: none !important;
            -webkit-user-select: none !important;
        }
        .xp-feed-track {
            position: relative !important;
            z-index: 2 !important;
            display: block !important;
            width: 100% !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 !important;
            will-change: transform;
            touch-action: none !important;
            transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .xp-feed-track.dragging {
            transition: none !important;
        }
        .xp-feed-slide {
            position: relative !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: 100% !important;
            height: var(--xp-slide-h, 100dvh) !important;
            min-height: var(--xp-slide-h, 100dvh) !important;
            max-height: var(--xp-slide-h, 100dvh) !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #040609 !important;
            overflow: hidden !important;
            flex: none !important;
        }
        .xp-feed-poster {
            position: absolute !important;
            inset: 0 !important;
            width: 100% !important;
            height: 100% !important;
            object-fit: contain !important;
            opacity: 0.45;
            pointer-events: none !important;
            z-index: 1 !important;
            transition: opacity 0.2s ease;
        }
        .xp-feed-video {
            position: relative !important;
            z-index: 2 !important;
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            object-fit: contain !important;
            background: transparent !important;
            pointer-events: none !important;
            display: block !important;
        }
        .xp-feed-video::-webkit-media-controls,
        .xp-feed-video::-webkit-media-controls-enclosure,
        .xp-feed-video::-webkit-media-controls-panel {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        .xp-feed-status {
            position: absolute !important;
            top: 44% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            z-index: 6 !important;
            padding: 8px 16px;
            border-radius: 999px;
            background: rgba(12, 18, 28, 0.9);
            border: 1px solid rgba(56, 189, 248, 0.6);
            color: #f3f4f6;
            font-size: 13px;
            font-weight: 700;
            pointer-events: none;
            text-align: center;
            max-width: 86vw;
        }
        .xp-feed-center-icon {
            position: absolute !important;
            top: 44% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) scale(0.8);
            z-index: 8 !important;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: rgba(12, 18, 28, 0.72);
            border: 1px solid rgba(255, 255, 255, 0.25);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: #fff;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.18s ease, transform 0.18s ease;
        }
        .xp-feed-center-icon.show {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }

        #xp-feed-topbar {
            position: fixed !important;
            top: calc(10px + env(safe-area-inset-top, 0px)) !important;
            left: 12px !important;
            right: 12px !important;
            z-index: 30 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 6px;
            pointer-events: none;
        }
        .xp-feed-top-group {
            display: flex;
            align-items: center;
            gap: 6px;
            pointer-events: auto;
        }
        .xp-fbtn {
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(12, 18, 28, 0.78);
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: #f3f4f6;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            font-variant-numeric: tabular-nums;
            line-height: 1.2;
            white-space: nowrap;
        }
        .xp-fbtn:active {
            transform: scale(0.95);
        }
        .xp-fbtn.highlight {
            border-color: rgba(56, 189, 248, 0.9);
            color: #bae6fd;
        }

        #xp-feed-bottom-dock {
            position: fixed !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            z-index: 28 !important;
            padding: 18px 12px calc(10px + env(safe-area-inset-bottom, 0px));
            background: linear-gradient(to top, rgba(4, 6, 9, 0.94) 0%, rgba(4, 6, 9, 0.72) 72%, transparent 100%);
            display: flex !important;
            flex-direction: column !important;
            gap: 6px;
            pointer-events: auto;
        }
        #xp-feed-author-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 12.5px;
        }
        #xp-feed-author {
            color: #38bdf8;
            font-weight: 800;
            text-decoration: none;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        #xp-feed-meta {
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 700;
            color: #e2e8f0;
            font-variant-numeric: tabular-nums;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        #xp-feed-text {
            font-size: 13px;
            line-height: 1.4;
            color: #f8fafc;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            word-break: break-word;
            cursor: pointer;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
        }
        #xp-feed-text.expanded {
            -webkit-line-clamp: unset;
            max-height: 36vh;
            overflow-y: auto;
        }
        .xp-feed-scrub-row {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
        }
        #xp-feed-time {
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 700;
            color: #e5e7eb;
            font-variant-numeric: tabular-nums;
            min-width: 82px;
            text-align: right;
        }
        #xp-feed-range {
            flex: 1;
            width: 100%;
            height: 6px;
            accent-color: #1d9bf0;
            cursor: pointer;
            margin: 0;
        }
        .xp-feed-ctrl-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            overflow-x: auto;
            scrollbar-width: none;
        }
        .xp-feed-ctrl-row::-webkit-scrollbar {
            display: none;
        }
        .xp-feed-ctrl-group {
            display: flex;
            align-items: center;
            gap: 5px;
            flex-shrink: 0;
        }
        .xp-fcbtn {
            padding: 5px 9px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.18);
            background: rgba(15, 20, 28, 0.72);
            color: #f3f4f6;
            font-size: 11.5px;
            font-weight: 700;
            cursor: pointer;
            line-height: 1.2;
            white-space: nowrap;
            text-decoration: none;
        }
        .xp-fcbtn:active {
            transform: scale(0.95);
        }
        .xp-fcbtn.accent {
            background: linear-gradient(135deg, #1d9bf0, #06b6d4);
            border-color: transparent;
            color: #fff;
        }

        /* 快轉即時預覽浮窗 */
        #xp-feed-preview-box {
            position: fixed !important;
            left: 50%;
            bottom: calc(158px + env(safe-area-inset-bottom, 0px));
            transform: translateX(-50%);
            z-index: 36 !important;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 5px;
            padding: 5px;
            border-radius: 12px;
            background: rgba(10, 14, 22, 0.95);
            border: 1.5px solid rgba(56, 189, 248, 0.85);
            box-shadow: 0 10px 28px rgba(0, 0, 0, 0.82);
            pointer-events: none;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.12s ease;
        }
        #xp-feed-preview-box.show {
            opacity: 1;
            visibility: visible;
        }
        #xp-feed-preview-stage {
            position: relative;
            width: 216px;
            height: 122px;
            border-radius: 8px;
            overflow: hidden;
            background: #070a10;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #xp-feed-preview-stage.portrait {
            width: 116px;
            height: 184px;
        }
        #xp-feed-preview-video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #070a10;
            display: block;
            opacity: 0;
            transition: opacity 0.1s ease;
            z-index: 2;
        }
        #xp-feed-preview-video.ready {
            opacity: 1;
        }
        #xp-feed-preview-poster {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: contain;
            opacity: 0.4;
            z-index: 1;
        }
        #xp-feed-preview-loading {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 4;
            padding: 3px 8px;
            border-radius: 999px;
            background: rgba(0, 0, 0, 0.72);
            color: #bae6fd;
            font-size: 11px;
            font-weight: 700;
        }
        #xp-feed-preview-label {
            font-size: 12.5px;
            font-weight: 800;
            color: #ffffff;
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
            padding: 1px 6px 2px;
        }

        #xp-feed-hud {
            position: fixed !important;
            top: 44% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            z-index: 35 !important;
            padding: 10px 18px;
            border-radius: 999px;
            background: rgba(12, 18, 28, 0.92);
            border: 1px solid rgba(56, 189, 248, 0.75);
            color: #fff;
            font-size: 15px;
            font-weight: 800;
            font-variant-numeric: tabular-nums;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.14s ease;
        }
        #xp-feed-hud.show {
            opacity: 1;
        }

        /* 選集抽屜（獨立觸控捲動，不被外層鎖死或擠壓變形） */
        #xp-feed-drawer {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 100% !important;
            height: var(--xp-slide-h, 100dvh) !important;
            z-index: 45 !important;
            background: rgba(4, 6, 9, 0.94) !important;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: none !important;
            flex-direction: column !important;
            overflow: hidden !important;
            pointer-events: auto !important;
            touch-action: auto !important;
        }
        #xp-feed-drawer.open {
            display: flex !important;
        }
        .xp-drawer-head {
            flex: 0 0 auto !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 8px;
            padding: calc(12px + env(safe-area-inset-top, 0px)) 14px 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.12);
            font-size: 14px;
            font-weight: 800;
        }
        .xp-drawer-scroll {
            flex: 1 1 0% !important;
            min-height: 0 !important;
            width: 100% !important;
            overflow-y: auto !important;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior: contain !important;
            touch-action: pan-y !important;
            padding: 10px 10px calc(24px + env(safe-area-inset-bottom, 0px)) !important;
        }
        .xp-drawer-grid {
            display: grid !important;
            grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
            grid-auto-rows: max-content !important;
            align-content: start !important;
            gap: 8px !important;
            width: 100% !important;
        }
        .xp-drawer-item {
            position: relative !important;
            border-radius: 8px !important;
            overflow: hidden !important;
            background: #111827 !important;
            border: 2px solid transparent;
            cursor: pointer;
            display: flex !important;
            flex-direction: column !important;
            flex: none !important;
        }
        .xp-drawer-item.active {
            border-color: #1d9bf0 !important;
        }
        .xp-drawer-thumb {
            position: relative !important;
            width: 100% !important;
            aspect-ratio: 16 / 9;
            background: #070a10 !important;
            overflow: hidden !important;
            flex: none !important;
        }
        .xp-drawer-grid.portrait-mode .xp-drawer-thumb {
            aspect-ratio: 9 / 14;
        }
        .xp-drawer-thumb img {
            width: 100% !important;
            height: 100% !important;
            object-fit: cover !important;
            display: block !important;
        }
        .xp-drawer-idx {
            position: absolute;
            top: 4px;
            left: 4px;
            padding: 1px 6px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.78);
            color: #fff;
            font-size: 10px;
            font-weight: 800;
        }
        .xp-drawer-orient {
            position: absolute;
            top: 4px;
            right: 4px;
            padding: 1px 5px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.75);
            color: #bae6fd;
            font-size: 9.5px;
            font-weight: 700;
        }
        .xp-drawer-dur {
            position: absolute;
            bottom: 4px;
            right: 4px;
            padding: 1px 5px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.82);
            color: #fff;
            font-size: 10px;
            font-weight: 700;
        }
        .xp-drawer-caption {
            padding: 5px 6px;
            font-size: 11px;
            line-height: 1.3;
            color: #e5e7eb;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        .xp-drawer-more-wrap {
            margin-top: 12px;
            display: flex;
            justify-content: center;
        }

        #xp-toast {
            position: fixed !important;
            left: 50%;
            bottom: calc(28px + env(safe-area-inset-bottom, 0px));
            transform: translateX(-50%);
            z-index: 2147483647 !important;
            padding: 8px 16px;
            border-radius: 999px;
            background: rgba(12, 18, 28, 0.95);
            border: 1px solid rgba(56, 189, 248, 0.75);
            color: #fff;
            font-size: 13px;
            font-weight: 700;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.18s ease;
            max-width: calc(100vw - 32px);
            text-align: center;
        }
        #xp-toast.show {
            opacity: 1;
        }
    `;

    function injectBaseStyles() {
        if (document.getElementById('xp-base-style')) return;
        const st = document.createElement('style');
        st.id = 'xp-base-style';
        st.textContent = BASE_CSS;
        (document.head || document.documentElement).appendChild(st);
    }

    function showToast(msg, duration = 2200) {
        if (!document.body) return;
        let el = document.getElementById('xp-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'xp-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), duration);
    }

    function formatSec(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    function orientLabel(mode) {
        if (mode === 'landscape') return '📺 橫屏';
        if (mode === 'portrait') return '📱 豎屏';
        return '📐 全部';
    }

    function formatMinDurLabel(sec) {
        if (!sec || sec <= 0) return '不限';
        if (sec < 60) return `≥${sec}秒`;
        if (sec % 60 === 0) return `≥${sec / 60}分`;
        return `≥${Math.floor(sec / 60)}分${sec % 60}秒`;
    }

    function parseDimensionsFromUrl(url) {
        const m = String(url || '').match(/\/(\d{2,4})x(\d{2,4})\//);
        if (m) {
            const w = Number(m[1]) || 0;
            const h = Number(m[2]) || 0;
            if (w > 0 && h > 0) return { w, h };
        }
        return { w: 0, h: 0 };
    }

    function classifyOrientation(w, h) {
        if (w > 0 && h > 0) {
            return h > w * 1.03 ? 'portrait' : 'landscape';
        }
        return 'unknown';
    }

    // ==================== 2. 四重影片擷取引擎（API + Redux + Fiber + DOM） ====================
    function isCandidateApiUrl(rawUrl) {
        const u = String(rawUrl || '');
        if (!u) return true;
        if (/\.(?:js|css|png|jpg|jpeg|webp|svg|woff2?|ico|mp4|m3u8|ts|m4s)(?:\?|$)/i.test(u)) return false;
        return /(?:x\.com|twitter\.com|\/i\/api\/|\/graphql\/|\/2\/|\/1\.1\/)/i.test(u);
    }

    function cleanTweetText(rawText) {
        return String(rawText || '')
            .replace(/https:\/\/t\.co\/\w+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function registerMediaItem(item) {
        if (!item || !item.id || !item.playUrl) return false;
        syncRouteKey();

        const bucket = getCurrentRouteBucket();
        const prev = allMediaMap.get(item.id);
        if (prev) {
            if (!prev.text && item.text) prev.text = item.text;
            if (!prev.screenName && item.screenName) {
                prev.screenName = item.screenName;
                prev.authorName = item.authorName || prev.authorName;
                prev.authorUrl = item.authorUrl || prev.authorUrl;
            }
            if (!prev.poster && item.poster) prev.poster = item.poster;
            if (prev.orientation === 'unknown' && item.orientation !== 'unknown') {
                prev.width = item.width;
                prev.height = item.height;
                prev.orientation = item.orientation;
            }
            if (!bucket.has(item.id)) {
                bucket.set(item.id, prev);
                updatePanelCounts();
                if (feedOpen && typeof feedOnNewMedia === 'function') feedOnNewMedia(prev);
                return true;
            }
            return false;
        }

        allMediaMap.set(item.id, item);
        bucket.set(item.id, item);
        updatePanelCounts();
        if (feedOpen && typeof feedOnNewMedia === 'function') {
            feedOnNewMedia(item);
        }
        return true;
    }

    function ingestSingleMedia(m, ctx = {}, idx = 0) {
        if (!m || typeof m !== 'object') return;
        const variants = Array.isArray(m.video_info?.variants) ? m.video_info.variants : [];
        if (variants.length === 0) return;

        const mp4s = variants
            .filter((v) => v && v.url && (/mp4/i.test(v.content_type || '') || /\.mp4(?:\?|$)/i.test(v.url)))
            .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

        const hls = variants.find((v) => v && v.url && (/mpegurl/i.test(v.content_type || '') || /\.m3u8(?:\?|$)/i.test(v.url)));
        const playUrl = mp4s[0]?.url || hls?.url || '';
        if (!playUrl) return;

        const previewUrl = mp4s.length > 0 ? mp4s[mp4s.length - 1].url : '';
        const isGif = m.type === 'animated_gif';
        const durationMs = Number(m.video_info?.duration_millis || 0);
        const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : (isGif ? 0 : -1);

        // 優先採用真實影片串流 URL 尺寸與 video_info.aspect_ratio，避免被 16:9 縮圖誤判
        let width = 0;
        let height = 0;
        const fromUrl = parseDimensionsFromUrl(mp4s[0]?.url || previewUrl || playUrl);
        if (fromUrl.w > 0 && fromUrl.h > 0) {
            width = fromUrl.w;
            height = fromUrl.h;
        } else if (Array.isArray(m.video_info?.aspect_ratio) && m.video_info.aspect_ratio.length === 2) {
            width = Number(m.video_info.aspect_ratio[0]) || 0;
            height = Number(m.video_info.aspect_ratio[1]) || 0;
        }
        if (!width || !height) {
            width = Number(m.original_info?.width || m.sizes?.large?.w || m.sizes?.medium?.w || 0);
            height = Number(m.original_info?.height || m.sizes?.large?.h || m.sizes?.medium?.h || 0);
        }
        const orientation = classifyOrientation(width, height);

        const tweetId = String(ctx.tweetId || '');
        const screenName = String(ctx.screenName || '');
        const authorName = String(ctx.authorName || (screenName ? `@${screenName}` : 'X 用戶'));
        const mediaKey = String(m.media_key || m.id_str || m.id || `${tweetId || 'v'}_${playUrl.split('?')[0].slice(-24)}_${idx}`);
        const tweetUrl = tweetId
            ? `https://x.com/${screenName || 'i'}/status/${tweetId}`
            : (m.expanded_url || location.href);

        registerMediaItem({
            id: mediaKey,
            tweetId,
            authorName,
            screenName,
            authorUrl: screenName ? `https://x.com/${screenName}` : '',
            text: cleanTweetText(ctx.fullText || ''),
            tweetUrl,
            poster: m.media_url_https || m.media_url || '',
            playUrl,
            previewUrl,
            isGif,
            durationSec,
            durationText: isGif ? 'GIF' : (durationSec > 0 ? formatSec(durationSec) : ''),
            width,
            height,
            orientation,
            orientationVerified: fromUrl.w > 0 && fromUrl.h > 0
        });
    }

    function extractUserFields(userObj) {
        if (!userObj || typeof userObj !== 'object') return { authorName: '', screenName: '' };
        const res = userObj.result || userObj;
        const authorName = res?.core?.name || res?.legacy?.name || res?.name || '';
        const screenName = res?.core?.screen_name || res?.legacy?.screen_name || res?.screen_name || '';
        return { authorName, screenName };
    }

    function extractMediaFromJson(root, baseCtx = {}) {
        if (!root || typeof root !== 'object') return;
        const visited = new Set();
        let nodeBudget = 30000;

        const walk = (node, depth, ctx) => {
            if (!node || typeof node !== 'object' || depth > 32 || nodeBudget <= 0 || visited.has(node)) return;
            visited.add(node);
            nodeBudget--;

            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) walk(node[i], depth + 1, ctx);
                return;
            }

            if (cfg.blockAds && (node.promotedMetadata || node.adMetadata || node.__typename === 'TimelinePromotedTweet')) {
                return;
            }

            if (node.globalObjects?.tweets && typeof node.globalObjects.tweets === 'object') {
                const users = node.globalObjects.users || {};
                Object.values(node.globalObjects.tweets).forEach((t) => {
                    if (!t || typeof t !== 'object') return;
                    const u = users[t.user_id_str] || {};
                    const tCtx = {
                        tweetId: t.id_str || '',
                        authorName: u.name || '',
                        screenName: u.screen_name || '',
                        fullText: t.full_text || t.text || ''
                    };
                    const media = t.extended_entities?.media || t.entities?.media;
                    if (Array.isArray(media)) media.forEach((m, i) => ingestSingleMedia(m, tCtx, i));
                });
            }

            let nextCtx = ctx;
            const tweetObj = node.__typename === 'TweetWithVisibilityResults' && node.tweet ? node.tweet : node;
            if (tweetObj && tweetObj.legacy && typeof tweetObj.legacy === 'object') {
                const leg = tweetObj.legacy;
                const u = extractUserFields(tweetObj.core?.user_results || tweetObj.author_results || tweetObj.user_results);
                const fullText = tweetObj.note_tweet?.note_tweet_results?.result?.text || leg.full_text || leg.text || ctx.fullText || '';
                nextCtx = {
                    tweetId: tweetObj.rest_id || leg.id_str || ctx.tweetId || '',
                    authorName: u.authorName || ctx.authorName || '',
                    screenName: u.screenName || ctx.screenName || '',
                    fullText
                };
            } else if (node.id_str && (node.full_text || node.text) && (node.extended_entities || node.entities)) {
                nextCtx = {
                    tweetId: node.id_str,
                    authorName: ctx.authorName || '',
                    screenName: ctx.screenName || '',
                    fullText: node.full_text || node.text || ctx.fullText || ''
                };
            }

            if (node.video_info && Array.isArray(node.video_info.variants)) {
                ingestSingleMedia(node, nextCtx, 0);
            }

            if (node.key === 'unified_card' && typeof node.value?.string_value === 'string') {
                try {
                    walk(JSON.parse(node.value.string_value), depth + 1, nextCtx);
                } catch {}
            } else if (typeof node.unified_card?.string_value === 'string') {
                try {
                    walk(JSON.parse(node.unified_card.string_value), depth + 1, nextCtx);
                } catch {}
            }

            const keys = Object.keys(node);
            for (let i = 0; i < keys.length; i++) {
                const val = node[keys[i]];
                if (val && typeof val === 'object') {
                    walk(val, depth + 1, nextCtx);
                }
            }
        };

        walk(root, 0, baseCtx);
    }

    function processApiText(text) {
        if (typeof text !== 'string' || text.length < 40) return;
        if (!text.includes('video_info') && !text.includes('animated_gif') && !text.includes('video.twimg.com')) return;
        try {
            const json = JSON.parse(text);
            extractMediaFromJson(json);
        } catch {}
    }

    function installApiHooks() {
        if (!window.__xpRespHooked && window.Response?.prototype) {
            const origJson = Response.prototype.json;
            const origText = Response.prototype.text;

            Response.prototype.json = function (...args) {
                const promise = origJson.apply(this, args);
                if (!this.__xpSkip && isCandidateApiUrl(this.url)) {
                    promise.then((data) => {
                        if (data && typeof data === 'object') extractMediaFromJson(data);
                    }).catch(() => {});
                }
                return promise;
            };

            Response.prototype.text = function (...args) {
                const promise = origText.apply(this, args);
                if (!this.__xpSkip && isCandidateApiUrl(this.url)) {
                    promise.then((txt) => processApiText(txt)).catch(() => {});
                }
                return promise;
            };

            window.__xpRespHooked = true;
        }

        if (typeof window.fetch === 'function' && !window.__xpFetchHooked) {
            const origFetch = window.fetch;
            window.fetch = function (...args) {
                const promise = origFetch.apply(this, args);
                try {
                    const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                    if (isCandidateApiUrl(reqUrl)) {
                        promise.then((res) => {
                            if (res && res.ok) {
                                const cloned = res.clone();
                                cloned.__xpSkip = true;
                                cloned.text().then(processApiText).catch(() => {});
                            }
                        }).catch(() => {});
                    }
                } catch {}
                return promise;
            };
            window.__xpFetchHooked = true;
        }

        if (window.XMLHttpRequest?.prototype && !window.XMLHttpRequest.prototype.__xpXhrHooked) {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this.__xpUrl = typeof url === 'string' ? url : String(url || '');
                return origOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.send = function (...args) {
                if (isCandidateApiUrl(this.__xpUrl)) {
                    this.addEventListener('load', function () {
                        try {
                            if (this.responseType === 'json' && this.response) {
                                extractMediaFromJson(this.response);
                            } else if ((!this.responseType || this.responseType === 'text') && this.responseText) {
                                processApiText(this.responseText);
                            }
                        } catch {}
                    });
                }
                return origSend.apply(this, args);
            };
            window.XMLHttpRequest.prototype.__xpXhrHooked = true;
        }
    }

    function findReduxStore() {
        if (cachedReduxStore && typeof cachedReduxStore.getState === 'function') {
            return cachedReduxStore;
        }
        try {
            const rootEl = document.getElementById('react-root') || document.querySelector('#react-root');
            if (!rootEl) return null;
            const reactKey = Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
            let startFiber = reactKey ? rootEl[reactKey] : rootEl._reactRootContainer?._internalRoot?.current;
            if (!startFiber) return null;

            const queue = [startFiber];
            const seen = new Set();
            let steps = 0;

            while (queue.length > 0 && steps < 700) {
                const node = queue.shift();
                if (!node || seen.has(node)) continue;
                seen.add(node);
                steps++;

                const candidates = [
                    node.memoizedProps?.store,
                    node.pendingProps?.store,
                    node.stateNode?.store,
                    node.memoizedProps?.value?.store
                ];
                for (const st of candidates) {
                    if (st && typeof st.getState === 'function' && typeof st.dispatch === 'function') {
                        cachedReduxStore = st;
                        return st;
                    }
                }
                if (node.child) queue.push(node.child);
                if (node.sibling) queue.push(node.sibling);
            }
        } catch {}
        return null;
    }

    function scanReduxStore() {
        const before = allMediaMap.size;
        try {
            if (window.__INITIAL_STATE__) {
                extractMediaFromJson(window.__INITIAL_STATE__);
            }
            const store = findReduxStore();
            if (!store) return allMediaMap.size - before;

            const state = store.getState();
            const tweets = state?.entities?.tweets?.entities;
            const users = state?.entities?.users?.entities || {};

            if (tweets && typeof tweets === 'object') {
                Object.values(tweets).forEach((t) => {
                    if (!t || typeof t !== 'object') return;
                    if (cfg.blockAds && (t.promotedMetadata || t.adMetadata)) return;
                    const u = users[t.user_id_str] || {};
                    const ctx = {
                        tweetId: t.id_str || '',
                        authorName: u.name || '',
                        screenName: u.screen_name || '',
                        fullText: t.full_text || t.text || ''
                    };
                    const media = t.extended_entities?.media || t.entities?.media;
                    if (Array.isArray(media)) {
                        media.forEach((m, i) => ingestSingleMedia(m, ctx, i));
                    }
                    const unifiedStr = t.card?.binding_values?.unified_card?.string_value;
                    if (typeof unifiedStr === 'string' && unifiedStr.includes('video_info')) {
                        try { extractMediaFromJson(JSON.parse(unifiedStr), ctx); } catch {}
                    }
                });
            }
        } catch {}
        return allMediaMap.size - before;
    }

    function scanDomAndFiber() {
        const before = allMediaMap.size;
        try {
            document.querySelectorAll('article[data-testid="tweet"], div[data-testid="videoPlayer"], video').forEach((el) => {
                if (el.closest('#xp-feed-overlay, #xp-float-panel')) return;

                if (el.tagName === 'VIDEO') {
                    const src = el.currentSrc || el.src || el.querySelector('source')?.src || '';
                    if (src && /^https?:\/\//i.test(src) && !src.startsWith('blob:')) {
                        const article = el.closest('article[data-testid="tweet"]');
                        const timeLink = article?.querySelector('a[href*="/status/"]')?.href || '';
                        const tweetId = (timeLink.match(/\/status\/(\d+)/) || [])[1] || '';
                        const screenName = (timeLink.match(/x\.com\/([^/]+)\/status\//) || [])[1] || '';
                        const text = article?.querySelector('[data-testid="tweetText"]')?.textContent || '';
                        const urlDims = parseDimensionsFromUrl(src);
                        const vw = el.videoWidth || urlDims.w || 0;
                        const vh = el.videoHeight || urlDims.h || 0;
                        registerMediaItem({
                            id: `dom_${src.split('?')[0].slice(-36)}`,
                            tweetId,
                            authorName: screenName ? `@${screenName}` : 'X 用戶',
                            screenName,
                            authorUrl: screenName ? `https://x.com/${screenName}` : '',
                            text: cleanTweetText(text),
                            tweetUrl: timeLink || location.href,
                            poster: el.poster || '',
                            playUrl: src,
                            previewUrl: /\.mp4(?:\?|$)/i.test(src) ? src : '',
                            isGif: Boolean(el.loop && (!el.duration || el.duration < 15)),
                            durationSec: Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : -1,
                            durationText: Number.isFinite(el.duration) && el.duration > 0 ? formatSec(el.duration) : '',
                            width: vw,
                            height: vh,
                            orientation: classifyOrientation(vw, vh),
                            orientationVerified: vw > 0 && vh > 0
                        });
                    }
                }

                const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
                if (!fiberKey) return;

                let cur = el[fiberKey];
                for (let step = 0; step < 26 && cur; step++) {
                    const props = cur.memoizedProps;
                    if (props && typeof props === 'object') {
                        const candidates = [props.tweet, props.media, props.mediaEntity, props.video, props.item, props.entry, props.source];
                        for (const c of candidates) {
                            if (c && typeof c === 'object') {
                                if (c.video_info?.variants) {
                                    ingestSingleMedia(c, {}, 0);
                                } else if (c.legacy || c.extended_entities || c.entities || c.variants) {
                                    extractMediaFromJson(c);
                                }
                            }
                        }
                    }
                    cur = cur.return;
                }
            });
        } catch {}
        return allMediaMap.size - before;
    }

    function scanAllPageSources() {
        syncRouteKey();
        const n1 = scanReduxStore();
        const n2 = scanDomAndFiber();
        updatePanelCounts();
        return n1 + n2;
    }

    // ==================== 3. 廣告隱藏與篩選規則 ====================
    function hidePromotedTweets() {
        if (!cfg.blockAds || feedOpen || document.hidden) return;

        document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
            const cell = article.closest('div[data-testid="cellInnerDiv"]') || article;
            if (cell.classList.contains('xp-ad-hidden')) return;
            if (article.querySelector('time')) return;

            let isAd = Boolean(article.querySelector('a[href*="/i/ads"], a[href*="business.x.com"]'));
            if (!isAd) {
                const spans = article.querySelectorAll('span');
                for (const sp of spans) {
                    if (sp.closest('[data-testid="tweetText"]')) continue;
                    const txt = (sp.textContent || '').trim();
                    if (txt && txt.length <= 16 && AD_TEXT_RE.test(txt)) {
                        isAd = true;
                        break;
                    }
                }
            }
            if (isAd) {
                cell.classList.add('xp-ad-hidden');
            }
        });
    }

    function matchesFilters(item, strictOrient = true) {
        if (!item || !item.playUrl) return false;
        if (item.isGif && !cfg.showGif) return false;

        if (cfg.minSeconds > 0) {
            if (item.isGif) return false;
            if (item.durationSec >= 0 && item.durationSec < cfg.minSeconds) return false;
        }

        if (cfg.orientation !== 'all') {
            if (item.orientation === 'unknown') {
                return !strictOrient;
            }
            if (item.orientation !== cfg.orientation) return false;
        }

        return true;
    }

    function getFilteredPool(strictOrient = true) {
        return getPoolItems().filter((it) => matchesFilters(it, strictOrient));
    }

    function updatePanelCounts() {
        const panel = document.getElementById('xp-float-panel');
        if (!panel) return;
        const pool = getPoolItems();
        const pageCount = getCurrentRouteBucket().size;
        const allCount = allMediaMap.size;
        const matched = getFilteredPool(true).length;
        const portCount = pool.filter((it) => it.orientation === 'portrait').length;
        const landCount = pool.filter((it) => it.orientation === 'landscape').length;

        const feedBtn = panel.querySelector('#xp-btn-feed');
        if (feedBtn) feedBtn.textContent = `🎬 進入抖音模式 (${matched})`;

        const miniBtn = panel.querySelector('#xp-btn-feed-mini');
        if (miniBtn) miniBtn.textContent = `🎬 ${matched}`;

        const landBtn = panel.querySelector('[data-orient="landscape"]');
        if (landBtn) landBtn.textContent = `📺 橫屏 (${landCount})`;

        const portBtn = panel.querySelector('[data-orient="portrait"]');
        if (portBtn) portBtn.textContent = `📱 豎屏 (${portCount})`;

        const statsEl = panel.querySelector('#xp-stats-line');
        if (statsEl) {
            statsEl.textContent = `符合 ${matched} 部 · 本頁 ${pageCount} / 累積 ${allCount}`;
        }
    }

    // ==================== 4. 抖音模式（固定像素高度防變形 + 獨立抽屜捲動 + 快轉預覽） ====================
    function updateFeedClockText() {
        const el = document.getElementById('xp-feed-clock');
        if (!el) return;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        el.textContent = feedClockShowSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
    }

    function startFeedClock() {
        stopFeedClock();
        updateFeedClockText();
        feedClockTimer = setInterval(() => {
            if (!feedOpen) {
                stopFeedClock();
                return;
            }
            if (!document.hidden) updateFeedClockText();
        }, 1000);
    }

    function stopFeedClock() {
        if (feedClockTimer) {
            clearInterval(feedClockTimer);
            feedClockTimer = null;
        }
    }

    function triggerBackgroundScrollLoad(forceNow = false) {
        if (!cfg.autoScrollLoad && !forceNow) return;
        const now = Date.now();
        if (!forceNow && now - lastBgScrollTs < 1800) return;
        lastBgScrollTs = now;
        try {
            window.scrollBy({ top: Math.max(900, window.innerHeight * 1.4), behavior: 'instant' });
        } catch {
            window.scrollBy(0, Math.max(900, window.innerHeight * 1.4));
        }
        setTimeout(() => {
            if (feedOpen) scanAllPageSources();
        }, 900);
    }

    function openFeedMode(startIdx = 0) {
        if (feedOpen) return;
        scanAllPageSources();

        let initialList = getFilteredPool(true);
        if (initialList.length === 0 && cfg.orientation !== 'all') {
            const unknownOnly = getPoolItems().filter((it) => it.orientation === 'unknown' && matchesFilters(it, false));
            if (unknownOnly.length > 0) {
                initialList = unknownOnly;
            }
        }
        if (initialList.length === 0) {
            const tip = cfg.orientation !== 'all'
                ? `⚠️ 目前尚未收到符合「${orientLabel(cfg.orientation)}」的影片，請先切回「全部」或往下滑過更多影片`
                : '⚠️ 目前尚未掃到符合條件的影片，請先往下滑過影片貼文或放寬篩選條件';
            showToast(tip, 3200);
            return;
        }

        document.querySelectorAll('video').forEach((v) => {
            try { v.pause(); } catch {}
        });

        feedOpen = true;
        feedItems = initialList.slice();
        feedIdSet = new Set(feedItems.map((it) => it.id));
        feedIndex = Math.max(0, Math.min(startIdx, feedItems.length - 1));
        consecutiveAutoSkips = 0;

        const overlay = document.createElement('div');
        overlay.id = 'xp-feed-overlay';
        overlay.innerHTML = `
            <div id="xp-feed-topbar">
                <div class="xp-feed-top-group">
                    <button type="button" id="xp-feed-close" class="xp-fbtn">✕ 退出</button>
                    <span id="xp-feed-counter" class="xp-fbtn">1 / ${feedItems.length}</span>
                </div>
                <div class="xp-feed-top-group">
                    <button type="button" id="xp-feed-orient" class="xp-fbtn ${cfg.orientation !== 'all' ? 'highlight' : ''}" title="切換 全部 / 橫屏 / 豎屏">${orientLabel(cfg.orientation)}</button>
                    <button type="button" id="xp-feed-drawer-btn" class="xp-fbtn">☰ 選集</button>
                    <button type="button" id="xp-feed-clock" class="xp-fbtn" title="點擊切換顯示秒數">00:00</button>
                </div>
            </div>
            <div id="xp-feed-track" class="xp-feed-track"></div>
            <div id="xp-feed-preview-box">
                <div id="xp-feed-preview-stage">
                    <img id="xp-feed-preview-poster" src="" alt="" />
                    <video id="xp-feed-preview-video" muted playsinline webkit-playsinline preload="metadata"></video>
                    <div id="xp-feed-preview-loading">⏳ 預覽</div>
                </div>
                <div id="xp-feed-preview-label">00:00 / 00:00</div>
            </div>
            <div id="xp-feed-bottom-dock">
                <div id="xp-feed-author-row">
                    <a id="xp-feed-author" href="#" target="_blank" rel="noopener"></a>
                    <span id="xp-feed-meta"></span>
                </div>
                <div id="xp-feed-text" title="點擊展開或收合內文"></div>
                <div class="xp-feed-scrub-row">
                    <input type="range" id="xp-feed-range" min="0" max="1000" value="0" />
                    <span id="xp-feed-time">00:00 / 00:00</span>
                </div>
                <div class="xp-feed-ctrl-row">
                    <div class="xp-feed-ctrl-group">
                        <button type="button" class="xp-fcbtn" data-fseek="-5">⏪ -5s</button>
                        <button type="button" class="xp-fcbtn accent" id="xp-fc-play">⏯ 播放</button>
                        <button type="button" class="xp-fcbtn" data-fseek="5">+5s ⏩</button>
                    </div>
                    <div class="xp-feed-ctrl-group">
                        <button type="button" class="xp-fcbtn" id="xp-fc-speed">${cfg.playbackRate}x</button>
                        <button type="button" class="xp-fcbtn" id="xp-fc-mute">${cfg.feedMuted ? '🔇 靜音' : '🔊 有聲'}</button>
                        <a id="xp-fc-open" class="xp-fcbtn" href="#" target="_blank" rel="noopener">🔗 原推文</a>
                        <button type="button" class="xp-fcbtn" id="xp-fc-fs">⛶ 全螢幕</button>
                    </div>
                </div>
            </div>
            <div id="xp-feed-hud"></div>
            <div id="xp-feed-drawer">
                <div class="xp-drawer-head">
                    <span id="xp-drawer-title">播放選集 (${feedItems.length})</span>
                    <button type="button" id="xp-drawer-close" class="xp-fbtn">✕ 關閉</button>
                </div>
                <div id="xp-drawer-scroll" class="xp-drawer-scroll">
                    <div id="xp-drawer-grid" class="xp-drawer-grid"></div>
                    <div class="xp-drawer-more-wrap">
                        <button type="button" id="xp-drawer-load-more" class="xp-fbtn highlight">＋ 載入更多推文影片</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const track = overlay.querySelector('#xp-feed-track');
        const hud = overlay.querySelector('#xp-feed-hud');
        const counterEl = overlay.querySelector('#xp-feed-counter');
        const orientBtn = overlay.querySelector('#xp-feed-orient');
        const authorEl = overlay.querySelector('#xp-feed-author');
        const metaEl = overlay.querySelector('#xp-feed-meta');
        const textEl = overlay.querySelector('#xp-feed-text');
        const openLinkEl = overlay.querySelector('#xp-fc-open');
        const rangeEl = overlay.querySelector('#xp-feed-range');
        const timeEl = overlay.querySelector('#xp-feed-time');
        const drawerEl = overlay.querySelector('#xp-feed-drawer');
        const drawerScroll = overlay.querySelector('#xp-drawer-scroll');
        const drawerGrid = overlay.querySelector('#xp-drawer-grid');
        const drawerTitle = overlay.querySelector('#xp-drawer-title');

        const previewBox = overlay.querySelector('#xp-feed-preview-box');
        const previewStage = overlay.querySelector('#xp-feed-preview-stage');
        const previewPoster = overlay.querySelector('#xp-feed-preview-poster');
        const previewVideo = overlay.querySelector('#xp-feed-preview-video');
        const previewLoading = overlay.querySelector('#xp-feed-preview-loading');
        const previewLabel = overlay.querySelector('#xp-feed-preview-label');

        let slideHeight = Math.round(window.visualViewport?.height || window.innerHeight || 640);
        let previewLoadedId = '';
        let previewVideoUrl = '';
        let previewTargetSec = null;
        let previewLastSeekTs = 0;
        let previewSeekTimer = null;
        let mainLiveSeekLastTs = 0;
        let mainWasPlayingBeforeScrub = false;
        let usingMainLiveFallback = false;

        let pendingAdvanceAfterLoad = false;
        let pendingAdvanceTimer = null;
        let lastAutoScrollLen = -1;

        let scrubbing = false;
        let hudHideTimer = null;

        const applyViewportMetrics = () => {
            const h = Math.round(window.visualViewport?.height || window.innerHeight || overlay.clientHeight || 640);
            if (h > 100) {
                slideHeight = h;
                overlay.style.setProperty('--xp-slide-h', `${slideHeight}px`);
                track.classList.add('dragging');
                track.style.transform = `translate3d(0, -${feedIndex * slideHeight}px, 0)`;
                requestAnimationFrame(() => track.classList.remove('dragging'));
            }
        };

        applyViewportMetrics();
        window.addEventListener('resize', applyViewportMetrics);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', applyViewportMetrics);
        }
        feedResizeCleanup = () => {
            window.removeEventListener('resize', applyViewportMetrics);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', applyViewportMetrics);
            }
        };

        const getSlides = () => Array.from(track.querySelectorAll(':scope > .xp-feed-slide'));
        const getSlide = (i) => getSlides()[i] || null;
        const getCurrentVideo = () => getSlide(feedIndex)?.querySelector('video') || null;

        const showFeedHud = (text, durationMs = 650) => {
            hud.textContent = text;
            hud.classList.add('show');
            clearTimeout(hudHideTimer);
            if (durationMs > 0) {
                hudHideTimer = setTimeout(() => hud.classList.remove('show'), durationMs);
            }
        };

        const requestMoreAndAdvance = () => {
            pendingAdvanceAfterLoad = true;
            clearTimeout(pendingAdvanceTimer);
            pendingAdvanceTimer = setTimeout(() => { pendingAdvanceAfterLoad = false; }, 4500);
            triggerBackgroundScrollLoad(true);
            showFeedHud('⏳ 正在載入更多推文...', 1400);
        };

        // ==================== 快轉畫面預覽引擎 ====================
        const resetPreviewMedia = () => {
            clearTimeout(previewSeekTimer);
            previewSeekTimer = null;
            previewTargetSec = null;
            previewLoadedId = '';
            previewVideoUrl = '';
            previewBox.classList.remove('show');
            previewVideo.classList.remove('ready');
            previewLoading.style.display = 'none';
            try {
                previewVideo.pause();
                previewVideo.removeAttribute('src');
                previewVideo.load();
            } catch {}
        };
        feedCleanupPreview = resetPreviewMedia;

        const executePreviewSeek = (sec) => {
            if (!previewVideoUrl || previewVideo.readyState < 1) return;
            const dur = Number.isFinite(previewVideo.duration) ? previewVideo.duration : 0;
            const clamped = dur > 0 ? Math.max(0, Math.min(dur - 0.1, sec)) : Math.max(0, sec);
            previewLastSeekTs = Date.now();
            try {
                if (typeof previewVideo.fastSeek === 'function') previewVideo.fastSeek(clamped);
                else previewVideo.currentTime = clamped;
            } catch {
                try { previewVideo.currentTime = clamped; } catch {}
            }
        };

        const schedulePreviewSeek = (sec) => {
            previewTargetSec = sec;
            if (!previewVideoUrl || previewVideo.readyState < 1 || previewVideo.seeking) return;
            const elapsed = Date.now() - previewLastSeekTs;
            clearTimeout(previewSeekTimer);
            if (elapsed >= 80) {
                executePreviewSeek(sec);
            } else {
                previewSeekTimer = setTimeout(() => {
                    if (previewTargetSec !== null && !previewVideo.seeking) {
                        executePreviewSeek(previewTargetSec);
                    }
                }, 80 - elapsed);
            }
        };

        previewVideo.addEventListener('loadedmetadata', () => {
            if (previewVideo.videoWidth > 0 && previewVideo.videoHeight > 0) {
                previewStage.classList.toggle('portrait', previewVideo.videoHeight > previewVideo.videoWidth * 1.03);
            }
            if (previewTargetSec !== null) executePreviewSeek(previewTargetSec);
        });

        previewVideo.addEventListener('seeked', () => {
            previewVideo.classList.add('ready');
            previewLoading.style.display = 'none';
            if (previewTargetSec !== null && Math.abs((previewVideo.currentTime || 0) - previewTargetSec) > 0.55) {
                executePreviewSeek(previewTargetSec);
            }
        });

        previewVideo.addEventListener('error', () => {
            previewVideoUrl = '';
            previewVideo.classList.remove('ready');
        });

        const showSeekPreview = (targetSec, duration, labelText, anchorClientX = null, allowMainFallback = true) => {
            const item = feedItems[feedIndex];
            const curVideo = getCurrentVideo();
            if (!item || !Number.isFinite(duration) || duration <= 0) return;

            const isPort = (curVideo && curVideo.videoHeight > curVideo.videoWidth * 1.03) || item.orientation === 'portrait';
            previewStage.classList.toggle('portrait', Boolean(isPort));

            if (previewPoster.src !== (item.poster || '')) {
                previewPoster.src = item.poster || '';
                previewPoster.style.display = item.poster ? 'block' : 'none';
            }
            previewLabel.textContent = labelText || `${formatSec(targetSec)} / ${formatSec(duration)}`;

            if (typeof anchorClientX === 'number' && Number.isFinite(anchorClientX)) {
                const halfW = (previewBox.offsetWidth || 226) / 2;
                const clampedX = Math.max(halfW + 10, Math.min(window.innerWidth - halfW - 10, anchorClientX));
                previewBox.style.left = `${clampedX}px`;
                previewBox.style.bottom = `calc(158px + env(safe-area-inset-bottom, 0px))`;
            } else {
                previewBox.style.left = '50%';
                previewBox.style.bottom = `calc(180px + env(safe-area-inset-bottom, 0px))`;
            }

            if (item.previewUrl) {
                previewBox.classList.add('show');
                if (previewLoadedId !== item.id || previewVideoUrl !== item.previewUrl) {
                    previewLoadedId = item.id;
                    previewVideoUrl = item.previewUrl;
                    previewVideo.classList.remove('ready');
                    previewLoading.style.display = 'block';
                    previewVideo.src = item.previewUrl;
                    previewVideo.load();
                } else if (!previewVideo.classList.contains('ready')) {
                    previewLoading.style.display = 'block';
                }
                schedulePreviewSeek(targetSec);
                return;
            }

            if (allowMainFallback && curVideo) {
                if (!usingMainLiveFallback) {
                    usingMainLiveFallback = true;
                    mainWasPlayingBeforeScrub = !curVideo.paused;
                    try { curVideo.pause(); } catch {}
                }
                const now = Date.now();
                if (now - mainLiveSeekLastTs >= 130) {
                    mainLiveSeekLastTs = now;
                    try { curVideo.currentTime = targetSec; } catch {}
                }
                showFeedHud(labelText || `${formatSec(targetSec)} / ${formatSec(duration)}`, 0);
            }
        };

        const hideSeekPreview = (commitFinalSec = null) => {
            clearTimeout(previewSeekTimer);
            previewSeekTimer = null;
            previewBox.classList.remove('show');
            hud.classList.remove('show');

            const curVideo = getCurrentVideo();
            if (curVideo && commitFinalSec !== null && Number.isFinite(curVideo.duration)) {
                curVideo.currentTime = Math.max(0, Math.min(curVideo.duration, commitFinalSec));
            }
            if (usingMainLiveFallback) {
                usingMainLiveFallback = false;
                if (curVideo && mainWasPlayingBeforeScrub) {
                    curVideo.play().catch(() => {});
                }
            }
        };

        const tryPlayVideo = (v) => {
            if (!v || !feedOpen) return;
            v.muted = Boolean(cfg.feedMuted);
            v.playbackRate = Number(cfg.playbackRate) || 1.0;
            v.play().catch(() => {
                v.muted = true;
                cfg.feedMuted = true;
                const muteBtn = overlay.querySelector('#xp-fc-mute');
                if (muteBtn) muteBtn.textContent = '🔇 靜音';
                v.play().catch(() => {});
            });
        };

        const syncBottomDockToItem = (item, realW = 0, realH = 0) => {
            if (!item) return;
            const handleStr = item.screenName && !item.authorName.includes(`@${item.screenName}`) ? ` @${item.screenName}` : '';
            authorEl.textContent = `${item.authorName}${handleStr}`;
            authorEl.href = item.authorUrl || item.tweetUrl || '#';

            const parts = [];
            if (item.isGif) parts.push('GIF');
            if (realW > 0 && realH > 0) {
                parts.push(`${realH > realW * 1.03 ? '📱 豎屏' : '📺 橫屏'} ${realW}×${realH}`);
            } else if (item.orientation === 'portrait') {
                parts.push('📱 豎屏');
            } else if (item.orientation === 'landscape') {
                parts.push('📺 橫屏');
            }
            if (item.durationText && !item.isGif) parts.push(`⏱ ${item.durationText}`);
            metaEl.textContent = parts.join(' · ');

            textEl.classList.remove('expanded');
            textEl.textContent = item.text || '（無推文文字）';
            openLinkEl.href = item.tweetUrl || '#';
        };

        const bindProgressSync = (video) => {
            if (feedProgressTimer) {
                clearInterval(feedProgressTimer);
                feedProgressTimer = null;
            }
            if (!video) return;
            feedProgressTimer = setInterval(() => {
                if (!feedOpen || scrubbing) return;
                if (Number.isFinite(video.duration) && video.duration > 0) {
                    rangeEl.value = String(Math.round((video.currentTime / video.duration) * 1000));
                    timeEl.textContent = `${formatSec(video.currentTime)} / ${formatSec(video.duration)}`;
                }
            }, 220);
        };

        const buildSlide = (item, idx) => {
            const slide = document.createElement('div');
            slide.className = 'xp-feed-slide';
            slide.dataset.idx = String(idx);

            slide.innerHTML = `
                ${item.poster ? `<img class="xp-feed-poster" src="${item.poster}" alt="" />` : ''}
                <video class="xp-feed-video" playsinline webkit-playsinline preload="metadata" loop></video>
                <div class="xp-feed-status">⏳ 正在載入影片...</div>
                <div class="xp-feed-center-icon">▶</div>
            `;

            const video = slide.querySelector('video');
            const posterEl = slide.querySelector('.xp-feed-poster');
            const statusEl = slide.querySelector('.xp-feed-status');

            if (video) {
                video.controls = false;
                video.removeAttribute('controls');
                video.muted = Boolean(cfg.feedMuted);
                video.playbackRate = Number(cfg.playbackRate) || 1.0;

                video.addEventListener('loadedmetadata', () => {
                    video.controls = false;
                    video.removeAttribute('controls');
                    const vw = video.videoWidth || 0;
                    const vh = video.videoHeight || 0;
                    if (vw > 0 && vh > 0) {
                        const actualOrient = classifyOrientation(vw, vh);
                        item.width = vw;
                        item.height = vh;
                        item.orientation = actualOrient;
                        item.orientationVerified = true;
                        updatePanelCounts();

                        if (idx === feedIndex) {
                            syncBottomDockToItem(item, vw, vh);
                            // 實際解析度與目前選定的橫／豎屏不符時自動跳過
                            if (cfg.orientation !== 'all' && actualOrient !== cfg.orientation) {
                                video.pause();
                                if (consecutiveAutoSkips < 15 && feedIndex < feedItems.length - 1) {
                                    consecutiveAutoSkips++;
                                    if (statusEl) {
                                        statusEl.textContent = `↪ 此片為${actualOrient === 'portrait' ? '豎屏' : '橫屏'}，自動跳下一部...`;
                                        statusEl.style.display = 'block';
                                    }
                                    setTimeout(() => {
                                        if (feedOpen && feedIndex === idx) goToSlide(idx + 1, true);
                                    }, 160);
                                    return;
                                }
                                consecutiveAutoSkips = 0;
                            } else {
                                consecutiveAutoSkips = 0;
                            }
                        }
                    }
                });

                video.addEventListener('playing', () => {
                    video.controls = false;
                    video.removeAttribute('controls');
                    if (statusEl) statusEl.style.display = 'none';
                    if (posterEl) posterEl.style.opacity = '0';
                });

                video.addEventListener('waiting', () => {
                    if (idx === feedIndex && statusEl) {
                        statusEl.textContent = '⏳ 緩衝中...';
                        statusEl.style.display = 'block';
                    }
                });

                video.addEventListener('error', () => {
                    if (idx === feedIndex && statusEl) {
                        statusEl.textContent = '⚠️ 影片無法播放，請上滑看下一部';
                        statusEl.style.display = 'block';
                    }
                });
            }

            return slide;
        };

        const syncSlidesDOM = () => {
            let count = getSlides().length;
            while (count < feedItems.length) {
                track.appendChild(buildSlide(feedItems[count], count));
                count++;
            }
            counterEl.textContent = `${feedIndex + 1} / ${feedItems.length}`;
        };

        // 增量建立選集卡片，避免背景新增影片時清空重繪卡住滑動
        const buildDrawerCell = (item, idx) => {
            const cell = document.createElement('div');
            cell.className = `xp-drawer-item ${idx === feedIndex ? 'active' : ''}`;
            cell.dataset.idx = String(idx);

            const thumb = document.createElement('div');
            thumb.className = 'xp-drawer-thumb';
            if (item.poster) {
                const img = document.createElement('img');
                img.src = item.poster;
                img.loading = 'lazy';
                img.alt = '';
                thumb.appendChild(img);
            }
            const idxSpan = document.createElement('span');
            idxSpan.className = 'xp-drawer-idx';
            idxSpan.textContent = `#${idx + 1}`;
            thumb.appendChild(idxSpan);

            if (item.orientation === 'portrait' || item.orientation === 'landscape') {
                const oSpan = document.createElement('span');
                oSpan.className = 'xp-drawer-orient';
                oSpan.textContent = item.orientation === 'portrait' ? '📱' : '📺';
                thumb.appendChild(oSpan);
            }

            if (item.durationText) {
                const durSpan = document.createElement('span');
                durSpan.className = 'xp-drawer-dur';
                durSpan.textContent = item.durationText;
                thumb.appendChild(durSpan);
            }

            const caption = document.createElement('div');
            caption.className = 'xp-drawer-caption';
            caption.textContent = item.text || item.authorName || '';

            cell.append(thumb, caption);
            cell.addEventListener('click', () => {
                drawerEl.classList.remove('open');
                goToSlide(idx);
            });
            return cell;
        };

        const syncDrawerItems = (forceRebuild = false) => {
            drawerTitle.textContent = `播放選集 (${feedItems.length})`;
            drawerGrid.classList.toggle('portrait-mode', cfg.orientation === 'portrait');

            if (forceRebuild) {
                drawerGrid.innerHTML = '';
            }

            let existing = drawerGrid.children.length;
            if (existing < feedItems.length) {
                const frag = document.createDocumentFragment();
                while (existing < feedItems.length) {
                    frag.appendChild(buildDrawerCell(feedItems[existing], existing));
                    existing++;
                }
                drawerGrid.appendChild(frag);
            }

            Array.from(drawerGrid.children).forEach((cell, i) => {
                cell.classList.toggle('active', i === feedIndex);
            });
        };

        feedOnNewMedia = (newItem) => {
            if (!feedOpen || feedIdSet.has(newItem.id) || !matchesFilters(newItem, true)) return;
            feedIdSet.add(newItem.id);
            feedItems.push(newItem);
            syncSlidesDOM();
            if (drawerEl.classList.contains('open')) {
                syncDrawerItems(false);
            }
            // 若使用者剛剛在底部上滑請求載入，收到新影片立刻自動滑向下一部
            if (pendingAdvanceAfterLoad && !drawerEl.classList.contains('open') && feedIndex < feedItems.length - 1) {
                pendingAdvanceAfterLoad = false;
                clearTimeout(pendingAdvanceTimer);
                goToSlide(feedIndex + 1);
            }
        };

        const activateSlide = (idx) => {
            const item = feedItems[idx];
            if (!item) return;

            resetPreviewMedia();
            hud.classList.remove('show');
            rangeEl.value = '0';
            timeEl.textContent = '00:00 / 00:00';
            syncBottomDockToItem(item, item.width, item.height);

            getSlides().forEach((sl, i) => {
                const v = sl.querySelector('video');
                if (!v) return;
                v.controls = false;
                v.removeAttribute('controls');
                if (i !== idx) {
                    try { v.pause(); } catch {}
                    if (Math.abs(i - idx) > 2 && v.src) {
                        v.removeAttribute('src');
                        v.load();
                        const posterEl = sl.querySelector('.xp-feed-poster');
                        if (posterEl) posterEl.style.opacity = '0.45';
                        delete sl.dataset.loaded;
                    }
                }
            });

            const activeSlide = getSlide(idx);
            const video = activeSlide?.querySelector('video');
            const statusEl = activeSlide?.querySelector('.xp-feed-status');
            if (!video) return;

            bindProgressSync(video);
            video.muted = Boolean(cfg.feedMuted);
            video.playbackRate = Number(cfg.playbackRate) || 1.0;

            if (activeSlide.dataset.loaded !== '1') {
                if (statusEl) {
                    statusEl.textContent = '⏳ 正在載入影片...';
                    statusEl.style.display = 'block';
                }
                activeSlide.dataset.loaded = '1';
                video.src = item.playUrl;
                video.load();
                tryPlayVideo(video);
            } else {
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                    syncBottomDockToItem(item, video.videoWidth, video.videoHeight);
                }
                tryPlayVideo(video);
            }

            // 接近倒數第 2 部時預抓下一批（每個清單長度只觸發一次，避免狂抓）
            if (idx >= feedItems.length - 2 && lastAutoScrollLen !== feedItems.length) {
                lastAutoScrollLen = feedItems.length;
                triggerBackgroundScrollLoad(false);
            }
        };

        const goToSlide = (targetIdx, isAutoSkip = false) => {
            if (!isAutoSkip) consecutiveAutoSkips = 0;
            syncSlidesDOM();
            feedIndex = Math.max(0, Math.min(targetIdx, feedItems.length - 1));
            track.classList.remove('dragging');
            track.style.transform = `translate3d(0, -${feedIndex * slideHeight}px, 0)`;
            counterEl.textContent = `${feedIndex + 1} / ${feedItems.length}`;
            activateSlide(feedIndex);
        };
        feedGoToSlide = goToSlide;

        const rebuildFeedForCurrentFilter = () => {
            const curId = feedItems[feedIndex]?.id;
            const filtered = getFilteredPool(true);
            if (filtered.length === 0) {
                showFeedHud(`⚠️ 目前沒有符合「${orientLabel(cfg.orientation)}」的影片`, 1400);
                return;
            }
            resetPreviewMedia();
            track.innerHTML = '';
            feedItems = filtered.slice();
            feedIdSet = new Set(feedItems.map((it) => it.id));
            lastAutoScrollLen = -1;
            const keepIdx = curId ? feedItems.findIndex((it) => it.id === curId) : -1;
            goToSlide(keepIdx >= 0 ? keepIdx : 0);
            if (drawerEl.classList.contains('open')) {
                syncDrawerItems(true);
            }
        };

        const calcRangeThumbX = (ratio) => {
            const rect = rangeEl.getBoundingClientRect();
            return rect.left + Math.max(0, Math.min(1, ratio)) * rect.width;
        };

        rangeEl.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            scrubbing = true;
            const curVideo = getCurrentVideo();
            if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                const ratio = Number(rangeEl.value) / 1000;
                const sec = ratio * curVideo.duration;
                showSeekPreview(sec, curVideo.duration, `${formatSec(sec)} / ${formatSec(curVideo.duration)}`, e.clientX || calcRangeThumbX(ratio), true);
            }
        });
        rangeEl.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            scrubbing = true;
        }, { passive: true });
        rangeEl.addEventListener('input', (e) => {
            e.stopPropagation();
            const curVideo = getCurrentVideo();
            if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                const ratio = Number(rangeEl.value) / 1000;
                const sec = ratio * curVideo.duration;
                const label = `${formatSec(sec)} / ${formatSec(curVideo.duration)}`;
                timeEl.textContent = label;
                showSeekPreview(sec, curVideo.duration, label, calcRangeThumbX(ratio), true);
            }
        });
        rangeEl.addEventListener('pointermove', (e) => {
            if (e.pointerType !== 'mouse' || scrubbing) return;
            const curVideo = getCurrentVideo();
            if (!curVideo || !Number.isFinite(curVideo.duration) || curVideo.duration <= 0) return;
            const rect = rangeEl.getBoundingClientRect();
            if (rect.width <= 0) return;
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const sec = ratio * curVideo.duration;
            showSeekPreview(sec, curVideo.duration, `${formatSec(sec)} / ${formatSec(curVideo.duration)}`, e.clientX, false);
        });
        rangeEl.addEventListener('pointerleave', () => {
            if (!scrubbing) hideSeekPreview(null);
        });

        const commitScrub = () => {
            if (!scrubbing) return;
            scrubbing = false;
            const curVideo = getCurrentVideo();
            const finalSec = (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0)
                ? (Number(rangeEl.value) / 1000) * curVideo.duration
                : null;
            hideSeekPreview(finalSec);
        };
        rangeEl.addEventListener('change', (e) => { e.stopPropagation(); commitScrub(); });
        rangeEl.addEventListener('pointerup', (e) => { e.stopPropagation(); commitScrub(); });
        rangeEl.addEventListener('touchend', (e) => { e.stopPropagation(); commitScrub(); }, { passive: true });
        rangeEl.addEventListener('pointercancel', () => commitScrub());

        textEl.addEventListener('click', (e) => {
            e.stopPropagation();
            textEl.classList.toggle('expanded');
        });

        overlay.querySelectorAll('[data-fseek]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sec = Number(btn.dataset.fseek);
                const curVideo = getCurrentVideo();
                if (!curVideo || !Number.isFinite(curVideo.duration)) return;
                curVideo.currentTime = Math.max(0, Math.min(curVideo.duration, curVideo.currentTime + sec));
                showFeedHud(sec > 0 ? `⏩ +${sec}s` : `⏪ ${sec}s`, 600);
            });
        });

        overlay.querySelector('#xp-fc-play').addEventListener('click', (e) => {
            e.stopPropagation();
            const curVideo = getCurrentVideo();
            if (!curVideo) return;
            if (curVideo.paused) curVideo.play().catch(() => {});
            else curVideo.pause();
        });

        overlay.querySelector('#xp-fc-speed').addEventListener('click', (e) => {
            e.stopPropagation();
            const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];
            cfg.playbackRate = speeds[(speeds.indexOf(cfg.playbackRate) + 1) % speeds.length];
            saveCfg();
            e.target.textContent = `${cfg.playbackRate}x`;
            const curVideo = getCurrentVideo();
            if (curVideo) curVideo.playbackRate = cfg.playbackRate;
        });

        overlay.querySelector('#xp-fc-mute').addEventListener('click', (e) => {
            e.stopPropagation();
            cfg.feedMuted = !cfg.feedMuted;
            saveCfg();
            e.target.textContent = cfg.feedMuted ? '🔇 靜音' : '🔊 有聲';
            const curVideo = getCurrentVideo();
            if (curVideo) curVideo.muted = cfg.feedMuted;
        });

        overlay.querySelector('#xp-fc-fs').addEventListener('click', (e) => {
            e.stopPropagation();
            const curVideo = getCurrentVideo();
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else if (overlay.requestFullscreen) {
                overlay.requestFullscreen().catch(() => {});
            } else if (curVideo?.webkitEnterFullscreen) {
                curVideo.webkitEnterFullscreen();
            }
        });

        orientBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const order = ['all', 'landscape', 'portrait'];
            cfg.orientation = order[(order.indexOf(cfg.orientation) + 1) % order.length];
            saveCfg();
            orientBtn.textContent = orientLabel(cfg.orientation);
            orientBtn.classList.toggle('highlight', cfg.orientation !== 'all');
            syncPanelUI();
            updatePanelCounts();
            rebuildFeedForCurrentFilter();
            showFeedHud(`已切換：${orientLabel(cfg.orientation)}`, 1000);
        });

        let tStartX = 0, tStartY = 0, gestureMode = null, scrubStartTime = 0, lastTapTs = 0;

        track.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            tStartX = e.touches[0].clientX;
            tStartY = e.touches[0].clientY;
            gestureMode = null;
            scrubStartTime = getCurrentVideo()?.currentTime || 0;
        }, { passive: true });

        track.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - tStartX;
            const dy = e.touches[0].clientY - tStartY;

            if (!gestureMode) {
                if (Math.hypot(dx, dy) < 12) return;
                gestureMode = Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'horizontal';
                if (gestureMode === 'vertical') track.classList.add('dragging');
            }

            if (gestureMode === 'vertical') {
                const atTop = feedIndex === 0 && dy > 0;
                const atBottom = feedIndex === feedItems.length - 1 && dy < 0;
                const offset = (atTop || atBottom) ? dy * 0.28 : dy;
                track.style.transform = `translate3d(0, ${-feedIndex * slideHeight + offset}px, 0)`;
            } else if (gestureMode === 'horizontal') {
                const curVideo = getCurrentVideo();
                if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                    const absY = Math.abs(dy);
                    const mult = absY > 90 ? 4 : (absY > 40 ? 2 : 1);
                    const spanSec = Math.min(90, Math.max(20, curVideo.duration));
                    const deltaSec = Math.round((dx / Math.max(240, window.innerWidth)) * spanSec * mult);
                    const targetSec = Math.max(0, Math.min(curVideo.duration, scrubStartTime + deltaSec));
                    const label = `${deltaSec >= 0 ? '⏩ +' : '⏪ '}${deltaSec}s · ${formatSec(targetSec)} / ${formatSec(curVideo.duration)} [${mult}x]`;
                    rangeEl.value = String(Math.round((targetSec / curVideo.duration) * 1000));
                    timeEl.textContent = `${formatSec(targetSec)} / ${formatSec(curVideo.duration)}`;
                    showSeekPreview(targetSec, curVideo.duration, label, null, true);
                }
            }
        }, { passive: true });

        track.addEventListener('touchend', (e) => {
            const endX = e.changedTouches[0]?.clientX ?? tStartX;
            const endY = e.changedTouches[0]?.clientY ?? tStartY;
            const dx = endX - tStartX;
            const dy = endY - tStartY;

            if (gestureMode === 'vertical') {
                const threshold = Math.min(80, slideHeight * 0.14);
                if (dy <= -threshold) {
                    if (feedIndex < feedItems.length - 1) goToSlide(feedIndex + 1);
                    else {
                        goToSlide(feedIndex);
                        requestMoreAndAdvance();
                    }
                } else if (dy >= threshold && feedIndex > 0) {
                    goToSlide(feedIndex - 1);
                } else {
                    goToSlide(feedIndex);
                }
            } else if (gestureMode === 'horizontal') {
                const curVideo = getCurrentVideo();
                let finalSec = null;
                if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                    const absY = Math.abs(dy);
                    const mult = absY > 90 ? 4 : (absY > 40 ? 2 : 1);
                    const spanSec = Math.min(90, Math.max(20, curVideo.duration));
                    const deltaSec = Math.round((dx / Math.max(240, window.innerWidth)) * spanSec * mult);
                    if (Math.abs(deltaSec) >= 1) {
                        finalSec = Math.max(0, Math.min(curVideo.duration, scrubStartTime + deltaSec));
                    }
                }
                hideSeekPreview(finalSec);
            } else if (Math.hypot(dx, dy) < 10 && !e.target.closest('button, input, a')) {
                const now = Date.now();
                const curSlide = getSlide(feedIndex);
                const curVideo = curSlide?.querySelector('video');
                const iconEl = curSlide?.querySelector('.xp-feed-center-icon');
                if (curVideo) {
                    if (now - lastTapTs < 260) {
                        const skip = endX > window.innerWidth * 0.5 ? 10 : -10;
                        if (Number.isFinite(curVideo.duration)) {
                            curVideo.currentTime = Math.max(0, Math.min(curVideo.duration, curVideo.currentTime + skip));
                        }
                        showFeedHud(skip > 0 ? '⏩ +10s' : '⏪ -10s', 650);
                    } else {
                        if (curVideo.paused) {
                            curVideo.play().catch(() => {});
                            if (iconEl) iconEl.textContent = '▶';
                        } else {
                            curVideo.pause();
                            if (iconEl) iconEl.textContent = '⏸';
                        }
                        if (iconEl) {
                            iconEl.classList.add('show');
                            setTimeout(() => iconEl.classList.remove('show'), 450);
                        }
                    }
                }
                lastTapTs = now;
            }
            gestureMode = null;
        }, { passive: true });

        track.addEventListener('touchcancel', () => {
            if (gestureMode === 'horizontal') hideSeekPreview(null);
            gestureMode = null;
        }, { passive: true });

        let wheelLock = false;
        overlay.addEventListener('wheel', (e) => {
            if (drawerEl.classList.contains('open')) return;
            e.preventDefault();
            if (wheelLock || Math.abs(e.deltaY) < 24) return;
            wheelLock = true;
            setTimeout(() => { wheelLock = false; }, 320);
            if (e.deltaY > 0) {
                if (feedIndex < feedItems.length - 1) goToSlide(feedIndex + 1);
                else requestMoreAndAdvance();
            } else if (e.deltaY < 0 && feedIndex > 0) {
                goToSlide(feedIndex - 1);
            }
        }, { passive: false });

        overlay.querySelector('#xp-feed-close').addEventListener('click', closeFeedMode);
        overlay.querySelector('#xp-feed-clock').addEventListener('click', (e) => {
            e.stopPropagation();
            feedClockShowSeconds = !feedClockShowSeconds;
            updateFeedClockText();
        });
        overlay.querySelector('#xp-feed-drawer-btn').addEventListener('click', () => {
            syncDrawerItems(true);
            drawerEl.classList.add('open');
            setTimeout(() => {
                const act = drawerGrid.querySelector('.xp-drawer-item.active');
                if (act) act.scrollIntoView({ block: 'center' });
            }, 40);
        });
        overlay.querySelector('#xp-drawer-close').addEventListener('click', () => {
            drawerEl.classList.remove('open');
        });
        overlay.querySelector('#xp-drawer-load-more').addEventListener('click', (e) => {
            e.stopPropagation();
            triggerBackgroundScrollLoad(true);
            showToast('⏳ 正在背景載入更多推文影片...', 1600);
        });
        drawerScroll.addEventListener('touchmove', (e) => {
            e.stopPropagation();
        }, { passive: true });

        startFeedClock();
        goToSlide(feedIndex);
    }

    function closeFeedMode() {
        if (!feedOpen) return;
        stopFeedClock();
        if (feedProgressTimer) {
            clearInterval(feedProgressTimer);
            feedProgressTimer = null;
        }
        if (feedCleanupPreview) {
            try { feedCleanupPreview(); } catch {}
            feedCleanupPreview = null;
        }
        if (feedResizeCleanup) {
            try { feedResizeCleanup(); } catch {}
            feedResizeCleanup = null;
        }
        feedGoToSlide = null;
        feedOnNewMedia = null;
        feedOpen = false;

        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }

        const overlay = document.getElementById('xp-feed-overlay');
        if (overlay) {
            overlay.querySelectorAll('video').forEach((v) => {
                try {
                    v.pause();
                    v.removeAttribute('src');
                    v.load();
                } catch {}
            });
            overlay.remove();
        }
    }

    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
        if (!feedOpen) return;

        const slides = document.querySelectorAll('#xp-feed-track > .xp-feed-slide');
        const curVideo = slides[feedIndex]?.querySelector('video') || null;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeFeedMode();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (feedIndex < feedItems.length - 1 && feedGoToSlide) feedGoToSlide(feedIndex + 1);
            else triggerBackgroundScrollLoad(true);
        } else if (e.key === 'ArrowUp' && feedIndex > 0) {
            e.preventDefault();
            if (feedGoToSlide) feedGoToSlide(feedIndex - 1);
        } else if (e.key === 'ArrowLeft' && curVideo) {
            e.preventDefault();
            curVideo.currentTime = Math.max(0, curVideo.currentTime - 5);
        } else if (e.key === 'ArrowRight' && curVideo && Number.isFinite(curVideo.duration)) {
            e.preventDefault();
            curVideo.currentTime = Math.min(curVideo.duration, curVideo.currentTime + 5);
        } else if (e.code === 'Space' && curVideo) {
            e.preventDefault();
            if (curVideo.paused) curVideo.play().catch(() => {});
            else curVideo.pause();
        }
    });

    // ==================== 5. 右下角懸浮控制面板 ====================
    function syncPanelUI() {
        const panel = document.getElementById('xp-float-panel');
        if (!panel) return;

        panel.querySelectorAll('[data-orient]').forEach((btn) => {
            btn.classList.toggle('on', btn.dataset.orient === cfg.orientation);
        });

        panel.querySelectorAll('[data-dur]').forEach((btn) => {
            btn.classList.toggle('on', Number(btn.dataset.dur) === cfg.minSeconds);
        });

        const presetSecs = DUR_PRESETS.map((p) => p.sec);
        const customBtn = panel.querySelector('#xp-dur-custom');
        if (customBtn) {
            const isCustom = cfg.minSeconds > 0 && !presetSecs.includes(cfg.minSeconds);
            customBtn.classList.toggle('on', isCustom);
            customBtn.textContent = isCustom ? formatMinDurLabel(cfg.minSeconds) : '自訂';
        }

        const durVal = panel.querySelector('#xp-dur-val');
        if (durVal) {
            durVal.textContent = cfg.minSeconds > 0 ? `隱藏 < ${formatMinDurLabel(cfg.minSeconds).replace('≥', '')}` : '目前：不限';
        }

        panel.querySelector('#xp-btn-gif')?.classList.toggle('on', cfg.showGif);
        panel.querySelector('#xp-btn-ads')?.classList.toggle('on', cfg.blockAds);
        panel.querySelector('#xp-btn-autoload')?.classList.toggle('on', cfg.autoScrollLoad);

        const scopeBtn = panel.querySelector('#xp-btn-scope');
        if (scopeBtn) {
            scopeBtn.textContent = cfg.scopeMode === 'page' ? '📄 來源：本頁' : '🌐 來源：全部累積';
            scopeBtn.classList.toggle('on', cfg.scopeMode === 'all');
        }
    }

    function createFloatingPanel() {
        if (!document.body || document.getElementById('xp-float-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'xp-float-panel';
        if (cfg.panelCollapsed) panel.classList.add('collapsed');

        panel.innerHTML = `
            <div class="xp-panel-head" id="xp-panel-head">
                <span>⚡ X 抖音增強</span>
                <div style="display:flex;align-items:center;gap:5px;">
                    <button type="button" id="xp-btn-feed-mini" class="xp-btn accent" style="padding:2px 8px;font-size:11px;">🎬 0</button>
                    <button type="button" id="xp-panel-toggle" class="xp-btn" style="padding:2px 8px;font-size:11px;">${cfg.panelCollapsed ? '展開' : '收合'}</button>
                </div>
            </div>
            <div class="xp-panel-body">
                <div class="xp-top-action-row">
                    <button type="button" id="xp-btn-feed" class="xp-btn accent" style="flex:1;padding:8px;font-size:13px;">🎬 進入抖音模式 (0)</button>
                    <button type="button" id="xp-btn-rescan" class="xp-btn" style="padding:8px 10px;" title="立即重新掃描目前頁面影片">🔄 重掃</button>
                </div>

                <div class="xp-section">
                    <div class="xp-section-title">
                        <span>📐 畫面方向篩選</span>
                        <span style="color:#9ca3af;font-weight:600;">依真實解析度判別</span>
                    </div>
                    <div class="xp-seg-3">
                        <button type="button" class="xp-btn" data-orient="all">全部一起</button>
                        <button type="button" class="xp-btn" data-orient="landscape">📺 橫屏 (0)</button>
                        <button type="button" class="xp-btn" data-orient="portrait">📱 豎屏 (0)</button>
                    </div>
                </div>

                <div class="xp-section">
                    <div class="xp-section-title">
                        <span>⏱️ 最低片長過濾</span>
                        <span id="xp-dur-val" style="color:#38bdf8;font-weight:700;">目前：不限</span>
                    </div>
                    <div class="xp-dur-grid">
                        ${DUR_PRESETS.map((p) => `<button type="button" class="xp-btn" data-dur="${p.sec}">${p.label}</button>`).join('')}
                        <button type="button" id="xp-dur-custom" class="xp-btn">自訂</button>
                    </div>
                </div>

                <div class="xp-section">
                    <div class="xp-grid-2">
                        <button type="button" id="xp-btn-gif" class="xp-btn">🎞️ 包含 GIF</button>
                        <button type="button" id="xp-btn-ads" class="xp-btn">🛡️ 隱藏廣告</button>
                        <button type="button" id="xp-btn-autoload" class="xp-btn">♾️ 自動翻頁</button>
                        <button type="button" id="xp-btn-scope" class="xp-btn">📄 來源：本頁</button>
                    </div>
                </div>

                <div id="xp-stats-line" class="xp-stats-line">正在掃描本頁影片...</div>
            </div>
        `;
        document.body.appendChild(panel);

        const head = panel.querySelector('#xp-panel-head');
        let dragging = false, sx = 0, sy = 0, ol = 0, ot = 0;
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            const r = panel.getBoundingClientRect();
            dragging = true; sx = e.clientX; sy = e.clientY; ol = r.left; ot = r.top;
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const r = panel.getBoundingClientRect();
            const nl = Math.max(8, Math.min(ol + (e.clientX - sx), window.innerWidth - r.width - 8));
            const nt = Math.max(8, Math.min(ot + (e.clientY - sy), window.innerHeight - r.height - 8));
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.left = `${nl}px`;
            panel.style.top = `${nt}px`;
        });
        head.addEventListener('pointerup', () => { dragging = false; });

        panel.querySelector('#xp-btn-feed').addEventListener('click', () => openFeedMode(0));
        panel.querySelector('#xp-btn-feed-mini').addEventListener('click', () => openFeedMode(0));

        panel.querySelector('#xp-btn-rescan').addEventListener('click', () => {
            const added = scanAllPageSources();
            const matched = getFilteredPool(true).length;
            showToast(matched > 0 ? `✅ 已掃描完成：目前可播 ${matched} 部（本次新增 ${added} 部）` : '⚠️ 目前頁面尚未載入符合條件的影片，請先往下滑過幾則影片貼文再試');
        });

        panel.querySelector('#xp-panel-toggle').addEventListener('click', () => {
            cfg.panelCollapsed = !cfg.panelCollapsed;
            saveCfg();
            panel.classList.toggle('collapsed', cfg.panelCollapsed);
            panel.querySelector('#xp-panel-toggle').textContent = cfg.panelCollapsed ? '展開' : '收合';
        });

        panel.querySelectorAll('[data-orient]').forEach((btn) => {
            btn.addEventListener('click', () => {
                cfg.orientation = btn.dataset.orient;
                saveCfg();
                syncPanelUI();
                updatePanelCounts();
                showToast(`已切換方向：${orientLabel(cfg.orientation)}`);
            });
        });

        panel.querySelectorAll('[data-dur]').forEach((btn) => {
            btn.addEventListener('click', () => {
                cfg.minSeconds = Number(btn.dataset.dur) || 0;
                saveCfg();
                syncPanelUI();
                updatePanelCounts();
                showToast(cfg.minSeconds > 0 ? `⏱️ 僅顯示 ${formatMinDurLabel(cfg.minSeconds)} 影片` : '⏱️ 已取消片長限制');
            });
        });

        panel.querySelector('#xp-dur-custom').addEventListener('click', () => {
            const raw = prompt('輸入最低片長（秒數，或加上 m 表示分鐘，例如 45 或 2m；輸入 0 不限）：', String(cfg.minSeconds || 30));
            if (raw === null) return;
            const trimmed = raw.trim().toLowerCase();
            let sec = 0;
            if (trimmed.endsWith('m')) {
                sec = Math.round(Number(trimmed.slice(0, -1)) * 60);
            } else {
                sec = Math.round(Number(trimmed));
            }
            if (!Number.isFinite(sec) || sec < 0) {
                showToast('⚠️ 請輸入有效數字');
                return;
            }
            cfg.minSeconds = sec;
            saveCfg();
            syncPanelUI();
            updatePanelCounts();
            showToast(sec > 0 ? `⏱️ 僅顯示 ${formatMinDurLabel(sec)} 影片` : '⏱️ 已取消片長限制');
        });

        panel.querySelector('#xp-btn-gif').addEventListener('click', () => {
            cfg.showGif = !cfg.showGif;
            saveCfg();
            syncPanelUI();
            updatePanelCounts();
            showToast(cfg.showGif ? '🎞️ 抖音模式已包含 GIF' : '🎞️ 已排除 GIF 動圖');
        });

        panel.querySelector('#xp-btn-ads').addEventListener('click', () => {
            cfg.blockAds = !cfg.blockAds;
            saveCfg();
            syncPanelUI();
            if (cfg.blockAds) hidePromotedTweets();
            else document.querySelectorAll('.xp-ad-hidden').forEach((el) => el.classList.remove('xp-ad-hidden'));
            showToast(cfg.blockAds ? '🛡️ 已開啟推廣廣告隱藏' : '已關閉推廣廣告隱藏');
        });

        panel.querySelector('#xp-btn-autoload').addEventListener('click', () => {
            cfg.autoScrollLoad = !cfg.autoScrollLoad;
            saveCfg();
            syncPanelUI();
            showToast(cfg.autoScrollLoad ? '♾️ 抖音模式自動背景翻頁已開啟' : '自動背景翻頁已關閉');
        });

        panel.querySelector('#xp-btn-scope').addEventListener('click', () => {
            cfg.scopeMode = cfg.scopeMode === 'page' ? 'all' : 'page';
            saveCfg();
            syncPanelUI();
            updatePanelCounts();
            showToast(cfg.scopeMode === 'page' ? '📄 切換為：僅播放目前頁面收集的影片' : '🌐 切換為：播放本分頁全部累積收集的影片');
        });

        syncPanelUI();
        updatePanelCounts();
    }

    // ==================== 6. 啟動與 SPA 路由監聽 ====================
    injectBaseStyles();
    installApiHooks();

    function boot() {
        if (!document.body) {
            setTimeout(boot, 50);
            return;
        }
        injectBaseStyles();
        createFloatingPanel();
        hidePromotedTweets();
        scanAllPageSources();

        setTimeout(scanAllPageSources, 1200);
        setTimeout(scanAllPageSources, 3000);

        let lastHref = location.href;
        let lastScrollScanTs = 0;

        window.addEventListener('scroll', () => {
            if (feedOpen) return;
            const now = Date.now();
            if (now - lastScrollScanTs > 1200) {
                lastScrollScanTs = now;
                scanAllPageSources();
            }
        }, { passive: true });

        setInterval(() => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                syncRouteKey();
                setTimeout(scanAllPageSources, 800);
            }
            if (!feedOpen && !document.hidden) {
                hidePromotedTweets();
                if (getCurrentRouteBucket().size === 0) {
                    scanReduxStore();
                }
            }
        }, 1200);

        let mutTimer = null;
        const obs = new MutationObserver(() => {
            if (feedOpen) return;
            clearTimeout(mutTimer);
            mutTimer = setTimeout(() => {
                syncRouteKey();
                hidePromotedTweets();
            }, 350);
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
