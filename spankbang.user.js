// ==UserScript==
// @name         SpankBang 全能增強：抖音模式 / 橫豎屏篩選 / Gold·Exclusive·AI分類 / 時長過濾 / 去廣告
// @namespace    https://spankbang.com/
// @version      1.0.0
// @description  為 SpankBang 打造抖音上下滑動連刷模式（支援橫屏/豎屏/全部切換）、徹底隱藏頁面與播放器廣告、獨立分類篩選 SpankBang Gold / Exclusive / AI 標籤影片與自訂最低時長過濾。
// @match        *://spankbang.com/*
// @match        *://*.spankbang.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://moyuuu0729.github.io/spankbang.user.js
// @downloadURL  https://moyuuu0729.github.io/spankbang.user.js
// ==/UserScript==

(function () {
    'use strict';

    const CFG_KEY = 'sb_plus_cfg_v1';
    const ORIENT_CACHE_KEY = 'sb_plus_orient_cache_v1';

    const DEFAULT_CFG = {
        blockAds: true,
        orientation: 'all', // 'all' | 'landscape' | 'portrait'
        showNormal: true,
        showGold: true,
        showExclusive: true,
        showAI: true,
        minMinutes: 0, // 0 = 不限
        playbackRate: 1.0,
        feedMuted: false,
        autoLoadNext: true,
        customHiddenSelectors: [],
        panelCollapsed: false
    };

    const AD_DOMAIN_RE = /(?:exoclick|juicyads|trafficjunky|tsyndicate|realsrv|popads|adtng|adsco|onclickalgo|acscdn|twinrdsrv|stripchat|chaturbate|livejasmin|bongacams|camsoda|myfreecams|jerkmate|flingster|doubleclick|googlesyndication|adxpansion|ero-advertising|plugrush|hilltopads|clickadu|popcash|propellerads)/i;

    let cfg = loadCfg();
    let orientCache = loadJson(ORIENT_CACHE_KEY, {});
    let adShieldUntil = 0;
    let lastAdToastTs = 0;
    let toastTimer = null;

    let pickerActive = false;
    let pickerLockedEl = null;

    let feedOpen = false;
    let feedItems = [];
    let feedIndex = 0;
    let feedNextPageUrl = '';
    let feedLoadingNext = false;
    let feedVisitedPages = new Set();
    let feedClockTimer = null;
    let feedProgressTimer = null;
    let feedGoToSlide = null;
    let feedClockShowSeconds = false;
    let consecutiveAutoSkips = 0;

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
            minMinutes: Math.max(0, Number(saved.minMinutes) || 0),
            customHiddenSelectors: Array.isArray(saved.customHiddenSelectors) ? saved.customHiddenSelectors : []
        });
    }

    function saveCfg() {
        saveJson(CFG_KEY, cfg);
    }

    function saveOrientCache(id, orientation, width = 0, height = 0) {
        if (!id || (orientation !== 'landscape' && orientation !== 'portrait')) return;
        orientCache[id] = { o: orientation, w: width, h: height, ts: Date.now() };
        const keys = Object.keys(orientCache);
        if (keys.length > 2000) {
            keys.sort((a, b) => (orientCache[a]?.ts || 0) - (orientCache[b]?.ts || 0))
                .slice(0, keys.length - 2000)
                .forEach((k) => delete orientCache[k]);
        }
        saveJson(ORIENT_CACHE_KEY, orientCache);
    }

    // ==================== 1. 基礎樣式注入 ====================
    const BASE_CSS = `
        /* 廣告隱藏 */
        html[data-sb-ads="true"] .ad,
        html[data-sb-ads="true"] .ads,
        html[data-sb-ads="true"] .ad-banner,
        html[data-sb-ads="true"] .banner-ad,
        html[data-sb-ads="true"] .top-banner,
        html[data-sb-ads="true"] .bottom-banner,
        html[data-sb-ads="true"] .video-item.ad,
        html[data-sb-ads="true"] .js-ad,
        html[data-sb-ads="true"] .cams-widget,
        html[data-sb-ads="true"] .live-cams,
        html[data-sb-ads="true"] .promo-banner,
        html[data-sb-ads="true"] .sponsored,
        html[data-sb-ads="true"] [id^="ad_"],
        html[data-sb-ads="true"] [id*="_ad_"],
        html[data-sb-ads="true"] [class*="ad_banner"],
        html[data-sb-ads="true"] [class*="adsbox"],
        html[data-sb-ads="true"] [class*="pause-ad"],
        html[data-sb-ads="true"] [data-testid*="ad-"],
        html[data-sb-ads="true"] [data-testid="ad"],
        html[data-sb-ads="true"] .ima-ad-container,
        html[data-sb-ads="true"] [class^="ima-"],
        html[data-sb-ads="true"] [class*=" ima-"],
        html[data-sb-ads="true"] .vjs-ad-control-bar,
        html[data-sb-ads="true"] .vjs-overlay,
        html[data-sb-ads="true"] ins,
        html[data-sb-ads="true"] iframe[src*="exoclick"],
        html[data-sb-ads="true"] iframe[src*="juicyads"],
        html[data-sb-ads="true"] iframe[src*="trafficjunky"],
        html[data-sb-ads="true"] iframe[src*="tsyndicate"],
        html[data-sb-ads="true"] iframe[src*="realsrv"],
        html[data-sb-ads="true"] iframe[src*="popads"],
        html[data-sb-ads="true"] iframe[src*="adtng"],
        html[data-sb-ads="true"] iframe[src*="stripchat"],
        html[data-sb-ads="true"] iframe[src*="chaturbate"],
        html[data-sb-ads="true"] iframe[src*="livejasmin"],
        html[data-sb-ads="true"] iframe[src*="bongacams"],
        html[data-sb-ads="true"] .sb-ad-hidden {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            width: 0 !important;
            height: 0 !important;
            overflow: hidden !important;
            pointer-events: none !important;
        }

        .sb-filtered-out,
        .sb-user-hidden {
            display: none !important;
        }

        /* 卡片分類徽章 */
        .sb-tag-badges {
            position: absolute;
            top: 6px;
            right: 6px;
            z-index: 15;
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 4px;
            pointer-events: none;
            max-width: calc(100% - 12px);
        }
        .sb-tag-chip {
            padding: 2px 6px;
            border-radius: 5px;
            font-size: 10.5px;
            font-weight: 800;
            line-height: 1.25;
            letter-spacing: 0.02em;
            color: #fff;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.55);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
        }
        .sb-tag-chip.gold {
            background: linear-gradient(135deg, #f59e0b, #d97706);
            color: #111827;
        }
        .sb-tag-chip.exclusive {
            background: linear-gradient(135deg, #ec4899, #8b5cf6);
        }
        .sb-tag-chip.ai {
            background: linear-gradient(135deg, #06b6d4, #2563eb);
        }
        .sb-tag-chip.orient {
            background: rgba(15, 23, 42, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.22);
            color: #e2e8f0;
        }

        /* ==================== 右下角懸浮控制面板 ==================== */
        #sb-float-panel,
        #sb-float-panel * {
            box-sizing: border-box;
        }
        #sb-float-panel {
            position: fixed;
            right: 12px;
            bottom: calc(16px + env(safe-area-inset-bottom, 0px));
            z-index: 2147483640;
            width: min(336px, calc(100vw - 24px));
            border-radius: 16px;
            background: rgba(17, 19, 27, 0.96);
            border: 1px solid rgba(245, 158, 11, 0.55);
            box-shadow: 0 12px 34px rgba(0, 0, 0, 0.72);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
            font-size: 12.5px;
            overflow: hidden;
            user-select: none;
        }
        #sb-float-panel.collapsed {
            width: auto;
            border-radius: 999px;
        }
        #sb-float-panel.collapsed .sb-panel-body {
            display: none;
        }
        .sb-panel-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 12px;
            background: linear-gradient(135deg, rgba(245, 158, 11, 0.24), rgba(239, 68, 68, 0.16));
            cursor: grab;
            touch-action: none;
            font-weight: 800;
            font-size: 12.5px;
        }
        .sb-panel-body {
            padding: 10px 12px 12px;
            display: flex;
            flex-direction: column;
            gap: 9px;
            max-height: min(76vh, 620px);
            overflow-y: auto;
        }
        .sb-section {
            display: flex;
            flex-direction: column;
            gap: 5px;
            padding-top: 7px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .sb-section-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11.5px;
            font-weight: 700;
            color: #cbd5e1;
        }
        .sb-seg-3 {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 5px;
        }
        .sb-grid-2 {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 5px;
        }
        .sb-dur-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 5px;
        }
        .sb-btn {
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
        .sb-btn:active {
            transform: scale(0.96);
        }
        .sb-btn.accent {
            background: linear-gradient(135deg, #f59e0b, #ef4444);
            border-color: transparent;
            color: #fff;
        }
        .sb-btn.on {
            background: rgba(245, 158, 11, 0.26);
            border-color: rgba(245, 158, 11, 0.8);
            color: #fff;
        }
        .sb-btn.on-gold {
            background: rgba(245, 158, 11, 0.3);
            border-color: #fbbf24;
            color: #fef3c7;
        }
        .sb-btn.on-exclusive {
            background: rgba(236, 72, 153, 0.28);
            border-color: #f472b6;
            color: #fce7f3;
        }
        .sb-btn.on-ai {
            background: rgba(6, 182, 212, 0.28);
            border-color: #22d3ee;
            color: #cffafe;
        }
        .sb-mini-presets {
            display: flex;
            gap: 5px;
        }
        .sb-mini-presets .sb-btn {
            flex: 1;
            padding: 4px 6px;
            font-size: 11px;
        }
        .sb-stats-line {
            font-size: 11px;
            color: #9ca3af;
            text-align: center;
            padding-top: 4px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            font-variant-numeric: tabular-nums;
        }

        /* ==================== 抖音模式全螢幕沉浸視窗 ==================== */
        #sb-feed-overlay,
        #sb-feed-overlay * {
            box-sizing: border-box !important;
        }
        #sb-feed-overlay {
            position: fixed;
            inset: 0;
            width: 100%;
            height: 100%;
            height: 100dvh;
            z-index: 2147483644;
            background: #050608;
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
            overflow: hidden;
            user-select: none;
            -webkit-user-select: none;
            touch-action: none;
        }
        .sb-feed-track {
            position: relative;
            z-index: 2;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            will-change: transform;
            transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .sb-feed-track.dragging {
            transition: none;
        }
        .sb-feed-slide {
            position: relative;
            flex: 0 0 100%;
            width: 100%;
            height: 100%;
            min-height: 100%;
            max-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #050608;
            overflow: hidden;
            padding-top: 52px;
            padding-bottom: 142px;
        }
        .sb-feed-poster {
            position: absolute;
            top: 52px;
            bottom: 142px;
            left: 0;
            right: 0;
            width: 100%;
            height: auto;
            object-fit: contain;
            opacity: 0.45;
            pointer-events: none;
            z-index: 1;
            transition: opacity 0.2s ease;
        }
        .sb-feed-video {
            position: relative;
            z-index: 2;
            width: 100%;
            height: 100%;
            max-height: 100%;
            object-fit: contain;
            background: transparent;
            pointer-events: none;
        }
        .sb-feed-video::-webkit-media-controls,
        .sb-feed-video::-webkit-media-controls-enclosure,
        .sb-feed-video::-webkit-media-controls-panel {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        .sb-feed-status {
            position: absolute;
            top: 42%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 6;
            padding: 8px 16px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.88);
            border: 1px solid rgba(245, 158, 11, 0.6);
            color: #f3f4f6;
            font-size: 13px;
            font-weight: 700;
            pointer-events: none;
            text-align: center;
            max-width: 86vw;
        }
        .sb-feed-center-icon {
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
        .sb-feed-center-icon.show {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }

        #sb-feed-topbar {
            position: fixed;
            top: calc(10px + env(safe-area-inset-top, 0px));
            left: 12px;
            right: 12px;
            z-index: 30;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            pointer-events: none;
        }
        .sb-feed-top-group {
            display: flex;
            align-items: center;
            gap: 6px;
            pointer-events: auto;
        }
        .sb-fbtn {
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.18);
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
        .sb-fbtn:active {
            transform: scale(0.95);
        }
        .sb-fbtn.highlight {
            border-color: rgba(245, 158, 11, 0.8);
            color: #fde68a;
        }

        #sb-feed-bottom-dock {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 28;
            padding: 16px 12px calc(10px + env(safe-area-inset-bottom, 0px));
            background: linear-gradient(to top, rgba(6, 8, 12, 0.97) 0%, rgba(6, 8, 12, 0.84) 74%, transparent 100%);
            display: flex;
            flex-direction: column;
            gap: 7px;
            pointer-events: auto;
        }
        #sb-feed-meta {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            font-size: 11.5px;
            font-weight: 700;
            color: #cbd5e1;
        }
        #sb-feed-title {
            font-size: 13.5px;
            font-weight: 700;
            color: #ffffff;
            line-height: 1.35;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .sb-feed-scrub-row {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
        }
        #sb-feed-time {
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 700;
            color: #e5e7eb;
            font-variant-numeric: tabular-nums;
            min-width: 82px;
            text-align: right;
        }
        #sb-feed-range {
            flex: 1;
            width: 100%;
            height: 6px;
            accent-color: #f59e0b;
            cursor: pointer;
            margin: 0;
        }
        .sb-feed-ctrl-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            overflow-x: auto;
            scrollbar-width: none;
        }
        .sb-feed-ctrl-row::-webkit-scrollbar {
            display: none;
        }
        .sb-feed-ctrl-group {
            display: flex;
            align-items: center;
            gap: 5px;
            flex-shrink: 0;
        }
        .sb-fcbtn {
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
            text-decoration: none;
        }
        .sb-fcbtn:active {
            transform: scale(0.95);
        }
        .sb-fcbtn.accent {
            background: linear-gradient(135deg, #f59e0b, #ef4444);
            border-color: transparent;
            color: #fff;
        }

        #sb-feed-hud {
            position: fixed;
            top: 44%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 35;
            padding: 10px 18px;
            border-radius: 999px;
            background: rgba(15, 17, 23, 0.92);
            border: 1px solid rgba(245, 158, 11, 0.7);
            color: #fff;
            font-size: 15px;
            font-weight: 800;
            font-variant-numeric: tabular-nums;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.14s ease;
        }
        #sb-feed-hud.show {
            opacity: 1;
        }

        #sb-feed-drawer {
            position: fixed;
            inset: 0;
            z-index: 40;
            background: rgba(5, 6, 8, 0.9);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: none;
            flex-direction: column;
            pointer-events: auto;
        }
        #sb-feed-drawer.open {
            display: flex;
        }
        .sb-drawer-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: calc(12px + env(safe-area-inset-top, 0px)) 14px 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.12);
            font-size: 14px;
            font-weight: 800;
        }
        .sb-drawer-grid {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
            align-content: start;
            touch-action: pan-y;
        }
        .sb-drawer-item {
            position: relative;
            border-radius: 8px;
            overflow: hidden;
            background: #141720;
            border: 2px solid transparent;
            cursor: pointer;
            display: flex;
            flex-direction: column;
        }
        .sb-drawer-item.active {
            border-color: #f59e0b;
        }
        .sb-drawer-thumb {
            position: relative;
            width: 100%;
            aspect-ratio: 16 / 9;
            background: #07080c;
        }
        .sb-drawer-thumb img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            display: block;
        }
        .sb-drawer-idx {
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
        .sb-drawer-dur {
            position: absolute;
            bottom: 4px;
            right: 4px;
            padding: 1px 5px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.8);
            color: #fff;
            font-size: 10px;
            font-weight: 700;
        }
        .sb-drawer-caption {
            padding: 5px 6px;
            font-size: 11px;
            line-height: 1.3;
            color: #e5e7eb;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        /* 點選隱藏工具 */
        #sb-picker-highlight {
            position: fixed;
            pointer-events: none;
            z-index: 2147483645;
            border: 2px dashed #f59e0b;
            background: rgba(245, 158, 11, 0.2);
            border-radius: 6px;
            display: none;
        }
        #sb-picker-bar {
            position: fixed;
            top: calc(10px + env(safe-area-inset-top, 0px));
            left: 50%;
            transform: translateX(-50%);
            z-index: 2147483647;
            width: min(520px, calc(100vw - 20px));
            background: rgba(18, 20, 28, 0.96);
            border: 1px solid rgba(245, 158, 11, 0.7);
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
        #sb-picker-bar.open {
            display: flex;
        }
        #sb-picker-drag {
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
        #sb-picker-info {
            font-size: 12px;
            color: #fde68a;
            word-break: break-all;
        }
        #sb-picker-btns {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }

        #sb-toast {
            position: fixed;
            left: 50%;
            bottom: calc(28px + env(safe-area-inset-bottom, 0px));
            transform: translateX(-50%);
            z-index: 2147483647;
            padding: 8px 16px;
            border-radius: 999px;
            background: rgba(18, 20, 28, 0.95);
            border: 1px solid rgba(245, 158, 11, 0.7);
            color: #fff;
            font-size: 13px;
            font-weight: 700;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.18s ease;
            max-width: calc(100vw - 32px);
            text-align: center;
        }
        #sb-toast.show {
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
        document.documentElement.dataset.sbAds = cfg.blockAds ? 'true' : 'false';
    }

    function showToast(msg, duration = 2200) {
        if (!document.body) return;
        let el = document.getElementById('sb-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'sb-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), duration);
    }

    function notifyAdBlocked(msg) {
        const now = Date.now();
        if (now - lastAdToastTs > 3500) {
            lastAdToastTs = now;
            showToast(msg);
        }
    }

    // ==================== 2. 廣告與彈窗攔截 ====================
    function isExternalAdUrl(rawUrl) {
        const str = String(rawUrl || '').trim();
        if (!str || str === 'about:blank' || str.startsWith('javascript:')) return true;
        if (str.startsWith('#') || str.startsWith('blob:') || str.startsWith('data:')) return false;
        try {
            const targetHost = new URL(str, location.origin).hostname;
            if (AD_DOMAIN_RE.test(targetHost)) return true;
            return !targetHost.endsWith('spankbang.com');
        } catch {
            return true;
        }
    }

    function installAdHooks() {
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        [window, pageWin].forEach((win) => {
            if (!win) return;

            if (typeof win.open === 'function' && !win.__sbOpenHooked) {
                const origOpen = win.open.bind(win);
                win.open = function (url, target, features) {
                    if (cfg.blockAds && (Date.now() < adShieldUntil || isExternalAdUrl(url))) {
                        notifyAdBlocked('🛡️ 已攔截彈窗廣告');
                        return null;
                    }
                    return origOpen(url, target, features);
                };
                win.__sbOpenHooked = true;
            }

            if (win.HTMLAnchorElement && !win.HTMLAnchorElement.prototype.__sbClickHooked) {
                const origClick = win.HTMLAnchorElement.prototype.click;
                win.HTMLAnchorElement.prototype.click = function (...args) {
                    if (cfg.blockAds && (this.target === '_blank' || Date.now() < adShieldUntil) && isExternalAdUrl(this.href)) {
                        notifyAdBlocked('🛡️ 已攔截背景跳轉廣告');
                        return;
                    }
                    return origClick.apply(this, args);
                };
                win.HTMLAnchorElement.prototype.__sbClickHooked = true;
            }

            if (win.document && typeof win.document.createElement === 'function' && !win.document.__sbCreateHooked) {
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
                win.document.__sbCreateHooked = true;
            }
        });

        const guardClick = (e) => {
            if (!cfg.blockAds || feedOpen) return;
            const target = e.target;
            if (!target || target.nodeType !== 1) return;
            if (target.closest('#sb-float-panel, #sb-picker-bar, #sb-feed-overlay')) return;

            const playerBox = target.closest('#main_video_player, .video-js, #video_container');
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
            }

            const extLink = target.closest('a[target="_blank"]');
            if (extLink && isExternalAdUrl(extLink.href)) {
                e.preventDefault();
                e.stopPropagation();
                extLink.classList.add('sb-ad-hidden');
                notifyAdBlocked('🛡️ 已阻擋外部廣告跳轉');
            }
        };

        ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach((evt) => {
            window.addEventListener(evt, guardClick, true);
        });
    }

    function applyCustomHiddenRules(forceReset = false) {
        if (forceReset) {
            document.querySelectorAll('.sb-user-hidden').forEach((el) => el.classList.remove('sb-user-hidden'));
        }
        cfg.customHiddenSelectors.forEach((sel) => {
            try {
                document.querySelectorAll(sel).forEach((el) => {
                    if (!el.classList.contains('sb-user-hidden') && !el.closest('#sb-float-panel, #sb-picker-bar, #sb-feed-overlay')) {
                        el.classList.add('sb-user-hidden');
                    }
                });
            } catch {}
        });
    }

    function cleanAdsOnPage() {
        if (!cfg.blockAds || feedOpen || document.hidden) return;

        // 移除固定懸浮廣告條
        document.querySelectorAll('body > div, body > aside, body > section, body > a').forEach((el) => {
            if (el.id?.startsWith('sb-')) return;
            if (el.querySelector('video, #main_video_player, header, nav, main, a[href*="/video/"]')) return;
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed') {
                const z = parseInt(cs.zIndex, 10) || 0;
                const rect = el.getBoundingClientRect();
                if (z >= 40 && (rect.width >= window.innerWidth * 0.6 || rect.height <= 150)) {
                    el.classList.add('sb-ad-hidden');
                }
            }
        });

        // 隱藏純外部廣告區塊 / 直播推廣卡片
        document.querySelectorAll('section, aside, div, li').forEach((box) => {
            if (box.classList.contains('sb-ad-hidden')) return;
            if (box.closest('#sb-float-panel, #sb-picker-bar, #sb-feed-overlay')) return;
            if (box.querySelector('video, #main_video_player, a[href*="/video/"], a[href*="/playlist/"], nav, header, form')) return;

            const cls = String(box.className || '');
            const id = String(box.id || '');
            if (/(?:^|[\s_-])(?:ad|ads|banner|sponsor|promo|livecam|cams|popunder)(?:$|[\s_-])/i.test(`${cls} ${id}`)) {
                const rect = box.getBoundingClientRect();
                if (rect.height > 0 && rect.height < 600) {
                    box.classList.add('sb-ad-hidden');
                    return;
                }
            }

            const links = Array.from(box.querySelectorAll('a[href]'));
            if (links.length > 0 && links.length <= 4 && links.every((a) => isExternalAdUrl(a.href))) {
                if (box.querySelector('img, iframe') && box.textContent.trim().length < 120) {
                    box.classList.add('sb-ad-hidden');
                }
            }
        });

        // 清理播放器內廣告遮罩與前貼片廣告
        const player = document.querySelector('#main_video_player, .video-js');
        if (player) {
            player.querySelectorAll('iframe, ins, [class*="pause-ad"], [id*="pause-ad"], a[href]').forEach((el) => {
                if (el.id?.startsWith('sb-')) return;
                if (el.tagName === 'A' && !isExternalAdUrl(el.href)) return;
                el.remove();
            });

            const inAdMode = Boolean(
                player.classList.contains('vjs-ad-playing') ||
                player.classList.contains('vjs-ad-loading') ||
                player.querySelector('.ima-ad-container, [class*="vast" i]')
            );
            if (inAdMode) {
                player.querySelectorAll('.ima-ad-container video, [class*="vast" i] video').forEach((v) => {
                    v.muted = true;
                    if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.15) {
                        v.currentTime = v.duration;
                    }
                });
                const skipSel = '.vast-skip-button, .videoAdUiSkipButton, [class*="skip-ad" i], [class*="ad-skip" i], .ima-ad-container [class*="skip" i]';
                player.querySelectorAll(skipSel).forEach((btn) => {
                    if (btn.closest('.vjs-control-bar, .vjs-menu')) return;
                    const rect = btn.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && typeof btn.click === 'function') {
                        btn.click();
                    }
                });
            }
        }
    }

    // ==================== 3. 影片卡片解析與分類（Gold / Exclusive / AI / 橫豎屏 / 片長） ====================
    function extractVideoId(href) {
        if (!href) return '';
        try {
            const u = new URL(href, location.origin);
            const m = u.pathname.match(/^\/([a-z0-9]+)(?:-[^/]+)?\/(?:video|playlist)\//i);
            return m ? m[1] : u.pathname;
        } catch {
            return '';
        }
    }

    function parseDurationToSeconds(text) {
        const s = String(text || '').trim().toLowerCase();
        if (!s) return -1;

        // hh:mm:ss 或 mm:ss
        const colon = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (colon) {
            if (colon[3] !== undefined) {
                return Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
            }
            return Number(colon[1]) * 60 + Number(colon[2]);
        }

        // 1h 20m / 12m / 12 min / 45s
        let total = 0;
        let matched = false;
        const hM = s.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/);
        const mM = s.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/);
        const sM = s.match(/(\d+)\s*(?:s|sec|secs|second|seconds)\b/);
        if (hM) { total += Number(hM[1]) * 3600; matched = true; }
        if (mM) { total += Number(mM[1]) * 60; matched = true; }
        if (sM) { total += Number(sM[1]); matched = true; }
        return matched ? total : -1;
    }

    function findVideoCards(root = document) {
        const found = new Set();

        root.querySelectorAll('div.js-video-item, div.video-item:not(.clear-fix), [data-testid="video-item"]').forEach((el) => {
            if (el.closest('#sb-float-panel, #sb-picker-bar, #sb-feed-overlay')) return;
            if (el.querySelector('a[href*="/video/"], a[href*="/playlist/"]')) {
                found.add(el);
            }
        });

        // 備援：偵測未套用舊版 class 的新版卡片
        if (found.size === 0) {
            root.querySelectorAll('a[href*="/video/"]').forEach((a) => {
                if (a.closest('#sb-float-panel, #sb-picker-bar, #sb-feed-overlay')) return;
                if (!a.querySelector('img')) return;
                const card = a.closest('article, li, [class*="video-item"], [class*="group"]') || a.parentElement?.parentElement || a.parentElement;
                if (card && card !== document.body && !card.querySelector('main, nav, header')) {
                    found.add(card);
                }
            });
        }

        return Array.from(found);
    }

    function detectSpecialTags(card, title) {
        let isGold = false;
        let isExclusive = false;
        let isAI = false;

        const cardAttrText = [
            card.className,
            card.getAttribute('data-type'),
            card.getAttribute('data-label'),
            card.getAttribute('data-badges'),
            card.getAttribute('data-gold'),
            card.getAttribute('data-exclusive'),
            card.getAttribute('data-ai')
        ].filter(Boolean).join(' ');

        if (/\b(?:spankbang[\s_-]?gold|sb[\s_-]?gold|gold|premium|paid)\b/i.test(cardAttrText) || card.dataset.gold === 'true') {
            isGold = true;
        }
        if (/\bexclusive\b/i.test(cardAttrText) || card.dataset.exclusive === 'true') {
            isExclusive = true;
        }
        if (/\b(?:ai[\s_-]?(?:video|tag|generated|porn|badge)|is[\s_-]?ai)\b/i.test(cardAttrText) || card.dataset.ai === 'true') {
            isAI = true;
        }

        // 檢查卡片內部的連結、徽章、標籤與圖示
        card.querySelectorAll('span, div, a, p, svg, img, i, em, strong').forEach((el) => {
            if (el.closest('.sb-tag-badges')) return;

            const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
            if (href) {
                if (/\/gold\b|[?&]gold=/i.test(href)) isGold = true;
                if (/\/exclusive\b|[?&]exclusive=/i.test(href)) isExclusive = true;
                if (/\/(?:s|tag|tags|category)\/ai(?:[\s/_-]|$)|[?&]ai=/i.test(href)) isAI = true;
            }

            const metaStr = [
                typeof el.className === 'string' ? el.className : (el.className?.baseVal || ''),
                el.getAttribute('title'),
                el.getAttribute('alt'),
                el.getAttribute('aria-label'),
                el.getAttribute('data-testid'),
                el.getAttribute('data-badge')
            ].filter(Boolean).join(' ');

            if (/\b(?:sb-?gold|spankbang-?gold|badge-?gold|ic-?gold|icon-?gold|gold-?badge)\b/i.test(metaStr)) isGold = true;
            if (/\b(?:sb-?exclusive|exclusive-?badge|badge-?exclusive|ic-?exclusive)\b/i.test(metaStr)) isExclusive = true;
            if (/\b(?:ai-?badge|badge-?ai|tag-?ai|ai-?generated|ic-?ai)\b/i.test(metaStr)) isAI = true;

            // 只對葉節點或短文字徽章檢查文字，避免整張卡片大段文字誤判
            if (el.children.length === 0 || el.tagName === 'SPAN' || el.tagName === 'A') {
                const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (txt && txt.length <= 28) {
                    if (/^(?:spankbang\s*)?gold$/i.test(txt)) isGold = true;
                    if (/^(?:spankbang\s*)?exclusive$/i.test(txt)) isExclusive = true;
                    if (/^(?:ai|ai\s*(?:generated|video|porn|girl|hentai|model|art|babes)|#ai|deepfake)$/i.test(txt)) isAI = true;
                }
            }
        });

        // 標題明確包含 AI / SpankBang Gold / Exclusive 字樣
        if (title) {
            if (/\bspankbang\s+gold\b/i.test(title)) isGold = true;
            if (/\bspankbang\s+exclusive\b/i.test(title)) isExclusive = true;
            if (
                /(?:^|[\s\[\(\-#【（/])AI(?:$|[\s\]\)\-】）/])/.test(title) ||
                /\b(?:ai[\s-]*(?:generated|porn|video|hentai|girl|babes|model|nsfw|upscale)|deepfake)\b/i.test(title)
            ) {
                isAI = true;
            }
        }

        return { isGold, isExclusive, isAI, isNormal: !isGold && !isExclusive && !isAI };
    }

    function detectCardOrientation(card, img, id, title) {
        // 1. 優先採用真實影片播放過後的精準解析度快取
        if (id && orientCache[id]?.o) {
            return { orientation: orientCache[id].o, verified: true };
        }

        // 2. 明確的直式／豎屏標籤或容器 class
        const hintStr = [
            card.className,
            img?.className,
            card.getAttribute('data-orientation'),
            title
        ].filter(Boolean).join(' ');

        if (/\b(?:vertical|portrait|shorts|9:16)\b/i.test(hintStr) || /豎屏|竖屏|直式/.test(hintStr)) {
            return { orientation: 'portrait', verified: true };
        }

        // 3. 檢查卡片內的預覽 <video> 解析度
        const previewVid = card.querySelector('video');
        if (previewVid && previewVid.videoWidth > 0 && previewVid.videoHeight > 0) {
            const o = previewVid.videoHeight > previewVid.videoWidth * 1.03 ? 'portrait' : 'landscape';
            saveOrientCache(id, o, previewVid.videoWidth, previewVid.videoHeight);
            return { orientation: o, verified: true };
        }

        // 4. 檢查縮圖實際長寬比
        if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
            if (img.naturalHeight > img.naturalWidth * 1.05) {
                return { orientation: 'portrait', verified: false };
            }
            if (img.naturalWidth > img.naturalHeight * 1.05) {
                return { orientation: 'landscape', verified: false };
            }
        }

        return { orientation: 'unknown', verified: false };
    }

    function parseCardMeta(card) {
        const linkEl = card.querySelector('a[href*="/video/"], a[href*="/playlist/"]');
        if (!linkEl) return null;
        const href = linkEl.href;
        if (!href || isExternalAdUrl(href)) return null;

        const id = extractVideoId(href);
        const img = card.querySelector('img');
        const poster = img ? (img.getAttribute('data-src') || img.dataset.src || img.getAttribute('src') || '') : '';

        // 提取標題
        let title = '';
        const titleCandidates = [
            card.querySelector('a.n'),
            card.querySelector('[data-testid="video-title"]'),
            card.querySelector('.title'),
            card.querySelector('p a[href*="/video/"]'),
            ...Array.from(card.querySelectorAll('a[href*="/video/"]'))
        ].filter(Boolean);

        for (const el of titleCandidates) {
            const attrT = (el.getAttribute('title') || '').trim();
            if (attrT && attrT.length > 1) {
                title = attrT;
                break;
            }
            const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (txt && txt.length > 2 && parseDurationToSeconds(txt) < 0 && !/^(?:hd|4k|1080p|720p|gold|exclusive|ai)$/i.test(txt)) {
                title = txt;
                break;
            }
        }
        if (!title && img) {
            title = (img.getAttribute('alt') || img.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        }
        if (!title) title = 'SpankBang Video';

        // 提取片長
        let durationText = '';
        let durationSec = -1;
        const durEl = card.querySelector('span.video-badge.l, .l, [data-testid="video-duration"], [class*="duration"]');
        if (durEl) {
            const t = (durEl.textContent || '').replace(/\s+/g, ' ').trim();
            const sec = parseDurationToSeconds(t);
            if (sec >= 0) {
                durationText = t;
                durationSec = sec;
            }
        }
        if (durationSec < 0) {
            for (const el of card.querySelectorAll('span, div')) {
                if (el.children.length > 0 || el.closest('.sb-tag-badges')) continue;
                const t = (el.textContent || '').trim();
                if (t.length >= 2 && t.length <= 12) {
                    const sec = parseDurationToSeconds(t);
                    if (sec >= 0) {
                        durationText = t;
                        durationSec = sec;
                        break;
                    }
                }
            }
        }

        const tags = detectSpecialTags(card, title);
        const orientInfo = detectCardOrientation(card, img, id, title);

        return {
            id,
            url: href,
            title,
            poster,
            durationText,
            durationSec,
            isGold: tags.isGold,
            isExclusive: tags.isExclusive,
            isAI: tags.isAI,
            isNormal: tags.isNormal,
            orientation: orientInfo.orientation,
            orientationVerified: orientInfo.verified
        };
    }

    function matchesFilters(meta, strictOrientation = true) {
        if (!meta) return true;

        // 1. 最低片長過濾
        if (cfg.minMinutes > 0 && meta.durationSec >= 0 && meta.durationSec < cfg.minMinutes * 60) {
            return false;
        }

        // 2. Gold / Exclusive / AI / 一般影片 分類顯示規則
        if (meta.isNormal) {
            if (!cfg.showNormal) return false;
        } else {
            // 若一部影片同時帶多個特殊標籤，只要其中任一被勾選顯示就顯示；全不勾就隱藏
            const allowedSpecial =
                (meta.isGold && cfg.showGold) ||
                (meta.isExclusive && cfg.showExclusive) ||
                (meta.isAI && cfg.showAI);
            if (!allowedSpecial) return false;
        }

        // 3. 橫屏 / 豎屏 / 全部一起
        if (cfg.orientation !== 'all') {
            if (meta.orientation !== 'unknown') {
                if (meta.orientation !== cfg.orientation) return false;
            } else if (strictOrientation) {
                // 尚未得知方向時保留顯示，待圖片/影片載入後再自動歸類
                return true;
            }
        }

        return true;
    }

    function renderCardBadges(card, meta) {
        const thumbWrap = card.querySelector('a.thumb, a[href*="/video/"]:has(img), picture') || card.querySelector('img')?.parentElement;
        if (!thumbWrap) return;

        if (getComputedStyle(thumbWrap).position === 'static') {
            thumbWrap.style.position = 'relative';
        }

        let box = thumbWrap.querySelector(':scope > .sb-tag-badges');
        const chips = [];
        if (meta.isGold) chips.push({ cls: 'gold', txt: '👑 Gold' });
        if (meta.isExclusive) chips.push({ cls: 'exclusive', txt: '💎 Exclusive' });
        if (meta.isAI) chips.push({ cls: 'ai', txt: '🤖 AI' });
        if (meta.orientation === 'portrait') chips.push({ cls: 'orient', txt: '📱 豎屏' });
        else if (meta.orientation === 'landscape' && meta.orientationVerified) chips.push({ cls: 'orient', txt: '📺 橫屏' });

        if (chips.length === 0) {
            if (box) box.remove();
            return;
        }

        if (!box) {
            box = document.createElement('div');
            box.className = 'sb-tag-badges';
            thumbWrap.appendChild(box);
        }

        const sig = chips.map((c) => c.txt).join('|');
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.innerHTML = '';
        chips.forEach((c) => {
            const sp = document.createElement('span');
            sp.className = `sb-tag-chip ${c.cls}`;
            sp.textContent = c.txt;
            box.appendChild(sp);
        });
    }

    function processVideoCards() {
        const cards = findVideoCards(document);
        const counts = { total: 0, shown: 0, hidden: 0, normal: 0, gold: 0, exclusive: 0, ai: 0 };

        cards.forEach((card) => {
            const meta = parseCardMeta(card);
            if (!meta) return;

            counts.total++;
            if (meta.isNormal) counts.normal++;
            if (meta.isGold) counts.gold++;
            if (meta.isExclusive) counts.exclusive++;
            if (meta.isAI) counts.ai++;

            card.dataset.sbId = meta.id;
            card.dataset.sbUrl = meta.url;
            card.dataset.sbTitle = meta.title;
            card.dataset.sbPoster = meta.poster;
            card.dataset.sbDurSec = String(meta.durationSec);
            card.dataset.sbDurTxt = meta.durationText;
            card.dataset.sbGold = meta.isGold ? '1' : '0';
            card.dataset.sbExclusive = meta.isExclusive ? '1' : '0';
            card.dataset.sbAi = meta.isAI ? '1' : '0';
            card.dataset.sbOrient = meta.orientation;

            // 圖片尚未載入完成時掛載一次監聽，載入後立即依實際比例更新橫豎屏過濾
            const img = card.querySelector('img');
            if (img && !img.complete && img.dataset.sbOrientBound !== '1') {
                img.dataset.sbOrientBound = '1';
                img.addEventListener('load', () => {
                    const updated = parseCardMeta(card);
                    if (updated) {
                        card.classList.toggle('sb-filtered-out', !matchesFilters(updated, true));
                        renderCardBadges(card, updated);
                        updatePanelCounts();
                    }
                }, { once: true });
            }

            // 預覽影片載入後同步記錄精準長寬比
            const previewVid = card.querySelector('video');
            if (previewVid && previewVid.dataset.sbOrientBound !== '1') {
                previewVid.dataset.sbOrientBound = '1';
                previewVid.addEventListener('loadedmetadata', () => {
                    if (previewVid.videoWidth > 0 && previewVid.videoHeight > 0) {
                        const o = previewVid.videoHeight > previewVid.videoWidth * 1.03 ? 'portrait' : 'landscape';
                        saveOrientCache(meta.id, o, previewVid.videoWidth, previewVid.videoHeight);
                        processVideoCards();
                    }
                });
            }

            const visible = matchesFilters(meta, true);
            card.classList.toggle('sb-filtered-out', !visible);
            if (visible) {
                counts.shown++;
                renderCardBadges(card, meta);
            } else {
                counts.hidden++;
            }
        });

        updatePanelCounts(counts);
    }

    function updatePanelCounts(counts) {
        const panel = document.getElementById('sb-float-panel');
        if (!panel) return;
        if (!counts) {
            const cards = findVideoCards(document);
            counts = { total: 0, shown: 0, hidden: 0, normal: 0, gold: 0, exclusive: 0, ai: 0 };
            cards.forEach((c) => {
                if (!c.dataset.sbUrl) return;
                counts.total++;
                if (c.classList.contains('sb-filtered-out')) counts.hidden++;
                else counts.shown++;
                const isG = c.dataset.sbGold === '1';
                const isE = c.dataset.sbExclusive === '1';
                const isA = c.dataset.sbAi === '1';
                if (!isG && !isE && !isA) counts.normal++;
                if (isG) counts.gold++;
                if (isE) counts.exclusive++;
                if (isA) counts.ai++;
            });
        }

        const setTxt = (id, text) => {
            const el = panel.querySelector(id);
            if (el) el.textContent = text;
        };
        setTxt('#sb-tag-normal', `🎞️ 一般 (${counts.normal})`);
        setTxt('#sb-tag-gold', `👑 Gold (${counts.gold})`);
        setTxt('#sb-tag-exclusive', `💎 Exclusive (${counts.exclusive})`);
        setTxt('#sb-tag-ai', `🤖 AI (${counts.ai})`);
        setTxt('#sb-stats-line', `本頁顯示 ${counts.shown} / ${counts.total} 部（已過濾 ${counts.hidden} 部）`);
    }

    // ==================== 4. SpankBang 串流解析與下一頁抓取 ====================
    function formatSec(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    function getCookie(name) {
        const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
        return m ? decodeURIComponent(m[1]) : '';
    }

    function pickBestStreamFromObj(obj) {
        if (!obj || typeof obj !== 'object') return '';
        const priority = ['720p', '1080p', '480p', 'm3u8_720p', 'm3u8_1080p', 'm3u8', 'm3u8_480p', '320p', '240p', '4k', 'main'];
        for (const k of priority) {
            const val = obj[k];
            const url = Array.isArray(val) ? val[0] : val;
            if (typeof url === 'string' && /^https?:\/\//i.test(url) && !AD_DOMAIN_RE.test(url)) {
                return url.replace(/\\\//g, '/');
            }
        }
        return '';
    }

    function parseStreamDataFromHtml(html) {
        const blockMatch = html.match(/stream_data\s*=\s*(\{[\s\S]*?\});/);
        if (blockMatch && blockMatch[1]) {
            const block = blockMatch[1];
            const keys = ['720p', '1080p', '480p', 'm3u8_720p', 'm3u8_1080p', 'm3u8', 'm3u8_480p', '320p', '240p', '4k', 'main'];
            const extracted = {};
            for (const k of keys) {
                const re = new RegExp(`['"]${k}['"]\\s*:\\s*(?:\\[\\s*)?['"](https?:[^'"]+)['"]`, 'i');
                const m = block.match(re);
                if (m && m[1]) extracted[k] = m[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
            }
            const best = pickBestStreamFromObj(extracted);
            if (best) return best;
        }
        return '';
    }

    async function resolveSpankBangStream(item) {
        const cacheKey = item.id || item.url;
        if (streamCache.has(cacheKey)) {
            return streamCache.get(cacheKey);
        }

        // 若目標正是目前開啟的播放頁，優先讀取頁內現有 stream_data 與播放器 src
        try {
            const curU = new URL(location.href);
            const itemU = new URL(item.url, location.origin);
            if (curU.pathname === itemU.pathname) {
                const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                const liveBest = pickBestStreamFromObj(pageWin?.stream_data || window.stream_data);
                if (liveBest) {
                    streamCache.set(cacheKey, liveBest);
                    return liveBest;
                }
                const liveVid = document.querySelector('#main_video_player_html5_api, #main_video_player video, video');
                const liveSrc = liveVid?.currentSrc || liveVid?.src || '';
                if (liveSrc && !liveSrc.startsWith('blob:') && !AD_DOMAIN_RE.test(liveSrc)) {
                    streamCache.set(cacheKey, liveSrc);
                    return liveSrc;
                }
            }
        } catch {}

        try {
            const res = await fetch(item.url, { credentials: 'include' });
            if (!res.ok) return '';
            const html = await res.text();

            // 1. 解析頁內 stream_data
            const fromStreamData = parseStreamDataFromHtml(html);
            if (fromStreamData) {
                streamCache.set(cacheKey, fromStreamData);
                return fromStreamData;
            }

            // 2. 備援：呼叫 /api/videos/stream
            const keyMatch =
                html.match(/data-streamkey\s*=\s*["']([^"']+)["']/i) ||
                html.match(/stream_key\s*[:=]\s*["']([^"']+)["']/i);
            if (keyMatch && keyMatch[1]) {
                const csrf = getCookie('sb_csrf_token') || getCookie('csrftoken');
                const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' };
                if (csrf) headers['X-CSRFToken'] = csrf;
                const body = new URLSearchParams({ id: keyMatch[1], data: '0' });
                if (csrf) body.set('sb_csrf_session', csrf);

                try {
                    const apiRes = await fetch(`${location.origin}/api/videos/stream`, {
                        method: 'POST',
                        headers,
                        body: body.toString(),
                        credentials: 'include'
                    });
                    if (apiRes.ok) {
                        const json = await apiRes.json();
                        const best = pickBestStreamFromObj(json);
                        if (best) {
                            streamCache.set(cacheKey, best);
                            return best;
                        }
                    }
                } catch {}
            }

            // 3. 備援：直接找 HTML 內的 <source> 或 mp4/m3u8 網址（排除縮圖預覽）
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const srcEl = doc.querySelector('#main_video_player source[src], video source[src], video[src]');
            const rawDomSrc = srcEl?.getAttribute('src') || '';
            if (rawDomSrc && !rawDomSrc.startsWith('blob:') && !AD_DOMAIN_RE.test(rawDomSrc)) {
                const abs = new URL(rawDomSrc, item.url).href;
                streamCache.set(cacheKey, abs);
                return abs;
            }

            const directMatches = html.match(/https?:\/\/[^"'\\\s<>]+\.(?:mp4|m3u8)(?:\?[^"'\\\s<>]*)?/gi) || [];
            const validDirect = directMatches.find((u) => !AD_DOMAIN_RE.test(u) && !/\/t\.|thumb|preview|sprite/i.test(u));
            if (validDirect) {
                const clean = validDirect.replace(/&amp;/g, '&');
                streamCache.set(cacheKey, clean);
                return clean;
            }
        } catch {}

        return '';
    }

    function ensureHlsLibrary() {
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (window.Hls || pageWin?.Hls) return Promise.resolve(window.Hls || pageWin.Hls);

        return new Promise((resolve) => {
            const existing = document.getElementById('sb-hls-lib');
            if (existing) {
                existing.addEventListener('load', () => resolve(window.Hls || pageWin?.Hls || null), { once: true });
                return;
            }
            const sc = document.createElement('script');
            sc.id = 'sb-hls-lib';
            sc.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
            sc.onload = () => resolve(window.Hls || pageWin?.Hls || null);
            sc.onerror = () => resolve(null);
            (document.head || document.documentElement).appendChild(sc);
        });
    }

    async function attachStreamToVideo(videoEl, streamUrl, slideIdx, onReadyPlay) {
        if (!videoEl || !streamUrl) return 'none';
        videoEl.controls = false;
        videoEl.removeAttribute('controls');

        if (hlsInstances.has(slideIdx)) {
            try { hlsInstances.get(slideIdx).destroy(); } catch {}
            hlsInstances.delete(slideIdx);
        }

        const isHls = /\.m3u8(?:\?|$)/i.test(streamUrl);
        if (isHls && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            const HlsLib = await ensureHlsLibrary();
            if (HlsLib && HlsLib.isSupported()) {
                const hls = new HlsLib({ enableWorker: true });
                hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
                    if (feedOpen && slideIdx === feedIndex && typeof onReadyPlay === 'function') {
                        onReadyPlay(videoEl);
                    }
                });
                hls.on(HlsLib.Events.ERROR, (_evt, data) => {
                    if (data?.fatal && feedOpen && slideIdx === feedIndex) {
                        const st = videoEl.closest('.sb-feed-slide')?.querySelector('.sb-feed-status');
                        if (st) {
                            st.textContent = '⚠️ 串流載入失敗，請上滑看下一部';
                            st.style.display = 'block';
                        }
                    }
                });
                hls.loadSource(streamUrl);
                hls.attachMedia(videoEl);
                hlsInstances.set(slideIdx, hls);
                return 'hls';
            }
        }

        videoEl.src = streamUrl;
        videoEl.load();
        return 'native';
    }

    function findNextPageUrl(doc, baseUrl) {
        const selectors = [
            '.pagination li.next a[href]',
            'a[rel="next"][href]',
            'a[aria-label="Next"][href]',
            '.paginate-bar a.next[href]',
            '.pagination a.next[href]'
        ];
        for (const sel of selectors) {
            const a = doc.querySelector(sel);
            const href = a?.getAttribute('href') || '';
            if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                try { return new URL(href, baseUrl).href; } catch {}
            }
        }
        // 文字比對 Next / › / »
        for (const a of doc.querySelectorAll('.pagination a[href], nav a[href]')) {
            const txt = (a.textContent || '').trim();
            if (/^(?:next|下一[頁页]|›|»|>>)$/i.test(txt)) {
                const href = a.getAttribute('href') || '';
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                    try { return new URL(href, baseUrl).href; } catch {}
                }
            }
        }
        return '';
    }

    function collectItemsFromDoc(doc, allowRelaxedOrientation = false) {
        const cards = findVideoCards(doc);
        const list = [];
        const seen = new Set();

        cards.forEach((card) => {
            if (doc === document && card.classList.contains('sb-user-hidden')) return;
            const meta = parseCardMeta(card);
            if (!meta || !meta.url) return;
            const key = meta.id || meta.url;
            if (seen.has(key)) return;

            if (!matchesFilters(meta, !allowRelaxedOrientation)) {
                // 若允許放寬縮圖方向（供抖音模式靠真實影片解析度判別），仍嚴格套用時長與特殊標籤規則
                if (!allowRelaxedOrientation) return;
                const savedOrient = cfg.orientation;
                cfg.orientation = 'all';
                const passNonOrient = matchesFilters(meta, false);
                cfg.orientation = savedOrient;
                if (!passNonOrient) return;
                // 若已透過真實影片確認方向不符，直接排除
                if (meta.orientationVerified && meta.orientation !== cfg.orientation) return;
            }

            seen.add(key);
            list.push(meta);
        });

        return list;
    }

    // ==================== 5. 抖音模式 ====================
    function orientLabel(mode) {
        if (mode === 'landscape') return '📺 橫屏';
        if (mode === 'portrait') return '📱 豎屏';
        return '📐 全部';
    }

    function updateFeedClockText() {
        const el = document.getElementById('sb-feed-clock');
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
        processVideoCards();

        let items = [];
        const seen = new Set();

        // 若目前正在單支影片播放頁，將本頁影片放第一順位
        if (/\/video\//.test(location.pathname)) {
            const curId = extractVideoId(location.href);
            const h1 = document.querySelector('h1.main_content_title, h1');
            const curTitle = (h1?.textContent || document.title || 'SpankBang Video').replace(/\s+/g, ' ').trim();
            const curVid = document.querySelector('#main_video_player_html5_api, #main_video_player video, video');
            let curOrient = 'unknown';
            let curVerified = false;
            if (curVid && curVid.videoWidth > 0 && curVid.videoHeight > 0) {
                curOrient = curVid.videoHeight > curVid.videoWidth * 1.03 ? 'portrait' : 'landscape';
                curVerified = true;
                saveOrientCache(curId, curOrient, curVid.videoWidth, curVid.videoHeight);
            }
            seen.add(curId || location.href);
            items.push({
                id: curId,
                url: location.href,
                title: curTitle,
                poster: curVid?.poster || '',
                durationText: curVid && Number.isFinite(curVid.duration) ? formatSec(curVid.duration) : '',
                durationSec: curVid && Number.isFinite(curVid.duration) ? Math.floor(curVid.duration) : -1,
                isGold: false,
                isExclusive: false,
                isAI: false,
                isNormal: true,
                orientation: curOrient,
                orientationVerified: curVerified
            });
        }

        let pageItems = collectItemsFromDoc(document, false);
        let relaxedHint = false;
        // 若選了豎屏但縮圖全為 16:9 導致列表為 0，放寬進入抖音並依真實影片寬高自動過濾
        if (pageItems.length === 0 && cfg.orientation !== 'all') {
            pageItems = collectItemsFromDoc(document, true);
            if (pageItems.length > 0) relaxedHint = true;
        }

        pageItems.forEach((it) => {
            const key = it.id || it.url;
            if (!seen.has(key)) {
                seen.add(key);
                items.push(it);
            }
        });

        if (items.length === 0) {
            showToast('⚠️ 目前篩選條件下沒有可播放的影片，請放寬標籤或片長篩選');
            return;
        }

        document.querySelectorAll('video').forEach((v) => {
            try { v.pause(); } catch {}
        });

        feedOpen = true;
        feedItems = items;
        feedIndex = Math.max(0, Math.min(startIdx, feedItems.length - 1));
        feedVisitedPages = new Set([location.href]);
        feedNextPageUrl = findNextPageUrl(document, location.href);
        feedLoadingNext = false;
        consecutiveAutoSkips = 0;

        document.documentElement.dataset.sbFeedActive = 'true';
        document.documentElement.style.overflow = 'hidden';

        if (relaxedHint) {
            showToast(`📱 縮圖多為固定比例，抖音模式將依實際影片解析度自動篩選${orientLabel(cfg.orientation)}`, 3200);
        }

        const overlay = document.createElement('div');
        overlay.id = 'sb-feed-overlay';
        overlay.innerHTML = `
            <div id="sb-feed-topbar">
                <div class="sb-feed-top-group">
                    <button type="button" id="sb-feed-close" class="sb-fbtn">✕ 退出</button>
                    <span id="sb-feed-counter" class="sb-fbtn">1 / ${feedItems.length}</span>
                </div>
                <div class="sb-feed-top-group">
                    <button type="button" id="sb-feed-orient" class="sb-fbtn ${cfg.orientation !== 'all' ? 'highlight' : ''}" title="切換 全部 / 橫屏 / 豎屏">${orientLabel(cfg.orientation)}</button>
                    <button type="button" id="sb-feed-drawer-btn" class="sb-fbtn">☰ 選集</button>
                    <button type="button" id="sb-feed-clock" class="sb-fbtn" title="點擊切換顯示秒數">00:00</button>
                </div>
            </div>
            <div id="sb-feed-track" class="sb-feed-track"></div>
            <div id="sb-feed-bottom-dock">
                <div id="sb-feed-meta"></div>
                <div id="sb-feed-title"></div>
                <div class="sb-feed-scrub-row">
                    <input type="range" id="sb-feed-range" min="0" max="1000" value="0" />
                    <span id="sb-feed-time">00:00 / 00:00</span>
                </div>
                <div class="sb-feed-ctrl-row">
                    <div class="sb-feed-ctrl-group">
                        <button type="button" class="sb-fcbtn" data-fseek="-10">⏪ -10s</button>
                        <button type="button" class="sb-fcbtn accent" id="sb-fc-play">⏯ 播放</button>
                        <button type="button" class="sb-fcbtn" data-fseek="10">+10s ⏩</button>
                    </div>
                    <div class="sb-feed-ctrl-group">
                        <button type="button" class="sb-fcbtn" id="sb-fc-speed">${cfg.playbackRate}x</button>
                        <button type="button" class="sb-fcbtn" id="sb-fc-mute">${cfg.feedMuted ? '🔇 靜音' : '🔊 有聲'}</button>
                        <a id="sb-fc-open" class="sb-fcbtn" href="#" target="_blank" rel="noopener">🔗 原頁</a>
                        <button type="button" class="sb-fcbtn" id="sb-fc-fs">⛶ 全螢幕</button>
                    </div>
                </div>
            </div>
            <div id="sb-feed-hud"></div>
            <div id="sb-feed-drawer">
                <div class="sb-drawer-head">
                    <span id="sb-drawer-title">播放選集 (${feedItems.length})</span>
                    <button type="button" id="sb-drawer-close" class="sb-fbtn">✕ 關閉</button>
                </div>
                <div id="sb-drawer-grid" class="sb-drawer-grid"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        const track = overlay.querySelector('#sb-feed-track');
        const hud = overlay.querySelector('#sb-feed-hud');
        const counterEl = overlay.querySelector('#sb-feed-counter');
        const orientBtn = overlay.querySelector('#sb-feed-orient');
        const metaEl = overlay.querySelector('#sb-feed-meta');
        const titleEl = overlay.querySelector('#sb-feed-title');
        const openLinkEl = overlay.querySelector('#sb-fc-open');
        const rangeEl = overlay.querySelector('#sb-feed-range');
        const timeEl = overlay.querySelector('#sb-feed-time');
        const drawerEl = overlay.querySelector('#sb-feed-drawer');
        const drawerGrid = overlay.querySelector('#sb-drawer-grid');

        let scrubbing = false;
        let hudHideTimer = null;

        const getSlides = () => Array.from(track.querySelectorAll(':scope > .sb-feed-slide'));
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

        const tryPlayVideo = (v) => {
            if (!v || !feedOpen) return;
            v.muted = Boolean(cfg.feedMuted);
            v.playbackRate = Number(cfg.playbackRate) || 1.0;
            v.play().catch(() => {
                v.muted = true;
                cfg.feedMuted = true;
                const muteBtn = overlay.querySelector('#sb-fc-mute');
                if (muteBtn) muteBtn.textContent = '🔇 靜音';
                v.play().catch(() => {});
            });
        };

        const syncBottomDockToItem = (item, realWidth = 0, realHeight = 0) => {
            if (!item) return;
            const parts = [];
            if (item.isGold) parts.push('👑 Gold');
            if (item.isExclusive) parts.push('💎 Exclusive');
            if (item.isAI) parts.push('🤖 AI');
            if (realWidth > 0 && realHeight > 0) {
                const isPort = realHeight > realWidth * 1.03;
                parts.push(`${isPort ? '📱 豎屏' : '📺 橫屏'} ${realWidth}×${realHeight}`);
            } else if (item.orientation === 'portrait') {
                parts.push('📱 豎屏');
            } else if (item.orientation === 'landscape') {
                parts.push('📺 橫屏');
            }
            if (item.durationText) parts.push(`⏱ ${item.durationText}`);
            metaEl.textContent = parts.join(' · ');
            titleEl.textContent = item.title || '';
            titleEl.title = item.title || '';
            if (openLinkEl) openLinkEl.href = item.url || '#';
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
            }, 250);
        };

        async function loadMoreFeedItemsFromNextPage() {
            if (!cfg.autoLoadNext || feedLoadingNext || !feedNextPageUrl || feedVisitedPages.has(feedNextPageUrl)) return;
            feedLoadingNext = true;
            const targetUrl = feedNextPageUrl;
            try {
                const res = await fetch(targetUrl, { credentials: 'include' });
                if (!res.ok) return;
                const html = await res.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                feedVisitedPages.add(targetUrl);
                feedNextPageUrl = findNextPageUrl(doc, targetUrl);

                const existingIds = new Set(feedItems.map((it) => it.id || it.url));
                let nextItems = collectItemsFromDoc(doc, false);
                if (nextItems.length === 0 && cfg.orientation !== 'all') {
                    nextItems = collectItemsFromDoc(doc, true);
                }

                let added = 0;
                nextItems.forEach((it) => {
                    const key = it.id || it.url;
                    if (!existingIds.has(key)) {
                        existingIds.add(key);
                        feedItems.push(it);
                        added++;
                    }
                });

                if (added > 0 && feedOpen) {
                    syncSlidesDOM();
                    if (drawerEl.classList.contains('open')) renderDrawer();
                }
            } catch {} finally {
                feedLoadingNext = false;
            }
        }

        const buildSlide = (item, idx) => {
            const slide = document.createElement('div');
            slide.className = 'sb-feed-slide';
            slide.dataset.idx = String(idx);

            slide.innerHTML = `
                ${item.poster ? `<img class="sb-feed-poster" src="${item.poster}" alt="" />` : ''}
                <video class="sb-feed-video" playsinline webkit-playsinline preload="metadata" loop></video>
                <div class="sb-feed-status">⏳ 正在載入影片...</div>
                <div class="sb-feed-center-icon">▶</div>
            `;

            const video = slide.querySelector('video');
            const posterEl = slide.querySelector('.sb-feed-poster');
            const statusEl = slide.querySelector('.sb-feed-status');

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
                        const actualOrient = vh > vw * 1.03 ? 'portrait' : 'landscape';
                        item.orientation = actualOrient;
                        item.orientationVerified = true;
                        saveOrientCache(item.id, actualOrient, vw, vh);

                        if (idx === feedIndex) {
                            syncBottomDockToItem(item, vw, vh);

                            // 若開啟橫屏/豎屏篩選且實際比例不符，自動跳至下一部
                            if (cfg.orientation !== 'all' && actualOrient !== cfg.orientation) {
                                video.pause();
                                if (consecutiveAutoSkips < 12 && feedIndex < feedItems.length - 1) {
                                    consecutiveAutoSkips++;
                                    if (statusEl) {
                                        statusEl.textContent = `↪ 此片為${actualOrient === 'portrait' ? '豎屏' : '橫屏'}，自動跳下一部...`;
                                        statusEl.style.display = 'block';
                                    }
                                    setTimeout(() => {
                                        if (feedOpen && feedIndex === idx) goToSlide(idx + 1, true);
                                    }, 220);
                                    return;
                                } else {
                                    consecutiveAutoSkips = 0;
                                    showFeedHud(`⚠️ 連續多部非${orientLabel(cfg.orientation)}，已暫停自動略過`, 1800);
                                }
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
                        statusEl.textContent = '⚠️ 串流無法播放，請上滑看下一部';
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

        const renderDrawer = () => {
            overlay.querySelector('#sb-drawer-title').textContent = `播放選集 (${feedItems.length})`;
            drawerGrid.innerHTML = '';
            const frag = document.createDocumentFragment();
            feedItems.forEach((item, idx) => {
                const cell = document.createElement('div');
                cell.className = `sb-drawer-item ${idx === feedIndex ? 'active' : ''}`;

                const thumb = document.createElement('div');
                thumb.className = 'sb-drawer-thumb';
                if (item.poster) {
                    const img = document.createElement('img');
                    img.src = item.poster;
                    img.loading = 'lazy';
                    img.alt = '';
                    thumb.appendChild(img);
                }
                const idxSpan = document.createElement('span');
                idxSpan.className = 'sb-drawer-idx';
                idxSpan.textContent = `#${idx + 1}`;
                thumb.appendChild(idxSpan);

                if (item.durationText) {
                    const durSpan = document.createElement('span');
                    durSpan.className = 'sb-drawer-dur';
                    durSpan.textContent = item.durationText;
                    thumb.appendChild(durSpan);
                }

                const caption = document.createElement('div');
                caption.className = 'sb-drawer-caption';
                caption.textContent = item.title || '';

                cell.append(thumb, caption);
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

            hud.classList.remove('show');
            rangeEl.value = '0';
            timeEl.textContent = '00:00 / 00:00';
            syncBottomDockToItem(item);

            getSlides().forEach((sl, i) => {
                const v = sl.querySelector('video');
                if (!v) return;
                v.controls = false;
                v.removeAttribute('controls');
                if (i !== idx) {
                    try { v.pause(); } catch {}
                    if (Math.abs(i - idx) > 2 && (v.src || hlsInstances.has(i))) {
                        if (hlsInstances.has(i)) {
                            try { hlsInstances.get(i).destroy(); } catch {}
                            hlsInstances.delete(i);
                        }
                        v.removeAttribute('src');
                        v.load();
                        const posterEl = sl.querySelector('.sb-feed-poster');
                        if (posterEl) posterEl.style.opacity = '0.45';
                        delete sl.dataset.loaded;
                    }
                }
            });

            const activeSlide = getSlide(idx);
            const video = activeSlide?.querySelector('video');
            const statusEl = activeSlide?.querySelector('.sb-feed-status');
            if (!video) return;

            // 若已知實際方向不符，直接略過
            if (cfg.orientation !== 'all' && item.orientationVerified && item.orientation !== cfg.orientation) {
                if (consecutiveAutoSkips < 12 && idx < feedItems.length - 1) {
                    consecutiveAutoSkips++;
                    setTimeout(() => {
                        if (feedOpen && feedIndex === idx) goToSlide(idx + 1, true);
                    }, 80);
                    return;
                }
            }

            bindProgressSync(video);
            video.muted = Boolean(cfg.feedMuted);
            video.playbackRate = Number(cfg.playbackRate) || 1.0;

            if (activeSlide.dataset.loaded !== '1') {
                if (statusEl) {
                    statusEl.textContent = '⏳ 正在解析影片串流...';
                    statusEl.style.display = 'block';
                }
                const streamUrl = await resolveSpankBangStream(item);
                if (!feedOpen || idx !== feedIndex) return;

                const latestSlide = getSlide(idx);
                const latestVideo = latestSlide?.querySelector('video');
                if (!latestVideo) return;

                if (!streamUrl) {
                    if (statusEl) {
                        statusEl.textContent = '⚠️ 無法解析串流（可能需要登入或為付費影片），請上滑下一部';
                        statusEl.style.display = 'block';
                    }
                    return;
                }

                latestSlide.dataset.loaded = '1';
                latestVideo.muted = Boolean(cfg.feedMuted);
                latestVideo.playbackRate = Number(cfg.playbackRate) || 1.0;
                const mode = await attachStreamToVideo(latestVideo, streamUrl, idx, tryPlayVideo);
                if (!feedOpen || idx !== feedIndex) return;
                if (mode !== 'hls') tryPlayVideo(latestVideo);
            } else {
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                    syncBottomDockToItem(item, video.videoWidth, video.videoHeight);
                }
                tryPlayVideo(video);
            }

            // 預先解析下一部串流
            if (idx + 1 < feedItems.length) {
                resolveSpankBangStream(feedItems[idx + 1]).catch(() => {});
            }

            // 接近清單尾端時自動抓下一頁
            if (idx >= feedItems.length - 3) {
                loadMoreFeedItemsFromNextPage();
            }
        };

        const goToSlide = (targetIdx, isAutoSkip = false) => {
            if (!isAutoSkip) consecutiveAutoSkips = 0;
            syncSlidesDOM();
            feedIndex = Math.max(0, Math.min(targetIdx, feedItems.length - 1));
            track.classList.remove('dragging');
            track.style.transform = `translate3d(0, -${feedIndex * 100}%, 0)`;
            counterEl.textContent = `${feedIndex + 1} / ${feedItems.length}`;
            syncBottomDockToItem(feedItems[feedIndex]);
            activateSlide(feedIndex);
        };
        feedGoToSlide = goToSlide;

        // 進度條拖曳
        rangeEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); scrubbing = true; });
        rangeEl.addEventListener('touchstart', (e) => { e.stopPropagation(); scrubbing = true; }, { passive: true });
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
        rangeEl.addEventListener('change', (e) => { e.stopPropagation(); commitScrub(); });
        rangeEl.addEventListener('pointerup', (e) => { e.stopPropagation(); commitScrub(); });

        // 控制列按鈕
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

        overlay.querySelector('#sb-fc-play').addEventListener('click', (e) => {
            e.stopPropagation();
            const curVideo = getCurrentVideo();
            if (!curVideo) return;
            if (curVideo.paused) curVideo.play().catch(() => {});
            else curVideo.pause();
        });

        overlay.querySelector('#sb-fc-speed').addEventListener('click', (e) => {
            e.stopPropagation();
            const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];
            cfg.playbackRate = speeds[(speeds.indexOf(cfg.playbackRate) + 1) % speeds.length];
            saveCfg();
            e.target.textContent = `${cfg.playbackRate}x`;
            const curVideo = getCurrentVideo();
            if (curVideo) curVideo.playbackRate = cfg.playbackRate;
        });

        overlay.querySelector('#sb-fc-mute').addEventListener('click', (e) => {
            e.stopPropagation();
            cfg.feedMuted = !cfg.feedMuted;
            saveCfg();
            e.target.textContent = cfg.feedMuted ? '🔇 靜音' : '🔊 有聲';
            const curVideo = getCurrentVideo();
            if (curVideo) curVideo.muted = cfg.feedMuted;
        });

        overlay.querySelector('#sb-fc-fs').addEventListener('click', (e) => {
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

        // 抖音模式頂部即時切換 全部 / 橫屏 / 豎屏
        orientBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const order = ['all', 'landscape', 'portrait'];
            cfg.orientation = order[(order.indexOf(cfg.orientation) + 1) % order.length];
            saveCfg();
            orientBtn.textContent = orientLabel(cfg.orientation);
            orientBtn.classList.toggle('highlight', cfg.orientation !== 'all');
            syncPanelUI();
            processVideoCards();
            showFeedHud(`已切換：${orientLabel(cfg.orientation)}`, 1100);

            const curVideo = getCurrentVideo();
            if (cfg.orientation !== 'all' && curVideo && curVideo.videoWidth > 0 && curVideo.videoHeight > 0) {
                const actual = curVideo.videoHeight > curVideo.videoWidth * 1.03 ? 'portrait' : 'landscape';
                if (actual !== cfg.orientation && feedIndex < feedItems.length - 1) {
                    setTimeout(() => goToSlide(feedIndex + 1, true), 350);
                }
            }
        });

        // 觸控滑動手勢（上下切集 / 左右快轉 / 單擊暫停 / 雙擊±10s）
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
                track.style.transform = `translate3d(0, calc(-${feedIndex * 100}% + ${offset}px), 0)`;
            } else if (gestureMode === 'horizontal') {
                const curVideo = getCurrentVideo();
                if (curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0) {
                    const absY = Math.abs(dy);
                    const mult = absY > 90 ? 4 : (absY > 40 ? 2 : 1);
                    const deltaSec = Math.round((dx / Math.max(240, window.innerWidth)) * 90 * mult);
                    const targetSec = Math.max(0, Math.min(curVideo.duration, scrubStartTime + deltaSec));
                    showFeedHud(`${deltaSec >= 0 ? '⏩ +' : '⏪ '}${deltaSec}s (${formatSec(targetSec)}) [${mult}x]`, 0);
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
                if (dy <= -threshold && feedIndex < feedItems.length - 1) goToSlide(feedIndex + 1);
                else if (dy >= threshold && feedIndex > 0) goToSlide(feedIndex - 1);
                else goToSlide(feedIndex);
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
            } else if (Math.hypot(dx, dy) < 10 && !e.target.closest('button, input, a')) {
                const now = Date.now();
                const curSlide = getSlide(feedIndex);
                const curVideo = curSlide?.querySelector('video');
                const iconEl = curSlide?.querySelector('.sb-feed-center-icon');
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

        overlay.querySelector('#sb-feed-close').addEventListener('click', closeFeedMode);
        overlay.querySelector('#sb-feed-clock').addEventListener('click', (e) => {
            e.stopPropagation();
            feedClockShowSeconds = !feedClockShowSeconds;
            updateFeedClockText();
        });
        overlay.querySelector('#sb-feed-drawer-btn').addEventListener('click', () => {
            renderDrawer();
            drawerEl.classList.add('open');
        });
        overlay.querySelector('#sb-drawer-close').addEventListener('click', () => {
            drawerEl.classList.remove('open');
        });

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
        feedGoToSlide = null;
        feedOpen = false;
        delete document.documentElement.dataset.sbFeedActive;
        document.documentElement.style.overflow = '';

        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }

        hlsInstances.forEach((hls) => {
            try { hls.destroy(); } catch {}
        });
        hlsInstances.clear();

        const overlay = document.getElementById('sb-feed-overlay');
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
        processVideoCards();
    }

    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
        if (!feedOpen) return;

        const slides = document.querySelectorAll('#sb-feed-track > .sb-feed-slide');
        const curVideo = slides[feedIndex]?.querySelector('video') || null;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeFeedMode();
        } else if (e.key === 'ArrowDown' && feedIndex < feedItems.length - 1) {
            e.preventDefault();
            if (feedGoToSlide) feedGoToSlide(feedIndex + 1);
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

    // ==================== 6. 點選隱藏元件工具 ====================
    function generateSelector(el) {
        if (!el || el === document.body || el === document.documentElement) return '';
        if (el.id && !/^\d/.test(el.id)) return `#${CSS.escape(el.id)}`;
        const classes = Array.from(el.classList || []).filter((c) => c && !c.startsWith('sb-') && !/active|open|hover/i.test(c));
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

        let hl = document.getElementById('sb-picker-highlight');
        if (!hl) {
            hl = document.createElement('div');
            hl.id = 'sb-picker-highlight';
            document.body.appendChild(hl);
        }

        let bar = document.getElementById('sb-picker-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'sb-picker-bar';
            bar.innerHTML = `
                <div id="sb-picker-drag">
                    <span>⠿ 按住拖曳移動</span>
                    <button type="button" id="sb-pk-flip" class="sb-btn" style="padding:3px 8px;">⇅ 移到底部</button>
                </div>
                <div id="sb-picker-info">點擊網頁上任何想隱藏的廣告或區塊</div>
                <div id="sb-picker-btns">
                    <button type="button" id="sb-pk-ok" class="sb-btn accent" disabled>🙈 隱藏此區塊</button>
                    <button type="button" id="sb-pk-up" class="sb-btn" disabled>⬆️ 擴大一層</button>
                    <button type="button" id="sb-pk-undo" class="sb-btn">↩️ 復原上一筆</button>
                    <button type="button" id="sb-pk-exit" class="sb-btn">✕ 結束</button>
                </div>
            `;
            document.body.appendChild(bar);

            const flipBtn = bar.querySelector('#sb-pk-flip');
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

            bar.querySelector('#sb-pk-up').addEventListener('click', () => {
                if (!pickerLockedEl?.parentElement || pickerLockedEl.parentElement === document.body) return;
                pickerLockedEl = pickerLockedEl.parentElement;
                updateHighlight();
            });

            bar.querySelector('#sb-pk-ok').addEventListener('click', () => {
                if (!pickerLockedEl) return;
                const sel = generateSelector(pickerLockedEl);
                if (sel && !cfg.customHiddenSelectors.includes(sel)) {
                    cfg.customHiddenSelectors.push(sel);
                    saveCfg();
                    applyCustomHiddenRules(true);
                    showToast('✅ 已永久隱藏該區塊');
                }
                pickerLockedEl = null;
                hl.style.display = 'none';
                bar.querySelector('#sb-pk-ok').disabled = true;
                bar.querySelector('#sb-pk-up').disabled = true;
            });

            bar.querySelector('#sb-pk-undo').addEventListener('click', () => {
                if (cfg.customHiddenSelectors.length === 0) return;
                cfg.customHiddenSelectors.pop();
                saveCfg();
                applyCustomHiddenRules(true);
                showToast('↩️ 已復原上一筆隱藏規則');
            });

            bar.querySelector('#sb-pk-exit').addEventListener('click', stopElementPicker);
        }

        function updateHighlight() {
            if (!pickerLockedEl) return;
            const r = pickerLockedEl.getBoundingClientRect();
            hl.style.display = 'block';
            hl.style.left = `${r.left}px`;
            hl.style.top = `${r.top}px`;
            hl.style.width = `${r.width}px`;
            hl.style.height = `${r.height}px`;
            bar.querySelector('#sb-picker-info').textContent = `已選取：${generateSelector(pickerLockedEl)}`;
            bar.querySelector('#sb-pk-ok').disabled = false;
            bar.querySelector('#sb-pk-up').disabled = false;
        }

        window.__sbPickHandler = (e) => {
            if (!pickerActive) return;
            if (e.target.closest('#sb-picker-bar, #sb-float-panel')) return;
            e.preventDefault();
            e.stopPropagation();
            pickerLockedEl = e.target;
            updateHighlight();
        };

        document.addEventListener('click', window.__sbPickHandler, true);
        bar.classList.add('open');
    }

    function stopElementPicker() {
        pickerActive = false;
        if (window.__sbPickHandler) {
            document.removeEventListener('click', window.__sbPickHandler, true);
        }
        const hl = document.getElementById('sb-picker-highlight');
        const bar = document.getElementById('sb-picker-bar');
        if (hl) hl.style.display = 'none';
        if (bar) bar.classList.remove('open');
    }

    // ==================== 7. 右下角懸浮控制面板 ====================
    const DUR_PRESETS = [0, 3, 5, 10, 15, 20, 30];

    function syncPanelUI() {
        const panel = document.getElementById('sb-float-panel');
        if (!panel) return;

        panel.querySelectorAll('[data-orient]').forEach((btn) => {
            btn.classList.toggle('on', btn.dataset.orient === cfg.orientation);
        });

        panel.querySelector('#sb-tag-normal')?.classList.toggle('on', cfg.showNormal);
        panel.querySelector('#sb-tag-gold')?.classList.toggle('on-gold', cfg.showGold);
        panel.querySelector('#sb-tag-exclusive')?.classList.toggle('on-exclusive', cfg.showExclusive);
        panel.querySelector('#sb-tag-ai')?.classList.toggle('on-ai', cfg.showAI);

        panel.querySelectorAll('[data-dur]').forEach((btn) => {
            btn.classList.toggle('on', Number(btn.dataset.dur) === cfg.minMinutes);
        });
        const customDurBtn = panel.querySelector('#sb-dur-custom');
        if (customDurBtn) {
            const isCustom = cfg.minMinutes > 0 && !DUR_PRESETS.includes(cfg.minMinutes);
            customDurBtn.classList.toggle('on', isCustom);
            customDurBtn.textContent = isCustom ? `≥${cfg.minMinutes}分` : '自訂';
        }
        const durTitle = panel.querySelector('#sb-dur-val');
        if (durTitle) {
            durTitle.textContent = cfg.minMinutes > 0 ? `隱藏 < ${cfg.minMinutes} 分鐘` : '目前：不限';
        }

        panel.querySelector('#sb-btn-ads')?.classList.toggle('on', cfg.blockAds);
        panel.querySelector('#sb-btn-autoload')?.classList.toggle('on', cfg.autoLoadNext);
    }

    function createFloatingPanel() {
        if (!document.body || document.getElementById('sb-float-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'sb-float-panel';
        if (cfg.panelCollapsed) panel.classList.add('collapsed');

        panel.innerHTML = `
            <div class="sb-panel-head" id="sb-panel-head">
                <span>⚡ SpankBang 增強</span>
                <div style="display:flex;align-items:center;gap:5px;">
                    <button type="button" id="sb-btn-feed-mini" class="sb-btn accent" style="padding:2px 8px;font-size:11px;">🎬 抖音</button>
                    <button type="button" id="sb-panel-toggle" class="sb-btn" style="padding:2px 8px;font-size:11px;">${cfg.panelCollapsed ? '展開' : '收合'}</button>
                </div>
            </div>
            <div class="sb-panel-body">
                <button type="button" id="sb-btn-feed" class="sb-btn accent" style="width:100%;padding:8px;font-size:13px;">🎬 進入抖音上下滑動模式</button>

                <div class="sb-section">
                    <div class="sb-section-title">
                        <span>📐 畫面方向篩選</span>
                        <span style="color:#9ca3af;font-weight:600;">列表＋抖音同步</span>
                    </div>
                    <div class="sb-seg-3">
                        <button type="button" class="sb-btn" data-orient="all">全部一起</button>
                        <button type="button" class="sb-btn" data-orient="landscape">📺 橫屏</button>
                        <button type="button" class="sb-btn" data-orient="portrait">📱 豎屏</button>
                    </div>
                </div>

                <div class="sb-section">
                    <div class="sb-section-title">
                        <span>🏷️ 特殊標籤分類顯示</span>
                        <span style="color:#9ca3af;font-weight:600;">可複選 / 全不選</span>
                    </div>
                    <div class="sb-grid-2">
                        <button type="button" id="sb-tag-normal" class="sb-btn">🎞️ 一般 (0)</button>
                        <button type="button" id="sb-tag-gold" class="sb-btn">👑 Gold (0)</button>
                        <button type="button" id="sb-tag-exclusive" class="sb-btn">💎 Exclusive (0)</button>
                        <button type="button" id="sb-tag-ai" class="sb-btn">🤖 AI (0)</button>
                    </div>
                    <div class="sb-mini-presets">
                        <button type="button" id="sb-preset-all" class="sb-btn">全部顯示</button>
                        <button type="button" id="sb-preset-no-special" class="sb-btn">隱藏全部特殊</button>
                        <button type="button" id="sb-preset-only-special" class="sb-btn">只看特殊</button>
                    </div>
                </div>

                <div class="sb-section">
                    <div class="sb-section-title">
                        <span>⏱️ 低於幾分鐘不顯示</span>
                        <span id="sb-dur-val" style="color:#fbbf24;font-weight:700;">目前：不限</span>
                    </div>
                    <div class="sb-dur-grid">
                        <button type="button" class="sb-btn" data-dur="0">不限</button>
                        <button type="button" class="sb-btn" data-dur="3">≥3分</button>
                        <button type="button" class="sb-btn" data-dur="5">≥5分</button>
                        <button type="button" class="sb-btn" data-dur="10">≥10分</button>
                        <button type="button" class="sb-btn" data-dur="15">≥15分</button>
                        <button type="button" class="sb-btn" data-dur="20">≥20分</button>
                        <button type="button" class="sb-btn" data-dur="30">≥30分</button>
                        <button type="button" id="sb-dur-custom" class="sb-btn">自訂</button>
                    </div>
                </div>

                <div class="sb-section">
                    <div class="sb-seg-3">
                        <button type="button" id="sb-btn-ads" class="sb-btn">🛡️ 隱藏廣告</button>
                        <button type="button" id="sb-btn-autoload" class="sb-btn">♾️ 抖音翻頁</button>
                        <button type="button" id="sb-btn-pick" class="sb-btn">🎯 點選隱藏</button>
                    </div>
                </div>

                <div id="sb-stats-line" class="sb-stats-line">正在掃描本頁影片...</div>
            </div>
        `;
        document.body.appendChild(panel);

        // 拖曳移動控制面板
        const head = panel.querySelector('#sb-panel-head');
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

        // 抖音模式入口
        panel.querySelector('#sb-btn-feed').addEventListener('click', () => openFeedMode(0));
        panel.querySelector('#sb-btn-feed-mini').addEventListener('click', () => openFeedMode(0));

        // 收合切換
        panel.querySelector('#sb-panel-toggle').addEventListener('click', () => {
            cfg.panelCollapsed = !cfg.panelCollapsed;
            saveCfg();
            panel.classList.toggle('collapsed', cfg.panelCollapsed);
            panel.querySelector('#sb-panel-toggle').textContent = cfg.panelCollapsed ? '展開' : '收合';
        });

        // 橫屏 / 豎屏 / 全部
        panel.querySelectorAll('[data-orient]').forEach((btn) => {
            btn.addEventListener('click', () => {
                cfg.orientation = btn.dataset.orient;
                saveCfg();
                syncPanelUI();
                processVideoCards();
                showToast(`已切換方向：${orientLabel(cfg.orientation)}`);
            });
        });

        // Gold / Exclusive / AI / 一般影片 個別開關
        const bindTagToggle = (id, key, label) => {
            panel.querySelector(id).addEventListener('click', () => {
                cfg[key] = !cfg[key];
                saveCfg();
                syncPanelUI();
                processVideoCards();
                showToast(`${label}：${cfg[key] ? '顯示' : '隱藏'}`);
            });
        };
        bindTagToggle('#sb-tag-normal', 'showNormal', '🎞️ 一般影片');
        bindTagToggle('#sb-tag-gold', 'showGold', '👑 SpankBang Gold');
        bindTagToggle('#sb-tag-exclusive', 'showExclusive', '💎 Exclusive');
        bindTagToggle('#sb-tag-ai', 'showAI', '🤖 AI 標籤');

        // 標籤快捷預設
        panel.querySelector('#sb-preset-all').addEventListener('click', () => {
            cfg.showNormal = true;
            cfg.showGold = true;
            cfg.showExclusive = true;
            cfg.showAI = true;
            saveCfg();
            syncPanelUI();
            processVideoCards();
            showToast('✅ 已顯示所有類型影片');
        });
        panel.querySelector('#sb-preset-no-special').addEventListener('click', () => {
            cfg.showNormal = true;
            cfg.showGold = false;
            cfg.showExclusive = false;
            cfg.showAI = false;
            saveCfg();
            syncPanelUI();
            processVideoCards();
            showToast('🙈 已隱藏全部 Gold / Exclusive / AI 影片');
        });
        panel.querySelector('#sb-preset-only-special').addEventListener('click', () => {
            cfg.showNormal = false;
            cfg.showGold = true;
            cfg.showExclusive = true;
            cfg.showAI = true;
            saveCfg();
            syncPanelUI();
            processVideoCards();
            showToast('✨ 目前僅顯示 Gold / Exclusive / AI 影片');
        });

        // 片長過濾按鈕
        panel.querySelectorAll('[data-dur]').forEach((btn) => {
            btn.addEventListener('click', () => {
                cfg.minMinutes = Number(btn.dataset.dur) || 0;
                saveCfg();
                syncPanelUI();
                processVideoCards();
                showToast(cfg.minMinutes > 0 ? `⏱️ 已隱藏低於 ${cfg.minMinutes} 分鐘的影片` : '⏱️ 已取消片長限制');
            });
        });
        panel.querySelector('#sb-dur-custom').addEventListener('click', () => {
            const raw = prompt('輸入最低片長（分鐘，輸入 0 表示不限制）：', String(cfg.minMinutes || 8));
            if (raw === null) return;
            const num = Math.max(0, Math.round(Number(raw)));
            if (!Number.isFinite(num)) {
                showToast('⚠️ 請輸入有效數字');
                return;
            }
            cfg.minMinutes = num;
            saveCfg();
            syncPanelUI();
            processVideoCards();
            showToast(num > 0 ? `⏱️ 已隱藏低於 ${num} 分鐘的影片` : '⏱️ 已取消片長限制');
        });

        // 廣告 / 自動翻頁 / 點選隱藏
        panel.querySelector('#sb-btn-ads').addEventListener('click', () => {
            cfg.blockAds = !cfg.blockAds;
            saveCfg();
            applyRootFlags();
            syncPanelUI();
            if (cfg.blockAds) cleanAdsOnPage();
            else document.querySelectorAll('.sb-ad-hidden').forEach((el) => el.classList.remove('sb-ad-hidden'));
            showToast(cfg.blockAds ? '🛡️ 已開啟廣告隱藏' : '已暫停廣告隱藏');
        });

        panel.querySelector('#sb-btn-autoload').addEventListener('click', () => {
            cfg.autoLoadNext = !cfg.autoLoadNext;
            saveCfg();
            syncPanelUI();
            showToast(cfg.autoLoadNext ? '♾️ 抖音模式自動翻頁已開啟' : '抖音模式自動翻頁已關閉');
        });

        panel.querySelector('#sb-btn-pick').addEventListener('click', startElementPicker);

        syncPanelUI();
    }

    // ==================== 8. 啟動與動態監聽 ====================
    injectBaseStyles();
    applyRootFlags();
    installAdHooks();

    function boot() {
        if (!document.body) {
            setTimeout(boot, 50);
            return;
        }
        createFloatingPanel();
        cleanAdsOnPage();
        processVideoCards();
        applyCustomHiddenRules();

        setInterval(() => {
            if (!feedOpen && !document.hidden) cleanAdsOnPage();
        }, 2000);

        let timer = null;
        const ignoredSel = '#sb-float-panel, #sb-picker-bar, #sb-feed-overlay, #sb-toast, .sb-tag-badges, .vjs-control-bar';
        const obs = new MutationObserver((mutations) => {
            if (feedOpen) return;
            const relevant = mutations.some((m) => {
                const el = m.target?.nodeType === 1 ? m.target : m.target?.parentElement;
                return el && !el.closest(ignoredSel);
            });
            if (!relevant) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                cleanAdsOnPage();
                processVideoCards();
                applyCustomHiddenRules();
            }, 300);
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
