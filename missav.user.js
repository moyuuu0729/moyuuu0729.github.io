// ==UserScript==
// @name         MissAV 多片單番號比對標註工具
// @namespace    http://tampermonkey.net/
// @version      8.5
// @description  多片單獨立規則、即時監聽站內收藏自動同步、番號前綴統計排行、多版本去重、變動追蹤、隨機抽片、書籤筆記與分類紀錄
// @match        https://missav.ws/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://moyuuu0729.github.io/missav.user.js
// @downloadURL  https://moyuuu0729.github.io/missav.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ================= 預設參數 =================
    const DEFAULT_PLAYLISTS = [
        { id: 'sd238ybx', name: '主片單', color: '#10b981', action: 'normal' }
    ];
    const PRESET_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#06b6d4'];
    const VALID_ACTIONS = ['normal', 'dim', 'hide'];
    const ACTION_LABELS = {
        normal: '👁️ 僅標註',
        dim: '🌫️ 淡化',
        hide: '🙈 隱藏'
    };
    const VALID_BADGE_POS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    const BADGE_POS_LABELS = {
        'top-left': '左上角',
        'top-right': '右上角',
        'bottom-left': '左下角',
        'bottom-right': '右下角'
    };
    const DEDUP_PRESETS = {
        zh_leak_orig: { label: '中文字幕 ＞ 無碼流出 ＞ 原版', order: ['zh', 'leak', 'orig'] },
        leak_zh_orig: { label: '無碼流出 ＞ 中文字幕 ＞ 原版', order: ['leak', 'zh', 'orig'] },
        orig_zh_leak: { label: '原版 ＞ 中文字幕 ＞ 無碼流出', order: ['orig', 'zh', 'leak'] }
    };
    const VERSION_LABELS = {
        zh: '中文字幕',
        leak: '無碼流出',
        orig: '原版'
    };
    const LOG_CATEGORIES = [
        { id: 'all',    label: '全部',        color: '#52525b' },
        { id: 'manual', label: '👆 手動操作', color: '#2563eb' },
        { id: 'auto',   label: '🤖 自動動作', color: '#059669' },
        { id: 'diff',   label: '📊 片單變動', color: '#d97706' },
        { id: 'error',  label: '⚠️ 錯誤異常', color: '#e11d48' }
    ];
    const DEFAULT_UI_PREFS = {
        badgePos: 'top-left',
        dimOpacity: 0.25,
        skipEnabled: true,
        skipAction: 'hide',
        skipConfirm: true,
        bottomSafeOffset: 0,
        dedupEnabled: true,
        dedupPreset: 'zh_leak_orig',
        watchNativePlaylist: true,
        blockPlayerAds: true
    };
    const REQUEST_DELAY_MS = 700;       // 換頁與切換片單間隔(毫秒)，避免觸發 Cloudflare 限流
    const NATIVE_SYNC_DELAY_MS = 2500;  // 偵測到站內收藏動作後的自動同步延遲(毫秒)
    const MAX_PAGES = 100;              // 單一片單最多抓取頁數上限
    const MAX_LOGS = 300;               // 最多保留操作紀錄筆數
    const MAX_DIFF_HISTORY = 120;       // 最多保留片單變動紀錄筆數
    // ============================================

    const CONFIG_KEY = 'missav_playlists_config';
    const STORAGE_KEY_PREFIX = 'missav_playlist_';
    const META_KEY_PREFIX = 'missav_playlist_meta_';
    const URL_MAP_KEY = 'missav_code_url_map';
    const SKIPPED_KEY = 'missav_local_skipped_codes';
    const NOTES_KEY = 'missav_video_notes_map';
    const DIFF_HISTORY_KEY = 'missav_playlist_diff_history';
    const LOGS_KEY = 'missav_activity_logs';
    const RECENT_PICKS_KEY = 'missav_recent_random_picks';
    const MODE_KEY = 'missav_playlist_mode_global';
    const COLLAPSED_KEY = 'missav_panel_collapsed';
    const AUTO_SYNC_KEY = 'missav_auto_sync_settings';
    const LAST_CHECK_KEY = 'missav_last_auto_check_ts';
    const UI_PREFS_KEY = 'missav_ui_prefs';
    const PANEL_POS_KEY = 'missav_panel_pos';

    const MODES = [
        { id: 'custom', label: '🎛️ 依片單', dot: '#3b82f6', title: '目前：套用各片單與略過獨立規則（點擊切換為全標註｜快捷鍵 Alt+H）' },
        { id: 'normal', label: '👁️ 全標註', dot: '#10b981', title: '目前：暫時全部只顯示標註（點擊切換為全淡化｜快捷鍵 Alt+H）' },
        { id: 'dim',    label: '🌫️ 全淡化', dot: '#d97706', title: '目前：全部已收錄/已略過影片淡化（點擊切換為全隱藏）' },
        { id: 'hide',   label: '🙈 全隱藏', dot: '#e11d48', title: '目前：全部已收錄/已略過影片隱藏（點擊切換回依片單規則）' }
    ];

    // 注入樣式
    GM_addStyle(`
        :root {
            --missav-pl-dim-opacity: 0.25;
        }

        /* 播放器去廣告與隱藏外部廣告框架 */
        html[data-missav-block-ads="true"] iframe[src*="exoclick"],
        html[data-missav-block-ads="true"] iframe[src*="trafficjunky"],
        html[data-missav-block-ads="true"] iframe[src*="juicyads"],
        html[data-missav-block-ads="true"] iframe[src*="tsyndicate"],
        html[data-missav-block-ads="true"] iframe[src*="realsrv"],
        html[data-missav-block-ads="true"] iframe[src*="adtng"],
        html[data-missav-block-ads="true"] iframe[src*="popads"],
        html[data-missav-block-ads="true"] iframe[src*="onclkds"],
        html[data-missav-block-ads="true"] .plyr__ads,
        html[data-missav-block-ads="true"] [class*="pause-ad"],
        html[data-missav-block-ads="true"] [id*="pause-ad"],
        html[data-missav-block-ads="true"] ins.adsbyexoclick {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }
        html[data-missav-block-ads="true"] .plyr video,
        html[data-missav-block-ads="true"] .plyr__controls {
            pointer-events: auto !important;
        }

        .missav-pl-matched-box {
            outline: 3px solid var(--missav-pl-color, #10b981) !important;
            outline-offset: -3px;
            border-radius: 6px;
        }

        /* 標籤群組：支援四個角落動態切換 */
        .missav-pl-badge-group {
            position: absolute !important;
            z-index: 40 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 4px !important;
            pointer-events: none !important;
            max-width: calc(100% - 42px);
        }
        html[data-missav-badge-pos="top-left"] .missav-pl-badge-group,
        html:not([data-missav-badge-pos]) .missav-pl-badge-group {
            top: 6px !important;
            left: 6px !important;
            align-items: flex-start !important;
        }
        html[data-missav-badge-pos="top-right"] .missav-pl-badge-group {
            top: 6px !important;
            right: 6px !important;
            align-items: flex-end !important;
        }
        html[data-missav-badge-pos="bottom-left"] .missav-pl-badge-group {
            bottom: 6px !important;
            left: 6px !important;
            align-items: flex-start !important;
        }
        html[data-missav-badge-pos="bottom-right"] .missav-pl-badge-group {
            bottom: 6px !important;
            right: 6px !important;
            align-items: flex-end !important;
        }

        .missav-pl-badge {
            color: #ffffff !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            line-height: 1.2 !important;
            padding: 3px 7px !important;
            border-radius: 4px !important;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45) !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
            letter-spacing: 0.3px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
        }
        .missav-pl-badge-skipped {
            background-color: rgba(63, 63, 70, 0.94) !important;
            border: 1px solid rgba(255, 255, 255, 0.22);
        }
        .missav-pl-badge-note {
            background-color: rgba(124, 58, 237, 0.93) !important;
            border: 1px solid rgba(255, 255, 255, 0.22);
        }
        .missav-pl-badge-dedup {
            background-color: rgba(14, 116, 144, 0.94) !important;
            border: 1px solid rgba(255, 255, 255, 0.25);
            pointer-events: auto !important;
            cursor: pointer !important;
        }
        .missav-pl-badge-dedup:hover {
            background-color: #0891b2 !important;
        }
        .missav-pl-dedup-hidden {
            display: none !important;
        }
        .missav-pl-dedup-expanded {
            outline: 2px dashed #06b6d4 !important;
            outline-offset: 2px;
            border-radius: 6px;
        }

        .missav-pl-title-badge {
            display: inline-block;
            margin-left: 8px;
            padding: 2px 8px;
            font-size: 13px;
            font-weight: 700;
            color: #ffffff;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
            border-radius: 4px;
            vertical-align: middle;
        }

        .missav-pl-title-skip-btn {
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
            margin-left: 8px !important;
            padding: 2px 9px !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            line-height: 1.4 !important;
            color: #e4e4e7 !important;
            background: rgba(63, 63, 70, 0.92) !important;
            border: 1px solid rgba(255, 255, 255, 0.24) !important;
            border-radius: 4px !important;
            vertical-align: middle !important;
            cursor: pointer !important;
            transition: background 0.15s ease, color 0.15s ease !important;
        }
        .missav-pl-title-skip-btn:hover {
            background: #e11d48 !important;
            border-color: #fda4af !important;
            color: #ffffff !important;
        }
        .missav-pl-title-skip-btn.is-skipped {
            background: #d97706 !important;
            border-color: rgba(255, 255, 255, 0.32) !important;
            color: #ffffff !important;
        }
        .missav-pl-title-skip-btn.is-skipped:hover {
            background: #10b981 !important;
            border-color: #a7f3d0 !important;
        }

        /* 封面快速「略過 / 還原」懸浮小按鈕 */
        .missav-pl-skip-btn {
            position: absolute !important;
            top: 6px !important;
            right: 6px !important;
            left: auto !important;
            z-index: 45 !important;
            width: 26px !important;
            height: 26px !important;
            min-width: 26px !important;
            padding: 0 !important;
            margin: 0 !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            border: 1px solid rgba(255, 255, 255, 0.28) !important;
            border-radius: 6px !important;
            background: rgba(24, 24, 27, 0.82) !important;
            color: #e4e4e7 !important;
            font-size: 13px !important;
            font-weight: 700 !important;
            line-height: 1 !important;
            cursor: pointer !important;
            pointer-events: auto !important;
            opacity: 0;
            transition: opacity 0.15s ease, background 0.15s ease, transform 0.12s ease;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45) !important;
        }
        html[data-missav-badge-pos="top-right"] .missav-pl-skip-btn {
            left: 6px !important;
            right: auto !important;
        }
        .missav-pl-card-scanned:hover .missav-pl-skip-btn,
        .missav-pl-skip-btn:focus-visible,
        .missav-pl-skip-btn.is-skipped {
            opacity: 0.92;
        }
        @media (hover: none) {
            .missav-pl-skip-btn {
                opacity: 0.55;
            }
        }
        .missav-pl-skip-btn:hover {
            opacity: 1 !important;
            background: #e11d48 !important;
            color: #ffffff !important;
            transform: scale(1.06);
        }
        .missav-pl-skip-btn.is-skipped {
            background: rgba(245, 158, 11, 0.92) !important;
            color: #ffffff !important;
        }
        .missav-pl-skip-btn.is-skipped:hover {
            background: #10b981 !important;
        }

        /* 半透明淡化規則 */
        html[data-missav-pl-mode="dim"]:not([data-missav-pl-self="true"]) .missav-pl-matched-card,
        html[data-missav-pl-mode="custom"]:not([data-missav-pl-self="true"]) .missav-pl-matched-card[data-missav-card-action="dim"] {
            opacity: var(--missav-pl-dim-opacity, 0.25) !important;
            filter: grayscale(65%);
            transition: opacity 0.2s ease, filter 0.2s ease;
        }
        html[data-missav-pl-mode="dim"]:not([data-missav-pl-self="true"]) .missav-pl-matched-card:hover,
        html[data-missav-pl-mode="custom"]:not([data-missav-pl-self="true"]) .missav-pl-matched-card[data-missav-card-action="dim"]:hover {
            opacity: 0.95 !important;
            filter: none;
        }

        /* 完全隱藏規則 */
        html[data-missav-pl-mode="hide"]:not([data-missav-pl-self="true"]) .missav-pl-matched-card,
        html[data-missav-pl-mode="custom"]:not([data-missav-pl-self="true"]) .missav-pl-matched-card[data-missav-card-action="hide"] {
            display: none !important;
        }

        /* ================= 單片播放頁：時間點書籤與筆記區塊 ================= */
        #missav-pl-note-widget {
            position: static !important;
            z-index: auto !important;
            clear: both !important;
            margin: 12px 0 !important;
            padding: 12px 14px !important;
            background: #18181b !important;
            border: 1px solid #3f3f46 !important;
            border-radius: 10px !important;
            color: #f4f4f5 !important;
            font-family: system-ui, -apple-system, sans-serif !important;
            font-size: 13px !important;
            box-sizing: border-box !important;
        }
        #missav-pl-note-widget * {
            box-sizing: border-box !important;
        }
        .missav-pl-note-head {
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: space-between !important;
            align-items: center !important;
            gap: 8px !important;
            margin-bottom: 10px !important;
        }
        .missav-pl-note-title {
            font-weight: 700 !important;
            font-size: 13px !important;
            color: #e4e4e7 !important;
        }
        .missav-pl-bm-list {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 6px !important;
            margin-bottom: 10px !important;
        }
        .missav-pl-bm-chip {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            background: rgba(124, 58, 237, 0.22) !important;
            border: 1px solid rgba(139, 92, 246, 0.5) !important;
            color: #ede9fe !important;
            border-radius: 999px !important;
            padding: 3px 8px 3px 10px !important;
            font-size: 12px !important;
            line-height: 1.3 !important;
        }
        .missav-pl-bm-jump {
            background: transparent !important;
            border: none !important;
            color: inherit !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            padding: 0 !important;
            margin: 0 !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
        }
        .missav-pl-bm-jump:hover {
            color: #ffffff !important;
            text-decoration: underline !important;
        }
        .missav-pl-bm-del {
            background: rgba(255, 255, 255, 0.12) !important;
            border: none !important;
            color: #fca5a5 !important;
            width: 18px !important;
            height: 18px !important;
            border-radius: 50% !important;
            font-size: 11px !important;
            line-height: 1 !important;
            padding: 0 !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
        }
        .missav-pl-bm-del:hover {
            background: #ef4444 !important;
            color: #ffffff !important;
        }
        .missav-pl-note-row {
            display: flex !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 6px !important;
            margin-top: 8px !important;
        }
        #missav-pl-note-widget input[type="text"],
        #missav-pl-note-widget textarea {
            background: #09090b !important;
            color: #f4f4f5 !important;
            border: 1px solid #52525b !important;
            border-radius: 6px !important;
            padding: 6px 9px !important;
            font-size: 12px !important;
            outline: none !important;
            box-shadow: none !important;
            margin: 0 !important;
        }
        #missav-pl-note-widget input[type="text"]:focus,
        #missav-pl-note-widget textarea:focus {
            border-color: #8b5cf6 !important;
        }
        #missav-pl-note-widget button.missav-pl-note-btn {
            appearance: none !important;
            height: 32px !important;
            padding: 0 11px !important;
            border: none !important;
            border-radius: 6px !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            color: #ffffff !important;
            background: #3f3f46 !important;
            cursor: pointer !important;
            white-space: nowrap !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
        }
        #missav-pl-note-widget button.missav-pl-note-btn.purple { background: #7c3aed !important; }
        #missav-pl-note-widget button.missav-pl-note-btn.green  { background: #10b981 !important; }
        #missav-pl-note-widget button.missav-pl-note-btn:hover  { opacity: 0.9; }

        /* ================= 浮動控制列（響應式＋可拖曳＋避開底部欄） ================= */
        #missav-pl-panel {
            position: fixed !important;
            z-index: 99999 !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: flex-end !important;
            gap: 6px !important;
            max-width: calc(100vw - 28px);
            box-sizing: border-box !important;
            background: rgba(24, 24, 27, 0.94) !important;
            color: #f4f4f5 !important;
            border: 1px solid rgba(255, 255, 255, 0.16) !important;
            border-radius: 10px !important;
            padding: 8px 10px !important;
            font-size: 12px !important;
            font-family: system-ui, -apple-system, sans-serif !important;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5) !important;
            backdrop-filter: blur(6px);
            user-select: none;
            -webkit-user-select: none;
        }
        #missav-pl-panel * {
            box-sizing: border-box !important;
        }
        #missav-pl-panel.is-dragging {
            opacity: 0.88 !important;
            box-shadow: 0 10px 26px rgba(0, 0, 0, 0.65) !important;
        }
        #missav-pl-panel.is-collapsed {
            padding: 4px !important;
            border-radius: 999px !important;
            gap: 0 !important;
        }
        #missav-pl-panel.is-collapsed .missav-pl-full-item {
            display: none !important;
        }
        #missav-pl-panel:not(.is-collapsed) .missav-pl-mini-btn {
            display: none !important;
        }

        /* 本頁統計列 */
        .missav-pl-page-stats-row {
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: flex-end !important;
            align-items: center !important;
            gap: 6px !important;
            width: 100% !important;
            font-size: 11px !important;
            color: #a1a1aa !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding-bottom: 5px;
        }
        .missav-pl-page-stats-row strong {
            color: #e4e4e7 !important;
            font-weight: 700 !important;
        }
        .missav-pl-nextpage-btn {
            display: inline-flex !important;
            align-items: center !important;
            padding: 2px 8px !important;
            border-radius: 999px !important;
            background: #2563eb !important;
            color: #ffffff !important;
            font-size: 11px !important;
            font-weight: 600 !important;
            text-decoration: none !important;
            white-space: nowrap !important;
        }
        .missav-pl-nextpage-btn:hover {
            background: #3b82f6 !important;
        }

        /* 各片單數量列 */
        .missav-pl-counts-row {
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: flex-end !important;
            align-items: center !important;
            gap: 5px !important;
            width: 100% !important;
            max-height: 76px;
            overflow-y: auto;
        }
        .missav-pl-count-chip {
            display: inline-flex !important;
            align-items: center !important;
            gap: 5px !important;
            width: auto !important;
            margin: 0 !important;
            background: rgba(255, 255, 255, 0.08) !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            color: #f4f4f5 !important;
            border-radius: 999px !important;
            padding: 2px 8px !important;
            font-size: 11px !important;
            line-height: 1.4 !important;
            cursor: pointer !important;
            max-width: 100%;
            transition: background 0.15s;
        }
        .missav-pl-count-chip:hover {
            background: rgba(255, 255, 255, 0.18) !important;
        }
        .missav-pl-count-chip .chip-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 110px;
        }
        .missav-pl-count-chip .chip-num {
            font-weight: 700;
            color: #ffffff;
        }
        .missav-pl-count-chip .chip-act {
            font-size: 10px;
            opacity: 0.78;
        }
        .missav-pl-total-btn {
            background: transparent !important;
            border: none !important;
            padding: 2px 4px !important;
            margin: 0 2px 0 0 !important;
            font-size: 11px !important;
            color: #a1a1aa !important;
            cursor: pointer !important;
            white-space: nowrap !important;
            border-radius: 4px !important;
        }
        .missav-pl-total-btn:hover {
            color: #ffffff !important;
            background: rgba(255, 255, 255, 0.1) !important;
        }

        /* 操作按鈕列 */
        .missav-pl-controls-row {
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: flex-end !important;
            align-items: center !important;
            gap: 5px !important;
            width: 100% !important;
        }
        .missav-pl-drag-handle {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: 4px 6px !important;
            color: #a1a1aa !important;
            cursor: grab !important;
            touch-action: none !important;
            font-size: 14px !important;
            line-height: 1 !important;
            border-radius: 5px !important;
        }
        .missav-pl-drag-handle:hover {
            color: #ffffff !important;
            background: rgba(255, 255, 255, 0.1) !important;
        }
        .missav-pl-drag-handle:active {
            cursor: grabbing !important;
        }

        #missav-pl-panel button.missav-pl-ctrl-btn {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: auto !important;
            margin: 0 !important;
            background: #10b981 !important;
            color: #fff !important;
            border: none !important;
            border-radius: 6px !important;
            padding: 5px 8px !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            cursor: pointer !important;
            transition: opacity 0.15s, background 0.15s;
            white-space: nowrap !important;
            line-height: 1.2 !important;
        }
        #missav-pl-panel button.missav-pl-ctrl-btn:hover {
            opacity: 0.88;
        }
        #missav-pl-panel button.missav-pl-ctrl-btn:disabled {
            background: #52525b !important;
            cursor: not-allowed !important;
        }
        #missav-pl-panel .btn-secondary { background: #3f3f46 !important; }
        #missav-pl-panel .btn-purple    { background: #7c3aed !important; }
        #missav-pl-panel .btn-collapse {
            background: rgba(255, 255, 255, 0.08) !important;
            color: #d4d4d8 !important;
            padding: 5px 8px !important;
        }
        #missav-pl-panel .btn-collapse:hover {
            background: rgba(255, 255, 255, 0.18) !important;
            color: #ffffff !important;
        }
        #missav-pl-panel .btn-mode-custom { background: #2563eb !important; }
        #missav-pl-panel .btn-mode-normal { background: #3f3f46 !important; }
        #missav-pl-panel .btn-mode-dim    { background: #d97706 !important; }
        #missav-pl-panel .btn-mode-hide   { background: #e11d48 !important; }

        /* 縮小後的膠囊按鈕 */
        #missav-pl-panel .missav-pl-mini-btn {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            width: auto !important;
            margin: 0 !important;
            background: #27272a !important;
            color: #f4f4f5 !important;
            border: none !important;
            border-radius: 999px !important;
            padding: 6px 11px !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            cursor: pointer !important;
            white-space: nowrap !important;
            touch-action: none !important;
        }
        .missav-pl-mini-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
            flex-shrink: 0;
        }

        /* 輕量 Toast 提示 */
        #missav-pl-toast {
            position: fixed !important;
            left: 50% !important;
            bottom: calc(24px + env(safe-area-inset-bottom, 0px)) !important;
            transform: translateX(-50%) !important;
            z-index: 100005 !important;
            background: rgba(24, 24, 27, 0.95) !important;
            color: #ffffff !important;
            border: 1px solid rgba(255, 255, 255, 0.18) !important;
            border-radius: 8px !important;
            padding: 8px 14px !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            font-family: system-ui, -apple-system, sans-serif !important;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5) !important;
            pointer-events: none !important;
            opacity: 0;
            transition: opacity 0.2s ease;
            white-space: nowrap !important;
        }
        #missav-pl-toast.show {
            opacity: 1;
        }

        @media (max-width: 640px) {
            #missav-pl-panel {
                max-width: calc(100vw - 16px);
                padding: 7px 8px !important;
                gap: 5px !important;
            }
            #missav-pl-panel button.missav-pl-ctrl-btn {
                padding: 4px 7px !important;
                font-size: 11px !important;
            }
            .missav-pl-count-chip {
                padding: 2px 6px !important;
                font-size: 11px !important;
            }
            .missav-pl-count-chip .chip-name {
                max-width: 80px;
            }
        }

        /* ================= 彈窗通用隔離樣式 ================= */
        .missav-pl-overlay {
            position: fixed !important;
            inset: 0 !important;
            z-index: 100000 !important;
            background: rgba(0, 0, 0, 0.72) !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-family: system-ui, -apple-system, sans-serif !important;
            padding: 12px !important;
            box-sizing: border-box !important;
        }
        .missav-pl-overlay * {
            box-sizing: border-box !important;
        }
        .missav-pl-modal-box {
            background: #18181b !important;
            color: #f4f4f5 !important;
            border: 1px solid #3f3f46 !important;
            border-radius: 12px !important;
            width: min(740px, 100%) !important;
            max-height: 88vh !important;
            display: flex !important;
            flex-direction: column !important;
            padding: 16px !important;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55) !important;
            text-align: left !important;
        }
        .missav-pl-modal-box.compact {
            width: min(500px, 100%) !important;
        }
        .missav-pl-modal-header {
            display: flex !important;
            justify-content: space-between !important;
            align-items: center !important;
            gap: 10px !important;
        }
        .missav-pl-modal-title {
            font-size: 15px !important;
            font-weight: 700 !important;
            color: #ffffff !important;
            margin: 0 !important;
        }

        .missav-pl-overlay button {
            appearance: none !important;
            -webkit-appearance: none !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: auto !important;
            min-width: 0 !important;
            margin: 0 !important;
            border: none !important;
            font-family: inherit !important;
            line-height: 1.2 !important;
            white-space: nowrap !important;
            flex-shrink: 0 !important;
            cursor: pointer !important;
            box-shadow: none !important;
        }
        .missav-pl-overlay button.missav-pl-btn-close {
            height: 30px !important;
            padding: 0 12px !important;
            border-radius: 6px !important;
            background: #3f3f46 !important;
            color: #ffffff !important;
            font-size: 12px !important;
            font-weight: 600 !important;
        }
        .missav-pl-overlay button.missav-pl-btn-close:hover {
            background: #52525b !important;
        }

        /* ================= 清單、統計、變動與紀錄視窗 ================= */
        .missav-pl-search-bar {
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
            margin-top: 10px !important;
        }
        .missav-pl-search-input {
            flex: 1 1 auto !important;
            min-width: 0 !important;
            height: 34px !important;
            margin: 0 !important;
            padding: 0 10px !important;
            background: #09090b !important;
            color: #f4f4f5 !important;
            border: 1px solid #52525b !important;
            border-radius: 6px !important;
            font-size: 13px !important;
            box-shadow: none !important;
            outline: none !important;
        }
        .missav-pl-search-input:focus {
            border-color: #10b981 !important;
        }
        .missav-pl-tabs {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 6px !important;
            margin-top: 10px !important;
        }
        .missav-pl-overlay button.missav-pl-tab {
            gap: 6px !important;
            height: 30px !important;
            background: #27272a !important;
            color: #d4d4d8 !important;
            border: 1px solid #3f3f46 !important;
            border-radius: 6px !important;
            padding: 0 10px !important;
            font-size: 12px !important;
        }
        .missav-pl-overlay button.missav-pl-tab.active {
            background: #3f3f46 !important;
            color: #ffffff !important;
            border-color: #71717a !important;
            font-weight: 600 !important;
        }
        .missav-pl-overlay button.missav-pl-tab.dup-tab {
            border-color: rgba(245, 158, 11, 0.45) !important;
            color: #fde68a !important;
        }
        .missav-pl-overlay button.missav-pl-tab.dup-tab.active {
            background: rgba(245, 158, 11, 0.25) !important;
            color: #ffffff !important;
            border-color: #f59e0b !important;
        }
        .missav-pl-overlay button.missav-pl-tab.skip-tab {
            border-color: rgba(244, 63, 94, 0.45) !important;
            color: #fda4af !important;
        }
        .missav-pl-overlay button.missav-pl-tab.skip-tab.active {
            background: rgba(244, 63, 94, 0.25) !important;
            color: #ffffff !important;
            border-color: #f43f5e !important;
        }
        .missav-pl-overlay button.missav-pl-tab.note-tab {
            border-color: rgba(139, 92, 246, 0.5) !important;
            color: #ddd6fe !important;
        }
        .missav-pl-overlay button.missav-pl-tab.note-tab.active {
            background: rgba(124, 58, 237, 0.3) !important;
            color: #ffffff !important;
            border-color: #8b5cf6 !important;
        }
        .missav-pl-overlay button.missav-pl-tab.diff-tab {
            border-color: rgba(14, 165, 233, 0.45) !important;
            color: #bae6fd !important;
        }
        .missav-pl-overlay button.missav-pl-tab.diff-tab.active {
            background: rgba(14, 165, 233, 0.26) !important;
            color: #ffffff !important;
            border-color: #38bdf8 !important;
        }
        .missav-pl-overlay button.missav-pl-tab.stats-tab {
            border-color: rgba(16, 185, 129, 0.5) !important;
            color: #a7f3d0 !important;
        }
        .missav-pl-overlay button.missav-pl-tab.stats-tab.active {
            background: rgba(16, 185, 129, 0.26) !important;
            color: #ffffff !important;
            border-color: #10b981 !important;
        }
        .missav-pl-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
            flex-shrink: 0;
        }
        .missav-pl-modal-meta {
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: space-between !important;
            align-items: center !important;
            gap: 8px !important;
            font-size: 12px !important;
            color: #a1a1aa !important;
            margin-top: 10px !important;
        }
        .missav-pl-modal-meta-btns {
            display: inline-flex !important;
            flex-wrap: wrap !important;
            gap: 6px !important;
            align-items: center !important;
        }
        .missav-pl-modal-list {
            margin-top: 8px !important;
            padding: 10px !important;
            background: #09090b !important;
            border-radius: 6px !important;
            overflow-y: auto !important;
            font-size: 12px !important;
            line-height: 1.6 !important;
            flex: 1 !important;
            min-height: 160px !important;
            color: #e4e4e7 !important;
        }
        .missav-pl-plain-codes {
            font-family: monospace !important;
            word-break: break-all !important;
        }
        .missav-pl-rich-row {
            display: flex !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 8px !important;
            padding: 7px 8px !important;
            border-bottom: 1px solid #27272a !important;
        }
        .missav-pl-rich-row:last-child {
            border-bottom: none !important;
        }
        .missav-pl-rich-left {
            display: flex !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 6px !important;
        }
        .missav-pl-rich-right {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
        }
        .missav-pl-code-pill {
            font-family: monospace !important;
            font-size: 13px !important;
            font-weight: 700 !important;
            color: #ffffff !important;
            background: #27272a !important;
            padding: 2px 7px !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            border: 1px solid #3f3f46 !important;
        }
        .missav-pl-code-pill:hover {
            border-color: #10b981 !important;
        }
        .missav-pl-code-pill.added {
            background: rgba(16, 185, 129, 0.18) !important;
            border-color: rgba(16, 185, 129, 0.45) !important;
            color: #6ee7b7 !important;
        }
        .missav-pl-code-pill.removed {
            background: rgba(239, 68, 68, 0.18) !important;
            border-color: rgba(239, 68, 68, 0.45) !important;
            color: #fca5a5 !important;
        }
        .missav-pl-mini-tag {
            display: inline-flex !important;
            align-items: center !important;
            color: #ffffff !important;
            font-size: 11px !important;
            font-weight: 600 !important;
            padding: 1px 7px !important;
            border-radius: 999px !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
        }
        .missav-pl-link-btn {
            font-size: 11px !important;
            color: #93c5fd !important;
            text-decoration: none !important;
            padding: 3px 7px !important;
            border-radius: 4px !important;
            background: rgba(59, 130, 246, 0.16) !important;
            white-space: nowrap !important;
        }
        .missav-pl-link-btn:hover {
            background: rgba(59, 130, 246, 0.3) !important;
        }
        .missav-pl-overlay button.missav-pl-unskip-btn {
            height: 24px !important;
            padding: 0 8px !important;
            border-radius: 4px !important;
            background: rgba(239, 68, 68, 0.22) !important;
            color: #fca5a5 !important;
            font-size: 11px !important;
            font-weight: 600 !important;
        }
        .missav-pl-overlay button.missav-pl-unskip-btn:hover {
            background: #ef4444 !important;
            color: #ffffff !important;
        }

        /* 番號前綴統計排行榜樣式 */
        .missav-pl-stats-summary {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 8px !important;
            margin-bottom: 10px !important;
            padding: 8px 10px !important;
            background: #18181b !important;
            border: 1px solid #27272a !important;
            border-radius: 8px !important;
            font-size: 12px !important;
            color: #d4d4d8 !important;
        }
        .missav-pl-stats-summary strong {
            color: #34d399 !important;
        }
        .missav-pl-stat-row {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            padding: 7px 8px !important;
            border-bottom: 1px solid #27272a !important;
            cursor: pointer !important;
            border-radius: 6px !important;
            transition: background 0.14s ease;
        }
        .missav-pl-stat-row:hover {
            background: rgba(255, 255, 255, 0.06) !important;
        }
        .missav-pl-stat-row:last-child {
            border-bottom: none !important;
        }
        .missav-pl-stat-rank {
            width: 28px !important;
            text-align: right !important;
            font-family: monospace !important;
            font-size: 11px !important;
            color: #a1a1aa !important;
            flex-shrink: 0 !important;
        }
        .missav-pl-stat-rank.top3 {
            color: #fbbf24 !important;
            font-weight: 800 !important;
        }
        .missav-pl-stat-prefix {
            width: 82px !important;
            font-family: monospace !important;
            font-size: 13px !important;
            font-weight: 700 !important;
            color: #ffffff !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
            flex-shrink: 0 !important;
        }
        .missav-pl-stat-bar-wrap {
            flex: 1 1 80px !important;
            min-width: 60px !important;
            height: 12px !important;
            background: #27272a !important;
            border-radius: 999px !important;
            overflow: hidden !important;
        }
        .missav-pl-stat-bar-fill {
            height: 100% !important;
            border-radius: 999px !important;
            background: linear-gradient(90deg, #10b981, #38bdf8) !important;
            min-width: 4px !important;
        }
        .missav-pl-stat-val {
            width: 92px !important;
            text-align: right !important;
            font-size: 12px !important;
            color: #e4e4e7 !important;
            white-space: nowrap !important;
            flex-shrink: 0 !important;
        }
        .missav-pl-stat-val span {
            color: #a1a1aa !important;
            font-size: 11px !important;
        }

        /* 變動紀錄卡片與操作紀錄條目 */
        .missav-pl-diff-card {
            background: #18181b !important;
            border: 1px solid #27272a !important;
            border-radius: 8px !important;
            padding: 9px 10px !important;
            margin-bottom: 8px !important;
        }
        .missav-pl-diff-card:last-child {
            margin-bottom: 0 !important;
        }
        .missav-pl-diff-head {
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: space-between !important;
            align-items: center !important;
            gap: 6px !important;
            margin-bottom: 6px !important;
            font-size: 12px !important;
        }
        .missav-pl-diff-codes {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 5px !important;
            margin-top: 4px !important;
        }
        .missav-pl-log-row {
            display: flex !important;
            flex-direction: column !important;
            gap: 3px !important;
            padding: 8px 9px !important;
            border-bottom: 1px solid #27272a !important;
        }
        .missav-pl-log-row:last-child {
            border-bottom: none !important;
        }
        .missav-pl-log-top {
            display: flex !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 7px !important;
        }
        .missav-pl-log-time {
            font-family: monospace !important;
            font-size: 11px !important;
            color: #a1a1aa !important;
        }
        .missav-pl-log-cat {
            font-size: 11px !important;
            font-weight: 700 !important;
            color: #ffffff !important;
            padding: 1px 7px !important;
            border-radius: 999px !important;
        }
        .missav-pl-log-action {
            font-weight: 700 !important;
            color: #f4f4f5 !important;
            font-size: 12px !important;
        }
        .missav-pl-log-detail {
            font-size: 12px !important;
            color: #d4d4d8 !important;
            word-break: break-word !important;
            padding-left: 2px !important;
        }

        /* 隨機抽片卡片 */
        .missav-pl-random-result {
            margin-top: 12px !important;
            padding: 16px !important;
            background: #09090b !important;
            border: 1px solid #3f3f46 !important;
            border-radius: 10px !important;
            text-align: center !important;
        }
        .missav-pl-random-code {
            font-family: monospace !important;
            font-size: 24px !important;
            font-weight: 800 !important;
            color: #ffffff !important;
            letter-spacing: 0.8px;
        }

        /* ================= 設定視窗 ================= */
        .missav-pl-hint {
            font-size: 12px !important;
            color: #a1a1aa !important;
            margin-top: 6px !important;
            line-height: 1.5 !important;
        }
        .missav-pl-settings-scroll {
            overflow-y: auto !important;
            flex: 1 1 auto !important;
            margin-top: 8px !important;
            padding-right: 2px !important;
        }
        .missav-pl-pref-box {
            margin-top: 8px !important;
            padding: 9px 12px !important;
            background: #27272a !important;
            border: 1px solid #3f3f46 !important;
            border-radius: 8px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            font-size: 12px !important;
            color: #f4f4f5 !important;
        }
        .missav-pl-pref-line {
            display: flex !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 10px !important;
        }
        .missav-pl-pref-line label {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            margin: 0 !important;
            cursor: pointer !important;
            font-weight: 400 !important;
        }
        .missav-pl-pref-box input[type="checkbox"] {
            width: 15px !important;
            height: 15px !important;
            margin: 0 !important;
            accent-color: #10b981 !important;
            cursor: pointer !important;
            flex-shrink: 0 !important;
        }
        .missav-pl-pref-box input[type="number"] {
            width: 58px !important;
            height: 28px !important;
            margin: 0 !important;
            padding: 0 6px !important;
            background: #09090b !important;
            color: #f4f4f5 !important;
            border: 1px solid #52525b !important;
            border-radius: 6px !important;
            font-size: 12px !important;
            text-align: center !important;
            box-shadow: none !important;
        }
        .missav-pl-pref-box input[type="range"] {
            width: 105px !important;
            accent-color: #10b981 !important;
            cursor: pointer !important;
            margin: 0 !important;
        }
        .missav-pl-pref-select {
            height: 28px !important;
            margin: 0 !important;
            padding: 0 8px !important;
            background: #09090b !important;
            color: #f4f4f5 !important;
            border: 1px solid #52525b !important;
            border-radius: 6px !important;
            font-size: 12px !important;
            cursor: pointer !important;
            outline: none !important;
        }

        #missav-pl-settings-rows {
            margin-top: 10px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
        }
        .missav-pl-row {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            width: 100% !important;
            background: #27272a !important;
            border: 1px solid #3f3f46 !important;
            border-radius: 8px !important;
            padding: 8px !important;
        }
        .missav-pl-color-input {
            width: 34px !important;
            height: 34px !important;
            min-width: 34px !important;
            padding: 2px !important;
            margin: 0 !important;
            border: 1px solid #52525b !important;
            border-radius: 6px !important;
            background: #18181b !important;
            cursor: pointer !important;
            flex-shrink: 0 !important;
        }
        .missav-pl-inputs {
            display: flex !important;
            flex: 1 1 0 !important;
            min-width: 0 !important;
            gap: 8px !important;
        }
        .missav-pl-text-input {
            display: block !important;
            width: 100% !important;
            min-width: 0 !important;
            height: 34px !important;
            margin: 0 !important;
            padding: 0 10px !important;
            background: #09090b !important;
            color: #f4f4f5 !important;
            border: 1px solid #52525b !important;
            border-radius: 6px !important;
            font-size: 13px !important;
            line-height: 32px !important;
            white-space: nowrap !important;
            overflow-x: auto !important;
            box-shadow: none !important;
            outline: none !important;
        }
        .missav-pl-text-input:focus {
            border-color: #10b981 !important;
        }
        .missav-pl-input-name { flex: 1 1 0 !important; }
        .missav-pl-input-id   { flex: 1.25 1 0 !important; }
        .missav-pl-action-select {
            width: 98px !important;
            min-width: 98px !important;
            height: 34px !important;
            margin: 0 !important;
            padding: 0 6px !important;
            background: #09090b !important;
            color: #f4f4f5 !important;
            border: 1px solid #52525b !important;
            border-radius: 6px !important;
            font-size: 12px !important;
            line-height: 1.2 !important;
            cursor: pointer !important;
            flex-shrink: 0 !important;
            box-shadow: none !important;
            outline: none !important;
        }
        .missav-pl-action-select:focus {
            border-color: #10b981 !important;
        }
        .missav-pl-row-actions {
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
            flex-shrink: 0 !important;
        }

        /* 確保 ↑ ↓ ✕ 為 34×34 正方形 */
        .missav-pl-overlay button.missav-pl-icon-btn {
            width: 34px !important;
            height: 34px !important;
            min-width: 34px !important;
            max-width: 34px !important;
            min-height: 34px !important;
            max-height: 34px !important;
            flex: 0 0 34px !important;
            aspect-ratio: 1 / 1 !important;
            padding: 0 !important;
            border-radius: 6px !important;
            background: #3f3f46 !important;
            color: #e4e4e7 !important;
            font-size: 14px !important;
            font-weight: 700 !important;
            line-height: 1 !important;
        }
        .missav-pl-overlay button.missav-pl-icon-btn:hover:not(:disabled) {
            background: #52525b !important;
        }
        .missav-pl-overlay button.missav-pl-icon-btn:disabled {
            opacity: 0.35 !important;
            cursor: not-allowed !important;
        }
        .missav-pl-overlay button.missav-pl-icon-btn.btn-del {
            background: rgba(239, 68, 68, 0.22) !important;
            color: #fca5a5 !important;
        }
        .missav-pl-overlay button.missav-pl-icon-btn.btn-del:hover {
            background: #ef4444 !important;
            color: #ffffff !important;
        }

        @media (max-width: 640px) {
            .missav-pl-row { flex-wrap: wrap !important; }
            .missav-pl-action-select { order: 2 !important; }
            .missav-pl-row-actions { order: 3 !important; margin-left: auto !important; }
            .missav-pl-inputs { flex: 1 1 100% !important; flex-direction: column !important; order: 4 !important; }
            .missav-pl-input-name, .missav-pl-input-id { flex: 1 1 auto !important; }
            .missav-pl-stat-prefix { width: 68px !important; font-size: 12px !important; }
            .missav-pl-stat-val { width: 78px !important; font-size: 11px !important; }
        }

        .missav-pl-settings-toolbar {
            display: flex !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 8px !important;
            margin-top: 10px !important;
        }
        .missav-pl-settings-footer {
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: space-between !important;
            align-items: center !important;
            gap: 8px !important;
            margin-top: 12px !important;
            padding-top: 12px !important;
            border-top: 1px solid #27272a !important;
        }
        .missav-pl-footer-group {
            display: flex !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 8px !important;
        }
        .missav-pl-overlay button.missav-pl-action-btn,
        .missav-pl-overlay a.missav-pl-action-btn {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            height: 34px !important;
            padding: 0 13px !important;
            border-radius: 6px !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            color: #ffffff !important;
            background: #3f3f46 !important;
            text-decoration: none !important;
            white-space: nowrap !important;
        }
        .missav-pl-overlay button.missav-pl-action-btn:hover,
        .missav-pl-overlay a.missav-pl-action-btn:hover {
            opacity: 0.9;
        }
        .missav-pl-overlay button.missav-pl-action-btn.primary,
        .missav-pl-overlay a.missav-pl-action-btn.primary { background: #10b981 !important; }
        .missav-pl-overlay button.missav-pl-action-btn.accent  { background: #3b82f6 !important; }
        .missav-pl-overlay button.missav-pl-action-btn.warn    { background: #d97706 !important; }
        .missav-pl-overlay button.missav-pl-action-btn.danger  { background: #e11d48 !important; }
        .missav-pl-overlay button.missav-pl-action-btn.purple  { background: #7c3aed !important; }

        .missav-pl-backup-textarea {
            width: 100% !important;
            min-height: 180px !important;
            margin-top: 10px !important;
            padding: 10px !important;
            background: #09090b !important;
            color: #e4e4e7 !important;
            border: 1px solid #52525b !important;
            border-radius: 8px !important;
            font-family: monospace !important;
            font-size: 12px !important;
            line-height: 1.5 !important;
            resize: vertical !important;
            outline: none !important;
        }
        .missav-pl-backup-textarea:focus {
            border-color: #10b981 !important;
        }
    `);

    // ================= 時間與格式化工具 =================
    function formatTimestamp(d = new Date()) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function formatSeconds(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    function parseTimeToSeconds(str) {
        if (!str) return null;
        const cleaned = str.trim().replace(/[：]/g, ':');
        if (/^\d+$/.test(cleaned)) {
            return parseInt(cleaned, 10);
        }
        const parts = cleaned.split(':').map(p => p.trim());
        if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) {
            return null;
        }
        const nums = parts.map(Number);
        if (nums.length === 2) {
            return nums[0] * 60 + nums[1];
        }
        return nums[0] * 3600 + nums[1] * 60 + nums[2];
    }

    // ================= 狀態管理 =================
    let playlists = loadPlaylistsConfig();
    let autoSyncCfg = loadAutoSyncConfig();
    let uiPrefs = loadUiPrefs();
    let skippedCodes = loadSkippedCodes();
    let notesMap = loadNotesMap();
    let codeUrlMap = loadCodeUrlMap();
    let diffHistory = loadDiffHistory();
    let activityLogs = loadLogs();
    let panelPos = loadPanelPos();

    const playlistCodesMap = new Map();
    const codeToPlaylists = new Map();
    const expandedDedupGroups = new Set();
    let lastLoggedDedupSig = '';
    let isSyncBusy = false;
    let isPanelDragging = false;

    // 站內原生片單動作監聽排程狀態
    let nativeSyncTimer = null;
    let nativePendingTargets = null; // null 代表偵測全部片單；Set 代表僅偵測特定片單 ID
    let nativePendingSource = '';

    let currentMode = GM_getValue(MODE_KEY, null);
    if (!currentMode) {
        const legacy = GM_getValue('missav_playlist_mode_sd238ybx', null);
        currentMode = legacy && MODES.some(m => m.id === legacy) ? legacy : 'custom';
    }
    if (!MODES.some(m => m.id === currentMode)) currentMode = 'custom';
    let lastNonNormalMode = currentMode === 'normal' ? 'custom' : currentMode;

    let isCollapsed = Boolean(GM_getValue(COLLAPSED_KEY, false));
    let pageStats = { total: 0, marked: 0, hidden: 0, dedupHidden: 0 };

    let panelEl = null;
    let panelPageStatsRow = null;
    let panelCountsRow = null;
    let panelModeBtn = null;
    let panelSyncBtn = null;
    let miniCountSpan = null;
    let miniDotSpan = null;
    let toastTimer = null;
    let clampRafId = null;

    function normalizeAction(act) {
        return VALID_ACTIONS.includes(act) ? act : 'normal';
    }

    function loadPlaylistsConfig() {
        const stored = GM_getValue(CONFIG_KEY, null);
        if (Array.isArray(stored)) {
            return stored.map((pl, idx) => ({
                id: String(pl.id || '').trim(),
                name: String(pl.name || `片單 ${idx + 1}`).trim(),
                color: /^#[0-9a-f]{6}$/i.test(pl.color || '') ? pl.color : PRESET_COLORS[idx % PRESET_COLORS.length],
                action: normalizeAction(pl.action)
            })).filter(pl => pl.id);
        }
        return DEFAULT_PLAYLISTS.map(pl => ({ ...pl }));
    }

    function savePlaylistsConfig(list) {
        playlists = list;
        GM_setValue(CONFIG_KEY, playlists);
    }

    function loadAutoSyncConfig() {
        const stored = GM_getValue(AUTO_SYNC_KEY, null);
        return {
            enabled: stored && typeof stored.enabled === 'boolean' ? stored.enabled : true,
            intervalMin: stored && Number(stored.intervalMin) >= 1 ? Math.floor(Number(stored.intervalMin)) : 10
        };
    }

    function saveAutoSyncConfig(cfg) {
        autoSyncCfg = {
            enabled: Boolean(cfg.enabled),
            intervalMin: Math.max(1, Math.floor(Number(cfg.intervalMin) || 10))
        };
        GM_setValue(AUTO_SYNC_KEY, autoSyncCfg);
    }

    function loadUiPrefs() {
        const stored = GM_getValue(UI_PREFS_KEY, null) || {};
        const opacity = Number(stored.dimOpacity);
        const bottomOffset = Number(stored.bottomSafeOffset);
        return {
            badgePos: VALID_BADGE_POS.includes(stored.badgePos) ? stored.badgePos : DEFAULT_UI_PREFS.badgePos,
            dimOpacity: !Number.isNaN(opacity) && opacity >= 0.08 && opacity <= 0.85 ? opacity : DEFAULT_UI_PREFS.dimOpacity,
            skipEnabled: typeof stored.skipEnabled === 'boolean' ? stored.skipEnabled : DEFAULT_UI_PREFS.skipEnabled,
            skipAction: normalizeAction(stored.skipAction || DEFAULT_UI_PREFS.skipAction),
            skipConfirm: typeof stored.skipConfirm === 'boolean' ? stored.skipConfirm : DEFAULT_UI_PREFS.skipConfirm,
            bottomSafeOffset: !Number.isNaN(bottomOffset) && bottomOffset >= 0 && bottomOffset <= 160 ? Math.round(bottomOffset) : DEFAULT_UI_PREFS.bottomSafeOffset,
            dedupEnabled: typeof stored.dedupEnabled === 'boolean' ? stored.dedupEnabled : DEFAULT_UI_PREFS.dedupEnabled,
            dedupPreset: DEDUP_PRESETS[stored.dedupPreset] ? stored.dedupPreset : DEFAULT_UI_PREFS.dedupPreset,
            watchNativePlaylist: typeof stored.watchNativePlaylist === 'boolean' ? stored.watchNativePlaylist : DEFAULT_UI_PREFS.watchNativePlaylist,
            blockPlayerAds: typeof stored.blockPlayerAds === 'boolean' ? stored.blockPlayerAds : DEFAULT_UI_PREFS.blockPlayerAds
        };
    }

    function saveUiPrefs(prefs) {
        const opacity = Number(prefs.dimOpacity);
        const bottomOffset = Number(prefs.bottomSafeOffset);
        uiPrefs = {
            badgePos: VALID_BADGE_POS.includes(prefs.badgePos) ? prefs.badgePos : DEFAULT_UI_PREFS.badgePos,
            dimOpacity: !Number.isNaN(opacity) && opacity >= 0.08 && opacity <= 0.85 ? opacity : DEFAULT_UI_PREFS.dimOpacity,
            skipEnabled: Boolean(prefs.skipEnabled),
            skipAction: normalizeAction(prefs.skipAction),
            skipConfirm: Boolean(prefs.skipConfirm),
            bottomSafeOffset: !Number.isNaN(bottomOffset) && bottomOffset >= 0 && bottomOffset <= 160 ? Math.round(bottomOffset) : DEFAULT_UI_PREFS.bottomSafeOffset,
            dedupEnabled: Boolean(prefs.dedupEnabled),
            dedupPreset: DEDUP_PRESETS[prefs.dedupPreset] ? prefs.dedupPreset : DEFAULT_UI_PREFS.dedupPreset,
            watchNativePlaylist: Boolean(prefs.watchNativePlaylist),
            blockPlayerAds: Boolean(prefs.blockPlayerAds)
        };
        GM_setValue(UI_PREFS_KEY, uiPrefs);
        applyUiPrefs();
    }

    function applyUiPrefs() {
        document.documentElement.dataset.missavBadgePos = uiPrefs.badgePos;
        document.documentElement.dataset.missavBlockAds = uiPrefs.blockPlayerAds ? 'true' : 'false';
        document.documentElement.style.setProperty('--missav-pl-dim-opacity', String(uiPrefs.dimOpacity));
    }

    function loadSkippedCodes() {
        const stored = GM_getValue(SKIPPED_KEY, []);
        return new Set(Array.isArray(stored) ? stored.filter(Boolean) : []);
    }

    function saveSkippedCodes() {
        GM_setValue(SKIPPED_KEY, Array.from(skippedCodes));
    }

    function loadNotesMap() {
        const stored = GM_getValue(NOTES_KEY, null);
        return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    }

    function saveNotesMap() {
        GM_setValue(NOTES_KEY, notesMap);
    }

    function getNoteEntry(code) {
        const entry = notesMap[code];
        if (!entry) return null;
        const note = typeof entry.note === 'string' ? entry.note.trim() : '';
        const bookmarks = Array.isArray(entry.bookmarks) ? entry.bookmarks : [];
        if (!note && bookmarks.length === 0) return null;
        return { note, bookmarks, updatedAt: entry.updatedAt || '' };
    }

    function getNotedCodeCount() {
        return Object.keys(notesMap).filter(c => Boolean(getNoteEntry(c))).length;
    }

    function loadCodeUrlMap() {
        const stored = GM_getValue(URL_MAP_KEY, null);
        return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    }

    function saveCodeUrlMap() {
        GM_setValue(URL_MAP_KEY, codeUrlMap);
    }

    function loadDiffHistory() {
        const stored = GM_getValue(DIFF_HISTORY_KEY, []);
        return Array.isArray(stored) ? stored : [];
    }

    function saveDiffHistory() {
        if (diffHistory.length > MAX_DIFF_HISTORY) {
            diffHistory = diffHistory.slice(0, MAX_DIFF_HISTORY);
        }
        GM_setValue(DIFF_HISTORY_KEY, diffHistory);
    }

    function loadLogs() {
        const stored = GM_getValue(LOGS_KEY, []);
        return Array.isArray(stored) ? stored : [];
    }

    function addLog(category, action, detail) {
        const validCat = ['manual', 'auto', 'diff', 'error'].includes(category) ? category : 'manual';
        const now = new Date();
        const latest = loadLogs();
        latest.unshift({
            id: `${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
            ts: now.getTime(),
            time: formatTimestamp(now),
            category: validCat,
            action: String(action || ''),
            detail: String(detail || '')
        });
        activityLogs = latest.slice(0, MAX_LOGS);
        GM_setValue(LOGS_KEY, activityLogs);
    }

    function loadPanelPos() {
        const stored = GM_getValue(PANEL_POS_KEY, null);
        if (!stored || typeof stored !== 'object') return null;

        if ((stored.anchorX === 'left' || stored.anchorX === 'right') &&
            (stored.anchorY === 'top' || stored.anchorY === 'bottom') &&
            typeof stored.x === 'number' && typeof stored.y === 'number') {
            return { anchorX: stored.anchorX, x: stored.x, anchorY: stored.anchorY, y: stored.y };
        }
        if (typeof stored.left === 'number' && typeof stored.top === 'number') {
            return { anchorX: 'left', x: stored.left, anchorY: 'top', y: stored.top };
        }
        return null;
    }

    function savePanelPos(pos) {
        panelPos = pos;
        GM_setValue(PANEL_POS_KEY, pos);
    }

    function getViewportMetrics() {
        const vv = window.visualViewport;
        const isZoomed = Boolean(vv && vv.scale > 1.05);
        const width = (!isZoomed && vv) ? vv.width : window.innerWidth;
        const height = (!isZoomed && vv) ? vv.height : window.innerHeight;
        const vvBottomDiff = (!isZoomed && vv)
            ? Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)))
            : 0;
        return { width, height, vvBottomDiff };
    }

    function showToast(msg) {
        if (!document.body) return;
        let toast = document.getElementById('missav-pl-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'missav-pl-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 2200);
    }

    function extractPlaylistId(input) {
        if (!input) return '';
        const trimmed = input.trim();
        const urlMatch = trimmed.match(/\/playlists\/([a-zA-Z0-9_-]+)/i);
        if (urlMatch) return urlMatch[1];
        return trimmed.replace(/^\/+|\/+$/g, '');
    }

    function getCurrentPagePlaylistId() {
        const match = location.pathname.match(/\/playlists\/([a-zA-Z0-9_-]+)/i);
        return match ? match[1] : null;
    }

    function checkIsOwnPlaylistPage() {
        const curId = getCurrentPagePlaylistId();
        if (!curId) return false;
        return playlists.some(pl => pl.id.toLowerCase() === curId.toLowerCase());
    }

    function loadAllSavedCodes() {
        playlistCodesMap.clear();
        codeToPlaylists.clear();

        for (const pl of playlists) {
            const arr = GM_getValue(`${STORAGE_KEY_PREFIX}${pl.id}`, []);
            const codeSet = new Set(Array.isArray(arr) ? arr : []);
            playlistCodesMap.set(pl.id, codeSet);

            codeSet.forEach(code => {
                if (!codeToPlaylists.has(code)) {
                    codeToPlaylists.set(code, []);
                }
                codeToPlaylists.get(code).push(pl);
            });
        }
    }

    function getDuplicateEntries() {
        const result = [];
        codeToPlaylists.forEach((pls, code) => {
            if (pls.length >= 2) {
                result.push({ code, playlists: pls });
            }
        });
        result.sort((a, b) => a.code.localeCompare(b.code));
        return result;
    }

    // 計算番號前綴／片商收藏統計排行
    function computePrefixStats(scope = '__all__') {
        const codes = scope === '__all__'
            ? Array.from(codeToPlaylists.keys())
            : Array.from(playlistCodesMap.get(scope) || []);

        const map = new Map();
        codes.forEach(code => {
            const prefix = String(code).split('-')[0].toUpperCase();
            if (!prefix) return;
            if (!map.has(prefix)) map.set(prefix, []);
            map.get(prefix).push(code);
        });

        const total = codes.length;
        const groups = Array.from(map.entries()).map(([prefix, list]) => {
            list.sort((a, b) => a.localeCompare(b));
            return {
                prefix,
                count: list.length,
                pct: total > 0 ? (list.length / total) * 100 : 0,
                codes: list
            };
        });

        groups.sort((a, b) => (b.count - a.count) || a.prefix.localeCompare(b.prefix));
        return { total, groups };
    }

    function updatePageStatsDisplay() {
        const scannedCards = document.querySelectorAll('.missav-pl-card-scanned');
        const dedupHiddenCards = document.querySelectorAll('.missav-pl-dedup-hidden');
        const visibleScanned = Array.from(scannedCards).filter(c => !c.classList.contains('missav-pl-dedup-hidden'));
        const matchedVisible = visibleScanned.filter(c => c.classList.contains('missav-pl-matched-card'));
        const isOwn = checkIsOwnPlaylistPage();

        let hiddenCount = 0;
        if (!isOwn) {
            if (currentMode === 'hide') {
                hiddenCount = matchedVisible.length;
            } else if (currentMode === 'custom') {
                matchedVisible.forEach(card => {
                    if (card.dataset.missavCardAction === 'hide') hiddenCount++;
                });
            }
        }

        pageStats = {
            total: visibleScanned.length,
            marked: matchedVisible.length,
            hidden: hiddenCount,
            dedupHidden: dedupHiddenCards.length
        };

        if (!panelPageStatsRow) return;

        if (pageStats.total === 0 && pageStats.dedupHidden === 0) {
            panelPageStatsRow.style.setProperty('display', 'none', 'important');
            return;
        }

        panelPageStatsRow.style.setProperty('display', 'flex', 'important');
        panelPageStatsRow.innerHTML = '';

        const statsSpan = document.createElement('span');
        const unflagged = Math.max(0, pageStats.total - pageStats.marked);
        const extras = [];
        if (pageStats.hidden > 0) extras.push(`隱藏 ${pageStats.hidden}`);
        if (pageStats.dedupHidden > 0) extras.push(`去重 ${pageStats.dedupHidden}`);
        statsSpan.innerHTML = `本頁：已標 <strong>${pageStats.marked}</strong> / ${pageStats.total}（新片 <strong>${unflagged}</strong>${extras.length ? `｜${extras.join('｜')}` : ''}）`;
        panelPageStatsRow.appendChild(statsSpan);

        if (pageStats.total > 0 && pageStats.hidden >= pageStats.total) {
            const nextLink = document.querySelector('a[rel="next"]');
            if (nextLink && nextLink.href) {
                const nextBtn = document.createElement('a');
                nextBtn.className = 'missav-pl-nextpage-btn';
                nextBtn.href = nextLink.href;
                nextBtn.textContent = '⏭️ 全已隱藏，跳下一頁';
                panelPageStatsRow.appendChild(nextBtn);
            }
        }
    }

    function updateStatusDisplay() {
        const totalUnique = codeToPlaylists.size;
        const notedCount = getNotedCodeCount();
        const lines = playlists.map(pl => {
            const count = playlistCodesMap.get(pl.id)?.size || 0;
            return `${pl.name} (${pl.id}): ${count} 部 [${ACTION_LABELS[pl.action || 'normal']}]`;
        });
        if (skippedCodes.size > 0) {
            lines.push(`本機已略過: ${skippedCodes.size} 部 [${ACTION_LABELS[uiPrefs.skipAction]}]`);
        }
        if (notedCount > 0) {
            lines.push(`筆記/書籤: ${notedCount} 部`);
        }
        const tooltip = lines.length ? lines.join('\n') : '尚未設定任何片單，請點擊「⚙️ 設定」加入';

        if (panelCountsRow) {
            panelCountsRow.innerHTML = '';

            if (playlists.length === 0 && skippedCodes.size === 0 && notedCount === 0) {
                const emptySpan = document.createElement('span');
                emptySpan.className = 'missav-pl-total-btn';
                emptySpan.textContent = '尚未設定片單';
                panelCountsRow.appendChild(emptySpan);
            } else {
                // 點擊總計可直接開啟「📊 統計」番號前綴排行
                if (totalUnique > 0) {
                    const totalBtn = document.createElement('button');
                    totalBtn.type = 'button';
                    totalBtn.className = 'missav-pl-total-btn';
                    totalBtn.textContent = playlists.length > 1 ? `📊 總計 ${totalUnique} 部｜` : `📊 統計｜`;
                    totalBtn.title = '點擊開啟番號前綴／片商收藏統計排行';
                    totalBtn.addEventListener('click', () => showSavedListModal('__stats__'));
                    panelCountsRow.appendChild(totalBtn);
                }

                const actionEmoji = { normal: '', dim: '🌫️', hide: '🙈' };

                playlists.forEach((pl, idx) => {
                    const count = playlistCodesMap.get(pl.id)?.size || 0;
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'missav-pl-count-chip';
                    chip.title = `${pl.name}（${pl.id}）：已收錄 ${count} 部\n獨立規則：${ACTION_LABELS[pl.action || 'normal']}\n點擊查看此片單番號`;

                    const dot = document.createElement('span');
                    dot.className = 'missav-pl-dot';
                    dot.style.backgroundColor = pl.color || '#10b981';

                    const nameEl = document.createElement('span');
                    nameEl.className = 'chip-name';
                    nameEl.textContent = pl.name;

                    const numEl = document.createElement('span');
                    numEl.className = 'chip-num';
                    numEl.textContent = `${count}部`;

                    chip.append(dot, nameEl, numEl);

                    if (actionEmoji[pl.action]) {
                        const actEl = document.createElement('span');
                        actEl.className = 'chip-act';
                        actEl.textContent = actionEmoji[pl.action];
                        chip.appendChild(actEl);
                    }

                    chip.addEventListener('click', () => showSavedListModal(idx));
                    panelCountsRow.appendChild(chip);
                });

                if (notedCount > 0) {
                    const noteChip = document.createElement('button');
                    noteChip.type = 'button';
                    noteChip.className = 'missav-pl-count-chip';
                    noteChip.title = `有筆記或時間書籤：${notedCount} 部\n點擊檢視所有筆記`;
                    noteChip.innerHTML = `<span class="missav-pl-dot" style="background:#8b5cf6;"></span><span class="chip-name">筆記</span><span class="chip-num">${notedCount}部</span>`;
                    noteChip.addEventListener('click', () => showSavedListModal('__notes__'));
                    panelCountsRow.appendChild(noteChip);
                }

                if (skippedCodes.size > 0) {
                    const skipChip = document.createElement('button');
                    skipChip.type = 'button';
                    skipChip.className = 'missav-pl-count-chip';
                    skipChip.title = `本機已略過：${skippedCodes.size} 部\n獨立規則：${ACTION_LABELS[uiPrefs.skipAction]}\n點擊檢視或還原`;
                    skipChip.innerHTML = `<span class="missav-pl-dot" style="background:#71717a;"></span><span class="chip-name">已略過</span><span class="chip-num">${skippedCodes.size}部</span>`;
                    if (actionEmoji[uiPrefs.skipAction]) {
                        const actEl = document.createElement('span');
                        actEl.className = 'chip-act';
                        actEl.textContent = actionEmoji[uiPrefs.skipAction];
                        skipChip.appendChild(actEl);
                    }
                    skipChip.addEventListener('click', () => showSavedListModal('__skipped__'));
                    panelCountsRow.appendChild(skipChip);
                }
            }
        }

        if (miniCountSpan) {
            miniCountSpan.textContent = `★ ${totalUnique}`;
        }
        const miniBtn = panelEl?.querySelector('.missav-pl-mini-btn');
        if (miniBtn) {
            const modeInfo = MODES.find(m => m.id === currentMode) || MODES[0];
            miniBtn.title = `點擊展開工具列｜按住可拖曳位置\n目前模式：${modeInfo.label} (Alt+H)\n${tooltip}`;
        }
    }

    function applyDisplayMode() {
        const isOwn = checkIsOwnPlaylistPage();
        document.documentElement.dataset.missavPlMode = currentMode;
        document.documentElement.dataset.missavPlSelf = isOwn ? 'true' : 'false';

        if (currentMode !== 'normal') {
            lastNonNormalMode = currentMode;
        }

        const info = MODES.find(m => m.id === currentMode) || MODES[0];
        if (panelModeBtn) {
            panelModeBtn.textContent = info.label;
            panelModeBtn.title = isOwn && currentMode !== 'normal'
                ? `${info.title}（目前在片單頁本身，已暫停隱藏/淡化）`
                : info.title;
            panelModeBtn.className = `missav-pl-ctrl-btn btn-mode-${info.id}`;
        }
        if (miniDotSpan) {
            miniDotSpan.style.backgroundColor = info.dot;
        }
        updateStatusDisplay();
        updatePageStatsDisplay();
        scheduleClampPanel();
    }

    function applyCollapsedState() {
        if (!panelEl) return;
        panelEl.classList.toggle('is-collapsed', isCollapsed);
        scheduleClampPanel();
    }

    function scheduleClampPanel() {
        if (clampRafId) cancelAnimationFrame(clampRafId);
        clampRafId = requestAnimationFrame(() => {
            clampRafId = null;
            clampPanelToViewport();
        });
    }

    function clampPanelToViewport(previewBottomOffset = null) {
        if (!panelEl || isPanelDragging) return;

        const { width, height, vvBottomDiff } = getViewportMetrics();
        const margin = width <= 640 ? 8 : 14;
        const safeOffset = previewBottomOffset !== null ? previewBottomOffset : uiPrefs.bottomSafeOffset;
        const extraBottom = safeOffset + vvBottomDiff;

        if (!isCollapsed) {
            panelEl.style.maxWidth = `${Math.max(220, width - margin * 2)}px`;
        } else {
            panelEl.style.removeProperty('max-width');
        }

        const rect = panelEl.getBoundingClientRect();

        if (!panelPos) {
            panelEl.style.setProperty('right', `${margin}px`, 'important');
            panelEl.style.setProperty('bottom', `calc(${margin + extraBottom}px + env(safe-area-inset-bottom, 0px))`, 'important');
            panelEl.style.setProperty('left', 'auto', 'important');
            panelEl.style.setProperty('top', 'auto', 'important');
            return;
        }

        const maxX = Math.max(margin, width - rect.width - margin);
        const clampedX = Math.min(Math.max(margin, panelPos.x), maxX);
        if (panelPos.anchorX === 'right') {
            panelEl.style.setProperty('right', `${clampedX}px`, 'important');
            panelEl.style.setProperty('left', 'auto', 'important');
        } else {
            panelEl.style.setProperty('left', `${clampedX}px`, 'important');
            panelEl.style.setProperty('right', 'auto', 'important');
        }

        if (panelPos.anchorY === 'bottom') {
            const maxBottom = Math.max(margin, height - rect.height - margin - safeOffset);
            const clampedY = Math.min(Math.max(margin, panelPos.y), maxBottom);
            panelEl.style.setProperty('bottom', `calc(${clampedY + extraBottom}px + env(safe-area-inset-bottom, 0px))`, 'important');
            panelEl.style.setProperty('top', 'auto', 'important');
        } else {
            const maxTop = Math.max(margin, height - rect.height - margin - safeOffset);
            const clampedTop = Math.min(Math.max(margin, panelPos.y), maxTop);
            panelEl.style.setProperty('top', `${clampedTop}px`, 'important');
            panelEl.style.setProperty('bottom', 'auto', 'important');
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        }
    }

    function extractCode(text) {
        if (!text) return null;

        const fc2Match = text.match(/\bFC2(?:[-_\s]?PPV)?[-_\s]?(\d{5,8})\b/i);
        if (fc2Match) {
            return `FC2-${fc2Match[1]}`;
        }

        const stdMatch = text.match(/\b(\d{2,3}[A-Z]{2,6}|[A-Z]{2,6}|[A-Z]\d{2})-(\d{2,5})\b/i);
        if (stdMatch) {
            return `${stdMatch[1].toUpperCase()}-${stdMatch[2]}`;
        }

        return null;
    }

    function detectVersionType(href, cardText) {
        const lowerHref = (href || '').toLowerCase();
        const lowerText = (cardText || '').toLowerCase();
        if (lowerHref.includes('chinese-subtitle') || /中文字幕|字幕/.test(lowerText)) {
            return 'zh';
        }
        if (lowerHref.includes('uncensored-leak') || lowerHref.includes('uncensored') || /無碼流出|无码流出|無碼|无码/.test(lowerText)) {
            return 'leak';
        }
        return 'orig';
    }

    function isVideoUrl(href) {
        if (!href) return false;
        try {
            const url = new URL(href, location.origin);
            if (url.origin !== location.origin) return false;
            const path = url.pathname.toLowerCase();
            if (/\/(playlists|actresses|genres|makers|tags|labels|series|search|login|register|saved|dmca|terms)\b/.test(path)) {
                return false;
            }
            return path.length > 2;
        } catch {
            return false;
        }
    }

    function getDirectVideoUrl(code) {
        const cachedPath = codeUrlMap[code];
        if (cachedPath && cachedPath.startsWith('/')) {
            return `${location.origin}${cachedPath}`;
        }
        return `${location.origin}/${code.toLowerCase()}`;
    }

    function countUniqueVideoCodes(el) {
        const codes = new Set();
        el.querySelectorAll('a[href]').forEach(link => {
            const href = link.getAttribute('href');
            if (!isVideoUrl(href)) return;
            const c = extractCode(href);
            if (c) codes.add(c);
        });
        return codes.size;
    }

    function findVideoCard(a, img) {
        const STOP_TAGS = new Set(['BODY', 'MAIN', 'SECTION', 'ASIDE', 'HEADER', 'FOOTER', 'NAV']);

        let el = a;
        for (let i = 0; i < 6 && el && el.parentElement; i++) {
            const parent = el.parentElement;
            if (STOP_TAGS.has(parent.tagName)) break;

            const display = getComputedStyle(parent).display;
            if (parent.classList.contains('grid') || display === 'grid' || display === 'inline-grid') {
                if (!el.querySelector('h1, video, iframe') && countUniqueVideoCodes(el) <= 1) {
                    return el;
                }
                break;
            }
            el = parent;
        }

        let best = a;
        let curr = a.parentElement;
        for (let i = 0; i < 4 && curr; i++) {
            if (STOP_TAGS.has(curr.tagName) || curr.querySelector('h1, video, iframe')) break;
            if (countUniqueVideoCodes(curr) > 1) break;
            best = curr;
            curr = curr.parentElement;
        }

        return best || img.parentElement || a;
    }

    function parseCodesFromPlaylistDoc(doc) {
        const root = doc.querySelector('main') || doc.body;
        const clone = root.cloneNode(true);
        clone.querySelectorAll('header, nav, footer, aside').forEach(el => el.remove());

        const grids = Array.from(clone.querySelectorAll('.grid')).filter(g => g.querySelector('a img'));
        const scope = grids.length > 0 ? grids[0] : clone;

        const codes = [];
        const urls = {};
        const seenInPage = new Set();

        scope.querySelectorAll('a[href]').forEach(a => {
            const hrefAttr = a.getAttribute('href');
            if (!isVideoUrl(hrefAttr)) return;
            const img = a.querySelector('img');
            const code =
                extractCode(hrefAttr) ||
                extractCode(img?.getAttribute('alt') || '') ||
                extractCode(a.textContent || '');

            if (code && !seenInPage.has(code)) {
                seenInPage.add(code);
                codes.push(code);
                try {
                    urls[code] = new URL(hrefAttr, location.origin).pathname;
                } catch {}
            }
        });

        return { codes, urls };
    }

    function hasNextPage(doc, currentPage) {
        if (doc.querySelector('a[rel="next"]')) return true;
        const nextPattern = new RegExp(`[?&]page=${currentPage + 1}(?:&|$)`);
        return Array.from(doc.querySelectorAll('a[href]')).some(a =>
            nextPattern.test(a.getAttribute('href') || '')
        );
    }

    function extractPlaylistPageStats(doc) {
        const root = doc.querySelector('main') || doc.body;
        const mainText = (root?.textContent || '').replace(/\s+/g, ' ');

        let remoteTotal = null;
        const countPatterns = [
            /(?:of|共)\s*([\d,]+)\s*(?:results?|項結果|項|筆|部影片|部|個影片|个视频|件)/i,
            /\b([\d,]+)\s*(?:videos?|部影片|個影片|个视频)\b/i
        ];
        for (const regex of countPatterns) {
            const m = mainText.match(regex);
            if (m && m[1]) {
                const n = parseInt(m[1].replace(/,/g, ''), 10);
                if (!Number.isNaN(n) && n >= 0) {
                    remoteTotal = n;
                    break;
                }
            }
        }

        let maxPage = 1;
        root.querySelectorAll('a[href*="page="]').forEach(a => {
            const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
            if (m) {
                const p = parseInt(m[1], 10);
                if (p > maxPage) maxPage = p;
            }
        });

        const parsed = parseCodesFromPlaylistDoc(doc);
        const signature = parsed.codes.join(',');

        if (remoteTotal === null && maxPage === 1 && !hasNextPage(doc, 1)) {
            remoteTotal = parsed.codes.length;
        }

        return { remoteTotal, maxPage, codes: parsed.codes, urls: parsed.urls, signature };
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    async function syncSinglePlaylist(pl, onProgress, prefetchedPage1Doc = null, trigger = 'manual') {
        const prevCodesArr = GM_getValue(`${STORAGE_KEY_PREFIX}${pl.id}`, []);
        const prevSet = new Set(Array.isArray(prevCodesArr) ? prevCodesArr : []);

        const collected = new Set();
        const collectedUrls = {};
        let prevSignature = '';
        let page = 1;
        let page1Stats = null;

        while (page <= MAX_PAGES) {
            if (onProgress) onProgress(page);

            let doc;
            if (page === 1 && prefetchedPage1Doc) {
                doc = prefetchedPage1Doc;
            } else {
                const url = `${location.origin}/playlists/${pl.id}?page=${page}`;
                const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const html = await res.text();
                doc = new DOMParser().parseFromString(html, 'text/html');
            }

            let parsed;
            if (page === 1) {
                page1Stats = extractPlaylistPageStats(doc);
                parsed = { codes: page1Stats.codes, urls: page1Stats.urls };
            } else {
                parsed = parseCodesFromPlaylistDoc(doc);
            }

            const signature = parsed.codes.join(',');
            if (parsed.codes.length === 0 || signature === prevSignature) {
                break;
            }

            prevSignature = signature;
            parsed.codes.forEach(c => collected.add(c));
            Object.assign(collectedUrls, parsed.urls);

            if (!hasNextPage(doc, page)) {
                break;
            }

            page++;
            await sleep(REQUEST_DELAY_MS);
        }

        if (collected.size === 0) {
            throw new Error('未抓到任何番號（請確認片單 ID 正確且有權限存取）');
        }

        Object.assign(codeUrlMap, collectedUrls);
        saveCodeUrlMap();

        const newArr = Array.from(collected);
        const nowStr = formatTimestamp();
        GM_setValue(`${STORAGE_KEY_PREFIX}${pl.id}`, newArr);
        GM_setValue(`${META_KEY_PREFIX}${pl.id}`, {
            updatedAt: nowStr,
            pages: page,
            count: collected.size,
            remoteTotal: page1Stats ? page1Stats.remoteTotal : collected.size,
            maxPage: page1Stats ? page1Stats.maxPage : page,
            page1Sig: page1Stats ? page1Stats.signature : ''
        });

        const added = prevSet.size > 0 ? newArr.filter(c => !prevSet.has(c)) : [];
        const removed = prevSet.size > 0 ? Array.from(prevSet).filter(c => !collected.has(c)) : [];

        if (added.length > 0 || removed.length > 0) {
            diffHistory = loadDiffHistory();
            diffHistory.unshift({
                id: `${Date.now()}_${pl.id}`,
                ts: Date.now(),
                time: nowStr,
                playlistId: pl.id,
                playlistName: pl.name,
                playlistColor: pl.color || '#10b981',
                trigger,
                added,
                removed,
                totalAfter: collected.size
            });
            saveDiffHistory();

            const tagMap = { manual: '[手動] ', auto: '[自動] ', native: '[站內操作觸發] ' };
            const parts = [];
            if (added.length > 0) {
                const sample = added.slice(0, 5).join(', ') + (added.length > 5 ? ` 等 ${added.length} 部` : '');
                parts.push(`新增 +${added.length} (${sample})`);
            }
            if (removed.length > 0) {
                const sample = removed.slice(0, 5).join(', ') + (removed.length > 5 ? ` 等 ${removed.length} 部` : '');
                parts.push(`消失/移除 -${removed.length} (${sample})`);
            }
            addLog('diff', `片單變動 [${pl.name}]`, `${tagMap[trigger] || ''}${parts.join('｜')}｜目前共 ${collected.size} 部`);
        }

        return { count: collected.size, added, removed, isFirstSync: prevSet.size === 0 };
    }

    async function syncAllPlaylists() {
        if (playlists.length === 0) {
            alert('目前尚未設定任何片單，請先點擊「⚙️ 設定」新增片單。');
            return;
        }
        if (isSyncBusy || !panelSyncBtn) return;

        isSyncBusy = true;
        panelSyncBtn.disabled = true;
        const errors = [];
        const summaries = [];

        try {
            for (let i = 0; i < playlists.length; i++) {
                const pl = playlists[i];
                try {
                    const res = await syncSinglePlaylist(pl, (page) => {
                        panelSyncBtn.textContent = `同步 [${pl.name}] P${page}`;
                    }, null, 'manual');
                    summaries.push(`${pl.name}:${res.count}部`);
                } catch (err) {
                    console.error(`[MissAV 片單同步失敗: ${pl.name}(${pl.id})]`, err);
                    errors.push(`• ${pl.name} (${pl.id})：${err.message}`);
                    addLog('error', `手動同步失敗 [${pl.name}]`, `片單 ${pl.id} 同步發生錯誤：${err.message}`);
                }

                if (i < playlists.length - 1) {
                    await sleep(REQUEST_DELAY_MS);
                }
            }

            GM_setValue(LAST_CHECK_KEY, Date.now());
            loadAllSavedCodes();
            updateStatusDisplay();
            markPageVideos(true);

            addLog('manual', '手動同步全部片單', `完成同步 ${playlists.length - errors.length}/${playlists.length} 個片單（${summaries.join('、') || '無成功項目'}）`);

            if (errors.length > 0) {
                alert(`部分片單同步失敗：\n${errors.join('\n')}\n\n其餘片單已更新完成。`);
                panelSyncBtn.textContent = '🔄 同步';
            } else {
                panelSyncBtn.textContent = `✓ 已同步`;
                setTimeout(() => {
                    if (!isSyncBusy && panelSyncBtn) panelSyncBtn.textContent = '🔄 同步';
                }, 2500);
            }
        } finally {
            isSyncBusy = false;
            if (panelSyncBtn) panelSyncBtn.disabled = false;
        }
    }

    // 自動偵測與同步（同時服務「定時背景偵測」與「站內原生收藏操作觸發」）
    async function autoCheckAndUpdatePlaylists(options = {}) {
        const {
            forceCheck = false,
            targetIds = null,     // Array<string> 或 null（null 表示全部）
            reason = 'interval',  // 'interval' | 'native'
            sourceHint = ''
        } = typeof options === 'boolean' ? { forceCheck: options } : options;

        if (playlists.length === 0 || isSyncBusy) return;
        if (reason === 'interval' && !autoSyncCfg.enabled) return;
        if (reason === 'native' && !uiPrefs.watchNativePlaylist) return;

        const now = Date.now();
        const lastCheck = GM_getValue(LAST_CHECK_KEY, 0);
        const intervalMs = autoSyncCfg.intervalMin * 60 * 1000;

        const curPlId = getCurrentPagePlaylistId();
        const curPageParam = new URLSearchParams(location.search).get('page');
        const isCurrentPlaylistPage1 = Boolean(curPlId) && (!curPageParam || curPageParam === '1');
        const currentPagePlaylist = isCurrentPlaylistPage1
            ? playlists.find(pl => pl.id.toLowerCase() === curPlId.toLowerCase())
            : null;

        let targets = [];
        if (reason === 'native') {
            if (Array.isArray(targetIds) && targetIds.length > 0) {
                const idSet = new Set(targetIds.map(id => id.toLowerCase()));
                targets = playlists.filter(pl => idSet.has(pl.id.toLowerCase()));
            }
            if (targets.length === 0) {
                targets = [...playlists];
            }
        } else {
            const shouldCheckAll = forceCheck || (now - lastCheck >= intervalMs);
            if (!shouldCheckAll && !currentPagePlaylist) return;
            if (shouldCheckAll) GM_setValue(LAST_CHECK_KEY, now);
            targets = shouldCheckAll ? playlists : [currentPagePlaylist];
        }

        isSyncBusy = true;
        if (panelSyncBtn) {
            panelSyncBtn.disabled = true;
            panelSyncBtn.textContent = reason === 'native' ? '⚡ 即時同步中...' : '🔍 偵測中...';
        }

        const updatedNames = [];
        const triggerTag = reason === 'native' ? 'native' : 'auto';

        try {
            for (let i = 0; i < targets.length; i++) {
                const pl = targets[i];
                try {
                    let doc1 = null;
                    // 若為站內原生操作觸發，一律向伺服器拉最新第 1 頁，避免讀到未更新的 DOM
                    if (reason !== 'native' && currentPagePlaylist && currentPagePlaylist.id === pl.id) {
                        doc1 = document;
                    } else {
                        const res = await fetch(`${location.origin}/playlists/${pl.id}?page=1`, {
                            credentials: 'include',
                            cache: 'no-store'
                        });
                        if (!res.ok) continue;
                        const html = await res.text();
                        doc1 = new DOMParser().parseFromString(html, 'text/html');
                    }

                    const stats = extractPlaylistPageStats(doc1);
                    if (stats.codes.length === 0) continue;

                    const savedSet = playlistCodesMap.get(pl.id) || new Set();
                    const meta = GM_getValue(`${META_KEY_PREFIX}${pl.id}`, null);

                    const countChanged =
                        stats.remoteTotal !== null &&
                        (meta && meta.remoteTotal !== undefined && meta.remoteTotal !== null
                            ? stats.remoteTotal !== meta.remoteTotal
                            : stats.remoteTotal !== savedSet.size);

                    const pagesChanged = Boolean(meta && meta.maxPage && stats.maxPage !== meta.maxPage);
                    const page1Changed = Boolean(!meta || !meta.page1Sig || stats.signature !== meta.page1Sig);
                    const needsSync = savedSet.size === 0 || countChanged || pagesChanged || page1Changed;

                    if (needsSync) {
                        await syncSinglePlaylist(
                            pl,
                            (page) => {
                                if (panelSyncBtn) panelSyncBtn.textContent = `同步[${pl.name}] P${page}`;
                            },
                            doc1,
                            triggerTag
                        );
                        updatedNames.push(pl.name);
                    }
                } catch (err) {
                    console.warn(`[MissAV 自動偵測略過: ${pl.name}(${pl.id})]`, err);
                    addLog('error', `自動偵測異常 [${pl.name}]`, `背景檢查失敗：${err.message}`);
                }

                if (i < targets.length - 1) {
                    await sleep(REQUEST_DELAY_MS);
                }
            }

            if (updatedNames.length > 0) {
                loadAllSavedCodes();
                updateStatusDisplay();
                markPageVideos(true);
                const actionTitle = reason === 'native' ? '站內收藏即時自動同步' : '背景自動偵測並更新';
                const extraHint = sourceHint ? `（來源：${sourceHint}）` : '';
                addLog('auto', actionTitle, `偵測 ${targets.length} 個片單，已自動更新：${updatedNames.join('、')}${extraHint}`);
                if (reason === 'native') {
                    showToast(`⚡ 已即時同步更新：${updatedNames.join('、')}`);
                }
                if (panelSyncBtn) {
                    panelSyncBtn.textContent = `✓ 自動更新(${updatedNames.length})`;
                    setTimeout(() => {
                        if (!isSyncBusy && panelSyncBtn) panelSyncBtn.textContent = '🔄 同步';
                    }, 3000);
                }
            } else {
                if (reason === 'native') {
                    addLog('auto', '站內操作觸發偵測', `已檢查 ${targets.length} 個片單（${sourceHint || '站內動作'}），片單內容尚未變動`);
                } else {
                    addLog('auto', '背景自動偵測完成', `已檢查 ${targets.length} 個片單，數量與內容皆無變動`);
                }
                if (panelSyncBtn) {
                    panelSyncBtn.textContent = '🔄 同步';
                }
            }
        } finally {
            isSyncBusy = false;
            if (panelSyncBtn) panelSyncBtn.disabled = false;
        }
    }

    // ================= 即時監聽站內「加入／移除片單」操作 =================
    function scheduleNativePlaylistSync(sourceLabel, matchedIds = []) {
        if (!uiPrefs.watchNativePlaylist || playlists.length === 0) return;

        // 合併防抖期間偵測到的目標片單 ID
        if (matchedIds.length > 0) {
            if (nativePendingTargets === null && !nativeSyncTimer) {
                nativePendingTargets = new Set(matchedIds);
            } else if (nativePendingTargets instanceof Set) {
                matchedIds.forEach(id => nativePendingTargets.add(id));
            }
        } else {
            // 若無法鎖定單一片單，則升級為檢查全部片單
            nativePendingTargets = null;
        }
        nativePendingSource = sourceLabel || nativePendingSource || '站內片單操作';

        const isFirstSchedule = !nativeSyncTimer;
        clearTimeout(nativeSyncTimer);

        if (isFirstSchedule) {
            showToast('⚡ 偵測到片單變更，即將自動同步...');
        }

        nativeSyncTimer = setTimeout(() => {
            const idsToSync = nativePendingTargets instanceof Set ? Array.from(nativePendingTargets) : null;
            const hint = nativePendingSource;
            nativeSyncTimer = null;
            nativePendingTargets = null;
            nativePendingSource = '';

            if (isSyncBusy) {
                // 若正在忙，2 秒後重試一次
                setTimeout(() => {
                    autoCheckAndUpdatePlaylists({ forceCheck: true, targetIds: idsToSync, reason: 'native', sourceHint: hint });
                }, 2000);
                return;
            }
            autoCheckAndUpdatePlaylists({ forceCheck: true, targetIds: idsToSync, reason: 'native', sourceHint: hint });
        }, NATIVE_SYNC_DELAY_MS);
    }

    function detectTargetPlaylistIdsFromText(text) {
        if (!text) return [];
        const lower = String(text).toLowerCase();
        const hits = [];
        playlists.forEach(pl => {
            if (pl.id && lower.includes(pl.id.toLowerCase())) {
                hits.push(pl.id);
            } else if (pl.name && pl.name.length >= 2 && lower.includes(pl.name.toLowerCase())) {
                hits.push(pl.id);
            }
        });
        return hits;
    }

    function installNativePlaylistWatcher() {
        // 1. 攔截頁面的 fetch 與 XMLHttpRequest（僅監聽非 GET 寫入請求，避免與腳本自身 GET 衝突）
        try {
            const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

            const inspectRequest = (urlStr, method, bodyStr) => {
                if (!uiPrefs.watchNativePlaylist || playlists.length === 0) return;
                const upperMethod = String(method || 'GET').toUpperCase();
                if (upperMethod === 'GET' || upperMethod === 'HEAD' || upperMethod === 'OPTIONS') return;

                const urlLower = String(urlStr || '').toLowerCase();
                const bodyLower = String(bodyStr || '').toLowerCase();
                const combined = `${urlLower} ${bodyLower}`;

                const directIdHits = detectTargetPlaylistIdsFromText(combined);
                const isPlaylistApi =
                    /\/(playlists?|saved|favorites?|bookmarks?)\b/i.test(urlLower) ||
                    (urlLower.includes('livewire') && /playlist|saved|favorite|toggle|add_video|remove_video/i.test(bodyLower)) ||
                    directIdHits.length > 0;

                if (isPlaylistApi) {
                    const curPlId = getCurrentPagePlaylistId();
                    const ids = directIdHits.length > 0
                        ? directIdHits
                        : (curPlId && checkIsOwnPlaylistPage() ? [curPlId] : []);
                    scheduleNativePlaylistSync(`網路請求 ${upperMethod}`, ids);
                }
            };

            if (pageWin && typeof pageWin.fetch === 'function' && !pageWin.__missavPlFetchHooked) {
                const origFetch = pageWin.fetch.bind(pageWin);
                pageWin.fetch = function (input, init) {
                    try {
                        const url = typeof input === 'string' ? input : (input?.url || '');
                        const method = init?.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET';
                        const body = typeof init?.body === 'string' ? init.body : '';
                        inspectRequest(url, method, body);
                    } catch {}
                    return origFetch(input, init);
                };
                pageWin.__missavPlFetchHooked = true;
            }

            if (pageWin && pageWin.XMLHttpRequest && !pageWin.XMLHttpRequest.prototype.__missavPlXhrHooked) {
                const origOpen = pageWin.XMLHttpRequest.prototype.open;
                const origSend = pageWin.XMLHttpRequest.prototype.send;
                pageWin.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                    this.__missavPlReqMethod = method;
                    this.__missavPlReqUrl = url;
                    return origOpen.call(this, method, url, ...rest);
                };
                pageWin.XMLHttpRequest.prototype.send = function (body) {
                    try {
                        const bodyStr = typeof body === 'string' ? body : '';
                        inspectRequest(this.__missavPlReqUrl, this.__missavPlReqMethod, bodyStr);
                    } catch {}
                    return origSend.call(this, body);
                };
                pageWin.XMLHttpRequest.prototype.__missavPlXhrHooked = true;
            }
        } catch (err) {
            console.warn('[MissAV 網路監聽初始化略過]', err);
        }

        // 2. DOM 互動監聽備援（捕捉播放頁片單選單、勾選框、以及片單頁移除按鈕點擊）
        const handleNativeInteraction = (e) => {
            if (!uiPrefs.watchNativePlaylist || playlists.length === 0) return;
            const target = e.target;
            if (!target || target.nodeType !== 1) return;
            // 排除腳本自身 UI 元件
            if (target.closest('#missav-pl-panel, .missav-pl-overlay, #missav-pl-note-widget, .missav-pl-skip-btn, .missav-pl-badge-dedup')) {
                return;
            }

            const interactive = target.closest('button, input[type="checkbox"], label, [role="button"], [role="menuitem"]');
            if (!interactive) return;

            const isVideoPage = isVideoUrl(location.href) && Boolean(extractCode(location.pathname));
            const isOwnPlPage = checkIsOwnPlaylistPage();
            if (!isVideoPage && !isOwnPlPage) return;

            const text = (interactive.textContent || '').trim().slice(0, 80);
            const attrs = [
                interactive.getAttribute('wire:click') || '',
                interactive.getAttribute('@click') || '',
                interactive.getAttribute('x-on:click') || '',
                interactive.getAttribute('aria-label') || '',
                interactive.getAttribute('title') || '',
                interactive.getAttribute('name') || '',
                interactive.getAttribute('value') || ''
            ].join(' ');
            const combined = `${text} ${attrs}`;

            const idHits = detectTargetPlaylistIdsFromText(combined);
            const inModalOrMenu = Boolean(interactive.closest('[role="dialog"], .modal, [x-show], [x-data*="playlist" i], [x-data*="save" i]'));
            const looksLikePlaylistAction =
                idHits.length > 0 ||
                /playlist|片單|片单|收藏|清單|清单|save_video|toggle_playlist/i.test(combined) ||
                (isVideoPage && interactive.tagName === 'INPUT' && interactive.type === 'checkbox' && inModalOrMenu) ||
                (isOwnPlPage && /移除|刪除|删除|remove|delete/i.test(combined));

            if (looksLikePlaylistAction) {
                const curPlId = getCurrentPagePlaylistId();
                const ids = idHits.length > 0 ? idHits : (isOwnPlPage && curPlId ? [curPlId] : []);
                scheduleNativePlaylistSync(`頁面點擊 (${text.slice(0, 18) || interactive.tagName})`, ids);
            }
        };

        document.addEventListener('click', handleNativeInteraction, true);
        document.addEventListener('change', handleNativeInteraction, true);
    }

    function resolveEffectiveAction(matchedPlaylists, isSkipped) {
        const rank = { normal: 0, dim: 1, hide: 2 };
        let act = matchedPlaylists.length > 0 ? normalizeAction(matchedPlaylists[0].action) : 'normal';
        if (isSkipped) {
            const skipAct = normalizeAction(uiPrefs.skipAction);
            if (rank[skipAct] > rank[act]) {
                act = skipAct;
            }
        }
        return act;
    }

    function handleToggleSkip(code) {
        const alreadySkipped = skippedCodes.has(code);
        if (alreadySkipped) {
            if (uiPrefs.skipConfirm) {
                if (!confirm(`確定要將「${code}」移出本機「已略過」清單嗎？`)) return;
            }
            skippedCodes.delete(code);
            saveSkippedCodes();
            addLog('manual', '還原略過影片', `已將 ${code} 移出本機「已略過」清單`);
            showToast(`↩ 已還原：${code}`);
        } else {
            if (uiPrefs.skipConfirm) {
                const actionDesc = ACTION_LABELS[uiPrefs.skipAction] || '隱藏';
                if (!confirm(`確定要將「${code}」加入本機「已略過」清單嗎？\n（將會套用：${actionDesc}，日後可在「清單 → 🚫 已略過」還原）`)) {
                    return;
                }
            }
            skippedCodes.add(code);
            saveSkippedCodes();
            addLog('manual', '加入略過影片', `已將 ${code} 加入本機「已略過」清單（規則：${ACTION_LABELS[uiPrefs.skipAction]}）`);
            showToast(`🚫 已略過：${code}`);
        }

        updateStatusDisplay();
        markPageVideos(true);
    }

    function applySamePageDeduplication(scannedEntries) {
        document.querySelectorAll('.missav-pl-dedup-hidden').forEach(el => el.classList.remove('missav-pl-dedup-hidden'));
        document.querySelectorAll('.missav-pl-dedup-expanded').forEach(el => el.classList.remove('missav-pl-dedup-expanded'));
        document.querySelectorAll('.missav-pl-badge-dedup').forEach(el => el.remove());

        if (!uiPrefs.dedupEnabled || checkIsOwnPlaylistPage()) return;

        const order = (DEDUP_PRESETS[uiPrefs.dedupPreset] || DEDUP_PRESETS.zh_leak_orig).order;
        const gridIdMap = new WeakMap();
        let gridSeq = 0;

        const groups = new Map();
        scannedEntries.forEach(entry => {
            if (!entry.card || !entry.card.parentElement) return;
            const parent = entry.card.parentElement;
            if (!gridIdMap.has(parent)) {
                gridIdMap.set(parent, ++gridSeq);
            }
            const key = `${gridIdMap.get(parent)}::${entry.code}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            if (!groups.get(key).some(x => x.card === entry.card)) {
                groups.get(key).push(entry);
            }
        });

        let hiddenTotal = 0;
        const dedupedCodes = [];

        groups.forEach((items, groupKey) => {
            if (items.length < 2) return;

            items.sort((a, b) => {
                const ra = order.indexOf(a.version);
                const rb = order.indexOf(b.version);
                return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
            });

            const kept = items[0];
            const duplicates = items.slice(1);
            const isExpanded = expandedDedupGroups.has(groupKey);

            duplicates.forEach(d => {
                if (isExpanded) {
                    d.card.classList.add('missav-pl-dedup-expanded');
                } else {
                    d.card.classList.add('missav-pl-dedup-hidden');
                    hiddenTotal++;
                }
            });

            dedupedCodes.push(kept.code);

            let badgeGroup = kept.container.querySelector('.missav-pl-badge-group');
            if (!badgeGroup) {
                badgeGroup = document.createElement('div');
                badgeGroup.className = 'missav-pl-badge-group';
                kept.container.appendChild(badgeGroup);
            }

            const otherVers = duplicates.map(d => VERSION_LABELS[d.version] || d.version).join('、');
            const dedupBadge = document.createElement('div');
            dedupBadge.className = 'missav-pl-badge missav-pl-badge-dedup';
            dedupBadge.textContent = isExpanded ? `📑 收合重複 (${duplicates.length})` : `📑 +${duplicates.length}版`;
            dedupBadge.title = `保留：${VERSION_LABELS[kept.version]}｜其他版本：${otherVers}\n點擊可展開或隱藏其他版本`;
            dedupBadge.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (expandedDedupGroups.has(groupKey)) {
                    expandedDedupGroups.delete(groupKey);
                } else {
                    expandedDedupGroups.add(groupKey);
                }
                markPageVideos(true);
            });
            badgeGroup.appendChild(dedupBadge);
        });

        const sig = `${location.pathname}|${hiddenTotal}|${dedupedCodes.sort().join(',')}`;
        if (hiddenTotal > 0 && sig !== lastLoggedDedupSig) {
            lastLoggedDedupSig = sig;
            const sample = dedupedCodes.slice(0, 5).join(', ') + (dedupedCodes.length > 5 ? '...' : '');
            addLog('auto', '同頁多版本自動去重', `本頁自動隱藏 ${hiddenTotal} 張重複版本封面（偏好：${DEDUP_PRESETS[uiPrefs.dedupPreset].label}｜番號：${sample}）`);
        }
    }

    function markPageVideos(forceRefresh = false) {
        if (forceRefresh) {
            document.querySelectorAll('.missav-pl-badge-group, .missav-pl-title-badge, .missav-pl-title-skip-btn, .missav-pl-skip-btn').forEach(el => el.remove());
            document.querySelectorAll('.missav-pl-matched-box').forEach(el => {
                el.classList.remove('missav-pl-matched-box');
                el.style.removeProperty('--missav-pl-color');
            });
            document.querySelectorAll('.missav-pl-matched-card').forEach(el => {
                el.classList.remove('missav-pl-matched-card');
                delete el.dataset.missavCardAction;
            });
            document.querySelectorAll('.missav-pl-card-scanned').forEach(el => {
                el.classList.remove('missav-pl-card-scanned');
            });
        }

        const scannedEntries = [];
        const links = document.querySelectorAll('a[href]');

        links.forEach(a => {
            if (a.closest('header, nav, footer, .plyr, #player, #missav-pl-note-widget, #missav-pl-panel, .missav-pl-overlay')) return;
            const img = a.querySelector('img');
            if (!img) return;
            if (!isVideoUrl(a.href)) return;

            const imgRect = img.getBoundingClientRect();
            if (imgRect.width > 0 && (imgRect.width < 110 || imgRect.height < 65)) return;

            const code =
                extractCode(new URL(a.href).pathname) ||
                extractCode(img.alt || '') ||
                extractCode(a.textContent || '');

            if (!code) return;

            const card = findVideoCard(a, img);
            if (card) {
                card.classList.add('missav-pl-card-scanned');
            }

            // 避開 <picture> 等無尺寸內聯包裝元素，確保按鈕準確錨定在縮圖外框右上角
            let container = img.parentElement || a;
            if (container && container.tagName === 'PICTURE') {
                container = container.parentElement || a;
            }
            const cs = getComputedStyle(container);
            if (cs.position === 'static') {
                container.style.position = 'relative';
            }
            if (cs.display === 'inline') {
                container.style.display = 'block';
            }

            scannedEntries.push({
                code,
                card,
                container,
                href: a.href,
                version: detectVersionType(a.href, card ? card.textContent : a.textContent)
            });

            const matchedPlaylists = codeToPlaylists.get(code) || [];
            const isSkipped = skippedCodes.has(code);
            const noteEntry = getNoteEntry(code);

            if (uiPrefs.skipEnabled && !container.querySelector('.missav-pl-skip-btn')) {
                const skipBtn = document.createElement('button');
                skipBtn.type = 'button';
                skipBtn.className = `missav-pl-skip-btn${isSkipped ? ' is-skipped' : ''}`;
                skipBtn.textContent = isSkipped ? '↩' : '✕';
                skipBtn.title = isSkipped
                    ? `點擊將 ${code} 移出「已略過」清單`
                    : `點擊將 ${code} 加入本機「已略過」清單`;
                skipBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    handleToggleSkip(code);
                });
                container.appendChild(skipBtn);
            }

            const hasPlaylistOrSkip = matchedPlaylists.length > 0 || isSkipped;
            if (!hasPlaylistOrSkip && !noteEntry) return;

            if (hasPlaylistOrSkip && card) {
                card.classList.add('missav-pl-matched-card');
                card.dataset.missavCardAction = resolveEffectiveAction(matchedPlaylists, isSkipped);
            }

            if (container.querySelector('.missav-pl-badge-group')) return;

            if (hasPlaylistOrSkip) {
                const primaryColor = matchedPlaylists.length > 0 ? (matchedPlaylists[0].color || '#10b981') : '#71717a';
                container.style.setProperty('--missav-pl-color', primaryColor);
                container.classList.add('missav-pl-matched-box');
            }

            const badgeGroup = document.createElement('div');
            badgeGroup.className = 'missav-pl-badge-group';

            matchedPlaylists.forEach(pl => {
                const badge = document.createElement('div');
                badge.className = 'missav-pl-badge';
                badge.style.backgroundColor = pl.color || '#10b981';
                badge.textContent = `★ ${pl.name}`;
                badge.title = `片單：${pl.name}（${pl.id}）｜規則：${ACTION_LABELS[pl.action || 'normal']}｜番號：${code}`;
                badgeGroup.appendChild(badge);
            });

            if (noteEntry) {
                const bmCount = noteEntry.bookmarks.length;
                const noteBadge = document.createElement('div');
                noteBadge.className = 'missav-pl-badge missav-pl-badge-note';
                noteBadge.textContent = bmCount > 0 ? `📝 ${bmCount}書籤` : '📝 筆記';
                const bmPreview = noteEntry.bookmarks.map(b => `${formatSeconds(b.time)}${b.label ? ' ' + b.label : ''}`).join(' / ');
                noteBadge.title = [noteEntry.note ? `筆記：${noteEntry.note}` : '', bmPreview ? `時間點：${bmPreview}` : ''].filter(Boolean).join('\n');
                badgeGroup.appendChild(noteBadge);
            }

            if (isSkipped) {
                const skipBadge = document.createElement('div');
                skipBadge.className = 'missav-pl-badge missav-pl-badge-skipped';
                skipBadge.textContent = '🚫 已略過';
                skipBadge.title = `本機已略過｜番號：${code}`;
                badgeGroup.appendChild(skipBadge);
            }

            container.appendChild(badgeGroup);
        });

        applySamePageDeduplication(scannedEntries);

        const pageCode = extractCode(location.pathname);
        if (pageCode && isVideoUrl(location.href)) {
            const matchedPlaylists = codeToPlaylists.get(pageCode) || [];
            const isSkipped = skippedCodes.has(pageCode);
            const h1 = document.querySelector('h1');
            if (h1) {
                if (!h1.querySelector('.missav-pl-title-badge') && matchedPlaylists.length > 0) {
                    matchedPlaylists.forEach(pl => {
                        const titleBadge = document.createElement('span');
                        titleBadge.className = 'missav-pl-title-badge';
                        titleBadge.style.backgroundColor = pl.color || '#10b981';
                        titleBadge.textContent = `★ ${pl.name}`;
                        h1.appendChild(titleBadge);
                    });
                }

                // 確保「加入已略過」按鈕永遠位於標題與所有片單標籤（如 ★ 主片單）的最右邊
                let titleSkipBtn = h1.querySelector('.missav-pl-title-skip-btn');
                if (!titleSkipBtn) {
                    titleSkipBtn = document.createElement('button');
                    titleSkipBtn.type = 'button';
                    titleSkipBtn.className = 'missav-pl-title-skip-btn';
                    titleSkipBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleToggleSkip(pageCode);
                    });
                }
                titleSkipBtn.classList.toggle('is-skipped', isSkipped);
                titleSkipBtn.textContent = isSkipped ? '🚫 已略過（點擊還原）' : '🚫 加入已略過';
                titleSkipBtn.title = isSkipped
                    ? `目前已加入「已略過」，點擊將 ${pageCode} 移出還原`
                    : `點擊將 ${pageCode} 加入本機「已略過」清單`;
                h1.appendChild(titleSkipBtn);
            }
        }

        updatePageStatsDisplay();
    }

    // ================= 單片播放頁：時間點書籤與筆記 Widget =================
    function injectVideoNoteWidget() {
        if (!isVideoUrl(location.href)) return;
        const pageCode = extractCode(location.pathname);
        if (!pageCode) return;
        if (document.getElementById('missav-pl-note-widget')) return;

        const h1 = document.querySelector('h1');
        if (!h1) return;

        if (codeUrlMap[pageCode] !== location.pathname) {
            codeUrlMap[pageCode] = location.pathname;
            saveCodeUrlMap();
        }

        const widget = document.createElement('div');
        widget.id = 'missav-pl-note-widget';
        widget.innerHTML = `
            <div class="missav-pl-note-head">
                <span class="missav-pl-note-title">📝 時間點書籤與簡短筆記（${escapeHtml(pageCode)}）</span>
                <span id="missav-pl-note-updated" style="font-size:11px;color:#a1a1aa;"></span>
            </div>
            <div class="missav-pl-bm-list" id="missav-pl-bm-list"></div>
            <div class="missav-pl-note-row">
                <button type="button" id="missav-pl-bm-grab" class="missav-pl-note-btn">⏱ 抓目前時間</button>
                <input type="text" id="missav-pl-bm-time" placeholder="例如 28:40" style="width:96px !important;" />
                <input type="text" id="missav-pl-bm-label" placeholder="標籤說明（選填，如：高潮/段落）" style="flex:1 1 140px !important;min-width:120px !important;" />
                <button type="button" id="missav-pl-bm-add" class="missav-pl-note-btn purple">＋ 加書籤</button>
            </div>
            <div class="missav-pl-note-row">
                <textarea id="missav-pl-note-text" rows="2" placeholder="在這裡記下這部片的簡短筆記或心得..." style="flex:1 1 220px !important;min-width:160px !important;resize:vertical;"></textarea>
                <button type="button" id="missav-pl-note-save" class="missav-pl-note-btn green">💾 儲存筆記</button>
            </div>
        `;

        const isSafeBlock = (el) => {
            if (!el || el.nodeType !== 1) return false;
            if (['BODY', 'HTML', 'MAIN', 'HEADER', 'FOOTER', 'NAV'].includes(el.tagName)) return false;
            if (el.querySelector('video, iframe, aside, nav, header, footer')) return false;
            if (countUniqueVideoCodes(el) >= 3) return false;
            if (el.getBoundingClientRect().height > 800) return false;
            return true;
        };

        // 1. 往上跳出同時包住標題、片單按鈕與展開選單的互動容器（Alpine / Livewire 區塊）
        let anchor = h1;
        while (anchor.parentElement && isSafeBlock(anchor.parentElement)) {
            anchor = anchor.parentElement;
        }

        // 2. 若片單按鈕列或點擊後展開的片單選項是緊接在後的兄弟節點，一併往後略過
        let skipped = 0;
        while (skipped < 4 && anchor.nextElementSibling) {
            const next = anchor.nextElementSibling;
            if (!isSafeBlock(next)) break;

            const textPreview = (next.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const attrPreview = [
                next.getAttribute('x-data') || '',
                next.getAttribute('x-show') || '',
                next.getAttribute('wire:id') || '',
                next.getAttribute('class') || ''
            ].join(' ');

            const isActionOrPlaylistSibling =
                next.hasAttribute('x-show') ||
                next.hasAttribute('x-data') ||
                next.hasAttribute('wire:id') ||
                Boolean(next.querySelector('[x-show], [wire\\:click], input[type="checkbox"], form')) ||
                /playlist|片單|片单|收藏|清單|清单|save/i.test(`${attrPreview} ${textPreview}`) ||
                (Boolean(next.querySelector('button')) && textPreview.length < 160);

            if (!isActionOrPlaylistSibling) break;
            anchor = next;
            skipped++;
        }

        anchor.insertAdjacentElement('afterend', widget);

        const bmListEl = widget.querySelector('#missav-pl-bm-list');
        const updatedEl = widget.querySelector('#missav-pl-note-updated');
        const timeInput = widget.querySelector('#missav-pl-bm-time');
        const labelInput = widget.querySelector('#missav-pl-bm-label');
        const noteTextEl = widget.querySelector('#missav-pl-note-text');

        function persistEntry(note, bookmarks) {
            const trimmed = (note || '').trim();
            const cleanBms = [...bookmarks].sort((a, b) => a.time - b.time);
            if (!trimmed && cleanBms.length === 0) {
                delete notesMap[pageCode];
            } else {
                notesMap[pageCode] = {
                    note: trimmed,
                    bookmarks: cleanBms,
                    updatedAt: formatTimestamp()
                };
            }
            saveNotesMap();
            updateStatusDisplay();
        }

        function renderWidgetState() {
            const entry = getNoteEntry(pageCode) || { note: '', bookmarks: [], updatedAt: '' };
            updatedEl.textContent = entry.updatedAt ? `更新於 ${entry.updatedAt}` : '尚未建立書籤或筆記';
            if (document.activeElement !== noteTextEl) {
                noteTextEl.value = entry.note;
            }

            bmListEl.innerHTML = '';
            if (entry.bookmarks.length === 0) {
                bmListEl.innerHTML = '<span style="font-size:12px;color:#71717a;">尚無時間點書籤（點擊下方「抓目前時間」即可快速標記精彩片段）</span>';
                return;
            }

            entry.bookmarks.forEach((bm, idx) => {
                const chip = document.createElement('span');
                chip.className = 'missav-pl-bm-chip';

                const jumpBtn = document.createElement('button');
                jumpBtn.type = 'button';
                jumpBtn.className = 'missav-pl-bm-jump';
                jumpBtn.textContent = `▶ ${formatSeconds(bm.time)}${bm.label ? ` ${bm.label}` : ''}`;
                jumpBtn.title = `點擊直接跳轉影片至 ${formatSeconds(bm.time)}`;
                const findMainVideoPlayer = () => {
                    const videos = [];
                    const collectFromRoot = (root) => {
                        if (!root || !root.querySelectorAll) return;
                        root.querySelectorAll('video').forEach((v) => videos.push(v));
                        root.querySelectorAll('*').forEach((el) => {
                            if (el.shadowRoot) collectFromRoot(el.shadowRoot);
                        });
                    };

                    collectFromRoot(document);
                    document.querySelectorAll('iframe').forEach((ifr) => {
                        try {
                            if (ifr.contentDocument) collectFromRoot(ifr.contentDocument);
                        } catch {}
                    });

                    // 檢查 Plyr 實例綁定的主媒體元素
                    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                    const plyrInst = document.querySelector('.plyr')?.plyr || pageWin?.player;
                    if (plyrInst?.media && plyrInst.media.tagName === 'VIDEO' && !videos.includes(plyrInst.media)) {
                        videos.push(plyrInst.media);
                    }

                    if (videos.length === 0) return null;

                    // 依「是否已有播放進度、正在播放、片長大於 1 分鐘、畫面尺寸大」評分，排除廣告與小預覽影片
                    let bestVideo = videos[0];
                    let bestScore = -Infinity;
                    videos.forEach((v) => {
                        let score = 0;
                        const rect = v.getBoundingClientRect();
                        if (v.currentTime > 0) score += 120;
                        if (!v.paused && !v.ended && v.readyState >= 2) score += 90;
                        if (Number.isFinite(v.duration) && v.duration > 60) score += 60;
                        if (v.currentSrc || v.src || v.querySelector('source')) score += 30;
                        if (rect.width >= 260 && rect.height >= 140) score += 45;
                        if (v.id === 'player' || v.closest('.plyr, [class*="player"]')) score += 35;
                        if (score > bestScore) {
                            bestScore = score;
                            bestVideo = v;
                        }
                    });
                    return bestVideo;
                };

                jumpBtn.addEventListener('click', () => {
                    const video = findMainVideoPlayer();
                    if (!video) {
                        showToast('⚠️ 尚未偵測到播放器，請先點開播放影片');
                        return;
                    }
                    try {
                        const plyr = video.closest('.plyr')?.plyr;
                        if (plyr && typeof plyr.currentTime === 'number') {
                            plyr.currentTime = bm.time;
                        } else {
                            video.currentTime = bm.time;
                        }
                        video.play?.().catch(() => {});
                        (video.closest('.plyr') || video).scrollIntoView({ behavior: 'smooth', block: 'center' });
                        showToast(`⏩ 已跳轉至 ${formatSeconds(bm.time)}${bm.label ? `（${bm.label}）` : ''}`);
                    } catch {
                        showToast('⚠️ 跳轉失敗，請先開始播放後再試');
                    }
                });

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'missav-pl-bm-del';
                delBtn.textContent = '×';
                delBtn.title = '刪除此書籤';
                delBtn.addEventListener('click', () => {
                    const cur = getNoteEntry(pageCode) || { note: '', bookmarks: [] };
                    const removedBm = cur.bookmarks[idx];
                    const nextBms = cur.bookmarks.filter((_, i) => i !== idx);
                    persistEntry(cur.note, nextBms);
                    addLog('manual', '刪除時間點書籤', `${pageCode} 移除書籤 ${formatSeconds(removedBm.time)}${removedBm.label ? ` (${removedBm.label})` : ''}`);
                    renderWidgetState();
                });

                chip.append(jumpBtn, delBtn);
                bmListEl.appendChild(chip);
            });
        }

        widget.querySelector('#missav-pl-bm-grab').addEventListener('click', () => {
            const videos = [];
            const collect = (root) => {
                if (!root || !root.querySelectorAll) return;
                root.querySelectorAll('video').forEach((v) => videos.push(v));
                root.querySelectorAll('*').forEach((el) => {
                    if (el.shadowRoot) collect(el.shadowRoot);
                });
            };
            collect(document);
            document.querySelectorAll('iframe').forEach((ifr) => {
                try {
                    if (ifr.contentDocument) collect(ifr.contentDocument);
                } catch {}
            });

            const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const plyrInst = document.querySelector('.plyr')?.plyr || pageWin?.player;
            if (plyrInst?.media && plyrInst.media.tagName === 'VIDEO' && !videos.includes(plyrInst.media)) {
                videos.push(plyrInst.media);
            }

            // 優先挑出 currentTime > 0 且片長最長的主影片
            const playingOrProgressed = videos
                .filter((v) => Number.isFinite(v.currentTime) && v.currentTime > 0)
                .sort((a, b) => (b.duration || 0) - (a.duration || 0));

            let grabbedSec = playingOrProgressed.length > 0 ? playingOrProgressed[0].currentTime : 0;

            // 備援：若播放器時間被封裝，改從播放器畫面上的目前時間文字讀取
            if (!grabbedSec) {
                const timeDom = document.querySelector('.plyr__time--current, .vjs-current-time-display');
                const parsed = parseTimeToSeconds((timeDom?.textContent || '').replace(/^-/, '').trim());
                if (parsed && parsed > 0) grabbedSec = parsed;
            }

            if (!grabbedSec || Number.isNaN(grabbedSec)) {
                showToast('⚠️ 尚未偵測到播放進度，請先按播放讓影片跑起來');
                return;
            }

            timeInput.value = formatSeconds(grabbedSec);
            labelInput.focus();
            showToast(`⏱ 已抓取時間：${timeInput.value}`);
        });

        widget.querySelector('#missav-pl-bm-add').addEventListener('click', () => {
            const sec = parseTimeToSeconds(timeInput.value);
            if (sec === null) {
                alert('時間格式不正確，請輸入如 28:40、1:12:05 或先點「⏱ 抓目前時間」。');
                return;
            }
            const label = labelInput.value.trim();
            const cur = getNoteEntry(pageCode) || { note: noteTextEl.value, bookmarks: [] };
            const nextBms = [...cur.bookmarks, { time: sec, label }];
            persistEntry(noteTextEl.value, nextBms);
            addLog('manual', '新增時間點書籤', `${pageCode} 加入書籤 ${formatSeconds(sec)}${label ? ` (${label})` : ''}`);
            timeInput.value = '';
            labelInput.value = '';
            showToast(`✓ 已新增書籤 ${formatSeconds(sec)}`);
            renderWidgetState();
        });

        widget.querySelector('#missav-pl-note-save').addEventListener('click', () => {
            const cur = getNoteEntry(pageCode) || { note: '', bookmarks: [] };
            const nextNote = noteTextEl.value.trim();
            persistEntry(nextNote, cur.bookmarks);
            addLog('manual', '儲存單片筆記', nextNote ? `${pageCode} 更新筆記：${nextNote.slice(0, 60)}` : `${pageCode} 已清空文字筆記`);
            showToast('💾 筆記已儲存');
            renderWidgetState();
        });

        renderWidgetState();
    }

    // ================= 彈窗：片單隨機抽片（🎲） =================
    function showRandomPickerModal() {
        if (document.getElementById('missav-pl-random-modal')) return;
        if (codeToPlaylists.size === 0) {
            alert('目前片單內還沒有任何番號，請先點擊「🔄 同步」載入片單。');
            return;
        }

        let recentPicks = GM_getValue(RECENT_PICKS_KEY, []);
        if (!Array.isArray(recentPicks)) recentPicks = [];

        const modal = document.createElement('div');
        modal.id = 'missav-pl-random-modal';
        modal.className = 'missav-pl-overlay';
        modal.innerHTML = `
            <div class="missav-pl-modal-box compact">
                <div class="missav-pl-modal-header">
                    <div class="missav-pl-modal-title">🎲 片單隨機抽片</div>
                    <button type="button" id="missav-pl-rand-close" class="missav-pl-btn-close">關閉</button>
                </div>
                <div class="missav-pl-pref-box" style="margin-top:10px !important;">
                    <div class="missav-pl-pref-line">
                        <label style="flex:1;">
                            <span>抽選來源：</span>
                            <select id="missav-pl-rand-source" class="missav-pl-pref-select" style="flex:1;">
                                <option value="__all__">全部片單（不重複共 ${codeToPlaylists.size} 部）</option>
                                ${playlists.map(pl => `<option value="${escapeHtml(pl.id)}">${escapeHtml(pl.name)}（${playlistCodesMap.get(pl.id)?.size || 0} 部）</option>`).join('')}
                            </select>
                        </label>
                    </div>
                    <div class="missav-pl-pref-line">
                        <label>
                            <input type="checkbox" id="missav-pl-rand-excl-skip" checked />
                            <span>排除本機「已略過」的影片</span>
                        </label>
                        <label>
                            <input type="checkbox" id="missav-pl-rand-excl-recent" checked />
                            <span>避開最近剛抽過的影片</span>
                        </label>
                    </div>
                </div>

                <div class="missav-pl-random-result" id="missav-pl-rand-result"></div>

                <div class="missav-pl-settings-footer">
                    <button type="button" id="missav-pl-rand-reroll" class="missav-pl-action-btn purple">🎲 再抽一部</button>
                    <div class="missav-pl-footer-group" id="missav-pl-rand-links"></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const sourceEl = modal.querySelector('#missav-pl-rand-source');
        const exclSkipEl = modal.querySelector('#missav-pl-rand-excl-skip');
        const exclRecentEl = modal.querySelector('#missav-pl-rand-excl-recent');
        const resultEl = modal.querySelector('#missav-pl-rand-result');
        const linksEl = modal.querySelector('#missav-pl-rand-links');

        function drawOne() {
            const src = sourceEl.value;
            let pool = src === '__all__'
                ? Array.from(codeToPlaylists.keys())
                : Array.from(playlistCodesMap.get(src) || []);

            if (exclSkipEl.checked) {
                pool = pool.filter(c => !skippedCodes.has(c));
            }
            if (pool.length === 0) {
                resultEl.innerHTML = '<div style="color:#a1a1aa;">此條件下沒有可抽選的影片，請切換片單或取消排除條件。</div>';
                linksEl.innerHTML = '';
                return;
            }

            let candidates = pool;
            if (exclRecentEl.checked) {
                const fresh = pool.filter(c => !recentPicks.includes(c));
                if (fresh.length > 0) {
                    candidates = fresh;
                } else {
                    recentPicks = [];
                }
            }

            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            recentPicks = [picked, ...recentPicks.filter(c => c !== picked)].slice(0, 25);
            GM_setValue(RECENT_PICKS_KEY, recentPicks);

            const pls = codeToPlaylists.get(picked) || [];
            const noteEntry = getNoteEntry(picked);
            const directUrl = getDirectVideoUrl(picked);
            const searchUrl = `${location.origin}/search/${encodeURIComponent(picked)}`;

            const srcName = src === '__all__' ? '全部片單' : (playlists.find(p => p.id === src)?.name || src);
            addLog('manual', '隨機抽片', `從 [${srcName}] 抽出 ${picked}`);

            resultEl.innerHTML = `
                <div class="missav-pl-random-code">${escapeHtml(picked)}</div>
                <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:10px;">
                    ${pls.map(pl => `<span class="missav-pl-mini-tag" style="background:${escapeHtml(pl.color || '#10b981')};">★ ${escapeHtml(pl.name)}</span>`).join('')}
                </div>
                ${noteEntry ? `<div style="margin-top:10px;font-size:12px;color:#ddd6fe;background:rgba(124,58,237,0.16);padding:6px 10px;border-radius:6px;text-align:left;">
                    ${noteEntry.note ? `<div>📝 ${escapeHtml(noteEntry.note)}</div>` : ''}
                    ${noteEntry.bookmarks.length ? `<div style="margin-top:3px;color:#c4b5fd;">⏱ ${noteEntry.bookmarks.map(b => `${formatSeconds(b.time)}${b.label ? ' ' + escapeHtml(b.label) : ''}`).join(' ／ ')}</div>` : ''}
                </div>` : ''}
                <div style="margin-top:8px;font-size:11px;color:#71717a;">候選池共 ${candidates.length} 部影片</div>
            `;

            linksEl.innerHTML = `
                <a class="missav-pl-action-btn" href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener noreferrer">🔍 站內搜尋</a>
                <a class="missav-pl-action-btn primary" href="${escapeHtml(directUrl)}" target="_blank" rel="noopener noreferrer">▶ 前往播放 ↗</a>
            `;
        }

        modal.querySelector('#missav-pl-rand-reroll').addEventListener('click', drawOne);
        sourceEl.addEventListener('change', drawOne);
        drawOne();

        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.id === 'missav-pl-rand-close') {
                modal.remove();
            }
        });
    }

    // ================= 彈窗：操作與自動動作紀錄中心（📜 紀錄） =================
    function showLogsModal() {
        if (document.getElementById('missav-pl-logs-modal')) return;

        activityLogs = loadLogs();
        let activeCat = 'all';
        let filterText = '';

        const modal = document.createElement('div');
        modal.id = 'missav-pl-logs-modal';
        modal.className = 'missav-pl-overlay';
        modal.innerHTML = `
            <div class="missav-pl-modal-box">
                <div class="missav-pl-modal-header">
                    <div class="missav-pl-modal-title">📜 操作與自動動作紀錄</div>
                    <button type="button" id="missav-pl-logs-close" class="missav-pl-btn-close">關閉</button>
                </div>
                <div class="missav-pl-search-bar">
                    <input type="text" id="missav-pl-logs-search" class="missav-pl-search-input" placeholder="🔍 篩選紀錄關鍵字、片單名稱或番號..." />
                    <button type="button" id="missav-pl-logs-clear-q" class="missav-pl-btn-close" style="display:none !important;">清除</button>
                </div>
                <div class="missav-pl-tabs" id="missav-pl-logs-tabs"></div>
                <div class="missav-pl-modal-meta" id="missav-pl-logs-meta"></div>
                <div class="missav-pl-modal-list" id="missav-pl-logs-list"></div>
            </div>
        `;
        document.body.appendChild(modal);

        const tabsEl = modal.querySelector('#missav-pl-logs-tabs');
        const metaEl = modal.querySelector('#missav-pl-logs-meta');
        const listEl = modal.querySelector('#missav-pl-logs-list');
        const searchInput = modal.querySelector('#missav-pl-logs-search');
        const clearQBtn = modal.querySelector('#missav-pl-logs-clear-q');

        const catMap = Object.fromEntries(LOG_CATEGORIES.map(c => [c.id, c]));

        function renderLogs() {
            activityLogs = loadLogs();

            tabsEl.innerHTML = '';
            LOG_CATEGORIES.forEach(cat => {
                const cnt = cat.id === 'all'
                    ? activityLogs.length
                    : activityLogs.filter(l => l.category === cat.id).length;

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `missav-pl-tab${activeCat === cat.id ? ' active' : ''}`;
                btn.innerHTML = `
                    <span class="missav-pl-dot" style="background:${cat.color};"></span>
                    <span>${cat.label} (${cnt})</span>
                `;
                btn.addEventListener('click', () => {
                    activeCat = cat.id;
                    renderLogs();
                });
                tabsEl.appendChild(btn);
            });

            const q = filterText.toLowerCase();
            const filtered = activityLogs.filter(item => {
                if (activeCat !== 'all' && item.category !== activeCat) return false;
                if (!q) return true;
                return (
                    (item.action || '').toLowerCase().includes(q) ||
                    (item.detail || '').toLowerCase().includes(q) ||
                    (item.time || '').toLowerCase().includes(q)
                );
            });

            metaEl.innerHTML = `
                <span>顯示 <strong>${filtered.length}</strong> / ${activityLogs.length} 筆（最多保留最近 ${MAX_LOGS} 筆）</span>
                <div class="missav-pl-modal-meta-btns">
                    ${filtered.length ? '<button type="button" id="missav-pl-logs-copy" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">📋 複製目前紀錄</button>' : ''}
                    ${activityLogs.length ? '<button type="button" id="missav-pl-logs-wipe" class="missav-pl-action-btn danger" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">🗑️ 清空紀錄</button>' : ''}
                </div>
            `;

            const copyBtn = metaEl.querySelector('#missav-pl-logs-copy');
            if (copyBtn) {
                copyBtn.addEventListener('click', async () => {
                    const txt = filtered.map(l => `[${l.time}] [${catMap[l.category]?.label || l.category}] ${l.action} - ${l.detail}`).join('\n');
                    const ok = await copyToClipboard(txt);
                    copyBtn.textContent = ok ? '✓ 已複製' : '失敗';
                    setTimeout(() => { copyBtn.textContent = '📋 複製目前紀錄'; }, 1500);
                });
            }

            const wipeBtn = metaEl.querySelector('#missav-pl-logs-wipe');
            if (wipeBtn) {
                wipeBtn.addEventListener('click', () => {
                    if (!confirm(`確定要清空全部 ${activityLogs.length} 筆操作與自動紀錄嗎？`)) return;
                    activityLogs = [];
                    GM_setValue(LOGS_KEY, []);
                    renderLogs();
                });
            }

            listEl.innerHTML = '';
            if (filtered.length === 0) {
                listEl.innerHTML = '<div style="text-align:center;color:#71717a;padding:28px 0;">目前這個分類還沒有符合的紀錄。</div>';
                return;
            }

            const frag = document.createDocumentFragment();
            filtered.forEach(item => {
                const catInfo = catMap[item.category] || catMap.manual;
                const row = document.createElement('div');
                row.className = 'missav-pl-log-row';
                row.innerHTML = `
                    <div class="missav-pl-log-top">
                        <span class="missav-pl-log-time">${escapeHtml(item.time)}</span>
                        <span class="missav-pl-log-cat" style="background:${catInfo.color};">${escapeHtml(catInfo.label)}</span>
                        <span class="missav-pl-log-action">${escapeHtml(item.action)}</span>
                    </div>
                    <div class="missav-pl-log-detail">${escapeHtml(item.detail)}</div>
                `;
                frag.appendChild(row);
            });
            listEl.appendChild(frag);
        }

        let qTimer = null;
        searchInput.addEventListener('input', (e) => {
            filterText = e.target.value.trim();
            clearQBtn.style.setProperty('display', filterText ? 'inline-flex' : 'none', 'important');
            clearTimeout(qTimer);
            qTimer = setTimeout(renderLogs, 120);
        });

        clearQBtn.addEventListener('click', () => {
            filterText = '';
            searchInput.value = '';
            clearQBtn.style.setProperty('display', 'none', 'important');
            renderLogs();
            searchInput.focus();
        });

        renderLogs();

        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.id === 'missav-pl-logs-close') {
                modal.remove();
            }
        });
    }

    // ================= 備份匯出 / 匯入 =================
    function buildBackupPayload(includeCache = true) {
        const caches = {};
        if (includeCache) {
            playlists.forEach(pl => {
                const codes = GM_getValue(`${STORAGE_KEY_PREFIX}${pl.id}`, []);
                const meta = GM_getValue(`${META_KEY_PREFIX}${pl.id}`, null);
                caches[pl.id] = { codes, meta };
            });
        }
        return {
            app: 'missav-playlist-marker',
            version: 8,
            exportedAt: new Date().toISOString(),
            playlists,
            skippedCodes: Array.from(skippedCodes).sort(),
            notesMap,
            autoSyncCfg,
            uiPrefs,
            currentMode,
            diffHistory: includeCache ? diffHistory : [],
            codeUrlMap: includeCache ? codeUrlMap : {},
            caches
        };
    }

    function applyImportedBackup(rawText) {
        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            throw new Error('JSON 格式不正確，請確認有完整複製備份內容。');
        }

        const rawPlaylists = Array.isArray(parsed) ? parsed : parsed?.playlists;
        if (!Array.isArray(rawPlaylists)) {
            throw new Error('備份資料中找不到 playlists 片單設定。');
        }

        const cleaned = [];
        const seen = new Set();
        rawPlaylists.forEach((item, idx) => {
            const id = extractPlaylistId(item?.id || '');
            if (!id || seen.has(id.toLowerCase())) return;
            seen.add(id.toLowerCase());
            cleaned.push({
                id,
                name: String(item?.name || `片單 ${idx + 1}`).trim() || `片單 ${idx + 1}`,
                color: /^#[0-9a-f]{6}$/i.test(item?.color || '') ? item.color : PRESET_COLORS[idx % PRESET_COLORS.length],
                action: normalizeAction(item?.action)
            });
        });

        savePlaylistsConfig(cleaned);

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (Array.isArray(parsed.skippedCodes)) {
                skippedCodes = new Set(parsed.skippedCodes.filter(Boolean));
                saveSkippedCodes();
            }
            if (parsed.notesMap && typeof parsed.notesMap === 'object' && !Array.isArray(parsed.notesMap)) {
                notesMap = parsed.notesMap;
                saveNotesMap();
            }
            if (Array.isArray(parsed.diffHistory)) {
                diffHistory = parsed.diffHistory;
                saveDiffHistory();
            }
            if (parsed.codeUrlMap && typeof parsed.codeUrlMap === 'object' && !Array.isArray(parsed.codeUrlMap)) {
                Object.assign(codeUrlMap, parsed.codeUrlMap);
                saveCodeUrlMap();
            }
            if (parsed.autoSyncCfg) {
                saveAutoSyncConfig(parsed.autoSyncCfg);
            }
            if (parsed.uiPrefs) {
                saveUiPrefs(parsed.uiPrefs);
            }
            if (parsed.currentMode && MODES.some(m => m.id === parsed.currentMode)) {
                currentMode = parsed.currentMode;
                GM_setValue(MODE_KEY, currentMode);
            }
            if (parsed.caches && typeof parsed.caches === 'object') {
                cleaned.forEach(pl => {
                    const entry = parsed.caches[pl.id];
                    if (entry && Array.isArray(entry.codes)) {
                        GM_setValue(`${STORAGE_KEY_PREFIX}${pl.id}`, entry.codes);
                        if (entry.meta) {
                            GM_setValue(`${META_KEY_PREFIX}${pl.id}`, entry.meta);
                        }
                    }
                });
            }
        }

        loadAllSavedCodes();
        applyDisplayMode();
        markPageVideos(true);
        const notesCount = getNotedCodeCount();
        addLog('manual', '匯入備份還原', `成功還原 ${cleaned.length} 個片單、${skippedCodes.size} 部略過紀錄、${notesCount} 部筆記`);
        return { playlistsCount: cleaned.length, skippedCount: skippedCodes.size, notesCount };
    }

    // ================= 彈窗：備份匯出與匯入 =================
    function showBackupModal(onImportedCallback) {
        if (document.getElementById('missav-pl-backup-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'missav-pl-backup-modal';
        modal.className = 'missav-pl-overlay';
        modal.style.zIndex = '100001';
        modal.innerHTML = `
            <div class="missav-pl-modal-box">
                <div class="missav-pl-modal-header">
                    <div class="missav-pl-modal-title">💾 匯出／匯入完整備份</div>
                    <button type="button" id="missav-pl-bk-close" class="missav-pl-btn-close">關閉</button>
                </div>
                <div class="missav-pl-hint">
                    <strong>匯出：</strong>包含片單設定、外觀與去重偏好、本機「已略過」與所有「時間書籤／筆記」。<br>
                    <strong>匯入：</strong>貼上 JSON 或選擇備份檔後點擊「套用匯入」。
                </div>
                <div class="missav-pl-pref-box" style="margin-top:8px !important;">
                    <div class="missav-pl-pref-line">
                        <label>
                            <input type="checkbox" id="missav-pl-bk-inc-cache" checked />
                            <span>一併包含各片單番號快取、直達連結與變動歷史</span>
                        </label>
                    </div>
                </div>
                <textarea id="missav-pl-bk-text" class="missav-pl-backup-textarea" spellcheck="false"></textarea>
                <input type="file" id="missav-pl-bk-file" accept=".json,application/json" style="display:none !important;" />
                <div class="missav-pl-settings-footer">
                    <div class="missav-pl-footer-group">
                        <button type="button" id="missav-pl-bk-copy" class="missav-pl-action-btn accent">📋 複製 JSON</button>
                        <button type="button" id="missav-pl-bk-download" class="missav-pl-action-btn">⬇️ 下載檔案</button>
                    </div>
                    <div class="missav-pl-footer-group">
                        <button type="button" id="missav-pl-bk-loadfile" class="missav-pl-action-btn">📂 讀取檔案</button>
                        <button type="button" id="missav-pl-bk-import" class="missav-pl-action-btn primary">📥 套用匯入</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const textarea = modal.querySelector('#missav-pl-bk-text');
        const incCacheEl = modal.querySelector('#missav-pl-bk-inc-cache');
        const fileInput = modal.querySelector('#missav-pl-bk-file');
        const copyBtn = modal.querySelector('#missav-pl-bk-copy');

        function refreshExportText() {
            textarea.value = JSON.stringify(buildBackupPayload(incCacheEl.checked), null, 2);
        }

        refreshExportText();
        incCacheEl.addEventListener('change', refreshExportText);

        copyBtn.addEventListener('click', async () => {
            const ok = await copyToClipboard(textarea.value);
            if (ok) addLog('manual', '複製備份 JSON', `已複製備份資料（含快取：${incCacheEl.checked ? '是' : '否'}）`);
            copyBtn.textContent = ok ? '✓ 已複製' : '複製失敗';
            setTimeout(() => { copyBtn.textContent = '📋 複製 JSON'; }, 1800);
        });

        modal.querySelector('#missav-pl-bk-download').addEventListener('click', () => {
            const blob = new Blob([textarea.value], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            a.href = url;
            a.download = `missav-playlists-backup-${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            addLog('manual', '下載備份檔案', `已匯出 missav-playlists-backup-${dateStr}.json`);
        });

        modal.querySelector('#missav-pl-bk-loadfile').addEventListener('click', () => {
            fileInput.value = '';
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => { textarea.value = String(reader.result || ''); };
            reader.readAsText(file);
        });

        modal.querySelector('#missav-pl-bk-import').addEventListener('click', () => {
            const raw = textarea.value.trim();
            if (!raw) {
                alert('請先貼上備份 JSON 或讀取備份檔案。');
                return;
            }
            if (!confirm('匯入將會覆蓋目前的片單設定、外觀偏好、略過清單與筆記，確定要套用嗎？')) return;
            try {
                const res = applyImportedBackup(raw);
                alert(`匯入成功！已還原 ${res.playlistsCount} 個片單、${res.skippedCount} 部略過紀錄、${res.notesCount} 部筆記。`);
                modal.remove();
                if (typeof onImportedCallback === 'function') onImportedCallback();
            } catch (err) {
                addLog('error', '匯入備份失敗', err.message);
                alert(`匯入失敗：${err.message}`);
            }
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.id === 'missav-pl-bk-close') modal.remove();
        });
    }

    // ================= 彈窗：設定中心（⚙️） =================
    function showSettingsModal() {
        if (document.getElementById('missav-pl-settings-modal')) return;

        let draft = playlists.map(pl => ({ ...pl, action: normalizeAction(pl.action) }));

        const modal = document.createElement('div');
        modal.id = 'missav-pl-settings-modal';
        modal.className = 'missav-pl-overlay';
        modal.innerHTML = `
            <div class="missav-pl-modal-box">
                <div class="missav-pl-modal-header">
                    <div class="missav-pl-modal-title">⚙️ 片單、去重與外觀設定</div>
                    <button type="button" id="missav-pl-set-close" class="missav-pl-btn-close">關閉</button>
                </div>
                <div class="missav-pl-hint">
                    快捷鍵：<strong>Alt + H</strong> 切換「全標註」與目前規則；拖曳 <code>⋮⋮</code> 或縮小膠囊可移動浮動列。
                </div>

                <div class="missav-pl-settings-scroll">
                    <div class="missav-pl-pref-box">
                        <div class="missav-pl-pref-line">
                            <label>
                                <input type="checkbox" id="missav-pl-auto-enable" ${autoSyncCfg.enabled ? 'checked' : ''} />
                                <span>定時自動偵測片單變動</span>
                            </label>
                            <label>
                                <span>間隔：每</span>
                                <input type="number" id="missav-pl-auto-interval" min="1" max="1440" value="${autoSyncCfg.intervalMin}" />
                                <span>分鐘</span>
                            </label>
                        </div>

                        <div class="missav-pl-pref-line">
                            <label title="在影片頁加入片單或在片單頁移除影片後，自動於 2.5 秒後同步最新片單">
                                <input type="checkbox" id="missav-pl-watch-native" ${uiPrefs.watchNativePlaylist ? 'checked' : ''} />
                                <span>⚡ 監聽站內「加入／移出片單」動作並在數秒後自動秒同步</span>
                            </label>
                        </div>

                        <div class="missav-pl-pref-line">
                            <label title="移除播放器透明點擊遮罩、暫停廣告橫幅並攔截彈窗跳轉">
                                <input type="checkbox" id="missav-pl-block-ads" ${uiPrefs.blockPlayerAds ? 'checked' : ''} />
                                <span>🛡️ 去除播放器廣告與點擊跳轉遮罩</span>
                            </label>
                        </div>

                        <div class="missav-pl-pref-line">
                            <label>
                                <input type="checkbox" id="missav-pl-dedup-enable" ${uiPrefs.dedupEnabled ? 'checked' : ''} />
                                <span>同頁多版本自動去重</span>
                            </label>
                            <label>
                                <span>優先順序：</span>
                                <select id="missav-pl-dedup-preset" class="missav-pl-pref-select">
                                    ${Object.entries(DEDUP_PRESETS).map(([k, v]) => `<option value="${k}" ${uiPrefs.dedupPreset === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                                </select>
                            </label>
                        </div>

                        <div class="missav-pl-pref-line">
                            <label>
                                <span>標籤位置：</span>
                                <select id="missav-pl-badge-pos" class="missav-pl-pref-select">
                                    ${VALID_BADGE_POS.map(pos => `<option value="${pos}" ${uiPrefs.badgePos === pos ? 'selected' : ''}>${BADGE_POS_LABELS[pos]}</option>`).join('')}
                                </select>
                            </label>
                            <label>
                                <span>淡化透明度：</span>
                                <input type="range" id="missav-pl-dim-opacity" min="10" max="75" step="5" value="${Math.round(uiPrefs.dimOpacity * 100)}" />
                                <strong id="missav-pl-dim-val" style="min-width:34px;">${Math.round(uiPrefs.dimOpacity * 100)}%</strong>
                            </label>
                        </div>

                        <div class="missav-pl-pref-line">
                            <label title="若手機瀏覽器底部欄仍會蓋住浮動列，可向右拉高此數值">
                                <span>底部防遮擋留白：</span>
                                <input type="range" id="missav-pl-bottom-offset" min="0" max="120" step="4" value="${uiPrefs.bottomSafeOffset}" />
                                <strong id="missav-pl-bottom-val" style="min-width:42px;">${uiPrefs.bottomSafeOffset}px</strong>
                            </label>
                            <button type="button" id="missav-pl-reset-pos" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">📍 重置浮動列位置</button>
                        </div>

                        <div class="missav-pl-pref-line">
                            <label>
                                <input type="checkbox" id="missav-pl-skip-enable" ${uiPrefs.skipEnabled ? 'checked' : ''} />
                                <span>封面顯示「略過 (✕)」按鈕</span>
                            </label>
                            <label>
                                <span>略過效果：</span>
                                <select id="missav-pl-skip-action" class="missav-pl-pref-select">
                                    ${VALID_ACTIONS.map(act => `<option value="${act}" ${uiPrefs.skipAction === act ? 'selected' : ''}>${ACTION_LABELS[act]}</option>`).join('')}
                                </select>
                            </label>
                            <label>
                                <input type="checkbox" id="missav-pl-skip-confirm" ${uiPrefs.skipConfirm ? 'checked' : ''} />
                                <span>點擊略過前跳出確認</span>
                            </label>
                        </div>
                    </div>

                    <div id="missav-pl-settings-rows"></div>
                    <div class="missav-pl-settings-toolbar" id="missav-pl-settings-toolbar"></div>
                </div>

                <div class="missav-pl-settings-footer">
                    <div class="missav-pl-footer-group">
                        <button type="button" id="missav-pl-set-backup" class="missav-pl-action-btn warn">💾 備份／還原</button>
                    </div>
                    <div class="missav-pl-footer-group">
                        <button type="button" id="missav-pl-set-cancel" class="missav-pl-action-btn">取消</button>
                        <button type="button" id="missav-pl-set-save" class="missav-pl-action-btn accent">儲存設定</button>
                        <button type="button" id="missav-pl-set-save-sync" class="missav-pl-action-btn primary">儲存並同步</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const scrollBox = modal.querySelector('.missav-pl-settings-scroll');
        const rowsContainer = modal.querySelector('#missav-pl-settings-rows');
        const toolbarEl = modal.querySelector('#missav-pl-settings-toolbar');
        const autoEnableEl = modal.querySelector('#missav-pl-auto-enable');
        const autoIntervalEl = modal.querySelector('#missav-pl-auto-interval');
        const watchNativeEl = modal.querySelector('#missav-pl-watch-native');
        const blockAdsEl = modal.querySelector('#missav-pl-block-ads');
        const dedupEnableEl = modal.querySelector('#missav-pl-dedup-enable');
        const dedupPresetEl = modal.querySelector('#missav-pl-dedup-preset');
        const badgePosEl = modal.querySelector('#missav-pl-badge-pos');
        const dimOpacityEl = modal.querySelector('#missav-pl-dim-opacity');
        const dimValEl = modal.querySelector('#missav-pl-dim-val');
        const bottomOffsetEl = modal.querySelector('#missav-pl-bottom-offset');
        const bottomValEl = modal.querySelector('#missav-pl-bottom-val');
        const skipEnableEl = modal.querySelector('#missav-pl-skip-enable');
        const skipActionEl = modal.querySelector('#missav-pl-skip-action');
        const skipConfirmEl = modal.querySelector('#missav-pl-skip-confirm');

        dimOpacityEl.addEventListener('input', () => {
            dimValEl.textContent = `${dimOpacityEl.value}%`;
        });

        bottomOffsetEl.addEventListener('input', () => {
            const val = Number(bottomOffsetEl.value) || 0;
            bottomValEl.textContent = `${val}px`;
            clampPanelToViewport(val);
        });

        modal.querySelector('#missav-pl-reset-pos').addEventListener('click', () => {
            savePanelPos(null);
            clampPanelToViewport(Number(bottomOffsetEl.value) || 0);
            addLog('manual', '重置浮動列位置', '已將浮動控制列重置回預設右下角');
            showToast('📍 浮動列已重置回右下角');
        });

        function closeWithoutSave() {
            clampPanelToViewport();
            modal.remove();
        }

        function renderRows() {
            rowsContainer.innerHTML = '';

            if (draft.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'text-align:center;color:#71717a;font-size:12px;padding:18px 0;';
                empty.textContent = '目前沒有片單，請點擊下方「＋ 新增片單」。';
                rowsContainer.appendChild(empty);
            } else {
                draft.forEach((item, idx) => {
                    const row = document.createElement('div');
                    row.className = 'missav-pl-row';

                    const colorInput = document.createElement('input');
                    colorInput.type = 'color';
                    colorInput.className = 'missav-pl-color-input';
                    colorInput.value = item.color || PRESET_COLORS[idx % PRESET_COLORS.length];
                    colorInput.title = '選擇標籤與邊框顏色';
                    colorInput.addEventListener('input', (e) => { draft[idx].color = e.target.value; });

                    const inputsWrap = document.createElement('div');
                    inputsWrap.className = 'missav-pl-inputs';

                    const nameInput = document.createElement('input');
                    nameInput.type = 'text';
                    nameInput.className = 'missav-pl-text-input missav-pl-input-name';
                    nameInput.value = item.name;
                    nameInput.placeholder = '片單名稱（如：神作）';
                    nameInput.title = item.name || '片單名稱';
                    nameInput.addEventListener('input', (e) => {
                        draft[idx].name = e.target.value;
                        e.target.title = e.target.value;
                    });

                    const idInput = document.createElement('input');
                    idInput.type = 'text';
                    idInput.className = 'missav-pl-text-input missav-pl-input-id';
                    idInput.value = item.id;
                    idInput.placeholder = '片單 ID 或貼上片單網址';
                    idInput.title = item.id || '片單 ID';
                    idInput.addEventListener('input', (e) => {
                        draft[idx].id = e.target.value;
                        e.target.title = e.target.value;
                    });
                    idInput.addEventListener('blur', (e) => {
                        const extracted = extractPlaylistId(e.target.value);
                        if (extracted !== e.target.value) {
                            e.target.value = extracted;
                            e.target.title = extracted;
                            draft[idx].id = extracted;
                        }
                    });

                    inputsWrap.append(nameInput, idInput);

                    const actionSelect = document.createElement('select');
                    actionSelect.className = 'missav-pl-action-select';
                    actionSelect.title = '此片單在「依片單」模式下的顯示規則';
                    VALID_ACTIONS.forEach(act => {
                        const opt = document.createElement('option');
                        opt.value = act;
                        opt.textContent = ACTION_LABELS[act];
                        actionSelect.appendChild(opt);
                    });
                    actionSelect.value = normalizeAction(item.action);
                    actionSelect.addEventListener('change', (e) => { draft[idx].action = normalizeAction(e.target.value); });

                    const actions = document.createElement('div');
                    actions.className = 'missav-pl-row-actions';

                    const upBtn = document.createElement('button');
                    upBtn.type = 'button';
                    upBtn.className = 'missav-pl-icon-btn';
                    upBtn.textContent = '↑';
                    upBtn.title = '提高優先權';
                    upBtn.disabled = idx === 0;
                    upBtn.addEventListener('click', () => {
                        [draft[idx - 1], draft[idx]] = [draft[idx], draft[idx - 1]];
                        renderRows();
                    });

                    const downBtn = document.createElement('button');
                    downBtn.type = 'button';
                    downBtn.className = 'missav-pl-icon-btn';
                    downBtn.textContent = '↓';
                    downBtn.title = '降低優先權';
                    downBtn.disabled = idx === draft.length - 1;
                    downBtn.addEventListener('click', () => {
                        [draft[idx + 1], draft[idx]] = [draft[idx], draft[idx + 1]];
                        renderRows();
                    });

                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.className = 'missav-pl-icon-btn btn-del';
                    delBtn.textContent = '✕';
                    delBtn.title = '刪除此片單';
                    delBtn.addEventListener('click', () => {
                        draft.splice(idx, 1);
                        renderRows();
                    });

                    actions.append(upBtn, downBtn, delBtn);
                    row.append(colorInput, inputsWrap, actionSelect, actions);
                    rowsContainer.appendChild(row);
                });
            }

            renderToolbar();
        }

        function renderToolbar() {
            toolbarEl.innerHTML = '';

            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'missav-pl-action-btn';
            addBtn.textContent = '＋ 新增片單';
            addBtn.addEventListener('click', () => {
                draft.push({
                    id: '',
                    name: `片單 ${draft.length + 1}`,
                    color: PRESET_COLORS[draft.length % PRESET_COLORS.length],
                    action: 'normal'
                });
                renderRows();
                scrollBox.scrollTop = scrollBox.scrollHeight;
            });
            toolbarEl.appendChild(addBtn);

            const curId = getCurrentPagePlaylistId();
            const alreadyExists = curId && draft.some(d => extractPlaylistId(d.id).toLowerCase() === curId.toLowerCase());
            if (curId && !alreadyExists) {
                const pageTitle = document.querySelector('h1')?.textContent?.trim() || `片單 ${draft.length + 1}`;
                const quickAddBtn = document.createElement('button');
                quickAddBtn.type = 'button';
                quickAddBtn.className = 'missav-pl-action-btn accent';
                quickAddBtn.textContent = `＋ 帶入本頁片單 (${curId})`;
                quickAddBtn.addEventListener('click', () => {
                    draft.push({
                        id: curId,
                        name: pageTitle,
                        color: PRESET_COLORS[draft.length % PRESET_COLORS.length],
                        action: 'normal'
                    });
                    renderRows();
                    scrollBox.scrollTop = scrollBox.scrollHeight;
                });
                toolbarEl.appendChild(quickAddBtn);
            }
        }

        function validateAndSave() {
            const cleaned = [];
            const seenIds = new Set();

            for (let i = 0; i < draft.length; i++) {
                const id = extractPlaylistId(draft[i].id);
                const name = (draft[i].name || '').trim() || `片單 ${i + 1}`;
                const color = /^#[0-9a-f]{6}$/i.test(draft[i].color || '')
                    ? draft[i].color
                    : PRESET_COLORS[i % PRESET_COLORS.length];
                const action = normalizeAction(draft[i].action);

                if (!id) {
                    alert(`第 ${i + 1} 列的片單 ID 還是空的，請填寫片單 ID 或先刪除該列。`);
                    return false;
                }
                if (seenIds.has(id.toLowerCase())) {
                    alert(`片單 ID「${id}」重複了，請移除重複項目。`);
                    return false;
                }
                seenIds.add(id.toLowerCase());
                cleaned.push({ id, name, color, action });
            }

            const nextPrefs = {
                badgePos: badgePosEl.value,
                dimOpacity: Number(dimOpacityEl.value) / 100,
                skipEnabled: skipEnableEl.checked,
                skipAction: skipActionEl.value,
                skipConfirm: skipConfirmEl.checked,
                bottomSafeOffset: Number(bottomOffsetEl.value) || 0,
                dedupEnabled: dedupEnableEl.checked,
                dedupPreset: dedupPresetEl.value,
                watchNativePlaylist: watchNativeEl.checked,
                blockPlayerAds: blockAdsEl.checked
         };

            const hasCustomRule = cleaned.some(pl => pl.action !== 'normal') || (skippedCodes.size > 0 && nextPrefs.skipAction !== 'normal');
            if (hasCustomRule && currentMode === 'normal') {
                currentMode = 'custom';
                GM_setValue(MODE_KEY, currentMode);
            }

            savePlaylistsConfig(cleaned);
            saveAutoSyncConfig({
                enabled: autoEnableEl.checked,
                intervalMin: autoIntervalEl.value
            });
            saveUiPrefs(nextPrefs);

            expandedDedupGroups.clear();
            lastLoggedDedupSig = '';
            loadAllSavedCodes();
            applyDisplayMode();
            markPageVideos(true);
            clampPanelToViewport();

            addLog('manual', '儲存腳本設定', `片單 ${cleaned.length} 個｜定時偵測：${autoSyncCfg.enabled ? `每 ${autoSyncCfg.intervalMin} 分` : '關閉'}｜站內收藏秒同步：${uiPrefs.watchNativePlaylist ? '開啟' : '關閉'}｜同頁去重：${uiPrefs.dedupEnabled ? '開啟' : '關閉'}`);
            return true;
        }

        renderRows();

        modal.querySelector('#missav-pl-set-backup').addEventListener('click', () => {
            showBackupModal(() => {
                draft = playlists.map(pl => ({ ...pl, action: normalizeAction(pl.action) }));
                autoEnableEl.checked = autoSyncCfg.enabled;
                autoIntervalEl.value = autoSyncCfg.intervalMin;
                watchNativeEl.checked = uiPrefs.watchNativePlaylist;
                blockAdsEl.checked = uiPrefs.blockPlayerAds;
                dedupEnableEl.checked = uiPrefs.dedupEnabled;
                dedupPresetEl.value = uiPrefs.dedupPreset;
                badgePosEl.value = uiPrefs.badgePos;
                dimOpacityEl.value = String(Math.round(uiPrefs.dimOpacity * 100));
                dimValEl.textContent = `${dimOpacityEl.value}%`;
                bottomOffsetEl.value = String(uiPrefs.bottomSafeOffset);
                bottomValEl.textContent = `${uiPrefs.bottomSafeOffset}px`;
                skipEnableEl.checked = uiPrefs.skipEnabled;
                skipActionEl.value = uiPrefs.skipAction;
                skipConfirmEl.checked = uiPrefs.skipConfirm;
                renderRows();
            });
        });

        modal.querySelector('#missav-pl-set-save').addEventListener('click', () => {
            if (validateAndSave()) modal.remove();
        });

        modal.querySelector('#missav-pl-set-save-sync').addEventListener('click', () => {
            if (validateAndSave()) {
                modal.remove();
                if (playlists.length > 0) syncAllPlaylists();
            }
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.id === 'missav-pl-set-close' || e.target.id === 'missav-pl-set-cancel') {
                closeWithoutSave();
            }
        });
    }

    // ================= 彈窗：已收錄清單（片單 + 統計 + 筆記 + 已略過 + 重複 + 變動） =================
    function showSavedListModal(initialTab = 0) {
        if (document.getElementById('missav-pl-modal')) return;
        const specialTabs = ['__stats__', '__notes__', '__skipped__', '__duplicates__', '__diffs__'];
        if (playlists.length === 0 && skippedCodes.size === 0 && getNotedCodeCount() === 0 && diffHistory.length === 0) {
            alert('目前尚未設定任何片單或紀錄，請先點擊「⚙️ 設定」新增片單。');
            return;
        }

        let activeTab = initialTab;
        if (!specialTabs.includes(activeTab)) {
            activeTab = playlists.length > 0
                ? Math.min(Math.max(0, Number(initialTab) || 0), playlists.length - 1)
                : '__notes__';
        }
        let searchQuery = '';
        let statsScope = '__all__';
        let selectedStatsPrefix = null;

        const modal = document.createElement('div');
        modal.id = 'missav-pl-modal';
        modal.className = 'missav-pl-overlay';
        modal.innerHTML = `
            <div class="missav-pl-modal-box">
                <div class="missav-pl-modal-header">
                    <div class="missav-pl-modal-title">片單番號清單</div>
                    <button type="button" id="missav-pl-close" class="missav-pl-btn-close">關閉</button>
                </div>
                <div class="missav-pl-search-bar">
                    <input type="text" id="missav-pl-search-input" class="missav-pl-search-input" placeholder="🔍 跨片單、筆記與略過清單即時搜尋（如 ABC-243、abc243 或筆記內容）..." />
                    <button type="button" id="missav-pl-search-clear" class="missav-pl-btn-close" style="display:none !important;">清除</button>
                </div>
                <div class="missav-pl-tabs" id="missav-pl-tabs"></div>
                <div class="missav-pl-modal-meta" id="missav-pl-modal-meta"></div>
                <div class="missav-pl-modal-list" id="missav-pl-modal-list"></div>
            </div>
        `;
        document.body.appendChild(modal);

        const tabsEl = modal.querySelector('#missav-pl-tabs');
        const metaEl = modal.querySelector('#missav-pl-modal-meta');
        const listEl = modal.querySelector('#missav-pl-modal-list');
        const titleEl = modal.querySelector('.missav-pl-modal-title');
        const searchInput = modal.querySelector('#missav-pl-search-input');
        const clearBtn = modal.querySelector('#missav-pl-search-clear');

        function renderRichEntries(entries, emptyText, options = {}) {
            listEl.innerHTML = '';
            if (entries.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'text-align:center;color:#71717a;padding:24px 0;';
                empty.textContent = emptyText;
                listEl.appendChild(empty);
                return;
            }

            const frag = document.createDocumentFragment();
            const limit = Math.min(entries.length, 300);
            for (let i = 0; i < limit; i++) {
                const { code, playlists: pls = [], isSkipped = false, noteEntry = null } = entries[i];
                const row = document.createElement('div');
                row.className = 'missav-pl-rich-row';

                const left = document.createElement('div');
                left.className = 'missav-pl-rich-left';

                const codePill = document.createElement('span');
                codePill.className = 'missav-pl-code-pill';
                codePill.textContent = code;
                codePill.title = '點擊複製番號';
                codePill.addEventListener('click', async () => {
                    const ok = await copyToClipboard(code);
                    if (ok) {
                        const prev = codePill.textContent;
                        codePill.textContent = `${code} ✓`;
                        setTimeout(() => { codePill.textContent = prev; }, 1000);
                    }
                });
                left.appendChild(codePill);

                pls.forEach(pl => {
                    const tag = document.createElement('span');
                    tag.className = 'missav-pl-mini-tag';
                    tag.style.backgroundColor = pl.color || '#10b981';
                    tag.textContent = pl.name;
                    left.appendChild(tag);
                });

                if (isSkipped) {
                    const skipTag = document.createElement('span');
                    skipTag.className = 'missav-pl-mini-tag';
                    skipTag.style.backgroundColor = '#52525b';
                    skipTag.textContent = '🚫 已略過';
                    left.appendChild(skipTag);
                }

                if (noteEntry) {
                    const detailDiv = document.createElement('div');
                    detailDiv.style.cssText = 'width:100%;font-size:11px;color:#ddd6fe;margin-top:2px;';
                    const bmStr = noteEntry.bookmarks.map(b => `⏱ ${formatSeconds(b.time)}${b.label ? ' ' + b.label : ''}`).join(' ｜ ');
                    detailDiv.textContent = [noteEntry.note ? `📝 ${noteEntry.note}` : '', bmStr].filter(Boolean).join('　');
                    left.appendChild(detailDiv);
                }

                const right = document.createElement('div');
                right.className = 'missav-pl-rich-right';

                if (options.showUnskip && isSkipped) {
                    const unskipBtn = document.createElement('button');
                    unskipBtn.type = 'button';
                    unskipBtn.className = 'missav-pl-unskip-btn';
                    unskipBtn.textContent = '移除還原';
                    unskipBtn.addEventListener('click', () => {
                        if (uiPrefs.skipConfirm && !confirm(`確定要將「${code}」移出本機「已略過」清單嗎？`)) return;
                        skippedCodes.delete(code);
                        saveSkippedCodes();
                        addLog('manual', '還原略過影片', `已從清單視窗將 ${code} 移出「已略過」`);
                        updateStatusDisplay();
                        markPageVideos(true);
                        renderView();
                    });
                    right.appendChild(unskipBtn);
                }

                if (options.showDeleteNote && noteEntry) {
                    const delNoteBtn = document.createElement('button');
                    delNoteBtn.type = 'button';
                    delNoteBtn.className = 'missav-pl-unskip-btn';
                    delNoteBtn.textContent = '刪除筆記';
                    delNoteBtn.addEventListener('click', () => {
                        if (!confirm(`確定要刪除「${code}」的所有時間點書籤與筆記嗎？`)) return;
                        delete notesMap[code];
                        saveNotesMap();
                        addLog('manual', '刪除影片筆記', `已刪除 ${code} 的筆記與時間書籤`);
                        updateStatusDisplay();
                        markPageVideos(true);
                        renderView();
                    });
                    right.appendChild(delNoteBtn);
                }

                const playLink = document.createElement('a');
                playLink.className = 'missav-pl-link-btn';
                playLink.href = getDirectVideoUrl(code);
                playLink.target = '_blank';
                playLink.rel = 'noopener noreferrer';
                playLink.textContent = '播放 ↗';
                right.appendChild(playLink);

                const searchLink = document.createElement('a');
                searchLink.className = 'missav-pl-link-btn';
                searchLink.href = `${location.origin}/search/${encodeURIComponent(code)}`;
                searchLink.target = '_blank';
                searchLink.rel = 'noopener noreferrer';
                searchLink.textContent = '搜尋';
                right.appendChild(searchLink);

                row.append(left, right);
                frag.appendChild(row);
            }

            if (entries.length > limit) {
                const more = document.createElement('div');
                more.style.cssText = 'text-align:center;color:#a1a1aa;font-size:11px;padding:10px 0;';
                more.textContent = `僅顯示前 ${limit} 筆（共 ${entries.length} 筆），請輸入更完整的番號縮小範圍。`;
                frag.appendChild(more);
            }

            listEl.appendChild(frag);
        }

        function renderView() {
            const duplicates = getDuplicateEntries();
            const notedCount = getNotedCodeCount();
            diffHistory = loadDiffHistory();
            titleEl.textContent = `番號清單（片單 ${codeToPlaylists.size} 部｜筆記 ${notedCount}｜略過 ${skippedCodes.size}）`;

            tabsEl.innerHTML = '';
            playlists.forEach((pl, idx) => {
                const count = playlistCodesMap.get(pl.id)?.size || 0;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `missav-pl-tab${!searchQuery && activeTab === idx ? ' active' : ''}`;
                btn.innerHTML = `
                    <span class="missav-pl-dot" style="background:${escapeHtml(pl.color || '#10b981')};"></span>
                    <span>${escapeHtml(pl.name)} (${count})</span>
                `;
                btn.addEventListener('click', () => {
                    searchQuery = '';
                    searchInput.value = '';
                    clearBtn.style.setProperty('display', 'none', 'important');
                    selectedStatsPrefix = null;
                    activeTab = idx;
                    renderView();
                });
                tabsEl.appendChild(btn);
            });

            const addSpecialTab = (id, cls, text) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `missav-pl-tab ${cls}${!searchQuery && activeTab === id ? ' active' : ''}`;
                btn.textContent = text;
                btn.addEventListener('click', () => {
                    searchQuery = '';
                    searchInput.value = '';
                    clearBtn.style.setProperty('display', 'none', 'important');
                    if (id !== '__stats__') selectedStatsPrefix = null;
                    activeTab = id;
                    renderView();
                });
                tabsEl.appendChild(btn);
            };

            addSpecialTab('__stats__', 'stats-tab', '📊 統計');
            addSpecialTab('__notes__', 'note-tab', `📝 筆記 (${notedCount})`);
            addSpecialTab('__skipped__', 'skip-tab', `🚫 已略過 (${skippedCodes.size})`);
            if (playlists.length >= 2) {
                addSpecialTab('__duplicates__', 'dup-tab', `🔁 重複 (${duplicates.length})`);
            }
            addSpecialTab('__diffs__', 'diff-tab', `📉 變動 (${diffHistory.length})`);

            // 1. 即時跨區搜尋（番號或筆記內容）
            if (searchQuery) {
                const rawQ = searchQuery.toUpperCase();
                const normQ = rawQ.replace(/[-\s_]/g, '');
                const lowerQ = searchQuery.toLowerCase();
                const allCodes = new Set([...codeToPlaylists.keys(), ...skippedCodes, ...Object.keys(notesMap)]);
                const matched = [];

                allCodes.forEach(code => {
                    const noteEntry = getNoteEntry(code);
                    const normCode = code.replace(/[-\s_]/g, '');
                    const codeHit = code.includes(rawQ) || (normQ && normCode.includes(normQ));
                    const noteHit = noteEntry && (
                        noteEntry.note.toLowerCase().includes(lowerQ) ||
                        noteEntry.bookmarks.some(b => (b.label || '').toLowerCase().includes(lowerQ))
                    );
                    if (codeHit || noteHit) {
                        matched.push({
                            code,
                            playlists: codeToPlaylists.get(code) || [],
                            isSkipped: skippedCodes.has(code),
                            noteEntry
                        });
                    }
                });
                matched.sort((a, b) => a.code.localeCompare(b.code));

                metaEl.innerHTML = `<span>搜尋「${escapeHtml(searchQuery)}」：找到 <strong>${matched.length}</strong> 部（點擊番號可複製）</span>`;
                renderRichEntries(matched, `找不到符合「${searchQuery}」的番號或筆記。`, { showUnskip: true, showDeleteNote: true });
                return;
            }

            // 2. 番號前綴／片商統計排行分頁（📊 統計）
            if (activeTab === '__stats__') {
                if (statsScope !== '__all__' && !playlists.some(p => p.id === statsScope)) {
                    statsScope = '__all__';
                }
                const stats = computePrefixStats(statsScope);

                // 2-A. 點進單一前綴的明細列表
                if (selectedStatsPrefix) {
                    const targetGroup = stats.groups.find(g => g.prefix === selectedStatsPrefix);
                    if (!targetGroup) {
                        selectedStatsPrefix = null;
                    } else {
                        const latestUrl = `${location.origin}/search/${encodeURIComponent(targetGroup.prefix)}`;
                        metaEl.innerHTML = `
                            <span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                <button type="button" id="missav-pl-stats-back" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">← 返回排行</button>
                                <span>系列 <strong style="color:#34d399;font-family:monospace;">${escapeHtml(targetGroup.prefix)}</strong>：已收錄 <strong>${targetGroup.count}</strong> 部（佔 ${targetGroup.pct.toFixed(1)}%）</span>
                            </span>
                            <div class="missav-pl-modal-meta-btns">
                                <button type="button" id="missav-pl-stats-copy-pfx" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">📋 複製番號</button>
                                <a class="missav-pl-action-btn primary" style="height:28px !important;padding:0 10px !important;font-size:12px !important;" href="${escapeHtml(latestUrl)}" target="_blank" rel="noopener noreferrer">🔎 站內看 ${escapeHtml(targetGroup.prefix)} 最新 ↗</a>
                            </div>
                        `;

                        metaEl.querySelector('#missav-pl-stats-back').addEventListener('click', () => {
                            selectedStatsPrefix = null;
                            renderView();
                        });

                        const copyPfxBtn = metaEl.querySelector('#missav-pl-stats-copy-pfx');
                        copyPfxBtn.addEventListener('click', async () => {
                            const ok = await copyToClipboard(targetGroup.codes.join('\n'));
                            copyPfxBtn.textContent = ok ? '✓ 已複製' : '失敗';
                            setTimeout(() => { copyPfxBtn.textContent = '📋 複製番號'; }, 1500);
                        });

                        const entries = targetGroup.codes.map(code => ({
                            code,
                            playlists: codeToPlaylists.get(code) || [],
                            isSkipped: skippedCodes.has(code),
                            noteEntry: getNoteEntry(code)
                        }));
                        renderRichEntries(entries, '此系列尚無紀錄。');
                        return;
                    }
                }

                // 2-B. 長條圖排行榜主視圖
                metaEl.innerHTML = `
                    <label style="display:inline-flex;align-items:center;gap:6px;">
                        <span>統計範圍：</span>
                        <select id="missav-pl-stats-scope" class="missav-pl-pref-select">
                            <option value="__all__" ${statsScope === '__all__' ? 'selected' : ''}>全部片單（不重複共 ${codeToPlaylists.size} 部）</option>
                            ${playlists.map(pl => `<option value="${escapeHtml(pl.id)}" ${statsScope === pl.id ? 'selected' : ''}>${escapeHtml(pl.name)}（${playlistCodesMap.get(pl.id)?.size || 0} 部）</option>`).join('')}
                        </select>
                    </label>
                    <div class="missav-pl-modal-meta-btns">
                        ${stats.groups.length ? '<button type="button" id="missav-pl-stats-copy" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">📋 複製排行</button>' : ''}
                    </div>
                `;

                metaEl.querySelector('#missav-pl-stats-scope').addEventListener('change', (e) => {
                    statsScope = e.target.value;
                    selectedStatsPrefix = null;
                    renderView();
                });

                const copyStatsBtn = metaEl.querySelector('#missav-pl-stats-copy');
                if (copyStatsBtn) {
                    copyStatsBtn.addEventListener('click', async () => {
                        const txt = stats.groups.slice(0, 50).map((g, i) => `#${i + 1} ${g.prefix}: ${g.count}部 (${g.pct.toFixed(1)}%)`).join('\n');
                        const ok = await copyToClipboard(txt);
                        copyStatsBtn.textContent = ok ? '✓ 已複製' : '失敗';
                        setTimeout(() => { copyStatsBtn.textContent = '📋 複製排行'; }, 1500);
                    });
                }

                listEl.innerHTML = '';
                if (stats.groups.length === 0) {
                    listEl.innerHTML = '<div style="text-align:center;color:#71717a;padding:24px 0;">此範圍尚無任何已同步的番號資料，請先點擊「🔄 同步」。</div>';
                    return;
                }

                const top1 = stats.groups[0];
                const summary = document.createElement('div');
                summary.className = 'missav-pl-stats-summary';
                summary.innerHTML = `
                    <span>總部數：<strong>${stats.total}</strong> 部</span>
                    <span>｜不同前綴系列：<strong>${stats.groups.length}</strong> 種</span>
                    <span>｜最常收藏：<strong>${escapeHtml(top1.prefix)}</strong>（${top1.count} 部 / ${top1.pct.toFixed(1)}%）</span>
                `;
                listEl.appendChild(summary);

                const frag = document.createDocumentFragment();
                const maxCount = top1.count || 1;
                const displayLimit = Math.min(stats.groups.length, 150);

                for (let i = 0; i < displayLimit; i++) {
                    const g = stats.groups[i];
                    const barWidth = Math.max(2, (g.count / maxCount) * 100);
                    const row = document.createElement('div');
                    row.className = 'missav-pl-stat-row';
                    row.title = `點擊檢視已收錄的 ${g.count} 部 ${g.prefix} 系列番號`;

                    row.innerHTML = `
                        <span class="missav-pl-stat-rank${i < 3 ? ' top3' : ''}">#${i + 1}</span>
                        <span class="missav-pl-stat-prefix">${escapeHtml(g.prefix)}</span>
                        <div class="missav-pl-stat-bar-wrap">
                            <div class="missav-pl-stat-bar-fill" style="width:${barWidth.toFixed(1)}%;"></div>
                        </div>
                        <span class="missav-pl-stat-val"><strong>${g.count}</strong>部 <span>(${g.pct.toFixed(1)}%)</span></span>
                    `;

                    const latestLink = document.createElement('a');
                    latestLink.className = 'missav-pl-link-btn';
                    latestLink.href = `${location.origin}/search/${encodeURIComponent(g.prefix)}`;
                    latestLink.target = '_blank';
                    latestLink.rel = 'noopener noreferrer';
                    latestLink.textContent = '最新 ↗';
                    latestLink.title = `前往站內搜尋 ${g.prefix} 最新作品`;
                    latestLink.addEventListener('click', (e) => e.stopPropagation());

                    row.appendChild(latestLink);
                    row.addEventListener('click', () => {
                        selectedStatsPrefix = g.prefix;
                        renderView();
                    });
                    frag.appendChild(row);
                }

                if (stats.groups.length > displayLimit) {
                    const more = document.createElement('div');
                    more.style.cssText = 'text-align:center;color:#a1a1aa;font-size:11px;padding:10px 0;';
                    more.textContent = `已顯示前 ${displayLimit} 名（共 ${stats.groups.length} 個前綴系列）`;
                    frag.appendChild(more);
                }

                listEl.appendChild(frag);
                return;
            }

            // 3. 筆記分頁
            if (activeTab === '__notes__') {
                const notedEntries = Object.keys(notesMap)
                    .map(code => ({
                        code,
                        playlists: codeToPlaylists.get(code) || [],
                        isSkipped: skippedCodes.has(code),
                        noteEntry: getNoteEntry(code)
                    }))
                    .filter(e => Boolean(e.noteEntry))
                    .sort((a, b) => (b.noteEntry.updatedAt || '').localeCompare(a.noteEntry.updatedAt || ''));

                metaEl.innerHTML = `<span>已建立時間點書籤或文字筆記的影片共 <strong>${notedEntries.length}</strong> 部（進入播放頁可編輯與跳轉）</span>`;
                renderRichEntries(notedEntries, '尚未建立任何筆記或時間點書籤。打開任一影片播放頁，在標題下方即可新增。', { showDeleteNote: true });
                return;
            }

            // 4. 變動與下架追蹤分頁
            if (activeTab === '__diffs__') {
                metaEl.innerHTML = `
                    <span>每次同步自動比對新舊片單，追蹤新增與消失（可能被移除／下架）的番號</span>
                    <div class="missav-pl-modal-meta-btns">
                        ${diffHistory.length ? '<button type="button" id="missav-pl-clear-diffs" class="missav-pl-action-btn danger" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">🗑️ 清空變動史</button>' : ''}
                    </div>
                `;

                const clearDiffBtn = metaEl.querySelector('#missav-pl-clear-diffs');
                if (clearDiffBtn) {
                    clearDiffBtn.addEventListener('click', () => {
                        if (!confirm('確定要清空所有片單變動紀錄嗎？')) return;
                        diffHistory = [];
                        saveDiffHistory();
                        addLog('manual', '清空片單變動史', '已清除所有歷史片單增減比對紀錄');
                        renderView();
                    });
                }

                listEl.innerHTML = '';
                if (diffHistory.length === 0) {
                    listEl.innerHTML = '<div style="text-align:center;color:#71717a;padding:24px 0;">尚無片單變動紀錄。日後同步時只要有新增或消失的影片，都會自動記錄在這裡。</div>';
                    return;
                }

                const frag = document.createDocumentFragment();
                const triggerLabelMap = { auto: '自動更新', native: '站內收藏同步', manual: '手動同步' };
                diffHistory.forEach(item => {
                    const card = document.createElement('div');
                    card.className = 'missav-pl-diff-card';
                    card.innerHTML = `
                        <div class="missav-pl-diff-head">
                            <span style="display:inline-flex;align-items:center;gap:6px;">
                                <span class="missav-pl-dot" style="background:${escapeHtml(item.playlistColor || '#10b981')};"></span>
                                <strong>${escapeHtml(item.playlistName)}</strong>
                                <span style="color:#a1a1aa;font-size:11px;">(${triggerLabelMap[item.trigger] || '同步'}｜同步後 ${item.totalAfter} 部)</span>
                            </span>
                            <span style="font-family:monospace;font-size:11px;color:#a1a1aa;">${escapeHtml(item.time)}</span>
                        </div>
                    `;

                    if (item.added && item.added.length > 0) {
                        const addWrap = document.createElement('div');
                        addWrap.className = 'missav-pl-diff-codes';
                        addWrap.innerHTML = `<span style="color:#34d399;font-size:11px;font-weight:700;">＋ 新增 (${item.added.length})：</span>`;
                        item.added.forEach(code => {
                            const pill = document.createElement('span');
                            pill.className = 'missav-pl-code-pill added';
                            pill.textContent = `+${code}`;
                            pill.title = '點擊複製番號';
                            pill.addEventListener('click', async () => {
                                if (await copyToClipboard(code)) showToast(`📋 已複製 ${code}`);
                            });
                            addWrap.appendChild(pill);
                        });
                        card.appendChild(addWrap);
                    }

                    if (item.removed && item.removed.length > 0) {
                        const remWrap = document.createElement('div');
                        remWrap.className = 'missav-pl-diff-codes';
                        remWrap.innerHTML = `<span style="color:#f87171;font-size:11px;font-weight:700;">－ 消失／移除 (${item.removed.length})：</span>`;
                        item.removed.forEach(code => {
                            const pill = document.createElement('span');
                            pill.className = 'missav-pl-code-pill removed';
                            pill.textContent = `-${code}`;
                            pill.title = '點擊複製番號（可用來搜尋救回下架影片）';
                            pill.addEventListener('click', async () => {
                                if (await copyToClipboard(code)) showToast(`📋 已複製 ${code}`);
                            });
                            remWrap.appendChild(pill);
                        });
                        card.appendChild(remWrap);
                    }

                    frag.appendChild(card);
                });
                listEl.appendChild(frag);
                return;
            }

            // 5. 已略過分頁
            if (activeTab === '__skipped__') {
                const skippedArr = Array.from(skippedCodes).sort().map(code => ({
                    code,
                    playlists: codeToPlaylists.get(code) || [],
                    isSkipped: true,
                    noteEntry: getNoteEntry(code)
                }));

                metaEl.innerHTML = `
                    <span>本機略過清單（規則：${escapeHtml(ACTION_LABELS[uiPrefs.skipAction])}）</span>
                    <div class="missav-pl-modal-meta-btns">
                        ${skippedArr.length ? '<button type="button" id="missav-pl-copy-skip" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">📋 複製</button>' : ''}
                        ${skippedArr.length ? '<button type="button" id="missav-pl-clear-skip" class="missav-pl-action-btn danger" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">🗑️ 清空</button>' : ''}
                    </div>
                `;

                const copySkipBtn = metaEl.querySelector('#missav-pl-copy-skip');
                if (copySkipBtn) {
                    copySkipBtn.addEventListener('click', async () => {
                        const ok = await copyToClipboard(skippedArr.map(d => d.code).join('\n'));
                        copySkipBtn.textContent = ok ? '✓ 已複製' : '失敗';
                        setTimeout(() => { copySkipBtn.textContent = '📋 複製'; }, 1500);
                    });
                }

                const clearSkipBtn = metaEl.querySelector('#missav-pl-clear-skip');
                if (clearSkipBtn) {
                    clearSkipBtn.addEventListener('click', () => {
                        if (!confirm(`確定要清空全部 ${skippedCodes.size} 筆「已略過」紀錄嗎？此動作無法復原。`)) return;
                        const prevCount = skippedCodes.size;
                        skippedCodes.clear();
                        saveSkippedCodes();
                        addLog('manual', '清空略過清單', `已清空全部 ${prevCount} 部本機略過影片`);
                        updateStatusDisplay();
                        markPageVideos(true);
                        renderView();
                    });
                }

                renderRichEntries(skippedArr, '目前沒有本機略過紀錄。將滑鼠移到任一影片封面點擊角落「✕」即可加入。', { showUnskip: true });
                return;
            }

            // 6. 重複檢查分頁
            if (activeTab === '__duplicates__') {
                metaEl.innerHTML = `
                    <span>以下共 <strong>${duplicates.length}</strong> 部影片同時收錄在 2 個以上片單</span>
                    <div class="missav-pl-modal-meta-btns">
                        ${duplicates.length ? '<button type="button" id="missav-pl-copy-dups" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">📋 複製重複番號</button>' : ''}
                    </div>
                `;
                const copyDupBtn = metaEl.querySelector('#missav-pl-copy-dups');
                if (copyDupBtn) {
                    copyDupBtn.addEventListener('click', async () => {
                        const ok = await copyToClipboard(duplicates.map(d => d.code).join('\n'));
                        copyDupBtn.textContent = ok ? '✓ 已複製' : '複製失敗';
                        setTimeout(() => { copyDupBtn.textContent = '📋 複製重複番號'; }, 1500);
                    });
                }
                renderRichEntries(
                    duplicates.map(d => ({ ...d, isSkipped: skippedCodes.has(d.code), noteEntry: getNoteEntry(d.code) })),
                    '太乾淨了！目前沒有任何影片重複收錄在多個片單中。'
                );
                return;
            }

            // 7. 單一片單分頁
            const pl = playlists[activeTab] || playlists[0];
            if (!pl) return;
            const meta = GM_getValue(`${META_KEY_PREFIX}${pl.id}`, null);
            const list = Array.from(playlistCodesMap.get(pl.id) || []).sort();

            metaEl.innerHTML = `
                <span>ID：${escapeHtml(pl.id)} ｜ 規則：${escapeHtml(ACTION_LABELS[pl.action || 'normal'])} ｜ 更新：${meta ? escapeHtml(meta.updatedAt) : '尚未同步'}</span>
                <div class="missav-pl-modal-meta-btns">
                    ${list.length ? '<button type="button" id="missav-pl-copy-list" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;">📋 複製</button>' : ''}
                    <button type="button" id="missav-pl-sync-one" class="missav-pl-action-btn" style="height:28px !important;padding:0 10px !important;font-size:12px !important;background:${escapeHtml(pl.color || '#10b981')} !important;text-shadow:0 1px 2px rgba(0,0,0,0.35);">同步此片單</button>
                </div>
            `;

            const copyListBtn = metaEl.querySelector('#missav-pl-copy-list');
            if (copyListBtn) {
                copyListBtn.addEventListener('click', async () => {
                    const ok = await copyToClipboard(list.join('\n'));
                    copyListBtn.textContent = ok ? '✓ 已複製' : '失敗';
                    setTimeout(() => { copyListBtn.textContent = '📋 複製'; }, 1500);
                });
            }

            const syncOneBtn = metaEl.querySelector('#missav-pl-sync-one');
            syncOneBtn.addEventListener('click', async () => {
                if (isSyncBusy) {
                    alert('目前正在背景同步中，請稍候再試。');
                    return;
                }
                isSyncBusy = true;
                syncOneBtn.disabled = true;
                try {
                    const res = await syncSinglePlaylist(pl, (page) => {
                        syncOneBtn.textContent = `第 ${page} 頁...`;
                    }, null, 'manual');
                    addLog('manual', `手動同步單一片單 [${pl.name}]`, `同步完成，共 ${res.count} 部（新增 +${res.added.length} / 消失 -${res.removed.length}）`);
                    loadAllSavedCodes();
                    updateStatusDisplay();
                    markPageVideos(true);
                    renderView();
                } catch (err) {
                    addLog('error', `手動同步失敗 [${pl.name}]`, err.message);
                    alert(`同步 [${pl.name}] 失敗：${err.message}`);
                    syncOneBtn.textContent = '同步此片單';
                    syncOneBtn.disabled = false;
                } finally {
                    isSyncBusy = false;
                }
            });

            listEl.innerHTML = '';
            const plain = document.createElement('div');
            plain.className = 'missav-pl-plain-codes';
            plain.textContent = list.length
                ? list.join(', ')
                : '此片單目前沒有資料，請點擊右上角「同步此片單」或右下角「🔄 同步」。';
            listEl.appendChild(plain);
        }

        let searchTimer = null;
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            clearBtn.style.setProperty('display', searchQuery ? 'inline-flex' : 'none', 'important');
            clearTimeout(searchTimer);
            searchTimer = setTimeout(renderView, 120);
        });

        clearBtn.addEventListener('click', () => {
            searchQuery = '';
            searchInput.value = '';
            clearBtn.style.setProperty('display', 'none', 'important');
            renderView();
            searchInput.focus();
        });

        renderView();

        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.id === 'missav-pl-close') {
                modal.remove();
            }
        });
    }

    // ================= 浮動列拖曳機制 =================
    function bindDraggable(handleEl, onPureClick = null) {
        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let initLeft = 0;
        let initTop = 0;

        handleEl.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            dragging = true;
            isPanelDragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;

            const rect = panelEl.getBoundingClientRect();
            initLeft = rect.left;
            initTop = rect.top;

            handleEl.setPointerCapture(e.pointerId);
        });

        handleEl.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (!moved && Math.hypot(dx, dy) > 6) {
                moved = true;
                panelEl.classList.add('is-dragging');
            }
            if (!moved) return;

            const { width, height } = getViewportMetrics();
            const margin = width <= 640 ? 8 : 14;
            const rect = panelEl.getBoundingClientRect();
            const maxLeft = Math.max(margin, width - rect.width - margin);
            const maxTop = Math.max(margin, height - rect.height - margin - uiPrefs.bottomSafeOffset);

            const nextLeft = Math.min(Math.max(margin, initLeft + dx), maxLeft);
            const nextTop = Math.min(Math.max(margin, initTop + dy), maxTop);

            panelEl.style.setProperty('left', `${Math.round(nextLeft)}px`, 'important');
            panelEl.style.setProperty('top', `${Math.round(nextTop)}px`, 'important');
            panelEl.style.setProperty('right', 'auto', 'important');
            panelEl.style.setProperty('bottom', 'auto', 'important');
        });

        function finishDrag(e) {
            if (!dragging) return;
            dragging = false;
            isPanelDragging = false;
            panelEl.classList.remove('is-dragging');
            if (handleEl.hasPointerCapture(e.pointerId)) {
                handleEl.releasePointerCapture(e.pointerId);
            }

            if (moved) {
                const { width, height } = getViewportMetrics();
                const margin = width <= 640 ? 8 : 14;
                const rect = panelEl.getBoundingClientRect();

                const distLeft = rect.left;
                const distRight = width - rect.right;
                const anchorX = distRight <= distLeft ? 'right' : 'left';
                const x = Math.round(Math.max(margin, anchorX === 'right' ? distRight : distLeft));

                const distTop = rect.top;
                const distBottom = height - rect.bottom;
                const anchorY = distBottom <= distTop ? 'bottom' : 'top';
                const y = anchorY === 'bottom'
                    ? Math.round(Math.max(margin, distBottom - uiPrefs.bottomSafeOffset))
                    : Math.round(Math.max(margin, distTop));

                savePanelPos({ anchorX, x, anchorY, y });
                clampPanelToViewport();
            } else if (typeof onPureClick === 'function') {
                onPureClick();
            }
        }

        handleEl.addEventListener('pointerup', finishDrag);
        handleEl.addEventListener('pointercancel', finishDrag);
    }

    // ================= 浮動控制列 =================
    function createFloatingPanel() {
        if (document.getElementById('missav-pl-panel')) return;

        panelEl = document.createElement('div');
        panelEl.id = 'missav-pl-panel';

        const miniBtn = document.createElement('button');
        miniBtn.type = 'button';
        miniBtn.className = 'missav-pl-mini-btn';
        miniDotSpan = document.createElement('span');
        miniDotSpan.className = 'missav-pl-mini-dot';
        miniCountSpan = document.createElement('span');
        miniBtn.append(miniDotSpan, miniCountSpan);
        bindDraggable(miniBtn, () => {
            isCollapsed = false;
            GM_setValue(COLLAPSED_KEY, false);
            applyCollapsedState();
        });

        panelPageStatsRow = document.createElement('div');
        panelPageStatsRow.className = 'missav-pl-page-stats-row missav-pl-full-item';
        panelPageStatsRow.style.setProperty('display', 'none', 'important');

        panelCountsRow = document.createElement('div');
        panelCountsRow.className = 'missav-pl-counts-row missav-pl-full-item';

        const controlsRow = document.createElement('div');
        controlsRow.className = 'missav-pl-controls-row missav-pl-full-item';

        const dragHandle = document.createElement('span');
        dragHandle.className = 'missav-pl-drag-handle';
        dragHandle.textContent = '⋮⋮';
        dragHandle.title = '按住拖曳移動浮動列位置';
        bindDraggable(dragHandle);

        panelModeBtn = document.createElement('button');
        panelModeBtn.type = 'button';
        panelModeBtn.className = 'missav-pl-ctrl-btn';
        panelModeBtn.addEventListener('click', () => {
            const idx = MODES.findIndex(m => m.id === currentMode);
            currentMode = MODES[(idx + 1) % MODES.length].id;
            GM_setValue(MODE_KEY, currentMode);
            applyDisplayMode();
            const info = MODES.find(m => m.id === currentMode);
            addLog('manual', '切換顯示模式', `切換為：${info?.label || currentMode}`);
        });

        panelSyncBtn = document.createElement('button');
        panelSyncBtn.type = 'button';
        panelSyncBtn.className = 'missav-pl-ctrl-btn';
        panelSyncBtn.textContent = '🔄 同步';
        panelSyncBtn.title = '立即手動同步所有片單';
        panelSyncBtn.addEventListener('click', syncAllPlaylists);

        const randBtn = document.createElement('button');
        randBtn.type = 'button';
        randBtn.className = 'missav-pl-ctrl-btn btn-purple';
        randBtn.textContent = '🎲 抽片';
        randBtn.title = '從片單隨機抽選一部影片';
        randBtn.addEventListener('click', showRandomPickerModal);

        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'missav-pl-ctrl-btn btn-secondary';
        viewBtn.textContent = '清單';
        viewBtn.title = '檢視片單番號、前綴統計、筆記、已略過、重複與變動紀錄';
        viewBtn.addEventListener('click', () => showSavedListModal(0));

        const logsBtn = document.createElement('button');
        logsBtn.type = 'button';
        logsBtn.className = 'missav-pl-ctrl-btn btn-secondary';
        logsBtn.textContent = '📜 紀錄';
        logsBtn.title = '檢視所有手動操作、自動動作與片單變動紀錄';
        logsBtn.addEventListener('click', showLogsModal);

        const settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.className = 'missav-pl-ctrl-btn btn-secondary';
        settingsBtn.textContent = '⚙️ 設定';
        settingsBtn.title = '管理片單、去重規則、外觀與備份';
        settingsBtn.addEventListener('click', showSettingsModal);

        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'missav-pl-ctrl-btn btn-collapse';
        collapseBtn.textContent = '—';
        collapseBtn.title = '縮小浮動列';
        collapseBtn.addEventListener('click', () => {
            isCollapsed = true;
            GM_setValue(COLLAPSED_KEY, true);
            applyCollapsedState();
        });

        controlsRow.append(dragHandle, panelModeBtn, panelSyncBtn, randBtn, viewBtn, logsBtn, settingsBtn, collapseBtn);
        panelEl.append(miniBtn, panelPageStatsRow, panelCountsRow, controlsRow);
        document.body.appendChild(panelEl);

        applyDisplayMode();
        applyCollapsedState();
        clampPanelToViewport();
    }

    // 鍵盤快捷鍵：Alt + H 瞬間在「全標註」與目前規則之間切換
    document.addEventListener('keydown', (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key.toLowerCase() !== 'h') return;

        const active = document.activeElement;
        if (active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.tagName === 'SELECT' ||
            active.isContentEditable
        )) {
            return;
        }

        e.preventDefault();
        if (currentMode === 'normal') {
            currentMode = lastNonNormalMode || 'custom';
        } else {
            lastNonNormalMode = currentMode;
            currentMode = 'normal';
        }
        GM_setValue(MODE_KEY, currentMode);
        applyDisplayMode();

        const info = MODES.find(m => m.id === currentMode) || MODES[0];
        addLog('manual', '快捷鍵切換模式', `透過 Alt+H 切換為：${info.label}`);
        showToast(`切換顯示模式：${info.label}（Alt + H）`);
    });

    window.addEventListener('resize', scheduleClampPanel);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleClampPanel);
        window.visualViewport.addEventListener('scroll', scheduleClampPanel);
    }

    let debounceTimer = null;
    const observer = new MutationObserver((mutations) => {
        const hasExternalChange = mutations.some(m =>
            Array.from(m.addedNodes).some(node =>
                node.nodeType === 1 &&
                !node.classList?.contains('missav-pl-badge-group') &&
                !node.classList?.contains('missav-pl-badge') &&
                !node.classList?.contains('missav-pl-title-badge') &&
                !node.classList?.contains('missav-pl-skip-btn') &&
                node.id !== 'missav-pl-toast' &&
                node.id !== 'missav-pl-note-widget' &&
                !(node.closest && node.closest('#missav-pl-panel, .missav-pl-overlay, #missav-pl-note-widget'))
            )
        );
        if (!hasExternalChange) return;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            markPageVideos(false);
            injectVideoNoteWidget();
            cleanPlayerAds();
        }, 300);
    });

    // ================= 播放器廣告、透明遮罩與彈窗攔截 =================
    let lastAdToastTs = 0;
    let adShieldUntil = 0;

    function notifyAdBlocked(msg) {
        const now = Date.now();
        if (now - lastAdToastTs > 3500) {
            lastAdToastTs = now;
            showToast(msg);
        }
    }

    function isExternalAdUrl(rawUrl) {
        const urlStr = String(rawUrl || '').trim();
        if (!urlStr || urlStr === 'about:blank' || urlStr.startsWith('javascript:')) return true;
        if (urlStr.startsWith('#') || urlStr.startsWith('blob:') || urlStr.startsWith('data:')) return false;
        try {
            return new URL(urlStr, location.origin).origin !== location.origin;
        } catch {
            return true;
        }
    }

    // 在 document-start 階段搶先攔截 window.open、動態建立外連 <a> 點擊與播放器點擊劫持
    function installEarlyAdHooks() {
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        [window, pageWin].forEach((win) => {
            if (!win) return;

            if (typeof win.open === 'function' && !win.__missavPlOpenHooked) {
                const origOpen = win.open.bind(win);
                win.open = function (url, target, features) {
                    if (uiPrefs.blockPlayerAds && (Date.now() < adShieldUntil || isExternalAdUrl(url))) {
                        notifyAdBlocked('🛡️ 已攔截播放器廣告彈窗');
                        return null;
                    }
                    return origOpen(url, target, features);
                };
                win.__missavPlOpenHooked = true;
            }

            if (win.HTMLAnchorElement && !win.HTMLAnchorElement.prototype.__missavPlClickHooked) {
                const origAnchorClick = win.HTMLAnchorElement.prototype.click;
                win.HTMLAnchorElement.prototype.click = function (...args) {
                    if (uiPrefs.blockPlayerAds && (this.target === '_blank' || Date.now() < adShieldUntil) && isExternalAdUrl(this.href)) {
                        notifyAdBlocked('🛡️ 已攔截背景廣告跳轉');
                        return;
                    }
                    return origAnchorClick.apply(this, args);
                };
                win.HTMLAnchorElement.prototype.__missavPlClickHooked = true;
            }
        });

        // 捕捉點擊播放器瞬間：啟動短時護盾、清除透明遮罩並阻止事件冒泡至 document/window 廣告監聽器
        const guardPlayerInteraction = (e) => {
            if (!uiPrefs.blockPlayerAds) return;
            const target = e.target;
            if (!target || target.nodeType !== 1) return;
            if (target.closest('#missav-pl-panel, .missav-pl-overlay, #missav-pl-note-widget')) return;

            const playerBox = target.closest('.plyr, #player');
            if (!playerBox) return;

            adShieldUntil = Date.now() + 2500;

            // 檢查是否點到蓋在播放器上方的外部廣告連結或透明遮罩層
            const badLink = target.closest('a[href]');
            if (badLink && isExternalAdUrl(badLink.getAttribute('href'))) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                badLink.remove();
                notifyAdBlocked('🛡️ 已清除播放器廣告連結');
                return;
            }

            const isLegitPlayerPart =
                target.tagName === 'VIDEO' ||
                Boolean(target.closest('.plyr__controls, .plyr__menu, .plyr__control--overlaid, .plyr__poster, .plyr__captions'));

            if (!isLegitPlayerPart) {
                const cs = getComputedStyle(target);
                const rect = target.getBoundingClientRect();
                const pRect = playerBox.getBoundingClientRect();
                const coversPlayer = pRect.width > 0 && rect.width >= pRect.width * 0.6 && rect.height >= pRect.height * 0.6;
                if (coversPlayer && (cs.position === 'absolute' || cs.position === 'fixed')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    target.remove();
                    const v = playerBox.querySelector('video');
                    if (v && v.paused) v.play().catch(() => {});
                    notifyAdBlocked('🛡️ 已清除播放器透明廣告遮罩');
                }
            }
        };

        ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach((evt) => {
            window.addEventListener(evt, guardPlayerInteraction, true);
        });
    }

    function bindPlayerBubbleShield() {
        if (!uiPrefs.blockPlayerAds) return;
        document.querySelectorAll('.plyr, #player').forEach((box) => {
            if (box.dataset.missavBubbleShielded === '1') return;
            box.dataset.missavBubbleShielded = '1';
            // 在事件完成播放器內部控制後、冒泡到 body/document/window 廣告監聽器前截斷
            ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((evt) => {
                box.addEventListener(evt, (e) => {
                    if (uiPrefs.blockPlayerAds) {
                        adShieldUntil = Date.now() + 2500;
                        e.stopPropagation();
                    }
                }, false);
            });
        });
    }

    function cleanPlayerAds() {
        if (!uiPrefs.blockPlayerAds) return;
        bindPlayerBubbleShield();

        // 1. 清除掛在 body 上的全螢幕透明點擊劫持層（常見於第一次點擊網頁彈出廣告）
        document.querySelectorAll('body > div, body > a, body > aside, body > section').forEach((el) => {
            if (el.id === 'missav-pl-panel' || el.id === 'missav-pl-toast' || el.classList.contains('missav-pl-overlay')) return;
            if (el.querySelector('video, .plyr, h1, main')) return;

            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
            const z = parseInt(cs.zIndex, 10) || 0;
            if (z < 50) return;

            const rect = el.getBoundingClientRect();
            if (rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8) {
                const bg = cs.backgroundColor || '';
                const isTransparent = cs.opacity === '0' || Number(cs.opacity) <= 0.08 || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)';
                if (isTransparent && (el.textContent || '').trim() === '') {
                    el.remove();
                }
            }
        });

        if (!isVideoUrl(location.href)) return;

        const plyrRoot = document.querySelector('.plyr') || document.querySelector('#player');
        const mainVideo = plyrRoot?.querySelector('video') || document.querySelector('video');
        if (!plyrRoot && !mainVideo) return;

        let wrapper = plyrRoot || mainVideo.parentElement;
        if (wrapper && wrapper.parentElement && !wrapper.parentElement.querySelector('h1, #missav-pl-note-widget')) {
            const pRect = wrapper.parentElement.getBoundingClientRect();
            const vRect = wrapper.getBoundingClientRect();
            if (pRect.height > 0 && pRect.height <= vRect.height + 120) {
                wrapper = wrapper.parentElement;
            }
        }
        if (!wrapper) return;

        // 2. 移除播放器區域內的廣告 iframe 與外部廣告連結
        wrapper.querySelectorAll('iframe, ins, a[target="_blank"], a[href]').forEach((el) => {
            if (el.closest('#missav-pl-panel, .missav-pl-overlay, #missav-pl-note-widget')) return;
            if (el.tagName === 'A') {
                if (isExternalAdUrl(el.getAttribute('href'))) el.remove();
            } else {
                el.remove();
            }
        });

        // 3. 移除蓋在播放器上的透明防點擊層與暫停廣告浮層
        const wRect = wrapper.getBoundingClientRect();
        wrapper.querySelectorAll('div, section, aside').forEach((el) => {
            if (el === wrapper || el === plyrRoot) return;
            if (el.closest('.plyr__controls, .plyr__menu, #missav-pl-panel, .missav-pl-overlay, #missav-pl-note-widget')) return;
            if (el.querySelector('video, .plyr, .plyr__controls')) return;

            const cls = String(el.className || '');
            if (/\bplyr__(?:poster|captions|progress|volume|tooltip)\b/.test(cls)) return;

            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            if (cs.position !== 'absolute' && cs.position !== 'fixed') return;

            const rect = el.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 60) return;

            const isTransparentShield =
                (Number(cs.opacity) <= 0.08 || cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') &&
                (el.textContent || '').trim() === '' &&
                !el.querySelector('img, svg, button');

            const hasExternalAdContent = Array.from(el.querySelectorAll('a[href], img[src]')).some((node) => {
                const rawUrl = node.getAttribute('href') || node.getAttribute('src') || '';
                return isExternalAdUrl(rawUrl);
            });

            const coversMostOfPlayer = wRect.width > 0 && rect.width >= wRect.width * 0.7 && rect.height >= wRect.height * 0.7;

            if (isTransparentShield || hasExternalAdContent || (coversMostOfPlayer && !cls.includes('plyr__'))) {
                el.remove();
            }
        });

        // 4. 若出現非 blob 串流的片頭短廣告 <video>，自動靜音快轉略過
        wrapper.querySelectorAll('video').forEach((v) => {
            const src = v.currentSrc || v.src || '';
            if (src && !src.startsWith('blob:') && Number.isFinite(v.duration) && v.duration > 0 && v.duration <= 45) {
                v.muted = true;
                if (v.currentTime < v.duration - 0.2) {
                    v.currentTime = v.duration;
                }
            }
        });
    }

    // ================= 初始化（分階段：document-start 掛鉤 + DOM 就緒掛載 UI） =================
    applyUiPrefs();
    installEarlyAdHooks();

    function bootOnDomReady() {
        loadAllSavedCodes();
        createFloatingPanel();
        markPageVideos(false);
        injectVideoNoteWidget();
        cleanPlayerAds();
        installNativePlaylistWatcher();

        observer.observe(document.body, { childList: true, subtree: true });
        setInterval(cleanPlayerAds, 1200);

        setTimeout(() => {
            autoCheckAndUpdatePlaylists({ forceCheck: false, reason: 'interval' });
        }, 1500);
    }

    function startWhenBodyReady() {
        if (!document.body) {
            setTimeout(startWhenBodyReady, 50);
            return;
        }
        bootOnDomReady();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startWhenBodyReady, { once: true });
    } else {
        startWhenBodyReady();
    }
})();