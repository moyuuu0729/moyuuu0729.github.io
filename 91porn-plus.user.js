// ==UserScript==
// @name         91Porn 全能增強：去廣告 / 極簡列表 / 無限滾動 / 抖音模式 / 播放器強化
// @namespace    https://91porn.com/
// @version      1.6.2
// @description  徹底去除 91Porn 播放器與頁面廣告、封面零變形(內嵌添加時間)＋標題＋查看人數、滑到底部自動載入下一頁、抖音上下滑動連刷模式與播放器強化。
// @match        *://*.91porn.com/*
// @match        *://91porn.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://moyuuu0729.github.io/91porn-plus.user.js
// @downloadURL  https://moyuuu0729.github.io/91porn-plus.user.js
// ==/UserScript==

(function () {
    'use strict';

    const CFG_KEY = 'p91_plus_cfg_v1';
    const WATCHED_KEY = 'p91_plus_watched_v1';
    const PROGRESS_KEY = 'p91_plus_progress_v1';

    const DEFAULT_CFG = {
        darkMode: true,
        cleanGrid: true,
        minimalCard: true,
        infiniteScroll: true,
        gridCols: 0,
        watchedMode: 'dim',
        blockAds: true,
        autoWidePlayer: true,
        playbackRate: 1.0,
        feedMuted: false,
        blacklistWords: [],
        customHiddenSelectors: [],
        panelCollapsed: false
    };

    const AD_DOMAIN_RE = /(?:exoclick|juicyads|trafficjunky|tsyndicate|realsrv|popads|adtng|adsco|onclickalgo|acscdn|twinrdsrv|stripchat|chaturbate|livejasmin|bongacams|doubleclick|googlesyndication)/i;

    let cfg = loadCfg();
    let watchedMap = loadJson(WATCHED_KEY, {});
    let progressMap = loadJson(PROGRESS_KEY, {});
    let adShieldUntil = 0;
    let lastAdToastTs = 0;
    let toastTimer = null;

    let pickerActive = false;
    let pickerLockedEl = null;
    let pickerHistoryStack = [];

    let infNextUrl = '';
    let infLoading = false;
    let infDone = false;
    let infLoadedPages = 1;
    let infObserver = null;
    const infVisitedUrls = new Set();

    let feedOpen = false;
    let feedItems = [];
    let feedIndex = 0;
    let feedClockTimer = null;
    let feedClockShowSeconds = false;
    const streamCache = new Map();
    const hlsInstances = new Map();

    function loadJson(key, fallback) {
        try {
            const raw = GM_getValue(key, null);
            if (!raw) return fallback;
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            return fallback;
        }
    }

    function saveJson(key, val) {
        try {
            GM_setValue(key, val);
        } catch {}
    }

    function loadCfg() {
        const saved = loadJson(CFG_KEY, {});
        return Object.assign({}, DEFAULT_CFG, saved, {
            blacklistWords: Array.isArray(saved.blacklistWords) ? saved.blacklistWords : [],
            customHiddenSelectors: Array.isArray(saved.customHiddenSelectors) ? saved.customHiddenSelectors : []
        });
    }

    function saveCfg() {
        saveJson(CFG_KEY, cfg);
    }

    // ==================== 1. 零閃爍樣式注入 ====================
    const BASE_CSS = `
        html[data-p91-ads="true"] #ad_header,
        html[data-p91-ads="true"] #ad_footer,
        html[data-p91-ads="true"] [id^="ad_"],
        html[data-p91-ads="true"] [id*="_ad_"],
        html[data-p91-ads="true"] [class*="ad_banner"],
        html[data-p91-ads="true"] [class*="adsbox"],
        html[data-p91-ads="true"] [class*="pause-ad"],
        html[data-p91-ads="true"] [id*="pause-ad"],
        html[data-p91-ads="true"] .ima-ad-container,
        html[data-p91-ads="true"] [class*="ima-"],
        html[data-p91-ads="true"] [id*="ima_"],
        html[data-p91-ads="true"] .vjs-ad-control-bar,
        html[data-p91-ads="true"] .vjs-overlay,
        html[data-p91-ads="true"] ins,
        html[data-p91-ads="true"] iframe[src*="exoclick"],
        html[data-p91-ads="true"] iframe[src*="juicyads"],
        html[data-p91-ads="true"] iframe[src*="trafficjunky"],
        html[data-p91-ads="true"] iframe[src*="tsyndicate"],
        html[data-p91-ads="true"] iframe[src*="realsrv"],
        html[data-p91-ads="true"] iframe[src*="popads"],
        html[data-p91-ads="true"] iframe[src*="adtng"],
        html[data-p91-ads="true"] iframe[src*="adsco"],
        html[data-p91-ads="true"] .p91-ad-hidden {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            width: 0 !important;
            height: 0 !important;
            overflow: hidden !important;
            pointer-events: none !important;
        }

        html[data-p91-ads="true"] #player_one video,
        html[data-p91-ads="true"] .video-js video,
        html[data-p91-ads="true"] .vjs-control-bar,
        html[data-p91-ads="true"] .vjs-big-play-button {
            pointer-events: auto !important;
        }

        .p91-user-hidden {
            display: none !important;
        }

        html[data-p91-dark="true"],
        html[data-p91-dark="true"] body {
            background-color: #0d0f14 !important;
            color: #e5e7eb !important;
        }
        html[data-p91-dark="true"] .navbar,
        html[data-p91-dark="true"] .navbar-default,
        html[data-p91-dark="true"] .navbar-inverse,
        html[data-p91-dark="true"] .panel,
        html[data-p91-dark="true"] .panel-default,
        html[data-p91-dark="true"] .well,
        html[data-p91-dark="true"] .boxPart {
            background-color: #161922 !important;
            border-color: rgba(255, 255, 255, 0.09) !important;
            color: #e5e7eb !important;
        }
        html[data-p91-dark="true"] a {
            color: #93c5fd;
        }
        html[data-p91-dark="true"] a:hover {
            color: #bfdbfe;
        }
        html[data-p91-dark="true"] .form-control,
        html[data-p91-dark="true"] input[type="text"],
        html[data-p91-dark="true"] select {
            background-color: #0d0f14 !important;
            color: #f3f4f6 !important;
            border-color: rgba(255, 255, 255, 0.16) !important;
        }
        html[data-p91-dark="true"] .pagination > li > a,
        html[data-p91-dark="true"] .pagination > li > span,
        html[data-p91-dark="true"] .pagingnav a,
        html[data-p91-dark="true"] .paging a {
            background-color: #161922 !important;
            border-color: rgba(255, 255, 255, 0.12) !important;
            color: #e5e7eb !important;
        }

        html[data-p91-grid="true"] .p91-grid-row {
            display: grid !important;
            grid-template-columns: repeat(var(--p91-cols, 4), minmax(0, 1fr)) !important;
            gap: 12px !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
        }
        html[data-p91-grid="true"] .p91-grid-row::before,
        html[data-p91-grid="true"] .p91-grid-row::after {
            display: none !important;
        }
        html[data-p91-grid="true"] .p91-grid-col {
            width: 100% !important;
            max-width: 100% !important;
            float: none !important;
            padding: 0 !important;
            margin: 0 !important;
            display: flex !important;
        }
        html[data-p91-grid="true"] .p91-card {
            width: 100% !important;
            margin: 0 !important;
            padding: 7px !important;
            border-radius: 12px !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: flex-start !important;
            text-align: left !important;
            transition: transform 0.16s ease, box-shadow 0.16s ease, opacity 0.2s ease !important;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28) !important;
        }
        html[data-p91-grid="true"] .p91-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 22px rgba(0, 0, 0, 0.42) !important;
        }
        html[data-p91-grid="true"] .p91-card a {
            text-decoration: none !important;
        }

        .p91-thumb-link {
            display: block !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
        }
        .p91-thumb-box {
            position: relative !important;
            width: 100% !important;
            aspect-ratio: 16 / 9 !important;
            overflow: hidden !important;
            border-radius: 8px !important;
            background: #07080c !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
        }
        .p91-thumb-box img {
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            object-fit: contain !important;
            object-position: center center !important;
            display: block !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
        }

        .p91-cover-time {
            position: absolute;
            bottom: 6px;
            left: 6px;
            z-index: 12;
            padding: 2px 7px;
            border-radius: 5px;
            background: rgba(10, 12, 18, 0.82);
            border: 1px solid rgba(255, 255, 255, 0.16);
            color: #f3f4f6;
            font-size: 11px;
            font-weight: 700;
            line-height: 1.3;
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            pointer-events: none;
            max-width: calc(100% - 68px);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .p91-cover-dur {
            position: absolute;
            bottom: 6px;
            right: 6px;
            z-index: 12;
            padding: 2px 6px;
            border-radius: 5px;
            background: rgba(10, 12, 18, 0.85);
            color: #ffffff;
            font-size: 11px;
            font-weight: 700;
            line-height: 1.3;
            font-variant-numeric: tabular-nums;
            pointer-events: none;
        }

        .p91-card-title {
            display: -webkit-box !important;
            -webkit-line-clamp: 2 !important;
            -webkit-box-orient: vertical !important;
            overflow: hidden !important;
            line-height: 1.42 !important;
            min-height: 2.84em !important;
            margin: 7px 2px 4px !important;
            font-size: 13.5px !important;
            font-weight: 600 !important;
            word-break: break-word !important;
            color: #1f2937 !important;
        }
        html[data-p91-dark="true"] .p91-card-title {
            color: #f3f4f6 !important;
        }
        .p91-card-title:hover {
            color: #a78bfa !important;
        }

        .p91-card-views-bar {
            display: flex !important;
            align-items: center !important;
            justify-content: flex-start !important;
            gap: 5px !important;
            margin-top: auto !important;
            padding: 2px 2px 0 !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            color: #9ca3af !important;
            font-variant-numeric: tabular-nums !important;
        }

        html[data-p91-minimal="true"] .p91-card .p91-legacy-meta {
            display: none !important;
        }
        html[data-p91-minimal="false"] .p91-card .p91-legacy-meta {
            margin-top: 6px;
            font-size: 12px;
            color: #9ca3af;
        }

        .p91-watched-badge {
            position: absolute;
            top: 6px;
            left: 6px;
            z-index: 13;
            padding: 2px 7px;
            border-radius: 5px;
            background: rgba(16, 185, 129, 0.92);
            color: #fff;
            font-size: 11px;
            font-weight: 700;
            pointer-events: none;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
        }
        html[data-p91-watched="dim"] .p91-card-watched {
            opacity: 0.45 !important;
            filter: grayscale(40%);
        }
        html[data-p91-watched="dim"] .p91-card-watched:hover {
            opacity: 0.96 !important;
            filter: none;
        }
        html[data-p91-watched="hide"] .p91-card-watched {
            display: none !important;
        }

        #p91-infinite-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            margin: 18px 0 28px;
            padding: 12px 16px;
            border-radius: 12px;
            background: rgba(22, 25, 34, 0.92);
            border: 1px solid rgba(139, 92, 246, 0.4);
            color: #e5e7eb;
            font-size: 13px;
            font-weight: 700;
            clear: both;
        }
        html[data-p91-infinite="true"] .pagination,
        html[data-p91-infinite="true"] .paging,
        html[data-p91-infinite="true"] .pagingnav {
            opacity: 0.4;
        }

        html[data-p91-wide="true"] #player_one,
        html[data-p91-wide="true"] .video-js {
            width: 100% !important;
            max-width: 100% !important;
            height: auto !important;
            aspect-ratio: 16 / 9 !important;
            border-radius: 10px !important;
            overflow: hidden !important;
        }
        html[data-p91-wide="true"] #player_one video,
        html[data-p91-wide="true"] .video-js video {
            width: 100% !important;
            height: 100% !important;
            object-fit: contain !important;
        }

        #p91-player-bar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin: 10px 0 14px;
            padding: 10px 12px;
            border-radius: 12px;
            background: #161922;
            border: 1px solid rgba(139, 92, 246, 0.35);
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12.5px;
        }
        .p91-pbar-group {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
        }
        .p91-pbtn {
            padding: 6px 10px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.14);
            background: rgba(255, 255, 255, 0.07);
            color: #f3f4f6;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            line-height: 1.2;
            transition: background 0.15s, transform 0.1s;
        }
        .p91-pbtn:active {
            transform: scale(0.95);
        }
        .p91-pbtn.accent {
            background: linear-gradient(135deg, #8b5cf6, #ec4899);
            border-color: transparent;
            color: #fff;
        }
        .p91-pbtn.active {
            background: rgba(139, 92, 246, 0.32);
            border-color: #a78bfa;
            color: #fff;
        }

        #p91-seek-hud {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 60;
            padding: 8px 16px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.85);
            border: 1px solid rgba(167, 139, 250, 0.5);
            color: #fff;
            font-size: 15px;
            font-weight: 800;
            font-variant-numeric: tabular-nums;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.15s ease;
        }
        #p91-seek-hud.show {
            opacity: 1;
        }
        #p91-player-clock {
            position: absolute;
            top: 10px;
            right: 12px;
            z-index: 55;
            padding: 3px 9px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.62);
            border: 1px solid rgba(255, 255, 255, 0.16);
            color: rgba(255, 255, 255, 0.9);
            font-size: 12px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            pointer-events: auto;
            cursor: pointer;
            user-select: none;
        }

        /* ==================== 抖音模式全螢幕沉浸視窗 ==================== */
        #p91-feed-overlay {
            position: fixed;
            inset: 0;
            width: 100%;
            height: 100%;
            z-index: 2147483644;
            background: #050608;
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden;
            user-select: none;
            -webkit-user-select: none;
            touch-action: none;
        }
        .p91-feed-track {
            position: relative;
            z-index: 2;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            will-change: transform;
            transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .p91-feed-track.dragging {
            transition: none;
        }
        .p91-feed-slide {
            position: relative;
            flex: 0 0 100%;
            width: 100%;
            height: 100%;
            min-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #050608;
            overflow: hidden;
            padding-bottom: 136px;
        }
        .p91-feed-poster {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: contain;
            opacity: 0.45;
            pointer-events: none;
            z-index: 1;
        }
        .p91-feed-video {
            position: relative;
            z-index: 2;
            width: 100%;
            height: 100%;
            max-height: 100%;
            object-fit: contain;
            background: transparent;
        }
        .p91-feed-status {
            position: absolute;
            top: 42%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 6;
            padding: 8px 16px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.88);
            border: 1px solid rgba(167, 139, 250, 0.5);
            color: #f3f4f6;
            font-size: 13px;
            font-weight: 700;
            pointer-events: none;
            text-align: center;
            max-width: 86vw;
        }
        .p91-feed-center-icon {
            position: absolute;
            top: 42%;
            left: 50%;
            transform: translate(-50%, -50%) scale(0.8);
            z-index: 8;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: rgba(15, 17, 23, 0.72);
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
        .p91-feed-center-icon.show {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }

        #p91-feed-topbar {
            position: fixed;
            top: calc(10px + env(safe-area-inset-top, 0px));
            left: 12px;
            right: 12px;
            z-index: 30;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            pointer-events: none;
        }
        .p91-feed-top-group {
            display: flex;
            align-items: center;
            gap: 6px;
            pointer-events: auto;
        }
        .p91-fbtn {
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.78);
            border: 1px solid rgba(255, 255, 255, 0.18);
            color: #f3f4f6;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            font-variant-numeric: tabular-nums;
            line-height: 1.2;
        }
        .p91-fbtn:active {
            transform: scale(0.95);
        }

        #p91-feed-bottom-dock {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 28;
            padding: 16px 12px calc(10px + env(safe-area-inset-bottom, 0px));
            background: linear-gradient(to top, rgba(6, 8, 12, 0.96) 0%, rgba(6, 8, 12, 0.82) 72%, transparent 100%);
            display: flex;
            flex-direction: column;
            gap: 7px;
            pointer-events: auto;
        }
        #p91-feed-meta {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            font-size: 11.5px;
            font-weight: 700;
            color: #cbd5e1;
        }
        #p91-feed-title {
            font-size: 13.5px;
            font-weight: 700;
            color: #ffffff;
            line-height: 1.35;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .p91-feed-scrub-row {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
        }
        #p91-feed-time {
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 700;
            color: #e5e7eb;
            font-variant-numeric: tabular-nums;
            min-width: 82px;
            text-align: right;
        }
        #p91-feed-range {
            flex: 1;
            width: 100%;
            height: 6px;
            accent-color: #ec4899;
            cursor: pointer;
            margin: 0;
        }
        .p91-feed-ctrl-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            overflow-x: auto;
            scrollbar-width: none;
        }
        .p91-feed-ctrl-row::-webkit-scrollbar {
            display: none;
        }
        .p91-feed-ctrl-group {
            display: flex;
            align-items: center;
            gap: 5px;
            flex-shrink: 0;
        }
        .p91-fcbtn {
            padding: 5px 9px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.16);
            background: rgba(255, 255, 255, 0.08);
            color: #f3f4f6;
            font-size: 11.5px;
            font-weight: 700;
            cursor: pointer;
            line-height: 1.2;
            white-space: nowrap;
        }
        .p91-fcbtn:active {
            transform: scale(0.95);
        }
        .p91-fcbtn.accent {
            background: linear-gradient(135deg, #8b5cf6, #ec4899);
            border-color: transparent;
            color: #fff;
        }

        #p91-feed-hud {
            position: fixed;
            top: 44%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 35;
            padding: 10px 18px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.9);
            border: 1px solid rgba(236, 72, 153, 0.65);
            color: #fff;
            font-size: 15px;
            font-weight: 800;
            font-variant-numeric: tabular-nums;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.14s ease;
        }
        #p91-feed-hud.show {
            opacity: 1;
        }

        #p91-feed-drawer {
            position: fixed;
            inset: 0;
            z-index: 40;
            background: rgba(5, 6, 8, 0.88);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: none;
            flex-direction: column;
            pointer-events: auto;
        }
        #p91-feed-drawer.open {
            display: flex;
        }
        .p91-drawer-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: calc(12px + env(safe-area-inset-top, 0px)) 14px 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.12);
            font-size: 14px;
            font-weight: 800;
        }
        .p91-drawer-grid {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
            align-content: start;
            touch-action: pan-y;
        }
        .p91-drawer-item {
            position: relative;
            border-radius: 8px;
            overflow: hidden;
            background: #141720;
            border: 2px solid transparent;
            cursor: pointer;
            display: flex;
            flex-direction: column;
        }
        .p91-drawer-item.active {
            border-color: #ec4899;
        }
        .p91-drawer-thumb {
            position: relative;
            width: 100%;
            aspect-ratio: 16 / 9;
            background: #07080c;
        }
        .p91-drawer-thumb img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            display: block;
        }
        .p91-drawer-idx {
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
        .p91-drawer-caption {
            padding: 5px 6px;
            font-size: 11px;
            line-height: 1.3;
            color: #e5e7eb;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        #p91-float-panel {
            position: fixed;
            right: 12px;
            bottom: calc(16px + env(safe-area-inset-bottom, 0px));
            z-index: 2147483640;
            width: min(320px, calc(100vw - 24px));
            border-radius: 16px;
            background: rgba(20, 23, 32, 0.95);
            border: 1px solid rgba(139, 92, 246, 0.5);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12.5px;
            overflow: hidden;
            user-select: none;
        }
        #p91-float-panel.collapsed {
            width: auto;
            border-radius: 999px;
        }
        #p91-float-panel.collapsed .p91-panel-body {
            display: none;
        }
        .p91-panel-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 12px;
            background: rgba(139, 92, 246, 0.16);
            cursor: grab;
            touch-action: none;
            font-weight: 800;
            font-size: 12.5px;
        }
        .p91-panel-body {
            padding: 10px 12px 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .p91-panel-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 6px;
        }
        .p91-toggle-btn {
            padding: 7px 8px;
            border-radius: 9px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.05);
            color: #d1d5db;
            font-size: 12px;
            font-weight: 700;
            text-align: center;
            cursor: pointer;
        }
        .p91-toggle-btn.on {
            background: rgba(139, 92, 246, 0.26);
            border-color: rgba(167, 139, 250, 0.7);
            color: #fff;
        }
        .p91-panel-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            padding-top: 6px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }

        #p91-picker-highlight {
            position: fixed;
            pointer-events: none;
            z-index: 2147483645;
            border: 2px dashed #ec4899;
            background: rgba(236, 72, 153, 0.18);
            border-radius: 6px;
            display: none;
        }
        #p91-picker-bar {
            position: fixed;
            top: calc(10px + env(safe-area-inset-top, 0px));
            left: 50%;
            transform: translateX(-50%);
            z-index: 2147483647;
            width: min(520px, calc(100vw - 20px));
            background: rgba(18, 20, 28, 0.96);
            border: 1px solid rgba(236, 72, 153, 0.65);
            border-radius: 14px;
            padding: 8px 12px 10px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.7);
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: none;
            flex-direction: column;
            gap: 8px;
            user-select: none;
        }
        #p91-picker-bar.open {
            display: flex;
        }
        #p91-picker-drag {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 5px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            cursor: grab;
            touch-action: none;
            font-size: 12px;
            font-weight: 700;
        }
        #p91-picker-info {
            font-size: 12px;
            color: #f9a8d4;
            word-break: break-all;
        }
        #p91-picker-btns {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }

        #p91-toast {
            position: fixed;
            left: 50%;
            bottom: calc(28px + env(safe-area-inset-bottom, 0px));
            transform: translateX(-50%);
            z-index: 2147483647;
            padding: 8px 16px;
            border-radius: 999px;
            background: rgba(18, 20, 28, 0.95);
            border: 1px solid rgba(167, 139, 250, 0.6);
            color: #fff;
            font-size: 13px;
            font-weight: 700;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.18s ease;
        }
        #p91-toast.show {
            opacity: 1;
        }
    `;

    function injectBaseStyles() {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(BASE_CSS);
        } else {
            const st = document.createElement('style');
            st.textContent = BASE_CSS;
            (document.head || document.documentElement).appendChild(st);
        }
    }

    function applyRootFlags() {
        const root = document.documentElement;
        root.dataset.p91Dark = cfg.darkMode ? 'true' : 'false';
        root.dataset.p91Grid = cfg.cleanGrid ? 'true' : 'false';
        root.dataset.p91Minimal = cfg.minimalCard ? 'true' : 'false';
        root.dataset.p91Infinite = cfg.infiniteScroll ? 'true' : 'false';
        root.dataset.p91Ads = cfg.blockAds ? 'true' : 'false';
        root.dataset.p91Wide = cfg.autoWidePlayer ? 'true' : 'false';
        root.dataset.p91Watched = cfg.watchedMode;

        const cols = cfg.gridCols > 0
            ? cfg.gridCols
            : (window.innerWidth <= 640 ? 2 : (window.innerWidth <= 960 ? 3 : 4));
        root.style.setProperty('--p91-cols', String(cols));
    }

    function showToast(msg) {
        if (!document.body) return;
        let el = document.getElementById('p91-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'p91-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    function notifyAdBlocked(msg) {
        const now = Date.now();
        if (now - lastAdToastTs > 3500) {
            lastAdToastTs = now;
            showToast(msg);
        }
    }

    // ==================== 2. 早期彈窗、廣告腳本與播放器劫持攔截 ====================
    function isExternalAdUrl(rawUrl) {
        const str = String(rawUrl || '').trim();
        if (!str || str === 'about:blank' || str.startsWith('javascript:')) return true;
        if (str.startsWith('#') || str.startsWith('blob:') || str.startsWith('data:')) return false;
        try {
            const targetHost = new URL(str, location.origin).hostname;
            if (AD_DOMAIN_RE.test(targetHost)) return true;
            const curBase = location.hostname.split('.').slice(-2).join('.');
            return !targetHost.endsWith(curBase);
        } catch {
            return true;
        }
    }

    function installAdHooks() {
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        [window, pageWin].forEach((win) => {
            if (!win) return;

            if (typeof win.open === 'function' && !win.__p91OpenHooked) {
                const origOpen = win.open.bind(win);
                win.open = function (url, target, features) {
                    if (cfg.blockAds && (Date.now() < adShieldUntil || isExternalAdUrl(url))) {
                        notifyAdBlocked('🛡️ 已攔截彈窗廣告');
                        return null;
                    }
                    return origOpen(url, target, features);
                };
                win.__p91OpenHooked = true;
            }

            if (win.HTMLAnchorElement && !win.HTMLAnchorElement.prototype.__p91ClickHooked) {
                const origClick = win.HTMLAnchorElement.prototype.click;
                win.HTMLAnchorElement.prototype.click = function (...args) {
                    if (cfg.blockAds && (this.target === '_blank' || Date.now() < adShieldUntil) && isExternalAdUrl(this.href)) {
                        notifyAdBlocked('🛡️ 已攔截背景跳轉廣告');
                        return;
                    }
                    return origClick.apply(this, args);
                };
                win.HTMLAnchorElement.prototype.__p91ClickHooked = true;
            }

            if (win.document && typeof win.document.createElement === 'function' && !win.document.__p91CreateHooked) {
                const origCreate = win.document.createElement.bind(win.document);
                win.document.createElement = function (tagName, options) {
                    const el = origCreate(tagName, options);
                    const tag = String(tagName || '').toLowerCase();
                    if (tag === 'script' || tag === 'iframe') {
                        const origSetAttr = el.setAttribute.bind(el);
                        el.setAttribute = function (name, val) {
                            if (cfg.blockAds && name.toLowerCase() === 'src' && AD_DOMAIN_RE.test(String(val))) {
                                return;
                            }
                            return origSetAttr(name, val);
                        };
                    }
                    return el;
                };
                win.document.__p91CreateHooked = true;
            }
        });

        const guardPlayerClick = (e) => {
            if (!cfg.blockAds) return;
            const target = e.target;
            if (!target || target.nodeType !== 1) return;
            if (target.closest('#p91-float-panel, #p91-picker-bar, #p91-player-bar, #p91-infinite-bar, #p91-feed-overlay')) return;

            const playerBox = target.closest('#player_one, .video-js');
            if (playerBox) {
                adShieldUntil = Date.now() + 3000;

                const badLink = target.closest('a[href]');
                if (badLink && isExternalAdUrl(badLink.href)) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    badLink.remove();
                    notifyAdBlocked('🛡️ 已移除播放器廣告連結');
                    return;
                }

                const isLegitControl =
                    target.tagName === 'VIDEO' ||
                    Boolean(target.closest('.vjs-control-bar, .vjs-big-play-button, .vjs-menu, #p91-player-clock'));

                if (!isLegitControl) {
                    const cs = getComputedStyle(target);
                    const rect = target.getBoundingClientRect();
                    const pRect = playerBox.getBoundingClientRect();
                    const coversPlayer = pRect.width > 0 && rect.width >= pRect.width * 0.55 && rect.height >= pRect.height * 0.55;
                    if (coversPlayer && (cs.position === 'absolute' || cs.position === 'fixed')) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        target.remove();
                        const v = playerBox.querySelector('video');
                        if (v && v.paused) v.play().catch(() => {});
                        notifyAdBlocked('🛡️ 已清除播放器透明廣告遮罩');
                        return;
                    }
                }
            }

            const extLink = target.closest('a[target="_blank"]');
            if (extLink && isExternalAdUrl(extLink.href)) {
                e.preventDefault();
                e.stopPropagation();
                extLink.classList.add('p91-ad-hidden');
                notifyAdBlocked('🛡️ 已阻擋外部廣告連結');
            }
        };

        ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach((evt) => {
            window.addEventListener(evt, guardPlayerClick, true);
        });
    }

    // ==================== 3. DOM 廣告清理 ====================
    function applyCustomHiddenRules() {
        document.querySelectorAll('.p91-user-hidden').forEach((el) => el.classList.remove('p91-user-hidden'));
        cfg.customHiddenSelectors.forEach((sel) => {
            try {
                document.querySelectorAll(sel).forEach((el) => {
                    if (!el.closest('#p91-float-panel, #p91-picker-bar, #p91-feed-overlay')) {
                        el.classList.add('p91-user-hidden');
                    }
                });
            } catch {}
        });
    }

    function cleanAdsOnPage() {
        if (!cfg.blockAds) return;

        document.querySelectorAll('body > div, body > a, body > aside, body > section').forEach((el) => {
            if (el.id?.startsWith('p91-')) return;
            if (el.querySelector('video, #player_one, .navbar, .container')) return;
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed') {
                const z = parseInt(cs.zIndex, 10) || 0;
                const rect = el.getBoundingClientRect();
                if (z >= 40 && (rect.width >= window.innerWidth * 0.65 || rect.height <= 140)) {
                    el.remove();
                }
            }
        });

        document.querySelectorAll('.well, .row > div, center, [align="center"]').forEach((box) => {
            if (box.closest('#p91-float-panel, #p91-picker-bar, #p91-player-bar, #p91-infinite-bar, #p91-feed-overlay')) return;
            if (box.querySelector('video, #player_one, a[href*="view_video.php"], a[href*="uprofile.php"], .pagination, .paging, .pagingnav')) return;

            const links = Array.from(box.querySelectorAll('a[href]'));
            if (links.length > 0 && links.every((a) => isExternalAdUrl(a.href))) {
                box.classList.add('p91-ad-hidden');
            }
        });

        const player = document.querySelector('#player_one, .video-js');
        if (player) {
            if (player.dataset.p91BubbleShield !== '1') {
                player.dataset.p91BubbleShield = '1';
                ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((evt) => {
                    player.addEventListener(evt, (e) => {
                        if (cfg.blockAds) {
                            adShieldUntil = Date.now() + 3000;
                            e.stopPropagation();
                        }
                    }, false);
                });
            }

            player.querySelectorAll('iframe, ins, .ima-ad-container, [class*="ima-"], [id*="ima_"], [class*="pause-ad"], [id*="pause-ad"], a[href]').forEach((el) => {
                if (el.id?.startsWith('p91-')) return;
                if (el.tagName === 'A' && !isExternalAdUrl(el.href)) return;
                el.remove();
            });

            const pRect = player.getBoundingClientRect();
            player.querySelectorAll('div, span').forEach((el) => {
                if (el.id?.startsWith('p91-')) return;
                if (el.closest('.vjs-control-bar, .vjs-menu')) return;
                if (el.querySelector('video, .vjs-control-bar')) return;
                const cls = String(el.className || '');
                if (/^vjs-(?:poster|text-track|loading-spinner|big-play-button|error-display|modal-dialog)/.test(cls)) return;

                const cs = getComputedStyle(el);
                if (cs.position !== 'absolute' && cs.position !== 'fixed') return;
                const rect = el.getBoundingClientRect();
                const covers = pRect.width > 0 && rect.width >= pRect.width * 0.6 && rect.height >= pRect.height * 0.6;
                const isTransparent = Number(cs.opacity) <= 0.1 || cs.backgroundColor === 'transparent' || cs.backgroundColor === 'rgba(0, 0, 0, 0)';
                if (covers && (isTransparent || !cls.includes('vjs-'))) {
                    el.remove();
                }
            });

            player.querySelectorAll('video').forEach((v) => {
                const isAdVideo = Boolean(v.closest('.ima-ad-container, [class*="ima-"]')) ||
                    (Number.isFinite(v.duration) && v.duration > 0 && v.duration <= 45 && !(v.currentSrc || v.src || '').includes('.m3u8'));
                if (isAdVideo) {
                    v.muted = true;
                    if (Number.isFinite(v.duration) && v.currentTime < v.duration - 0.1) {
                        v.currentTime = v.duration;
                    }
                }
            });
            player.querySelectorAll('[class*="skip" i], [id*="skip" i]').forEach((btn) => {
                if (typeof btn.click === 'function') btn.click();
            });

            const mainCol = player.closest('[class*="col-md-8"], [class*="col-lg-8"], .col-sm-8');
            if (mainCol && mainCol.parentElement) {
                Array.from(mainCol.parentElement.children).forEach((sibling) => {
                    if (sibling !== mainCol && !sibling.querySelector('video')) {
                        sibling.classList.add('p91-ad-hidden');
                    }
                });
                if (cfg.autoWidePlayer) {
                    mainCol.style.width = '100%';
                    mainCol.style.maxWidth = '100%';
                    mainCol.style.flex = '0 0 100%';
                }
            }
        }
    }

    // ==================== 4. 列表卡片重構 ====================
    function extractViewKey(href) {
        if (!href) return '';
        try {
            const u = new URL(href, location.origin);
            return u.searchParams.get('viewkey') || '';
        } catch {
            return '';
        }
    }

    function extractCardData(card, videoLink, img) {
        const fullText = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
        let addedTime = '';
        let views = '';

        card.querySelectorAll('span.info').forEach((span) => {
            const label = (span.textContent || '').trim();
            let nextText = '';
            let node = span.nextSibling;
            while (node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const t = node.textContent.replace(/\s+/g, ' ').trim();
                    if (t) {
                        nextText = t;
                        break;
                    }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName === 'BR' || node.classList.contains('info')) break;
                    const t = node.textContent.replace(/\s+/g, ' ').trim();
                    if (t) {
                        nextText = t;
                        break;
                    }
                }
                node = node.nextSibling;
            }

            if (/添加[时時][间間]/.test(label) && nextText) {
                addedTime = nextText;
            } else if (/查看/.test(label) && nextText) {
                views = nextText;
            }
        });

        if (!addedTime) {
            const mTime = fullText.match(/添加[时時][间間]\s*[:：]\s*(.+?)(?=\s*(?:作者|查看|收藏|留言|積分|积分|$))/i);
            if (mTime && mTime[1]) addedTime = mTime[1].trim();
        }
        if (!views) {
            const mViews = fullText.match(/查看\s*[:：]\s*([\d,.\s萬万kKmM]+)/i);
            if (mViews && mViews[1]) views = mViews[1].trim();
        }

        const durEl = card.querySelector('.duration, [class*="duration"]');
        const duration = durEl ? durEl.textContent.replace(/\s+/g, ' ').trim() : '';

        let title = '';
        const titleCandidate = card.querySelector('.video-title, [class*="video-title"], .title');
        if (titleCandidate && titleCandidate.textContent.trim()) {
            title = titleCandidate.textContent.replace(/\s+/g, ' ').trim();
        }
        if (!title) {
            for (const a of card.querySelectorAll('a[href*="view_video.php"]')) {
                const attrTitle = (a.getAttribute('title') || '').trim();
                if (attrTitle) {
                    title = attrTitle;
                    break;
                }
                const clone = a.cloneNode(true);
                clone.querySelectorAll('.duration, [class*="duration"], img, span.info').forEach((n) => n.remove());
                const txt = clone.textContent.replace(/\s+/g, ' ').trim();
                if (txt && txt.length > 1) {
                    title = txt;
                    break;
                }
            }
        }
        if (!title) {
            title = (img.getAttribute('alt') || img.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        }

        return {
            vk: extractViewKey(videoLink.href),
            href: videoLink.href,
            poster: img.getAttribute('src') || img.dataset.src || '',
            title: title || '未命名影片',
            addedTime,
            views,
            duration,
            fullTextLower: fullText.toLowerCase()
        };
    }

    function enhanceVideoCards() {
        const videoLinks = document.querySelectorAll('a[href*="view_video.php"]');
        const processedRows = new Set();

        videoLinks.forEach((a) => {
            if (a.closest('#p91-float-panel, #p91-picker-bar, #p91-feed-overlay')) return;
            const img = a.querySelector('img');
            if (!img) return;

            const card = a.closest('.well') || a.parentElement;
            if (!card) return;

            if (!img.getAttribute('src')) {
                const lazySrc = img.dataset.src || img.dataset.original || img.getAttribute('data-src');
                if (lazySrc) img.setAttribute('src', lazySrc);
            }

            const col = card.parentElement;
            const row = col?.parentElement;
            if (row && !processedRows.has(row)) {
                processedRows.add(row);
                row.classList.add('p91-grid-row');
            }
            if (col && row?.classList.contains('p91-grid-row')) {
                col.classList.add('p91-grid-col');
            }

            card.classList.add('p91-card');

            if (card.dataset.p91Enhanced !== '1') {
                const data = extractCardData(card, a, img);
                card.dataset.p91Enhanced = '1';
                card.dataset.p91FullText = data.fullTextLower;
                card.dataset.p91Vk = data.vk;
                card.dataset.p91Href = data.href;
                card.dataset.p91Title = data.title;
                card.dataset.p91Poster = data.poster;
                card.dataset.p91AddedTime = data.addedTime;
                card.dataset.p91Views = data.views;
                card.dataset.p91Duration = data.duration;

                const legacyWrap = document.createElement('div');
                legacyWrap.className = 'p91-legacy-meta';
                while (card.firstChild) {
                    legacyWrap.appendChild(card.firstChild);
                }

                const thumbLink = document.createElement('a');
                thumbLink.className = 'p91-thumb-link';
                thumbLink.href = data.href;
                thumbLink.title = data.title;

                const thumbBox = document.createElement('div');
                thumbBox.className = 'p91-thumb-box';
                img.removeAttribute('width');
                img.removeAttribute('height');
                img.style.removeProperty('width');
                img.style.removeProperty('height');
                thumbBox.appendChild(img);

                if (data.addedTime) {
                    const timeBadge = document.createElement('span');
                    timeBadge.className = 'p91-cover-time';
                    timeBadge.textContent = `🕒 ${data.addedTime}`;
                    thumbBox.appendChild(timeBadge);
                }
                if (data.duration) {
                    const durBadge = document.createElement('span');
                    durBadge.className = 'p91-cover-dur';
                    durBadge.textContent = data.duration;
                    thumbBox.appendChild(durBadge);
                }
                thumbLink.appendChild(thumbBox);

                const titleLink = document.createElement('a');
                titleLink.className = 'p91-card-title';
                titleLink.href = data.href;
                titleLink.textContent = data.title;
                titleLink.title = data.title;

                const viewsBar = document.createElement('div');
                viewsBar.className = 'p91-card-views-bar';
                viewsBar.textContent = `👁️ ${data.views || '--'}`;

                card.append(thumbLink, titleLink, viewsBar, legacyWrap);
            }

            const fullText = card.dataset.p91FullText || '';
            const hitBlacklist = cfg.blacklistWords.some((w) => w && fullText.includes(w.toLowerCase()));
            card.style.display = hitBlacklist ? 'none' : '';

            const vk = card.dataset.p91Vk || extractViewKey(a.href);
            const thumbBox = card.querySelector('.p91-thumb-box');
            if (vk && watchedMap[vk]) {
                card.classList.add('p91-card-watched');
                if (thumbBox && !thumbBox.querySelector('.p91-watched-badge')) {
                    const badge = document.createElement('span');
                    badge.className = 'p91-watched-badge';
                    badge.textContent = '✓ 已看過';
                    thumbBox.appendChild(badge);
                }
            }
        });
    }

    // ==================== 5. 無限滾動 ====================
    function findNextPageUrl(doc, currentBaseUrl) {
        const pagContainers = Array.from(doc.querySelectorAll('.pagination, .paging, .pagingnav, [class*="paging"], [id*="paging"]'));
        const scopes = pagContainers.length > 0 ? pagContainers : [doc];

        for (const scope of scopes) {
            const currentNode = scope.querySelector('li.active, .current, span.current');
            if (currentNode) {
                const nextLi = currentNode.nextElementSibling;
                const nextLink = nextLi ? (nextLi.tagName === 'A' ? nextLi : nextLi.querySelector('a[href]')) : null;
                if (nextLink) {
                    const href = nextLink.getAttribute('href') || '';
                    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                        try {
                            return new URL(href, currentBaseUrl).href;
                        } catch {}
                    }
                }
            }

            for (const a of scope.querySelectorAll('a[href]')) {
                const txt = (a.textContent || '').trim();
                const href = a.getAttribute('href') || '';
                if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
                if (/^(?:»|›|>>|下一[页頁]|next)$/i.test(txt)) {
                    try {
                        return new URL(href, currentBaseUrl).href;
                    } catch {}
                }
            }
        }

        try {
            const curUrlObj = new URL(currentBaseUrl);
            const curPage = parseInt(curUrlObj.searchParams.get('page') || '1', 10) || 1;
            const targetPageStr = String(curPage + 1);

            for (const a of doc.querySelectorAll('a[href*="page="]')) {
                const rawHref = a.getAttribute('href') || '';
                if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;
                const u = new URL(rawHref, currentBaseUrl);
                if (u.pathname === curUrlObj.pathname && u.searchParams.get('page') === targetPageStr) {
                    return u.href;
                }
            }
        } catch {}

        return '';
    }

    function updateInfiniteStatus(htmlText) {
        const bar = document.getElementById('p91-infinite-bar');
        if (!bar) return;
        bar.style.display = cfg.infiniteScroll ? 'flex' : 'none';
        bar.innerHTML = htmlText;
    }

    async function loadNextPage() {
        if (!cfg.infiniteScroll || infLoading || infDone || !infNextUrl) return false;
        if (infVisitedUrls.has(infNextUrl)) {
            infDone = true;
            updateInfiniteStatus(`🏁 已載入全部內容（共 ${infLoadedPages} 頁）`);
            return false;
        }

        const targetUrl = infNextUrl;
        infLoading = true;
        updateInfiniteStatus(`⏳ 正在載入第 ${infLoadedPages + 1} 頁...`);

        try {
            const res = await fetch(targetUrl, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            const newLinks = Array.from(doc.querySelectorAll('a[href*="view_video.php"]')).filter((a) => a.querySelector('img'));
            const rows = document.querySelectorAll('.p91-grid-row');
            const targetRow = rows[rows.length - 1];

            if (!targetRow || newLinks.length === 0) {
                infDone = true;
                updateInfiniteStatus(`🏁 已到底部，沒有更多影片了（共 ${infLoadedPages} 頁）`);
                return false;
            }

            const seenCards = new Set();
            let addedCount = 0;

            newLinks.forEach((a) => {
                const card = a.closest('.well') || a.parentElement;
                if (!card || seenCards.has(card)) return;
                seenCards.add(card);

                const col = card.parentElement;
                const nodeToImport = (col && col.parentElement && col.parentElement.querySelectorAll('a[href*="view_video.php"]').length >= 2)
                    ? col
                    : card;

                const imported = document.importNode(nodeToImport, true);
                if (!imported.classList.contains('p91-grid-col')) {
                    const wrap = document.createElement('div');
                    wrap.className = 'p91-grid-col';
                    wrap.appendChild(imported);
                    targetRow.appendChild(wrap);
                } else {
                    targetRow.appendChild(imported);
                }
                addedCount++;
            });

            infVisitedUrls.add(targetUrl);
            infLoadedPages++;
            infNextUrl = findNextPageUrl(doc, targetUrl);

            cleanAdsOnPage();
            enhanceVideoCards();
            applyCustomHiddenRules();

            if (!infNextUrl || addedCount === 0 || infVisitedUrls.has(infNextUrl)) {
                infDone = true;
                updateInfiniteStatus(`🏁 已載入全部內容（共 ${infLoadedPages} 頁）`);
            } else {
                updateInfiniteStatus(`📄 已載入至第 ${infLoadedPages} 頁 · 繼續下滑自動載入`);
            }
            return addedCount > 0;
        } catch {
            updateInfiniteStatus(`⚠️ 第 ${infLoadedPages + 1} 頁載入失敗 <button type="button" id="p91-inf-retry" class="p91-pbtn accent" style="padding:3px 10px;">點擊重試</button>`);
            document.getElementById('p91-inf-retry')?.addEventListener('click', loadNextPage);
            return false;
        } finally {
            infLoading = false;
        }
    }

    function setupInfiniteScroll() {
        if (location.pathname.includes('view_video.php')) return;
        const rows = document.querySelectorAll('.p91-grid-row');
        if (rows.length === 0) return;

        if (!infVisitedUrls.has(location.href)) {
            infVisitedUrls.add(location.href);
        }
        if (!infNextUrl && !infDone) {
            infNextUrl = findNextPageUrl(document, location.href);
        }

        let bar = document.getElementById('p91-infinite-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'p91-infinite-bar';
            const lastRow = rows[rows.length - 1];
            lastRow.insertAdjacentElement('afterend', bar);
        }

        if (!infNextUrl) {
            infDone = true;
            updateInfiniteStatus('🏁 目前僅此一頁內容');
            return;
        }

        if (!infLoading && !infDone) {
            updateInfiniteStatus('📄 下滑到底部自動載入下一頁');
        }

        if (!infObserver && 'IntersectionObserver' in window) {
            infObserver = new IntersectionObserver((entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    loadNextPage();
                }
            }, { rootMargin: '900px 0px' });
            infObserver.observe(bar);
        }
    }

    // ==================== 6. 播放頁強化 ====================
    function formatSec(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    function markVideoAsWatched(vk) {
        if (!vk) return;
        watchedMap[vk] = Date.now();
        const keys = Object.keys(watchedMap);
        if (keys.length > 1500) {
            keys.sort((a, b) => watchedMap[a] - watchedMap[b]).slice(0, keys.length - 1500).forEach((k) => delete watchedMap[k]);
        }
        saveJson(WATCHED_KEY, watchedMap);
    }

    function enhancePlayerPage() {
        const vk = extractViewKey(location.href);
        if (vk) markVideoAsWatched(vk);

        const playerWrap = document.querySelector('#player_one, .video-js') || document.querySelector('video')?.parentElement;
        const video = playerWrap?.querySelector('video') || document.querySelector('video');
        if (!playerWrap || !video) return;

        if (getComputedStyle(playerWrap).position === 'static') {
            playerWrap.style.position = 'relative';
        }

        if (!video.dataset.p91Bound) {
            video.dataset.p91Bound = '1';
            video.playbackRate = cfg.playbackRate || 1.0;

            const tryResume = () => {
                if (!vk || video.dataset.p91Resumed === '1') return;
                const savedSec = Number(progressMap[vk] || 0);
                if (savedSec > 8 && Number.isFinite(video.duration) && savedSec < video.duration - 10) {
                    video.currentTime = savedSec;
                    video.dataset.p91Resumed = '1';
                    showToast(`🔖 已自動續播上次進度：${formatSec(savedSec)}`);
                }
            };
            video.addEventListener('loadedmetadata', tryResume);
            if (video.readyState >= 1) tryResume();

            let lastSaveTs = 0;
            video.addEventListener('timeupdate', () => {
                if (feedOpen) return;
                if (!vk || !Number.isFinite(video.duration) || video.duration <= 0) return;
                const now = Date.now();
                if (now - lastSaveTs < 3000) return;
                lastSaveTs = now;

                if (video.currentTime / video.duration >= 0.95) {
                    delete progressMap[vk];
                } else if (video.currentTime > 5) {
                    progressMap[vk] = Math.floor(video.currentTime);
                }
                saveJson(PROGRESS_KEY, progressMap);
            });
        }

        if (!document.getElementById('p91-player-clock')) {
            let showSec = false;
            const clock = document.createElement('div');
            clock.id = 'p91-player-clock';
            clock.title = '點擊切換顯示秒數';
            const tick = () => {
                const d = new Date();
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                const ss = String(d.getSeconds()).padStart(2, '0');
                clock.textContent = showSec ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
            };
            clock.addEventListener('click', (e) => {
                e.stopPropagation();
                showSec = !showSec;
                tick();
            });
            tick();
            setInterval(tick, 1000);
            playerWrap.appendChild(clock);
        }

        if (!document.getElementById('p91-seek-hud')) {
            const hud = document.createElement('div');
            hud.id = 'p91-seek-hud';
            playerWrap.appendChild(hud);

            let touchStartX = 0;
            let touchStartY = 0;
            let startTime = 0;
            let swiping = false;

            playerWrap.addEventListener('touchstart', (e) => {
                if (e.touches.length !== 1 || e.target.closest('.vjs-control-bar')) return;
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                startTime = video.currentTime || 0;
                swiping = false;
            }, { passive: true });

            playerWrap.addEventListener('touchmove', (e) => {
                if (e.touches.length !== 1 || !Number.isFinite(video.duration)) return;
                const dx = e.touches[0].clientX - touchStartX;
                const dy = e.touches[0].clientY - touchStartY;
                if (!swiping && Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                    swiping = true;
                }
                if (swiping) {
                    const deltaSec = Math.round((dx / Math.max(240, playerWrap.clientWidth)) * 90);
                    const preview = Math.max(0, Math.min(video.duration, startTime + deltaSec));
                    hud.textContent = `${deltaSec >= 0 ? '⏩ +' : '⏪ '}${deltaSec}s (${formatSec(preview)})`;
                    hud.classList.add('show');
                }
            }, { passive: true });

            playerWrap.addEventListener('touchend', (e) => {
                if (!swiping) return;
                swiping = false;
                hud.classList.remove('show');
                const dx = (e.changedTouches[0]?.clientX || touchStartX) - touchStartX;
                const deltaSec = Math.round((dx / Math.max(240, playerWrap.clientWidth)) * 90);
                if (Math.abs(deltaSec) >= 2 && Number.isFinite(video.duration)) {
                    video.currentTime = Math.max(0, Math.min(video.duration, startTime + deltaSec));
                }
            }, { passive: true });
        }

        if (!document.getElementById('p91-player-bar')) {
            const bar = document.createElement('div');
            bar.id = 'p91-player-bar';
            const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];

            bar.innerHTML = `
                <div class="p91-pbar-group">
                    <button type="button" class="p91-pbtn" data-seek="-10">⏪ -10s</button>
                    <button type="button" class="p91-pbtn" data-seek="-5">◀ -5s</button>
                    <button type="button" class="p91-pbtn accent" id="p91-pb-play">⏯ 播放/暫停</button>
                    <button type="button" class="p91-pbtn" data-seek="5">+5s ▶</button>
                    <button type="button" class="p91-pbtn" data-seek="10">+10s ⏩</button>
                </div>
                <div class="p91-pbar-group">
                    ${speeds.map((sp) => `<button type="button" class="p91-pbtn p91-sp-btn ${cfg.playbackRate === sp ? 'active' : ''}" data-speed="${sp}">${sp}x</button>`).join('')}
                    <button type="button" class="p91-pbtn" id="p91-pb-pip">🖼️ 畫中畫</button>
                    <button type="button" class="p91-pbtn" id="p91-pb-fs">⛶ 全螢幕</button>
                </div>
            `;

            playerWrap.insertAdjacentElement('afterend', bar);

            bar.querySelectorAll('[data-seek]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sec = Number(btn.dataset.seek);
                    if (Number.isFinite(video.duration)) {
                        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
                        showToast(sec > 0 ? `⏩ 快進 +${sec} 秒` : `⏪ 倒退 ${sec} 秒`);
                    }
                });
            });

            bar.querySelector('#p91-pb-play').addEventListener('click', () => {
                if (video.paused) video.play().catch(() => {});
                else video.pause();
            });

            bar.querySelectorAll('.p91-sp-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sp = Number(btn.dataset.speed);
                    cfg.playbackRate = sp;
                    saveCfg();
                    video.playbackRate = sp;
                    bar.querySelectorAll('.p91-sp-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === sp));
                    showToast(`⚡ 播放速度：${sp}x`);
                });
            });

            bar.querySelector('#p91-pb-pip').addEventListener('click', async () => {
                try {
                    if (document.pictureInPictureElement) await document.exitPictureInPicture();
                    else if (video.requestPictureInPicture) await video.requestPictureInPicture();
                } catch {
                    showToast('⚠️ 目前瀏覽器不支援畫中畫');
                }
            });

            bar.querySelector('#p91-pb-fs').addEventListener('click', () => {
                const target = document.fullscreenElement ? document : playerWrap;
                if (document.fullscreenElement) {
                    document.exitFullscreen().catch(() => {});
                } else if (target.requestFullscreen) {
                    target.requestFullscreen().catch(() => {});
                } else if (video.webkitEnterFullscreen) {
                    video.webkitEnterFullscreen();
                }
            });
        }
    }

    // ==================== 7. 抖音模式（含完整空值防呆與 URL 百分比/Base64 串流解碼） ====================
    function collectFeedItemsFromPage() {
        const list = [];
        const seen = new Set();

        const curVk = extractViewKey(location.href);
        if (curVk && location.pathname.includes('view_video.php')) {
            const curVideo = document.querySelector('#player_one video, .video-js video, video');
            const curSrc = curVideo?.currentSrc || curVideo?.src || '';
            if (curSrc && !AD_DOMAIN_RE.test(curSrc) && !/ad-i18n-dsp|preroll/i.test(curSrc)) {
                streamCache.set(curVk, curSrc);
            }
            const h1 = document.querySelector('h4, h3, .login_register_header, title');
            seen.add(curVk);
            list.push({
                vk: curVk,
                url: location.href,
                title: (h1?.textContent || document.title || '目前播放影片').replace(/\s+/g, ' ').trim(),
                poster: curVideo?.poster || '',
                addedTime: '本頁影片',
                views: '',
                duration: ''
            });
        }

        document.querySelectorAll('.p91-card').forEach((card) => {
            if (card.style.display === 'none' || card.classList.contains('p91-user-hidden')) return;
            const url = card.dataset.p91Href || card.querySelector('a[href*="view_video.php"]')?.href || '';
            const vk = card.dataset.p91Vk || extractViewKey(url);
            if (!url || (vk && seen.has(vk))) return;
            if (vk) seen.add(vk);

            list.push({
                vk,
                url,
                title: card.dataset.p91Title || '未命名影片',
                poster: card.dataset.p91Poster || card.querySelector('img')?.src || '',
                addedTime: card.dataset.p91AddedTime || '',
                views: card.dataset.p91Views || '',
                duration: card.dataset.p91Duration || ''
            });
        });

        return list;
    }

    function ensureHlsLibrary() {
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (window.Hls || pageWin?.Hls) return Promise.resolve(window.Hls || pageWin.Hls);

        return new Promise((resolve) => {
            const existing = document.getElementById('p91-hls-lib');
            if (existing) {
                existing.addEventListener('load', () => resolve(window.Hls || pageWin?.Hls || null), { once: true });
                return;
            }
            const sc = document.createElement('script');
            sc.id = 'p91-hls-lib';
            sc.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
            sc.onload = () => resolve(window.Hls || pageWin?.Hls || null);
            sc.onerror = () => resolve(null);
            (document.head || document.documentElement).appendChild(sc);
        });
    }

    function decodeEncodedStreamsFromHtml(html) {
        const found = [];
        const pushIfValid = (raw) => {
            if (!raw) return;
            const clean = String(raw)
                .replace(/\\u002F/gi, '/')
                .replace(/\\\//g, '/')
                .replace(/&amp;/g, '&')
                .trim();
            if (/^https?:\/\/.+/i.test(clean) && !AD_DOMAIN_RE.test(clean) && !/ad-i18n-dsp|preroll/i.test(clean) && !found.includes(clean)) {
                found.push(clean);
            }
        };

        // 1. 解析 strencode2(...) 內層字串（支援 URL 百分比編碼 %3c...%3e 與 Base64）
        const encRegex = /strencode2\(\s*["'`]([^"'`]+)["'`]\s*\)/gi;
        let m;
        while ((m = encRegex.exec(html)) !== null) {
            const inner = m[1];
            try {
                const uriDec = decodeURIComponent(inner);
                const srcMatch = uriDec.match(/src=['"]([^'"]+)['"]/i) || uriDec.match(/(https?:\/\/[^\s"'<>]+)/i);
                if (srcMatch && srcMatch[1]) pushIfValid(srcMatch[1]);
            } catch {}

            try {
                const b64Dec = decodeURIComponent(atob(inner));
                const srcMatch = b64Dec.match(/src=['"]([^'"]+)['"]/i) || b64Dec.match(/(https?:\/\/[^\s"'<>]+)/i);
                if (srcMatch && srcMatch[1]) pushIfValid(srcMatch[1]);
            } catch {}
        }

        // 2. 直接比對 HTML 內的 mp4 / m3u8 網址（排除前貼片廣告）
        const directMatches = html.match(/https?:\/\/[^"'\\\s<>]+\.(?:mp4|m3u8)(?:\?[^"'\\\s<>]*)?/gi) || [];
        directMatches.forEach((u) => pushIfValid(u));

        // 3. 嘗試其他 Base64 編碼片段
        const b64Regex = /(?:atob\(|["'])([A-Za-z0-9+/=]{24,})(?:["']|\))/g;
        while ((m = b64Regex.exec(html)) !== null) {
            try {
                const raw = atob(m[1]);
                const urlM = raw.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)(?:\?[^\s"'<>]*)?/i);
                if (urlM && urlM[0]) pushIfValid(urlM[0]);
            } catch {}
        }

        return found;
    }

    async function resolveVideoStreamUrl(item) {
        const cacheKey = item.vk || item.url;
        if (streamCache.has(cacheKey)) {
            return streamCache.get(cacheKey);
        }

        try {
            const res = await fetch(item.url, { credentials: 'include' });
            if (!res.ok) return '';
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            const domEl = doc.querySelector('#player_one source[src], video source[src], video[src]');
            const domSrc = domEl?.getAttribute('src') || '';
            if (domSrc && !domSrc.startsWith('blob:') && !AD_DOMAIN_RE.test(domSrc) && !/ad-i18n-dsp|preroll/i.test(domSrc)) {
                const abs = new URL(domSrc, item.url).href;
                streamCache.set(cacheKey, abs);
                return abs;
            }

            const decodedList = decodeEncodedStreamsFromHtml(html);
            if (decodedList.length > 0) {
                const abs = new URL(decodedList[0], item.url).href;
                streamCache.set(cacheKey, abs);
                return abs;
            }
        } catch {}

        return '';
    }

    async function attachStreamToVideo(videoEl, streamUrl, slideIdx) {
        if (!videoEl || !streamUrl) return;
        if (hlsInstances.has(slideIdx)) {
            try { hlsInstances.get(slideIdx).destroy(); } catch {}
            hlsInstances.delete(slideIdx);
        }

        const isHls = /\.m3u8(?:\?|$)/i.test(streamUrl);
        if (isHls && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            const HlsLib = await ensureHlsLibrary();
            if (HlsLib && HlsLib.isSupported()) {
                const hls = new HlsLib({ enableWorker: true });
                hls.loadSource(streamUrl);
                hls.attachMedia(videoEl);
                hlsInstances.set(slideIdx, hls);
                return;
            }
        }
        videoEl.src = streamUrl;
    }

    function updateFeedClockText() {
        const el = document.getElementById('p91-feed-clock');
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

    function openFeedMode(startIdx = 0) {
        if (feedOpen) return;
        enhanceVideoCards();
        feedItems = collectFeedItemsFromPage();
        if (feedItems.length === 0) {
            showToast('⚠️ 目前頁面沒有可播放的影片清單');
            return;
        }

        document.querySelectorAll('video').forEach((v) => {
            try { v.pause(); } catch {}
        });

        feedOpen = true;
        feedIndex = Math.max(0, Math.min(startIdx, feedItems.length - 1));
        document.documentElement.style.overflow = 'hidden';

        const overlay = document.createElement('div');
        overlay.id = 'p91-feed-overlay';
        overlay.innerHTML = `
            <div id="p91-feed-topbar">
                <div class="p91-feed-top-group">
                    <button type="button" id="p91-feed-close" class="p91-fbtn">✕ 退出</button>
                    <span id="p91-feed-counter" class="p91-fbtn">1 / ${feedItems.length}</span>
                </div>
                <div class="p91-feed-top-group">
                    <button type="button" id="p91-feed-drawer-btn" class="p91-fbtn">☰ 選集</button>
                    <button type="button" id="p91-feed-clock" class="p91-fbtn" title="點擊切換顯示秒數">00:00</button>
                </div>
            </div>
            <div id="p91-feed-track" class="p91-feed-track"></div>
            <div id="p91-feed-bottom-dock">
                <div id="p91-feed-meta"></div>
                <div id="p91-feed-title"></div>
                <div class="p91-feed-scrub-row">
                    <input type="range" id="p91-feed-range" min="0" max="1000" value="0" />
                    <span id="p91-feed-time">00:00 / 00:00</span>
                </div>
                <div class="p91-feed-ctrl-row">
                    <div class="p91-feed-ctrl-group">
                        <button type="button" class="p91-fcbtn" data-fseek="-10">⏪ -10s</button>
                        <button type="button" class="p91-fcbtn accent" id="p91-fc-play">⏯ 播放</button>
                        <button type="button" class="p91-fcbtn" data-fseek="10">+10s ⏩</button>
                    </div>
                    <div class="p91-feed-ctrl-group">
                        <button type="button" class="p91-fcbtn" id="p91-fc-speed">${cfg.playbackRate}x</button>
                        <button type="button" class="p91-fcbtn" id="p91-fc-mute">${cfg.feedMuted ? '🔇 靜音' : '🔊 有聲'}</button>
                        <button type="button" class="p91-fcbtn" id="p91-fc-fs">⛶ 全螢幕</button>
                    </div>
                </div>
            </div>
            <div id="p91-feed-hud"></div>
            <div id="p91-feed-drawer">
                <div class="p91-drawer-head">
                    <span id="p91-drawer-title">播放選集 (${feedItems.length})</span>
                    <button type="button" id="p91-drawer-close" class="p91-fbtn">✕ 關閉</button>
                </div>
                <div id="p91-drawer-grid" class="p91-drawer-grid"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        const track = overlay.querySelector('#p91-feed-track');
        const hud = overlay.querySelector('#p91-feed-hud');
        const counterEl = overlay.querySelector('#p91-feed-counter');
        const metaEl = overlay.querySelector('#p91-feed-meta');
        const titleEl = overlay.querySelector('#p91-feed-title');
        const rangeEl = overlay.querySelector('#p91-feed-range');
        const timeEl = overlay.querySelector('#p91-feed-time');
        const drawerEl = overlay.querySelector('#p91-feed-drawer');
        const drawerGrid = overlay.querySelector('#p91-drawer-grid');

        let scrubbing = false;
        let activeProgressTimer = null;

        const getCurrentVideo = () => track?.children?.[feedIndex]?.querySelector('video') || null;

        const syncBottomDockToItem = (item) => {
            if (!item) return;
            const metaParts = [];
            if (item.addedTime) metaParts.push(`🕒 ${item.addedTime}`);
            if (item.views) metaParts.push(`👁️ ${item.views}`);
            if (item.duration) metaParts.push(`⏱ ${item.duration}`);
            metaEl.textContent = metaParts.join(' · ');
            titleEl.textContent = item.title || '';
            titleEl.title = item.title || '';
            rangeEl.value = '0';
            timeEl.textContent = '00:00 / 00:00';
        };

        const bindProgressSync = (video) => {
            if (activeProgressTimer) {
                clearInterval(activeProgressTimer);
                activeProgressTimer = null;
            }
            if (!video) return;
            activeProgressTimer = setInterval(() => {
                if (!feedOpen || scrubbing) return;
                if (Number.isFinite(video.duration) && video.duration > 0) {
                    rangeEl.value = String(Math.round((video.currentTime / video.duration) * 1000));
                    timeEl.textContent = `${formatSec(video.currentTime)} / ${formatSec(video.duration)}`;
                }
            }, 250);
        };

        rangeEl.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            scrubbing = true;
        });
        rangeEl.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            scrubbing = true;
        }, { passive: true });
        rangeEl.addEventListener('input', (e) => {
            e.stopPropagation();
            const curVideo = getCurrentVideo();
            if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                const preview = (Number(rangeEl.value) / 1000) * curVideo.duration;
                timeEl.textContent = `${formatSec(preview)} / ${formatSec(curVideo.duration)}`;
            }
        });
        const commitScrub = () => {
            const curVideo = getCurrentVideo();
            if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                curVideo.currentTime = (Number(rangeEl.value) / 1000) * curVideo.duration;
            }
            scrubbing = false;
        };
        rangeEl.addEventListener('change', (e) => {
            e.stopPropagation();
            commitScrub();
        });
        rangeEl.addEventListener('pointerup', (e) => {
            e.stopPropagation();
            commitScrub();
        });

        overlay.querySelectorAll('[data-fseek]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sec = Number(btn.dataset.fseek);
                const curVideo = getCurrentVideo();
                if (!curVideo || !Number.isFinite(curVideo.duration)) return;
                curVideo.currentTime = Math.max(0, Math.min(curVideo.duration, curVideo.currentTime + sec));
                hud.textContent = sec > 0 ? `⏩ +${sec}s` : `⏪ ${sec}s`;
                hud.classList.add('show');
                setTimeout(() => hud.classList.remove('show'), 600);
            });
        });

        overlay.querySelector('#p91-fc-play').addEventListener('click', (e) => {
            e.stopPropagation();
            const curVideo = getCurrentVideo();
            if (!curVideo) return;
            if (curVideo.paused) curVideo.play().catch(() => {});
            else curVideo.pause();
        });

        overlay.querySelector('#p91-fc-speed').addEventListener('click', (e) => {
            e.stopPropagation();
            const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];
            cfg.playbackRate = speeds[(speeds.indexOf(cfg.playbackRate) + 1) % speeds.length];
            saveCfg();
            e.target.textContent = `${cfg.playbackRate}x`;
            const curVideo = getCurrentVideo();
            if (curVideo) curVideo.playbackRate = cfg.playbackRate;
        });

        overlay.querySelector('#p91-fc-mute').addEventListener('click', (e) => {
            e.stopPropagation();
            cfg.feedMuted = !cfg.feedMuted;
            saveCfg();
            e.target.textContent = cfg.feedMuted ? '🔇 靜音' : '🔊 有聲';
            const curVideo = getCurrentVideo();
            if (curVideo) curVideo.muted = cfg.feedMuted;
        });

        overlay.querySelector('#p91-fc-fs').addEventListener('click', (e) => {
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

        const buildSlide = (item, idx) => {
            const slide = document.createElement('div');
            slide.className = 'p91-feed-slide';
            slide.dataset.idx = String(idx);

            slide.innerHTML = `
                ${item.poster ? `<img class="p91-feed-poster" src="${item.poster}" alt="" />` : ''}
                <video class="p91-feed-video" playsinline webkit-playsinline preload="metadata" loop></video>
                <div class="p91-feed-status">⏳ 正在載入影片...</div>
                <div class="p91-feed-center-icon">▶</div>
            `;

            const video = slide.querySelector('video');
            const statusEl = slide.querySelector('.p91-feed-status');

            if (video) {
                video.muted = Boolean(cfg.feedMuted);
                video.playbackRate = Number(cfg.playbackRate) || 1.0;

                video.addEventListener('playing', () => {
                    if (statusEl) statusEl.style.display = 'none';
                });
                video.addEventListener('waiting', () => {
                    if (idx === feedIndex && statusEl) {
                        statusEl.textContent = '⏳ 緩衝中...';
                        statusEl.style.display = 'block';
                    }
                });
                video.addEventListener('error', () => {
                    if (idx === feedIndex && statusEl) {
                        statusEl.textContent = '⚠️ 串流無法播放，請上滑看下一部';
                        statusEl.style.display = 'block';
                    }
                });
            }

            return slide;
        };

        const syncSlidesDOM = () => {
            while (track.children.length < feedItems.length) {
                const nextIdx = track.children.length;
                track.appendChild(buildSlide(feedItems[nextIdx], nextIdx));
            }
            counterEl.textContent = `${feedIndex + 1} / ${feedItems.length}`;
        };

        const renderDrawer = () => {
            overlay.querySelector('#p91-drawer-title').textContent = `播放選集 (${feedItems.length})`;
            drawerGrid.innerHTML = '';
            const frag = document.createDocumentFragment();
            feedItems.forEach((item, idx) => {
                const cell = document.createElement('div');
                cell.className = `p91-drawer-item ${idx === feedIndex ? 'active' : ''}`;
                cell.innerHTML = `
                    <div class="p91-drawer-thumb">
                        ${item.poster ? `<img src="${item.poster}" loading="lazy" alt="" />` : ''}
                        <span class="p91-drawer-idx">#${idx + 1}</span>
                    </div>
                    <div class="p91-drawer-caption">${item.title}</div>
                `;
                cell.addEventListener('click', () => {
                    drawerEl.classList.remove('open');
                    goToSlide(idx);
                });
                frag.appendChild(cell);
            });
            drawerGrid.appendChild(frag);
        };

        const activateSlide = async (idx) => {
            const item = feedItems[idx];
            if (!item) return;

            syncBottomDockToItem(item);
            if (item.vk) markVideoAsWatched(item.vk);
            enhanceVideoCards();

            Array.from(track.children).forEach((sl, i) => {
                const v = sl.querySelector('video');
                if (!v) return;
                if (i !== idx) {
                    try { v.pause(); } catch {}
                    if (Math.abs(i - idx) > 2 && v.src) {
                        v.removeAttribute('src');
                        v.load();
                        delete sl.dataset.loaded;
                    }
                }
            });

            const activeSlide = track.children[idx];
            const video = activeSlide ? activeSlide.querySelector('video') : null;
            const statusEl = activeSlide ? activeSlide.querySelector('.p91-feed-status') : null;

            if (!video) {
                if (statusEl) {
                    statusEl.textContent = '⚠️ 找不到播放器元素，請滑動切換下一部';
                    statusEl.style.display = 'block';
                }
                return;
            }

            bindProgressSync(video);
            video.muted = Boolean(cfg.feedMuted);
            video.playbackRate = Number(cfg.playbackRate) || 1.0;

            if (activeSlide.dataset.loaded !== '1') {
                if (statusEl) {
                    statusEl.textContent = '⏳ 正在解析影片串流...';
                    statusEl.style.display = 'block';
                }
                const streamUrl = await resolveVideoStreamUrl(item);
                if (!feedOpen || idx !== feedIndex) return;

                const latestVideo = track.children[idx]?.querySelector('video');
                if (!latestVideo) return;

                if (!streamUrl) {
                    if (statusEl) {
                        statusEl.textContent = '⚠️ 串流無法播放，請上滑看下一部';
                        statusEl.style.display = 'block';
                    }
                    return;
                }
                activeSlide.dataset.loaded = '1';
                latestVideo.muted = Boolean(cfg.feedMuted);
                latestVideo.playbackRate = Number(cfg.playbackRate) || 1.0;
                await attachStreamToVideo(latestVideo, streamUrl, idx);
                if (!feedOpen || idx !== feedIndex) return;

                latestVideo.play().catch(() => {
                    latestVideo.muted = true;
                    cfg.feedMuted = true;
                    const muteBtn = overlay.querySelector('#p91-fc-mute');
                    if (muteBtn) muteBtn.textContent = '🔇 靜音';
                    latestVideo.play().catch(() => {});
                });
            } else {
                video.play().catch(() => {
                    video.muted = true;
                    cfg.feedMuted = true;
                    const muteBtn = overlay.querySelector('#p91-fc-mute');
                    if (muteBtn) muteBtn.textContent = '🔇 靜音';
                    video.play().catch(() => {});
                });
            }

            if (idx + 1 < feedItems.length) {
                resolveVideoStreamUrl(feedItems[idx + 1]).catch(() => {});
            }

            if (idx >= feedItems.length - 2 && cfg.infiniteScroll && !infDone) {
                loadNextPage().then((hasMore) => {
                    if (hasMore && feedOpen) {
                        const updated = collectFeedItemsFromPage();
                        if (updated.length > feedItems.length) {
                            feedItems = updated;
                            syncSlidesDOM();
                            if (drawerEl.classList.contains('open')) renderDrawer();
                        }
                    }
                });
            }
        };

        const goToSlide = (targetIdx) => {
            syncSlidesDOM();
            feedIndex = Math.max(0, Math.min(targetIdx, feedItems.length - 1));
            track.classList.remove('dragging');
            track.style.transform = `translate3d(0, -${feedIndex * 100}%, 0)`;
            counterEl.textContent = `${feedIndex + 1} / ${feedItems.length}`;
            syncBottomDockToItem(feedItems[feedIndex]);
            activateSlide(feedIndex);
        };

        let tStartX = 0;
        let tStartY = 0;
        let gestureMode = null;
        let scrubStartTime = 0;
        let lastTapTs = 0;

        track.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            tStartX = e.touches[0].clientX;
            tStartY = e.touches[0].clientY;
            gestureMode = null;
            const curVideo = getCurrentVideo();
            scrubStartTime = curVideo?.currentTime || 0;
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
                track.style.transform = `translate3d(0, calc(-${feedIndex * 100}% + ${offset}px), 0)`;
            } else if (gestureMode === 'horizontal') {
                const curVideo = getCurrentVideo();
                if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                    const absY = Math.abs(dy);
                    const mult = absY > 90 ? 4 : (absY > 40 ? 2 : 1);
                    const deltaSec = Math.round((dx / Math.max(240, window.innerWidth)) * 90 * mult);
                    const targetSec = Math.max(0, Math.min(curVideo.duration, scrubStartTime + deltaSec));
                    hud.textContent = `${deltaSec >= 0 ? '⏩ +' : '⏪ '}${deltaSec}s (${formatSec(targetSec)}) [${mult}x]`;
                    hud.classList.add('show');
                }
            }
        }, { passive: true });

        track.addEventListener('touchend', (e) => {
            const endX = e.changedTouches[0]?.clientX ?? tStartX;
            const endY = e.changedTouches[0]?.clientY ?? tStartY;
            const dx = endX - tStartX;
            const dy = endY - tStartY;

            if (gestureMode === 'vertical') {
                const threshold = Math.min(80, window.innerHeight * 0.14);
                if (dy <= -threshold && feedIndex < feedItems.length - 1) {
                    goToSlide(feedIndex + 1);
                } else if (dy >= threshold && feedIndex > 0) {
                    goToSlide(feedIndex - 1);
                } else {
                    goToSlide(feedIndex);
                }
            } else if (gestureMode === 'horizontal') {
                hud.classList.remove('show');
                const curVideo = getCurrentVideo();
                if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                    const absY = Math.abs(dy);
                    const mult = absY > 90 ? 4 : (absY > 40 ? 2 : 1);
                    const deltaSec = Math.round((dx / Math.max(240, window.innerWidth)) * 90 * mult);
                    if (Math.abs(deltaSec) >= 2) {
                        curVideo.currentTime = Math.max(0, Math.min(curVideo.duration, scrubStartTime + deltaSec));
                    }
                }
            } else if (Math.hypot(dx, dy) < 10 && !e.target.closest('button, input')) {
                const now = Date.now();
                const curSlide = track.children[feedIndex];
                const curVideo = curSlide?.querySelector('video');
                const iconEl = curSlide?.querySelector('.p91-feed-center-icon');
                if (curVideo) {
                    if (now - lastTapTs < 260) {
                        const skip = endX > window.innerWidth * 0.5 ? 10 : -10;
                        if (Number.isFinite(curVideo.duration)) {
                            curVideo.currentTime = Math.max(0, Math.min(curVideo.duration, curVideo.currentTime + skip));
                        }
                        hud.textContent = skip > 0 ? '⏩ +10s' : '⏪ -10s';
                        hud.classList.add('show');
                        setTimeout(() => hud.classList.remove('show'), 650);
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

        let wheelLock = false;
        overlay.addEventListener('wheel', (e) => {
            if (drawerEl.classList.contains('open')) return;
            e.preventDefault();
            if (wheelLock || Math.abs(e.deltaY) < 24) return;
            wheelLock = true;
            setTimeout(() => { wheelLock = false; }, 340);
            if (e.deltaY > 0 && feedIndex < feedItems.length - 1) goToSlide(feedIndex + 1);
            else if (e.deltaY < 0 && feedIndex > 0) goToSlide(feedIndex - 1);
        }, { passive: false });

        overlay.querySelector('#p91-feed-close').addEventListener('click', closeFeedMode);

        overlay.querySelector('#p91-feed-clock').addEventListener('click', (e) => {
            e.stopPropagation();
            feedClockShowSeconds = !feedClockShowSeconds;
            updateFeedClockText();
        });

        overlay.querySelector('#p91-feed-drawer-btn').addEventListener('click', () => {
            renderDrawer();
            drawerEl.classList.add('open');
        });
        overlay.querySelector('#p91-drawer-close').addEventListener('click', () => {
            drawerEl.classList.remove('open');
        });

        startFeedClock();
        goToSlide(feedIndex);
    }

    function closeFeedMode() {
        if (!feedOpen) return;
        stopFeedClock();
        feedOpen = false;
        document.documentElement.style.overflow = '';

        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }

        hlsInstances.forEach((hls) => {
            try { hls.destroy(); } catch {}
        });
        hlsInstances.clear();

        const overlay = document.getElementById('p91-feed-overlay');
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
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

        if (feedOpen) {
            const track = document.getElementById('p91-feed-track');
            const curVideo = track?.children?.[feedIndex]?.querySelector('video') || null;
            if (e.key === 'Escape') {
                e.preventDefault();
                closeFeedMode();
            } else if (e.key === 'ArrowDown' && feedIndex < feedItems.length - 1) {
                e.preventDefault();
                feedIndex++;
                if (track) track.style.transform = `translate3d(0, -${feedIndex * 100}%, 0)`;
                const counter = document.getElementById('p91-feed-counter');
                if (counter) counter.textContent = `${feedIndex + 1} / ${feedItems.length}`;
                track?.children?.[feedIndex]?.querySelector('video')?.play().catch(() => {});
            } else if (e.key === 'ArrowUp' && feedIndex > 0) {
                e.preventDefault();
                feedIndex--;
                if (track) track.style.transform = `translate3d(0, -${feedIndex * 100}%, 0)`;
                const counter = document.getElementById('p91-feed-counter');
                if (counter) counter.textContent = `${feedIndex + 1} / ${feedItems.length}`;
                track?.children?.[feedIndex]?.querySelector('video')?.play().catch(() => {});
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
            return;
        }

        const video = document.querySelector('#player_one video, .video-js video, video');
        if (!video) return;

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            video.currentTime = Math.max(0, video.currentTime - 5);
            showToast('⏪ 倒退 5 秒');
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 5);
            showToast('⏩ 快進 5 秒');
        } else if (e.code === 'Space') {
            e.preventDefault();
            if (video.paused) video.play().catch(() => {});
            else video.pause();
        }
    });

    // ==================== 8. 點選隱藏元件工具 ====================
    function generateSelector(el) {
        if (!el || el === document.body || el === document.documentElement) return '';
        if (el.id && !/^\d/.test(el.id)) return `#${CSS.escape(el.id)}`;
        const classes = Array.from(el.classList || []).filter((c) => c && !c.startsWith('p91-') && !/active|open|hover/i.test(c));
        const tag = el.tagName.toLowerCase();
        if (classes.length > 0) {
            return `${tag}.${classes.slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
        }
        if (el.parentElement && el.parentElement !== document.body) {
            return `${generateSelector(el.parentElement)} > ${tag}`;
        }
        return tag;
    }

    function startElementPicker() {
        if (pickerActive) return;
        pickerActive = true;
        pickerLockedEl = null;
        pickerHistoryStack = [];

        let hl = document.getElementById('p91-picker-highlight');
        if (!hl) {
            hl = document.createElement('div');
            hl.id = 'p91-picker-highlight';
            document.body.appendChild(hl);
        }

        let bar = document.getElementById('p91-picker-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'p91-picker-bar';
            bar.innerHTML = `
                <div id="p91-picker-drag">
                    <span>⠿ 按住拖曳移動</span>
                    <button type="button" id="p91-pk-flip" class="p91-pbtn" style="padding:3px 8px;font-size:11px;">⇅ 移到底部</button>
                </div>
                <div id="p91-picker-info">點擊網頁上任何想隱藏的廣告或區塊</div>
                <div id="p91-picker-btns">
                    <button type="button" id="p91-pk-ok" class="p91-pbtn accent" disabled>🙈 隱藏此區塊</button>
                    <button type="button" id="p91-pk-up" class="p91-pbtn" disabled>⬆️ 擴大一層</button>
                    <button type="button" id="p91-pk-undo" class="p91-pbtn">↩️ 復原上一筆</button>
                    <button type="button" id="p91-pk-exit" class="p91-pbtn">✕ 結束</button>
                </div>
            `;
            document.body.appendChild(bar);

            const flipBtn = bar.querySelector('#p91-pk-flip');
            const moveBar = (left, top) => {
                const r = bar.getBoundingClientRect();
                const cl = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
                const ct = Math.max(8, Math.min(top, window.innerHeight - r.height - 8));
                bar.style.transform = 'none';
                bar.style.left = `${cl}px`;
                bar.style.top = `${ct}px`;
                flipBtn.textContent = (ct + r.height / 2 > window.innerHeight / 2) ? '⇅ 移到頂部' : '⇅ 移到底部';
            };

            flipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const r = bar.getBoundingClientRect();
                const lower = r.top + r.height / 2 > window.innerHeight / 2;
                moveBar((window.innerWidth - r.width) / 2, lower ? 12 : (window.innerHeight - r.height - 16));
            });

            let dragging = false, sx = 0, sy = 0, ol = 0, ot = 0;
            bar.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button')) return;
                const r = bar.getBoundingClientRect();
                dragging = true; sx = e.clientX; sy = e.clientY; ol = r.left; ot = r.top;
                bar.setPointerCapture(e.pointerId);
            });
            bar.addEventListener('pointermove', (e) => {
                if (!dragging) return;
                moveBar(ol + (e.clientX - sx), ot + (e.clientY - sy));
            });
            bar.addEventListener('pointerup', () => { dragging = false; });

            bar.querySelector('#p91-pk-up').addEventListener('click', () => {
                if (!pickerLockedEl?.parentElement || pickerLockedEl.parentElement === document.body) return;
                pickerHistoryStack.push(pickerLockedEl);
                pickerLockedEl = pickerLockedEl.parentElement;
                updateHighlight();
            });

            bar.querySelector('#p91-pk-ok').addEventListener('click', () => {
                if (!pickerLockedEl) return;
                const sel = generateSelector(pickerLockedEl);
                if (sel && !cfg.customHiddenSelectors.includes(sel)) {
                    cfg.customHiddenSelectors.push(sel);
                    saveCfg();
                    applyCustomHiddenRules();
                    showToast('✅ 已永久隱藏該區塊');
                }
                pickerLockedEl = null;
                hl.style.display = 'none';
                bar.querySelector('#p91-pk-ok').disabled = true;
                bar.querySelector('#p91-pk-up').disabled = true;
            });

            bar.querySelector('#p91-pk-undo').addEventListener('click', () => {
                if (cfg.customHiddenSelectors.length === 0) return;
                cfg.customHiddenSelectors.pop();
                saveCfg();
                applyCustomHiddenRules();
                showToast('↩️ 已復原上一筆隱藏規則');
            });

            bar.querySelector('#p91-pk-exit').addEventListener('click', stopElementPicker);
        }

        function updateHighlight() {
            if (!pickerLockedEl) return;
            const r = pickerLockedEl.getBoundingClientRect();
            hl.style.display = 'block';
            hl.style.left = `${r.left}px`;
            hl.style.top = `${r.top}px`;
            hl.style.width = `${r.width}px`;
            hl.style.height = `${r.height}px`;
            bar.querySelector('#p91-picker-info').textContent = `已選取：${generateSelector(pickerLockedEl)}`;
            bar.querySelector('#p91-pk-ok').disabled = false;
            bar.querySelector('#p91-pk-up').disabled = false;
        }

        window.__p91PickHandler = (e) => {
            if (!pickerActive) return;
            if (e.target.closest('#p91-picker-bar, #p91-float-panel')) return;
            e.preventDefault();
            e.stopPropagation();
            pickerLockedEl = e.target;
            pickerHistoryStack = [];
            updateHighlight();
        };

        document.addEventListener('click', window.__p91PickHandler, true);
        bar.classList.add('open');
    }

    function stopElementPicker() {
        pickerActive = false;
        if (window.__p91PickHandler) {
            document.removeEventListener('click', window.__p91PickHandler, true);
        }
        const hl = document.getElementById('p91-picker-highlight');
        const bar = document.getElementById('p91-picker-bar');
        if (hl) hl.style.display = 'none';
        if (bar) bar.classList.remove('open');
    }

    // ==================== 9. 右下角懸浮控制面板 ====================
    function createFloatingPanel() {
        if (!document.body || document.getElementById('p91-float-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'p91-float-panel';
        if (cfg.panelCollapsed) panel.classList.add('collapsed');

        const watchedLabels = { badge: '👁️ 僅標記已看', dim: '🌫️ 淡化已看過', hide: '🙈 隱藏已看過' };
        const colsLabel = () => (cfg.gridCols === 0 ? '📐 欄數：自動' : `📐 欄數：${cfg.gridCols}欄`);

        panel.innerHTML = `
            <div class="p91-panel-head" id="p91-panel-head">
                <span>⚡ 91Porn 增強</span>
                <div style="display:flex;align-items:center;gap:5px;">
                    <button type="button" id="p91-btn-feed-mini" class="p91-pbtn accent" style="padding:2px 8px;font-size:11px;">🎬 抖音</button>
                    <button type="button" id="p91-panel-toggle" class="p91-pbtn" style="padding:2px 8px;font-size:11px;">${cfg.panelCollapsed ? '展開' : '收合'}</button>
                </div>
            </div>
            <div class="p91-panel-body">
                <button type="button" id="p91-btn-feed" class="p91-pbtn accent" style="width:100%;padding:8px;font-size:13px;">🎬 進入抖音上下滑動模式</button>
                <div class="p91-panel-grid">
                    <button type="button" id="p91-btn-dark" class="p91-toggle-btn ${cfg.darkMode ? 'on' : ''}">🌙 深色主題</button>
                    <button type="button" id="p91-btn-ads" class="p91-toggle-btn ${cfg.blockAds ? 'on' : ''}">🛡️ 去廣告</button>
                    <button type="button" id="p91-btn-minimal" class="p91-toggle-btn ${cfg.minimalCard ? 'on' : ''}">🧹 精簡資訊</button>
                    <button type="button" id="p91-btn-infinite" class="p91-toggle-btn ${cfg.infiniteScroll ? 'on' : ''}">♾️ 無限滾動</button>
                    <button type="button" id="p91-btn-cols" class="p91-toggle-btn">${colsLabel()}</button>
                    <button type="button" id="p91-btn-watched" class="p91-toggle-btn on">${watchedLabels[cfg.watchedMode]}</button>
                </div>
                <div class="p91-panel-row">
                    <button type="button" id="p91-btn-pick" class="p91-pbtn" style="flex:1;">🎯 點選隱藏元件</button>
                    <button type="button" id="p91-btn-kw" class="p91-pbtn" style="flex:1;">🚫 關鍵字 (${cfg.blacklistWords.length})</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const head = panel.querySelector('#p91-panel-head');
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

        panel.querySelector('#p91-btn-feed').addEventListener('click', () => openFeedMode(0));
        panel.querySelector('#p91-btn-feed-mini').addEventListener('click', () => openFeedMode(0));

        panel.querySelector('#p91-panel-toggle').addEventListener('click', () => {
            cfg.panelCollapsed = !cfg.panelCollapsed;
            saveCfg();
            panel.classList.toggle('collapsed', cfg.panelCollapsed);
            panel.querySelector('#p91-panel-toggle').textContent = cfg.panelCollapsed ? '展開' : '收合';
        });

        panel.querySelector('#p91-btn-dark').addEventListener('click', (e) => {
            cfg.darkMode = !cfg.darkMode;
            saveCfg();
            applyRootFlags();
            e.target.classList.toggle('on', cfg.darkMode);
        });

        panel.querySelector('#p91-btn-ads').addEventListener('click', (e) => {
            cfg.blockAds = !cfg.blockAds;
            saveCfg();
            applyRootFlags();
            e.target.classList.toggle('on', cfg.blockAds);
            if (cfg.blockAds) cleanAdsOnPage();
        });

        panel.querySelector('#p91-btn-minimal').addEventListener('click', (e) => {
            cfg.minimalCard = !cfg.minimalCard;
            saveCfg();
            applyRootFlags();
            e.target.classList.toggle('on', cfg.minimalCard);
        });

        panel.querySelector('#p91-btn-infinite').addEventListener('click', (e) => {
            cfg.infiniteScroll = !cfg.infiniteScroll;
            saveCfg();
            applyRootFlags();
            e.target.classList.toggle('on', cfg.infiniteScroll);
            const bar = document.getElementById('p91-infinite-bar');
            if (bar) bar.style.display = cfg.infiniteScroll ? 'flex' : 'none';
            if (cfg.infiniteScroll && !infDone) loadNextPage();
        });

        panel.querySelector('#p91-btn-cols').addEventListener('click', (e) => {
            const seq = [0, 2, 3, 4];
            cfg.gridCols = seq[(seq.indexOf(cfg.gridCols) + 1) % seq.length];
            saveCfg();
            applyRootFlags();
            e.target.textContent = colsLabel();
        });

        panel.querySelector('#p91-btn-watched').addEventListener('click', (e) => {
            const modes = ['badge', 'dim', 'hide'];
            cfg.watchedMode = modes[(modes.indexOf(cfg.watchedMode) + 1) % modes.length];
            saveCfg();
            applyRootFlags();
            e.target.textContent = watchedLabels[cfg.watchedMode];
        });

        panel.querySelector('#p91-btn-pick').addEventListener('click', startElementPicker);

        panel.querySelector('#p91-btn-kw').addEventListener('click', (e) => {
            const cur = cfg.blacklistWords.join(', ');
            const input = prompt('輸入要過濾隱藏的標題或作者關鍵字（多個請用逗號分隔）：', cur);
            if (input === null) return;
            cfg.blacklistWords = input.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
            saveCfg();
            enhanceVideoCards();
            e.target.textContent = `🚫 關鍵字 (${cfg.blacklistWords.length})`;
            showToast(`✅ 已更新 ${cfg.blacklistWords.length} 個過濾關鍵字`);
        });
    }

    // ==================== 10. 啟動與動態監聽 ====================
    injectBaseStyles();
    applyRootFlags();
    installAdHooks();

    function checkBottomAndLoad() {
        if (!cfg.infiniteScroll || infLoading || infDone || !infNextUrl) return;
        const bar = document.getElementById('p91-infinite-bar');
        if (bar) {
            const rect = bar.getBoundingClientRect();
            if (rect.top <= window.innerHeight + 900) {
                loadNextPage();
                return;
            }
        }
        const docHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        if (window.innerHeight + window.scrollY >= docHeight - 900) {
            loadNextPage();
        }
    }

    function boot() {
        if (!document.body) {
            setTimeout(boot, 50);
            return;
        }
        createFloatingPanel();
        cleanAdsOnPage();
        enhanceVideoCards();
        setupInfiniteScroll();
        enhancePlayerPage();
        applyCustomHiddenRules();

        setInterval(cleanAdsOnPage, 1200);

        let scrollThrottle = null;
        const onScrollOrTouch = () => {
            if (scrollThrottle) return;
            scrollThrottle = setTimeout(() => {
                scrollThrottle = null;
                checkBottomAndLoad();
            }, 180);
        };
        window.addEventListener('scroll', onScrollOrTouch, { passive: true });
        window.addEventListener('touchmove', onScrollOrTouch, { passive: true });

        let timer = null;
        const obs = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                cleanAdsOnPage();
                enhanceVideoCards();
                setupInfiniteScroll();
                enhancePlayerPage();
                applyCustomHiddenRules();
            }, 250);
        });
        obs.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', applyRootFlags);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
