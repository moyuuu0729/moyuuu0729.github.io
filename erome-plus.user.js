// ==UserScript==
// @name         Erome 全能增強：去廣告 / 黑名單 / 點選隱藏 / 作者追片 / 完整備份 / 抖音模式
// @namespace    https://www.erome.com/
// @version      4.1.2
// @description  去廣告、視覺化點選隱藏、作者與關鍵字黑名單、隱藏 Suggested users、略過 18+、豎屏過濾、列表指定開刷、網站底部無限滾動、點擊 @作者名 快速追片、全設定一鍵 JSON 備份還原與抖音滑動播放器
// @author       MingTW0729
// @match        https://www.erome.com/*
// @match        https://*.erome.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @downloadURL  https://moyuuu0729.github.io/erome-plus.user.js
// @updateURL.   https://moyuuu0729.github.io/erome-plus.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 可調整參數 ====================
    // 判定為「豎屏」的高寬比門檻（高 / 寬 > 1.02 即視為直向；若只想看 9:16 可改 1.3）
    const PORTRAIT_RATIO_THRESHOLD = 1.02;
    const SCAN_CONCURRENCY = 2;
    const SCAN_DELAY_MS = 220;
    const MAX_VIDEOS_PER_ALBUM = 10;
    const CACHE_KEY = 'erome_vertical_filter_cache_v3';
    const SPEED_STEPS = [1.0, 1.25, 1.5, 2.0, 0.75];
    const LONG_PRESS_SPEED = 2.0;
    const DOUBLE_TAP_SEEK_SEC = 5;
    const WEBSITE_BOTTOM_THRESHOLD_PX = 220;
    const MAX_AUTO_EMPTY_PAGES = 3;

    // 常見成人廣告聯播網與導流網域特徵
    const AD_URL_PATTERN = /(?:exoclick|exosrv|exdynsrv|realsrv|magsrv|tsyndicate|trafficjunky|trafficfactory|trafficstars|juicyads|popads|popcash|propellerads|adsterra|hilltopads|adspyglass|clickadu|adnium|ero-?advertising|plugrush|doubleclick|googlesyndication|chaturbate|stripchat|bongacams|livejasmin|jerkmate|cam4|myfreecams|flirt4free|camsoda|imlive|xlovecam|streamate|brazzers|pornhub|xvideos|adultfriendfinder|flingster|dirtyroulette|t\.irtyc\.|go\.xlirdr\.|creative\.|syndication\.|trk\.|track\.|click\.|ads\.)/i;
    // 驗證碼白名單（避免誤擋 Cloudflare / hCaptcha / reCAPTCHA）
    const CAPTCHA_URL_PATTERN = /(?:challenges\.cloudflare\.com|turnstile|hcaptcha\.com|recaptcha|arkoselabs|gstatic\.com\/recaptcha)/i;

    // ==================== 使用者設定與永久資料 ====================
    const DEFAULT_CONFIG = {
        blockAds: true,
        hideSuggestedUsers: true,
        onlyVertical: true,
        hidePhotos: true,
        autoNextPage: true,
        deepScan: true,
        panelCollapsed: false,
        feedAutoNext: false,
        feedCoverMode: false,
        playbackRate: 1.0,
        coverShape: 'portrait',
        coverSize: 0, // 0=網站原樣, 1=特大(1欄), 2=大(2欄), 3=中(3欄), 4=小(4欄)
        cleanCardUi: true,
    };

    const config = {
        blockAds: GM_getValue('blockAds', DEFAULT_CONFIG.blockAds),
        hideSuggestedUsers: GM_getValue('hideSuggestedUsers', DEFAULT_CONFIG.hideSuggestedUsers),
        onlyVertical: GM_getValue('onlyVertical', DEFAULT_CONFIG.onlyVertical),
        hidePhotos: GM_getValue('hidePhotos', DEFAULT_CONFIG.hidePhotos),
        autoNextPage: GM_getValue('autoNextPage', DEFAULT_CONFIG.autoNextPage),
        deepScan: GM_getValue('deepScan', DEFAULT_CONFIG.deepScan),
        panelCollapsed: GM_getValue('panelCollapsed', DEFAULT_CONFIG.panelCollapsed),
        feedAutoNext: GM_getValue('feedAutoNext', DEFAULT_CONFIG.feedAutoNext),
        feedCoverMode: GM_getValue('feedCoverMode', DEFAULT_CONFIG.feedCoverMode),
        playbackRate: Number(GM_getValue('playbackRate', DEFAULT_CONFIG.playbackRate)) || 1.0,
        coverShape: GM_getValue('coverShape', DEFAULT_CONFIG.coverShape),
        coverSize: Number(GM_getValue('gridCols', DEFAULT_CONFIG.gridCols)) || 0,
        cleanCardUi: GM_getValue('cleanCardUi', DEFAULT_CONFIG.cleanCardUi),
    };


    function saveConfig() {
        Object.keys(config).forEach((k) => GM_setValue(k, config[k]));
    }

    function loadArrayValue(key) {
        try {
            const val = GM_getValue(key, []);
            return Array.isArray(val) ? val : [];
        } catch (_) {
            return [];
        }
    }

    // 1) 收藏清單
    let favorites = loadArrayValue('ef_favorites');
    const favSrcSet = new Set(favorites.map((f) => f.src));
    function saveFavorites() {
        GM_setValue('ef_favorites', favorites);
    }
    function isFavorited(src) {
        return favSrcSet.has(src);
    }

    // 2) 黑名單（封鎖作者與標題關鍵字）
    let blockedAuthors = loadArrayValue('ef_blocked_authors').map((s) => String(s).trim()).filter(Boolean);
    let blockedKeywords = loadArrayValue('ef_blocked_keywords').map((s) => String(s).trim()).filter(Boolean);
    let blockedAuthorLowerSet = new Set(blockedAuthors.map((s) => s.toLowerCase()));
    let blockedKeywordLowerList = blockedKeywords.map((s) => s.toLowerCase());

    function saveBlocklists() {
        blockedAuthorLowerSet = new Set(blockedAuthors.map((s) => s.toLowerCase()));
        blockedKeywordLowerList = blockedKeywords.map((s) => s.toLowerCase());
        GM_setValue('ef_blocked_authors', blockedAuthors);
        GM_setValue('ef_blocked_keywords', blockedKeywords);
    }

    function isBlockedContent(author, title) {
        const a = String(author || '').replace(/^@+/, '').trim().toLowerCase();
        if (a && blockedAuthorLowerSet.has(a)) {
            return { type: 'author', matched: a };
        }
        const t = String(title || '').trim().toLowerCase();
        if (t && blockedKeywordLowerList.length > 0) {
            for (const kw of blockedKeywordLowerList) {
                if (kw && t.includes(kw)) {
                    return { type: 'keyword', matched: kw };
                }
            }
        }
        return null;
    }

    // 3) 視覺化點選隱藏的 CSS 規則
    let customHiddenSelectors = loadArrayValue('ef_custom_hidden_selectors').map((s) => String(s).trim()).filter(Boolean);

    function saveCustomHiddenSelectors() {
        GM_setValue('ef_custom_hidden_selectors', customHiddenSelectors);
        applyCustomHiddenStyles();
    }

    function applyCustomHiddenStyles() {
        const styleId = 'ef-custom-hide-style';
        let styleEl = document.getElementById(styleId);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            (document.head || document.documentElement).appendChild(styleEl);
        }
        const rules = [];
        for (const sel of customHiddenSelectors) {
            if (!sel) continue;
            try {
                document.createDocumentFragment().querySelector(sel);
                rules.push(`${sel} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`);
            } catch (_) {}
        }
        styleEl.textContent = rules.join('\n');
    }
    applyCustomHiddenStyles();

    // ==================== 1. 狀態同步與基礎判斷 ====================
    let adsBlockedCount = 0;

    function getCoverLayoutMetrics(sizeVal) {
        const s = Number(sizeVal);
        if (!Number.isFinite(s) || s < 18 || s > 50) {
            return { active: false, size: 0, cols: 0, gap: 10, totalGap: 10 };
        }
        const size = Math.round(s);
        // 依單張寬度占比自動計算能塞下幾欄（最少 2 欄、最多 4 欄）
        const cols = Math.min(4, Math.max(2, Math.floor(100 / size)));
        const gap = cols === 4 ? 6 : (cols === 3 ? 8 : 10);
        return { active: true, size, cols, gap, totalGap: (cols - 1) * gap };
    }

    function syncRootFeatureClasses() {
        if (!document.documentElement) return;
        const root = document.documentElement;
        const m = getCoverLayoutMetrics(config.coverSize);

        root.classList.toggle('ef-adblock-on', !!config.blockAds);
        root.classList.toggle('ef-hide-suggested', !!config.hideSuggestedUsers);
        root.classList.toggle('ef-clean-card', !!config.cleanCardUi);
        root.classList.toggle('ef-cover-portrait', config.coverShape === 'portrait');
        root.classList.toggle('ef-cover-tall', config.coverShape === 'tall');
        root.classList.toggle('ef-cover-landscape', config.coverShape === 'landscape');
        root.classList.toggle('ef-grid-custom', m.active);
        root.classList.toggle('ef-grid-compact', m.active && m.cols >= 3);
        root.classList.toggle('ef-grid-cols-4', m.active && m.cols === 4);

        if (m.active) {
            root.style.setProperty('--ef-grid-cols', String(m.cols));
            root.style.setProperty('--ef-grid-gap', `${m.gap}px`);
            root.style.setProperty('--ef-total-gap', `${m.totalGap}px`);
            root.style.setProperty('--ef-card-pct', String(m.size / 100));
        } else {
            root.style.removeProperty('--ef-grid-cols');
            root.style.removeProperty('--ef-grid-gap');
            root.style.removeProperty('--ef-total-gap');
            root.style.removeProperty('--ef-card-pct');
        }
    }


    syncRootFeatureClasses();

    function isOurUiElement(el) {
        if (!el || el.nodeType !== 1) return false;
        return !!el.closest(
            '#ef-panel, #ef-feed-overlay, #ef-fav-modal, #ef-blacklist-modal, #ef-hidden-rules-modal, #ef-picker-bar, #ef-picker-highlight, #ef-toast, #ef-infinite-sentinel, .ef-page-divider, .ef-card-play-btn, #ef-resume-bar, .ef-preview-wrap, .ef-preview-video'
        );
    }



    function isSameOriginUrl(urlStr) {
        if (!urlStr) return true;
        const s = String(urlStr).trim();
        if (!s || s.startsWith('#') || /^javascript:/i.test(s) || /^blob:/i.test(s)) return true;
        try {
            const u = new URL(s, window.location.href);
            return u.origin === window.location.origin || u.hostname === 'erome.com' || u.hostname.endsWith('.erome.com');
        } catch (_) {
            return false;
        }
    }

    function isAdUrl(urlStr) {
        if (!urlStr) return false;
        const s = String(urlStr).trim();
        if (!s || s.startsWith('#') || /^javascript:/i.test(s) || /^blob:/i.test(s) || CAPTCHA_URL_PATTERN.test(s)) return false;
        return AD_URL_PATTERN.test(s);
    }

    function isValidAlbumCard(el) {
        if (!el || el.nodeType !== 1) return false;
        if (!(el.classList.contains('album') || /^album-/i.test(el.id))) return false;
        const link = el.querySelector('a.album-link, a[href*="/a/"]');
        if (!link) return false;
        const href = link.getAttribute('href') || link.href || '';
        if (!isSameOriginUrl(href)) return false;
        try {
            return /\/a\//.test(new URL(href, window.location.href).pathname);
        } catch (_) {
            return false;
        }
    }

    function isSafeProtectedContainer(el) {
        if (!el || el.nodeType !== 1) return true;
        if (el === document.body || el === document.documentElement) return true;
        if (isOurUiElement(el)) return true;
        if (el.dataset.efSuggested === '1' || el.closest('[data-ef-suggested="1"]')) return true;
        if (el.id === 'albums' || el.id === 'page' || el.id === 'content' || el.id === 'disclaimer') return true;
        const tag = el.tagName;
        if (tag === 'HEADER' || tag === 'NAV' || tag === 'FOOTER' || tag === 'MAIN') return true;
        if (el.closest('header, nav, .navbar, footer, .footer')) return true;
        return false;
    }

    // ==================== 2. Suggested users 偵測與開關 ====================
    function markSuggestedElement(el) {
        if (!el || el.nodeType !== 1 || isOurUiElement(el)) return;
        if (el === document.body || el === document.documentElement) return;
        if (el.querySelector('#albums, .media-group, a[href*="/a/"], nav, .navbar')) return;
        el.dataset.efSuggested = '1';
        el.classList.toggle('ef-suggested-hidden', !!config.hideSuggestedUsers);
    }

    function processSuggestedUsers() {
        syncRootFeatureClasses();
        if (!document.body) return;

        document.querySelectorAll('#suggested-users, .suggested-users, .suggested_users, [data-section="suggested-users"]').forEach((el) => {
            markSuggestedElement(el);
        });

        const headingNodes = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, strong, b, label');
        headingNodes.forEach((node) => {
            if (isOurUiElement(node) || node.dataset.efSuggested === '1') return;
            if (node.children.length > 2) return;
            const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (!/^suggested\s+users\b/i.test(text) || text.length > 40) return;

            let dedicatedWrapper = null;
            let cur = node.parentElement;
            let depth = 0;
            while (cur && cur !== document.body && cur !== document.documentElement && depth < 4) {
                if (
                    isOurUiElement(cur) ||
                    cur.id === 'albums' ||
                    cur.id === 'page' ||
                    cur.tagName === 'MAIN' ||
                    cur.tagName === 'HEADER' ||
                    cur.tagName === 'NAV' ||
                    cur.tagName === 'FOOTER' ||
                    cur.querySelector('#albums, .album, a[href*="/a/"], .media-group, video, nav, .navbar')
                ) {
                    break;
                }
                if (cur.querySelector('a[href], img')) {
                    dedicatedWrapper = cur;
                }
                cur = cur.parentElement;
                depth++;
            }

            if (dedicatedWrapper) {
                markSuggestedElement(dedicatedWrapper);
                return;
            }

            let titleBlock = node;
            if (
                node.parentElement &&
                node.parentElement !== document.body &&
                !node.parentElement.querySelector('#albums, .album, a[href*="/a/"], .media-group') &&
                (node.parentElement.textContent || '').replace(/\s+/g, ' ').trim().length <= 60
            ) {
                titleBlock = node.parentElement;
            }
            markSuggestedElement(titleBlock);

            const nextEl = titleBlock.nextElementSibling;
            if (
                nextEl &&
                !isOurUiElement(nextEl) &&
                nextEl.id !== 'albums' &&
                !nextEl.querySelector('#albums, .album, a[href*="/a/"], .media-group, nav, .navbar')
            ) {
                markSuggestedElement(nextEl);
            }
        });

        document.querySelectorAll('[data-ef-suggested="1"]').forEach((el) => {
            el.classList.toggle('ef-suggested-hidden', !!config.hideSuggestedUsers);
        });
    }

    // ==================== 3. 強化去廣告模組 ====================
    function markAsBlockedAd(el) {
        if (!el || el.nodeType !== 1 || isSafeProtectedContainer(el)) return;
        if (el.querySelector('#albums, .media-group, a[href*="/a/"], [data-ef-suggested="1"]')) return;

        el.querySelectorAll('video').forEach((v) => {
            try { v.pause(); } catch (_) {}
        });

        if (el.dataset.efAdBlocked === '1') {
            el.classList.toggle('ef-ad-hidden', !!config.blockAds);
            return;
        }
        el.dataset.efAdBlocked = '1';
        adsBlockedCount++;
        if (config.blockAds) {
            el.classList.add('ef-ad-hidden');
        }
    }

    function hasLegitimateInternalLink(container) {
        const links = container.querySelectorAll('a[href]');
        for (const a of links) {
            const href = a.getAttribute('href') || a.href || '';
            if (!isSameOriginUrl(href) || isAdUrl(href)) continue;
            try {
                const path = new URL(href, window.location.href).pathname;
                if (/^\/(out|go|click|redirect|banner|promo|ad|ads|sponsor)\b/i.test(path)) continue;
                return true;
            } catch (_) {}
        }
        return false;
    }

    function findAdWrapper(el) {
        let target = el;
        let parent = el.parentElement;
        let depth = 0;
        while (parent && depth < 4) {
            if (
                isSafeProtectedContainer(parent) ||
                parent.querySelector('#albums, .media-group, a[href*="/a/"], nav, .navbar, footer, .pagination, [data-ef-suggested="1"]') ||
                hasLegitimateInternalLink(parent)
            ) {
                break;
            }
            target = parent;
            parent = parent.parentElement;
            depth++;
        }
        return target;
    }

    function hasVisualMediaInside(link) {
        if (link.querySelector('img, video, picture, canvas, iframe, object, embed')) return true;
        const svg = link.querySelector('svg');
        if (svg) {
            const r = svg.getBoundingClientRect();
            if (r.width >= 36 || r.height >= 36) return true;
        }
        try {
            const bg = window.getComputedStyle(link).backgroundImage;
            if (bg && bg !== 'none' && /url\(/i.test(bg)) return true;
            const childWithBg = link.querySelector('div, span, figure');
            if (childWithBg) {
                const cbg = window.getComputedStyle(childWithBg).backgroundImage;
                if (cbg && cbg !== 'none' && /url\(/i.test(cbg)) return true;
            }
        } catch (_) {}
        return false;
    }

    function installPopupBlocker() {
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        try {
            const origOpen = pageWin.open;
            if (typeof origOpen === 'function' && !origOpen.__efWrapped) {
                const wrappedOpen = function (url) {
                    if (config.blockAds) {
                        const urlStr = url ? String(url) : '';
                        if (!urlStr || urlStr === 'about:blank' || isAdUrl(urlStr) || !isSameOriginUrl(urlStr)) {
                            adsBlockedCount++;
                            updateStats();
                            return null;
                        }
                    }
                    return origOpen.apply(this, arguments);
                };
                wrappedOpen.__efWrapped = true;
                Object.defineProperty(pageWin, 'open', {
                    value: wrappedOpen,
                    writable: true,
                    configurable: true,
                });
            }
        } catch (_) {}

        try {
            const AnchorProto = pageWin.HTMLAnchorElement && pageWin.HTMLAnchorElement.prototype;
            if (AnchorProto && typeof AnchorProto.click === 'function' && !AnchorProto.click.__efWrapped) {
                const origClick = AnchorProto.click;
                const wrappedClick = function () {
                    const href = this.getAttribute('href') || this.href || '';
                    if (this.dataset?.efAllowClick === '1' || this.hasAttribute('download') || href.startsWith('blob:')) {
                        return origClick.apply(this, arguments);
                    }
                    if (config.blockAds) {
                        const isOffDomExternal = !this.isConnected && href && !isSameOriginUrl(href);
                        if (isOffDomExternal || isAdUrl(href)) {
                            adsBlockedCount++;
                            updateStats();
                            return;
                        }
                    }
                    return origClick.apply(this, arguments);
                };
                wrappedClick.__efWrapped = true;
                AnchorProto.click = wrappedClick;
            }
        } catch (_) {}

        document.addEventListener(
            'click',
            (e) => {
                if (!config.blockAds || pickerActive || isOurUiElement(e.target)) return;
                const link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
                if (!link) return;
                const href = link.getAttribute('href') || link.href || '';
                if (isAdUrl(href) || link.closest('[data-ef-ad-blocked="1"]')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    adsBlockedCount++;
                    updateStats();
                }
            },
            true
        );
    }
    installPopupBlocker();

    function cleanAds() {
        syncRootFeatureClasses();

        if (!config.blockAds) {
            document.querySelectorAll('[data-ef-ad-blocked="1"]').forEach((el) => {
                el.classList.remove('ef-ad-hidden');
            });
            return;
        }
        if (!document.body) return;

        processSuggestedUsers();

        const albumsContainer = getAlbumsContainer();
        if (albumsContainer) {
            Array.from(albumsContainer.children).forEach((child) => {
                if (child.nodeType !== 1 || isSafeProtectedContainer(child)) return;
                if (isValidAlbumCard(child)) return;
                if (child.classList.contains('pagination') || child.querySelector('.pagination')) return;

                const hasContent =
                    child.shadowRoot ||
                    child.querySelector('a, img, iframe, video, ins, canvas, svg') ||
                    (child.textContent || '').trim().length > 0;
                if (hasContent) {
                    markAsBlockedAd(child);
                }
            });
        }

        document.querySelectorAll('iframe').forEach((iframe) => {
            if (isSafeProtectedContainer(iframe)) return;
            const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
            if (CAPTCHA_URL_PATTERN.test(src)) return;
            if (!src || src === 'about:blank' || isAdUrl(src) || !isSameOriginUrl(src)) {
                markAsBlockedAd(findAdWrapper(iframe));
            }
        });

        const adContainerSelector = [
            'ins',
            '.ad', '.ads', '.advert', '.advertisement',
            '.ad-container', '.ad-wrapper', '.ad-banner', '.ad-box', '.ad-slot', '.ad-unit',
            '.ads-container', '.ads-wrapper', '.ads-banner', '.ads-box',
            '.banner', '.banners', '#banners', '.banner-ad', '.top-ad', '.bottom-ad',
            '.sidebar-ad', '.sticky-ad', '.floating-ad', '.sponsored', '.sponsor-banner',
            '.native-ad', '.promo-banner', '.promo-box', '.exo-native-widget', '.mgbox',
            '[id^="exo"]', '[class*="exoclick"]', '[id*="trafficjunky"]', '[id*="juicyads"]',
            '[data-ad]', '[data-ad-slot]', '[data-zoneid]', '[data-exoclick]',
            '.vjs-ad-playing', '[class*="vast-"]'
        ].join(',');

        document.querySelectorAll(adContainerSelector).forEach((el) => {
            if (isSafeProtectedContainer(el)) return;
            if (el.querySelector('#albums, .media-group, a[href*="/a/"], .pagination, [data-ef-suggested="1"]')) return;
            markAsBlockedAd(findAdWrapper(el));
        });

        document.querySelectorAll('a[href]').forEach((a) => {
            if (isSafeProtectedContainer(a)) return;
            if (a.closest('[data-ef-ad-blocked="1"]')) return;
            if (a.closest('.user-bio, .description, #user_description, .album-description, .comments')) return;

            const href = a.getAttribute('href') || a.href || '';
            const rel = (a.getAttribute('rel') || '').toLowerCase();
            const isExternal = !isSameOriginUrl(href);

            let isRedirectPath = false;
            if (!isExternal) {
                try {
                    const path = new URL(href, window.location.href).pathname;
                    isRedirectPath = /^\/(out|go|click|redirect|banner|promo|ad|ads|sponsor)\b/i.test(path);
                } catch (_) {}
            }

            if (isAdUrl(href) || isRedirectPath || (isExternal && (rel.includes('sponsored') || hasVisualMediaInside(a)))) {
                markAsBlockedAd(findAdWrapper(a));
            }
        });

        document.querySelectorAll('video').forEach((video) => {
            if (isSafeProtectedContainer(video)) return;
            if (video.closest('.media-group, #ef-feed-overlay')) return;
            const parentAlbum = video.closest('.album, div[id^="album-"]');
            if (parentAlbum && isValidAlbumCard(parentAlbum)) return;
            markAsBlockedAd(findAdWrapper(video));
        });

        document.querySelectorAll('.album, div[id^="album-"]').forEach((card) => {
            if (isSafeProtectedContainer(card)) return;
            if (!isValidAlbumCard(card)) {
                markAsBlockedAd(card);
            }
        });

        const vw = window.innerWidth || document.documentElement.clientWidth || 1000;
        const vh = window.innerHeight || document.documentElement.clientHeight || 800;

        Array.from(document.body.children).forEach((el) => {
            if (el.nodeType !== 1 || isSafeProtectedContainer(el)) return;
            const tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return;
            if (el.querySelector('#albums, .media-group, nav, .navbar, [data-ef-suggested="1"]')) return;

            if (el.shadowRoot) {
                markAsBlockedAd(el);
                return;
            }

            const style = window.getComputedStyle(el);
            if (style.display === 'none') return;

            const isFixedOrAbs = style.position === 'fixed' || style.position === 'absolute';
            if (!isFixedOrAbs) return;

            const rect = el.getBoundingClientRect();
            const zIndex = parseInt(style.zIndex, 10) || 0;

            const isHuge = rect.width >= vw * 0.5 && rect.height >= vh * 0.5;
            const isTransparent =
                parseFloat(style.opacity) === 0 ||
                ((style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent') &&
                    el.textContent.trim() === '' &&
                    !el.querySelector('img, svg, canvas, input'));

            if (isHuge && zIndex >= 100 && isTransparent) {
                markAsBlockedAd(el);
                return;
            }

            if (style.position === 'fixed' && !el.classList.contains('modal')) {
                const hasAdIframe = !!el.querySelector('iframe');
                const links = Array.from(el.querySelectorAll('a[href]'));
                const hasOnlyExternalLinks = links.length > 0 && links.every((l) => !isSameOriginUrl(l.getAttribute('href') || l.href));
                if (hasAdIframe || hasOnlyExternalLinks) {
                    markAsBlockedAd(el);
                }
            }
        });
    }

    let adCleanTimer = null;
    function scheduleCleanAds() {
        if (adCleanTimer) return;
        adCleanTimer = setTimeout(() => {
            adCleanTimer = null;
            cleanAds();
            updateStats();
        }, 180);
    }

    // ==================== 4. 樣式注入 ====================
    function injectStyle(css) {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
        } else {
            const style = document.createElement('style');
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
        }
    }

    injectStyle(`
        /* 零閃爍隱藏 18+ 驗證畫面 */
        #disclaimer,
        .disclaimer,
        #age-verification,
        .age-gate,
        .age-verification {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }

        /* 零閃爍隱藏 Suggested users */
        html.ef-hide-suggested .ef-suggested-hidden,
        html.ef-hide-suggested #suggested-users,
        html.ef-hide-suggested .suggested-users,
        html.ef-hide-suggested .suggested_users {
            display: none !important;
        }

        /* 零閃爍隱藏廣告 */
        html.ef-adblock-on .ef-ad-hidden,
        html.ef-adblock-on ins,
        html.ef-adblock-on .ad,
        html.ef-adblock-on .ads,
        html.ef-adblock-on .advert,
        html.ef-adblock-on .advertisement,
        html.ef-adblock-on .ad-container,
        html.ef-adblock-on .ad-wrapper,
        html.ef-adblock-on .ad-banner,
        html.ef-adblock-on .ad-box,
        html.ef-adblock-on .ad-slot,
        html.ef-adblock-on .ads-container,
        html.ef-adblock-on .ads-banner,
        html.ef-adblock-on .banner-ad,
        html.ef-adblock-on .top-ad,
        html.ef-adblock-on .bottom-ad,
        html.ef-adblock-on .sticky-ad,
        html.ef-adblock-on .floating-ad,
        html.ef-adblock-on .native-ad,
        html.ef-adblock-on .exo-native-widget,
        html.ef-adblock-on [id^="exo"],
        html.ef-adblock-on [class*="exoclick"],
        html.ef-adblock-on [data-zoneid],
        html.ef-adblock-on iframe[src*="exoclick"],
        html.ef-adblock-on iframe[src*="exosrv"],
        html.ef-adblock-on iframe[src*="realsrv"],
        html.ef-adblock-on iframe[src*="magsrv"],
        html.ef-adblock-on iframe[src*="tsyndicate"],
        html.ef-adblock-on iframe[src*="trafficjunky"],
        html.ef-adblock-on iframe[src*="juicyads"],
        html.ef-adblock-on iframe[src*="adsterra"],
        html.ef-adblock-on iframe[src*="stripchat"],
        html.ef-adblock-on iframe[src*="chaturbate"],
        html.ef-adblock-on iframe[src*="bongacams"],
        html.ef-adblock-on iframe[src*="livejasmin"],
        html.ef-adblock-on iframe[src*="jerkmate"] {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            height: 0 !important;
            min-height: 0 !important;
            max-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
        }

        html, body, footer, .footer, #ef-infinite-sentinel {
            overflow-anchor: none !important;
        }
        html, body {
            overflow: auto !important;
        }
        html.ef-feed-open, body.ef-feed-open {
            overflow: hidden !important;
            overscroll-behavior: none !important;
        }
        .ef-hidden {
            display: none !important;
        }
        .ef-loaded-img {
            opacity: 1 !important;
            visibility: visible !important;
        }
        
        /* 長方形封面排版（覆蓋網站預設正方形／固定高度限制） */
        html.ef-cover-portrait .ef-cover-box,
        html.ef-cover-tall .ef-cover-box,
        html.ef-cover-landscape .ef-cover-box {
            position: relative !important;
            display: block !important;
            width: 100% !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
            overflow: hidden !important;
            border-radius: 10px !important;
            background: #0d0d12 !important;
        }
        html.ef-cover-portrait .ef-cover-box::before,
        html.ef-cover-portrait .ef-cover-box::after,
        html.ef-cover-tall .ef-cover-box::before,
        html.ef-cover-tall .ef-cover-box::after,
        html.ef-cover-landscape .ef-cover-box::before,
        html.ef-cover-landscape .ef-cover-box::after {
            display: none !important;
            content: none !important;
        }
        html.ef-cover-portrait .ef-cover-box > a,
        html.ef-cover-tall .ef-cover-box > a,
        html.ef-cover-landscape .ef-cover-box > a {
            position: static !important;
            display: block !important;
            width: 100% !important;
            height: auto !important;
        }
        html.ef-cover-portrait .ef-cover-img,
        html.ef-cover-tall .ef-cover-img,
        html.ef-cover-landscape .ef-cover-img {
            position: static !important;
            width: 100% !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            object-fit: cover !important;
            object-position: center !important;
            display: block !important;
            margin: 0 !important;
        }
        html.ef-cover-portrait .ef-cover-img { aspect-ratio: 2 / 3 !important; }
        html.ef-cover-tall .ef-cover-img { aspect-ratio: 9 / 16 !important; }
        html.ef-cover-landscape .ef-cover-img { aspect-ratio: 16 / 9 !important; }

        .ef-select {
            background: rgba(255, 255, 255, 0.1);
            color: #f3f4f6;
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 7px;
            padding: 3px 6px;
            font-size: 12px;
            outline: none;
            cursor: pointer;
        }
        .ef-select option {
            background: #16161d;
            color: #f3f4f6;
        }

        /* 自訂封面大小與多欄排列（1～4 欄，保持比例不變） */
        html.ef-grid-custom .ef-grid-container {
            display: grid !important;
            grid-template-columns: repeat(
                var(--ef-grid-cols, 2),
                minmax(0, calc((100% - var(--ef-total-gap, 10px)) * var(--ef-card-pct, 0.5)))
            ) !important;
            gap: var(--ef-grid-gap, 10px) !important;
            justify-content: center !important;
            align-items: start !important;
            width: 100% !important;
            box-sizing: border-box !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
        }
        /* 移除 Bootstrap 假元素與 clearfix，避免佔用多餘空位 */
        html.ef-grid-custom .ef-grid-container::before,
        html.ef-grid-custom .ef-grid-container::after,
        html.ef-grid-custom .ef-grid-container > .clearfix {
            display: none !important;
            content: none !important;
        }
        html.ef-grid-custom .ef-grid-container > .album,
        html.ef-grid-custom .ef-grid-container > div[id^="album-"] {
            width: 100% !important;
            max-width: 100% !important;
            min-width: 0 !important;
            flex: none !important;
            float: none !important;
            margin: 0 !important;
            padding: 0 !important;
        }
        /* 網站原樣比例模式下，縮小欄寬一樣維持原圖比例不變形 */
        html.ef-grid-custom .ef-grid-container .album img {
            width: 100% !important;
            height: auto !important;
        }
        /* 3～4 欄緊湊排版：縮小卡片文字與按鈕避免重疊 */
        html.ef-grid-compact .ef-grid-container .ef-badge {
            top: 5px;
            left: 5px;
            padding: 1px 6px;
            font-size: 10px;
        }
        html.ef-grid-compact .ef-grid-container .ef-card-play-btn {
            top: 5px;
            right: 5px;
            padding: 2px 7px;
            font-size: 10px;
        }
        html.ef-grid-cols-4 .ef-grid-container .ef-card-play-btn {
            top: auto;
            bottom: 5px;
            right: 5px;
        }
        html.ef-grid-compact .ef-grid-container .album-title,
        html.ef-grid-compact .ef-grid-container .album-user {
            font-size: 11px !important;
            line-height: 1.3 !important;
        }

        /* 面板內封面大小滑桿樣式 */
        .ef-size-control {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 2px 0;
        }
        .ef-size-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            font-size: 12px;
        }
        .ef-size-head-right {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        #ef-size-label {
            color: #f9a8d4;
            font-weight: 700;
            font-size: 11px;
        }
        .ef-reset-mini {
            background: rgba(255, 255, 255, 0.12);
            color: #e5e7eb;
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 6px;
            padding: 1px 6px;
            font-size: 10px;
            cursor: pointer;
        }
        .ef-size-slider-row {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: #9ca3af;
        }
        #ef-rng-cover-size {
            flex: 1;
            accent-color: #eb6395;
            cursor: pointer;
            margin: 0;
        }

        /* 精簡封面與優化標題（徹底隱藏頭像／作者／角標，改為單行＋預覽跑馬燈） */
        html.ef-clean-card .ef-clean-hide,
        html.ef-clean-card .ef-album-card .album-bottom-left,
        html.ef-clean-card .ef-album-card .album-bottom-right,
        html.ef-clean-card .ef-album-card .album-views,
        html.ef-clean-card .ef-album-card .album-videos,
        html.ef-clean-card .ef-album-card .album-images,
        html.ef-clean-card .ef-album-card .album-photos,
        html.ef-clean-card .ef-album-card .album-counts,
        html.ef-clean-card .ef-album-card .album-stats,
        html.ef-clean-card .ef-album-card .album-user,
        html.ef-clean-card .ef-album-card .album-author,
        html.ef-clean-card .ef-album-card .album-username,
        html.ef-clean-card .ef-album-card .album-avatar,
        html.ef-clean-card .ef-album-card .user-avatar,
        html.ef-clean-card .ef-album-card .album-informations img,
        html.ef-clean-card .ef-album-card .album-informations .rounded-circle,
        html.ef-clean-card .ef-album-card .album-informations [class*="avatar"] {
            display: none !important;
        }

        /* 解除網站原本標題外層的固定高度與左右縮排（解決字體被蓋住一半） */
        html.ef-clean-card .ef-album-card .album-informations,
        html.ef-clean-card .ef-album-card .ef-clean-title-wrap {
            display: block !important;
            width: 100% !important;
            max-width: 100% !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: visible !important;
            background: transparent !important;
        }
        html.ef-clean-card .ef-album-card .album-informations {
            padding: 6px 2px 2px !important;
        }

        /* 一般模式：高對比單行顯示（超出以 ... 收尾，絕不截半字） */
        html.ef-clean-card .ef-album-card .ef-clean-title {
            display: block !important;
            width: 100% !important;
            max-width: 100% !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            margin: 0 !important;
            padding: 2px 0 !important;
            overflow: hidden !important;
            white-space: nowrap !important;
            text-overflow: ellipsis !important;
            color: #f8fafc !important;
            font-size: 13.5px !important;
            font-weight: 600 !important;
            line-height: 1.5 !important;
            letter-spacing: 0.01em !important;
            text-decoration: none !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
        }
        html.ef-clean-card .ef-album-card .ef-clean-title:hover {
            color: #f9a8d4 !important;
        }
        html.ef-clean-card .ef-album-card .ef-marquee-inner {
            display: inline !important;
            white-space: nowrap !important;
        }

        /* 預覽影片模式：文字過長時自動啟動跑馬燈顯示完整標題 */
        html.ef-clean-card .ef-album-card.ef-card-previewing.ef-marquee-active .ef-clean-title {
            text-overflow: clip !important;
            color: #ffd1e1 !important;
        }
        html.ef-clean-card .ef-album-card.ef-card-previewing.ef-marquee-active .ef-marquee-inner {
            display: inline-block !important;
            will-change: transform;
            animation: efTitleMarquee var(--ef-marquee-dur, 6s) linear infinite;
        }
        @keyframes efTitleMarquee {
            0%, 10% {
                transform: translateX(0);
                opacity: 1;
            }
            78%, 90% {
                transform: translateX(var(--ef-marquee-shift, 0px));
                opacity: 1;
            }
            95% {
                transform: translateX(var(--ef-marquee-shift, 0px));
                opacity: 0;
            }
            96% {
                transform: translateX(0);
                opacity: 0;
            }
            100% {
                transform: translateX(0);
                opacity: 1;
            }
        }

        /* 3～4 欄緊湊排列時同步微調單行字級 */
        html.ef-clean-card.ef-grid-compact .ef-album-card .ef-clean-title {
            font-size: 12.5px !important;
        }
        html.ef-clean-card.ef-grid-cols-4 .ef-album-card .ef-clean-title {
            font-size: 11.5px !important;
        }

        /* 卡片標籤與「從此篇直接開刷」按鈕 */
        .ef-badge {
            position: absolute;
            top: 8px;
            left: 8px;
            z-index: 20;
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 700;
            line-height: 1.4;
            color: #fff;
            background: rgba(235, 99, 149, 0.92);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
            pointer-events: none;
            backdrop-filter: blur(4px);
        }
        .ef-badge.ef-scanning {
            background: rgba(30, 30, 35, 0.82);
            color: #ddd;
        }
        .ef-card-play-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            z-index: 25;
            padding: 4px 10px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.28);
            background: linear-gradient(135deg, rgba(235, 99, 149, 0.95), rgba(255, 77, 121, 0.95));
            color: #fff;
            font-size: 11px;
            font-weight: 700;
            line-height: 1.4;
            cursor: pointer;
            box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45);
            backdrop-filter: blur(4px);
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }
        .ef-card-play-btn:active {
            transform: scale(0.95);
        }
        .ef-card-play-btn:disabled {
            opacity: 0.7;
            cursor: wait;
        }

        /* 新頁面分隔線 */
        .ef-page-divider {
            width: 100%;
            flex: 0 0 100%;
            grid-column: 1 / -1;
            clear: both;
            text-align: center;
            padding: 12px 10px;
            margin: 10px 0 14px;
            font-size: 12px;
            font-weight: 600;
            color: #f9a8d4;
            border-top: 1px dashed rgba(235, 99, 149, 0.4);
            border-bottom: 1px dashed rgba(235, 99, 149, 0.4);
            background: rgba(235, 99, 149, 0.08);
            border-radius: 8px;
        }

        /* 網站最底部無限滾動狀態條 */
        #ef-infinite-sentinel {
            width: 100%;
            clear: both;
            padding: 20px 12px calc(76px + env(safe-area-inset-bottom, 0px));
            margin-top: 12px;
            text-align: center;
            color: #d1d5db;
            font-size: 13px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            flex-wrap: wrap;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        #ef-load-more-btn {
            background: #eb6395;
            color: #fff;
            border: none;
            border-radius: 999px;
            padding: 7px 16px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
        }
        #ef-load-more-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* 浮動控制面板 */
        #ef-panel {
            position: fixed;
            right: 14px;
            bottom: calc(14px + env(safe-area-inset-bottom, 0px));
            z-index: 2147483640;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            color: #f3f4f6;
            background: rgba(20, 20, 26, 0.94);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 14px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            min-width: 236px;
            max-width: calc(100vw - 28px);
            overflow: hidden;
            user-select: none;
        }
        #ef-panel.collapsed {
            min-width: auto;
            border-radius: 999px;
        }
        #ef-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 9px 13px;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.06);
            font-weight: 600;
        }
        #ef-body {
            padding: 10px 12px 11px;
            display: flex;
            flex-direction: column;
            gap: 7px;
            max-height: 78vh;
            overflow-y: auto;
        }
        #ef-panel.collapsed #ef-body {
            display: none;
        }
        .ef-panel-btn {
            width: 100%;
            padding: 7px 9px;
            border: none;
            border-radius: 9px;
            color: #fff;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            white-space: nowrap;
        }
        .ef-panel-btn:active {
            transform: scale(0.98);
        }
        .ef-btn-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
        }
        .ef-btn-split {
            display: flex;
            gap: 6px;
        }
        .ef-btn-split > :first-child {
            flex: 1;
        }
        .ef-btn-split > :last-child {
            width: auto;
            padding: 7px 10px;
        }
        #ef-open-feed-btn {
            padding: 8px 10px;
            font-size: 13px;
            background: linear-gradient(135deg, #eb6395, #ff4d79);
            box-shadow: 0 3px 10px rgba(235, 99, 149, 0.35);
        }
        .ef-panel-subbtn {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.16);
            font-weight: 600;
        }
        .ef-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            cursor: pointer;
            margin: 0;
            font-weight: 400;
        }
        .ef-row input[type="checkbox"] {
            accent-color: #eb6395;
            width: 16px;
            height: 16px;
            cursor: pointer;
            margin: 0;
        }
        #ef-stats {
            font-size: 11px;
            color: #9ca3af;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            padding-top: 6px;
            line-height: 1.5;
            white-space: pre-line;
        }

        /* ==================== 視覺化「點選隱藏」工具 ==================== */
        #ef-picker-highlight {
            position: fixed;
            z-index: 2147483645;
            pointer-events: none;
            display: none;
            border: 2px solid #eb6395;
            background: rgba(235, 99, 149, 0.22);
            box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4);
            border-radius: 4px;
            transition: all 0.06s ease-out;
        }
        #ef-picker-highlight.locked {
            border: 3px solid #22c55e;
            background: rgba(34, 197, 94, 0.22);
        }
        #ef-picker-bar {
            position: fixed;
            top: calc(10px + env(safe-area-inset-top, 0px));
            left: 50%;
            transform: translateX(-50%);
            z-index: 2147483647;
            width: min(560px, calc(100vw - 20px));
            background: rgba(18, 18, 24, 0.96);
            border: 1px solid rgba(235, 99, 149, 0.55);
            border-radius: 14px;
            padding: 8px 12px 10px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.65);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            color: #f3f4f6;
            display: none;
            flex-direction: column;
            gap: 8px;
            user-select: none;
            -webkit-user-select: none;
        }
        #ef-picker-bar.open {
            display: flex;
        }
        #ef-picker-bar.dragging {
            opacity: 0.88;
            border-color: #22c55e;
            box-shadow: 0 14px 36px rgba(0, 0, 0, 0.8);
        }
        #ef-picker-drag-handle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            cursor: grab;
            touch-action: none;
            font-size: 12px;
            font-weight: 700;
            color: #e5e7eb;
        }
        #ef-picker-bar.dragging #ef-picker-drag-handle {
            cursor: grabbing;
        }
        #ef-picker-info {
            font-size: 12px;
            color: #f9a8d4;
            word-break: break-all;
            line-height: 1.4;
            cursor: grab;
            touch-action: none;
        }
        #ef-picker-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }

        /* ==================== 抖音全螢幕滑動模式 ==================== */
        #ef-feed-overlay {
            position: fixed;
            inset: 0;
            width: 100vw;
            height: 100vh;
            z-index: 2147483644;
            background: #000;
            display: none;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            color: #fff;
        }
        @supports (height: 100dvh) {
            #ef-feed-overlay { height: 100dvh; }
        }
        #ef-feed-overlay:fullscreen,
        #ef-feed-overlay:-webkit-full-screen {
            width: 100% !important;
            height: 100% !important;
            background: #000 !important;
        }
        #ef-feed-overlay.open {
            display: block;
        }
        #ef-feed-topbar {
            position: fixed;
            top: calc(10px + env(safe-area-inset-top, 0px));
            left: 10px;
            right: 10px;
            z-index: 35;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            pointer-events: none;
            transition: opacity 0.2s ease;
        }
        .ef-topbar-group {
            display: flex;
            align-items: center;
            gap: 6px;
            pointer-events: auto;
        }
        .ef-pill-btn {
            background: rgba(15, 15, 20, 0.68);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 999px;
            padding: 6px 10px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            white-space: nowrap;
            line-height: 1.2;
        }
        .ef-pill-btn.active {
            background: rgba(235, 99, 149, 0.85);
            border-color: #ff80ab;
        }
        .ef-mode-tabs {
            display: flex;
            align-items: center;
            background: rgba(15, 15, 20, 0.68);
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 999px;
            padding: 2px;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
        }
        .ef-mode-tab {
            border: none;
            background: transparent;
            color: rgba(255, 255, 255, 0.72);
            border-radius: 999px;
            padding: 5px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
        }
        .ef-mode-tab.active {
            background: #eb6395;
            color: #fff;
        }
        #ef-feed-counter {
            position: fixed;
            top: calc(50px + env(safe-area-inset-top, 0px));
            left: 12px;
            z-index: 34;
            background: rgba(15, 15, 20, 0.58);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 999px;
            padding: 4px 10px;
            font-size: 11px;
            color: #e5e7eb;
            backdrop-filter: blur(8px);
            pointer-events: none;
            white-space: nowrap;
            transition: opacity 0.2s ease;
        }

        /* 作者快速追片專屬提示列 */
        #ef-author-bar {
            position: fixed;
            top: calc(82px + env(safe-area-inset-top, 0px));
            left: 12px;
            right: 12px;
            z-index: 34;
            display: none;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 6px 10px;
            border-radius: 12px;
            background: rgba(235, 99, 149, 0.22);
            border: 1px solid rgba(235, 99, 149, 0.55);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            font-size: 12px;
            transition: opacity 0.2s ease;
        }
        #ef-author-bar.show {
            display: flex;
        }
        #ef-author-bar-label {
            font-weight: 700;
            color: #ffe4ee;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
        }
        .ef-author-bar-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        .ef-author-bar-btn {
            background: rgba(15, 15, 20, 0.72);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 999px;
            padding: 4px 9px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            white-space: nowrap;
        }

        /* 專注模式 */
        #ef-feed-overlay.focus-mode #ef-feed-topbar,
        #ef-feed-overlay.focus-mode #ef-feed-counter,
        #ef-feed-overlay.focus-mode #ef-author-bar,
        #ef-feed-overlay.focus-mode .ef-side-actions,
        #ef-feed-overlay.focus-mode .ef-slide-bottom {
            opacity: 0 !important;
            pointer-events: none !important;
        }
        #ef-focus-exit-btn {
            position: fixed;
            right: 14px;
            bottom: calc(18px + env(safe-area-inset-bottom, 0px));
            z-index: 42;
            display: none;
            align-items: center;
            justify-content: center;
            gap: 5px;
            padding: 7px 12px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.22);
            background: rgba(15, 15, 20, 0.38);
            color: rgba(255, 255, 255, 0.72);
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            transition: opacity 0.2s ease, background 0.2s ease;
        }
        #ef-focus-exit-btn:hover,
        #ef-focus-exit-btn:active {
            background: rgba(235, 99, 149, 0.88);
            color: #fff;
        }
        #ef-feed-overlay.focus-mode #ef-focus-exit-btn {
            display: flex;
        }

        /* 長按倍速指示膠囊 */
        #ef-speed-pill {
            position: fixed;
            top: calc(56px + env(safe-area-inset-top, 0px));
            left: 50%;
            transform: translateX(-50%);
            z-index: 40;
            background: rgba(235, 99, 149, 0.92);
            color: #fff;
            padding: 6px 14px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 700;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.15s ease;
        }
        #ef-speed-pill.show {
            opacity: 1;
        }

        #ef-feed-scroller {
            width: 100%;
            height: 100%;
            overflow-y: scroll;
            scroll-snap-type: y mandatory;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior-y: contain;
            scrollbar-width: none;
        }
        #ef-feed-scroller::-webkit-scrollbar {
            display: none;
        }
        .ef-slide {
            position: relative;
            width: 100%;
            height: 100%;
            min-height: 100%;
            scroll-snap-align: start;
            scroll-snap-stop: always;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #000;
            overflow: hidden;
            user-select: none;
            -webkit-user-select: none;
            -webkit-touch-callout: none;
        }
        .ef-slide video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
            display: block;
            -webkit-touch-callout: none;
        }
        #ef-feed-overlay.cover-mode .ef-slide video {
            object-fit: cover;
        }
        .ef-pause-indicator {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) scale(0.9);
            width: 68px;
            height: 68px;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.55);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 30px;
            color: rgba(255, 255, 255, 0.92);
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.16s ease, transform 0.16s ease;
        }
        .ef-slide.paused .ef-pause-indicator {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }

        /* 雙擊快進/快退與愛心特效 */
        .ef-gesture-fx {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            padding: 10px 16px;
            border-radius: 14px;
            background: rgba(0, 0, 0, 0.65);
            color: #fff;
            font-size: 16px;
            font-weight: 700;
            pointer-events: none;
            z-index: 30;
            animation: efPopFade 0.65s ease forwards;
        }
        .ef-gesture-fx.left { left: 16%; }
        .ef-gesture-fx.right { right: 16%; }
        .ef-heart-burst {
            position: absolute;
            font-size: 76px;
            pointer-events: none;
            z-index: 30;
            transform: translate(-50%, -50%);
            filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.5));
            animation: efHeartPop 0.75s ease forwards;
        }
        @keyframes efPopFade {
            0% { opacity: 0; transform: translateY(-50%) scale(0.85); }
            20% { opacity: 1; transform: translateY(-50%) scale(1.03); }
            80% { opacity: 1; transform: translateY(-50%) scale(1); }
            100% { opacity: 0; transform: translateY(-50%) scale(0.95); }
        }
        @keyframes efHeartPop {
            0% { opacity: 0; transform: translate(-50%, -50%) scale(0.4) rotate(-12deg); }
            30% { opacity: 1; transform: translate(-50%, -50%) scale(1.2) rotate(6deg); }
            70% { opacity: 0.95; transform: translate(-50%, -65%) scale(1); }
            100% { opacity: 0; transform: translate(-50%, -90%) scale(1.15); }
        }

        /* 右側抖音式操作欄 */
        .ef-side-actions {
            position: absolute;
            right: 10px;
            bottom: calc(80px + env(safe-area-inset-bottom, 0px));
            z-index: 25;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 7px;
            transition: opacity 0.2s ease;
        }
        .ef-action-wrap {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;
        }
        .ef-action-btn {
            width: 38px;
            height: 38px;
            border-radius: 50%;
            border: 1px solid rgba(255, 255, 255, 0.2);
            background: rgba(20, 20, 26, 0.65);
            color: #fff;
            font-size: 15px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            padding: 0;
            text-decoration: none;
        }
        .ef-action-btn.ef-btn-speed {
            font-size: 11px;
        }
        .ef-action-btn.is-fav {
            background: rgba(235, 99, 149, 0.85);
            border-color: #ff80ab;
        }
        .ef-action-btn.ef-btn-skip-album {
            background: rgba(235, 99, 149, 0.28);
            border-color: rgba(235, 99, 149, 0.65);
        }
        .ef-action-btn.ef-btn-block-author {
            background: rgba(239, 68, 68, 0.28);
            border-color: rgba(239, 68, 68, 0.55);
        }
        .ef-action-label {
            font-size: 10px;
            color: rgba(255, 255, 255, 0.92);
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
        }

        /* 底部資訊與進度條 */
        .ef-slide-bottom {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 15;
            padding: 36px 62px calc(14px + env(safe-area-inset-bottom, 0px)) 14px;
            background: linear-gradient(to top, rgba(0, 0, 0, 0.84), rgba(0, 0, 0, 0.28) 65%, transparent);
            pointer-events: none;
            transition: opacity 0.2s ease;
        }
        .ef-slide-meta-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 5px;
            flex-wrap: wrap;
        }
        .ef-slide-author-btn {
            pointer-events: auto;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 3px 10px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.26);
            background: rgba(20, 20, 28, 0.58);
            color: #fff;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
            transition: background 0.15s ease, border-color 0.15s ease;
        }
        .ef-slide-author-btn:hover,
        .ef-slide-author-btn:active {
            background: rgba(235, 99, 149, 0.82);
            border-color: #ff80ab;
        }
        .ef-slide-author-tag {
            font-size: 10px;
            font-weight: 600;
            color: #ffd1e1;
        }
        .ef-album-pos {
            font-size: 11px;
            font-weight: 600;
            color: #ffd1e1;
            background: rgba(235, 99, 149, 0.35);
            border: 1px solid rgba(235, 99, 149, 0.55);
            padding: 1px 7px;
            border-radius: 999px;
            display: none;
        }
        .ef-slide-title {
            font-size: 13px;
            color: rgba(255, 255, 255, 0.9);
            line-height: 1.35;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            margin-bottom: 10px;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        .ef-progress-wrap {
            pointer-events: auto;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ef-progress {
            flex: 1;
            -webkit-appearance: none;
            appearance: none;
            height: 4px;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.28);
            outline: none;
            cursor: pointer;
        }
        .ef-progress::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #eb6395;
            cursor: pointer;
        }
        .ef-time-text {
            font-size: 11px;
            color: rgba(255, 255, 255, 0.85);
            font-variant-numeric: tabular-nums;
            min-width: 72px;
            text-align: right;
        }

        #ef-feed-tail {
            flex-direction: column;
            gap: 14px;
            text-align: center;
            padding: 24px;
            color: #d1d5db;
        }
        #ef-feed-tail button {
            background: #eb6395;
            color: #fff;
            border: none;
            border-radius: 999px;
            padding: 9px 20px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
        }

        /* ==================== 通用管理彈窗 ==================== */
        .ef-modal-backdrop {
            position: fixed;
            inset: 0;
            z-index: 2147483646;
            background: rgba(0, 0, 0, 0.74);
            backdrop-filter: blur(6px);
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            color: #f3f4f6;
        }
        .ef-modal-backdrop.open {
            display: flex;
        }
        .ef-modal-card {
            width: 100%;
            max-width: 540px;
            max-height: 84vh;
            background: #16161d;
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 16px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
        }
        .ef-modal-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 13px 16px;
            background: rgba(255, 255, 255, 0.04);
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            font-weight: 700;
            font-size: 15px;
        }
        .ef-modal-tools {
            display: flex;
            gap: 7px;
            padding: 10px 14px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            flex-wrap: wrap;
        }
        .ef-modal-body {
            flex: 1;
            overflow-y: auto;
            padding: 12px 14px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .ef-small-btn {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
        }
        .ef-small-btn.primary {
            background: #eb6395;
            border-color: #eb6395;
        }
        .ef-small-btn.success {
            background: #16a34a;
            border-color: #22c55e;
        }
        .ef-small-btn.danger {
            background: rgba(239, 68, 68, 0.2);
            border-color: rgba(239, 68, 68, 0.45);
            color: #fca5a5;
        }
        .ef-small-btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }
        .ef-input-row {
            display: flex;
            gap: 7px;
        }
        .ef-text-input {
            flex: 1;
            background: rgba(255, 255, 255, 0.07);
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 8px;
            padding: 7px 10px;
            color: #fff;
            font-size: 13px;
            outline: none;
        }
        .ef-text-input:focus {
            border-color: #eb6395;
        }
        .ef-section-title {
            font-size: 13px;
            font-weight: 700;
            color: #f9a8d4;
            margin-bottom: 6px;
        }
        .ef-chip-list {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            margin-top: 8px;
        }
        .ef-chip {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 9px;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.14);
            font-size: 12px;
            color: #f3f4f6;
        }
        .ef-chip button {
            background: none;
            border: none;
            color: #fca5a5;
            font-weight: 700;
            cursor: pointer;
            padding: 0 2px;
            font-size: 12px;
            line-height: 1;
        }
        .ef-fav-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .ef-fav-thumb {
            width: 52px;
            height: 74px;
            border-radius: 7px;
            object-fit: cover;
            background: #000;
            flex-shrink: 0;
            cursor: pointer;
        }
        .ef-fav-info {
            flex: 1;
            min-width: 0;
            cursor: pointer;
        }
        .ef-fav-title {
            font-size: 13px;
            font-weight: 600;
            color: #fff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .ef-fav-meta {
            font-size: 11px;
            color: #9ca3af;
            margin-top: 3px;
        }
        .ef-fav-item-actions {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
        }
        .ef-rule-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 8px 10px;
            border-radius: 9px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            font-size: 12px;
            word-break: break-all;
        }

        /* 全域輕提示 Toast */
        #ef-toast {
            position: fixed;
            left: 50%;
            bottom: calc(82px + env(safe-area-inset-bottom, 0px));
            transform: translateX(-50%) translateY(12px);
            z-index: 2147483647;
            background: rgba(20, 20, 26, 0.92);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.16);
            padding: 8px 16px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s ease, transform 0.2s ease;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
            max-width: 86vw;
            text-align: center;
        }
        #ef-toast.show {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
    `);

    // ==================== 5. 略過 18+ 驗證畫面 ====================
    let disclaimerApiSent = false;
    let enterButtonClicked = false;

    function restoreScroll() {
        if (document.documentElement && !document.documentElement.classList.contains('ef-feed-open')) {
            document.documentElement.style.setProperty('overflow', 'auto', 'important');
        }
        if (document.body && !document.body.classList.contains('ef-feed-open')) {
            document.body.style.setProperty('overflow', 'auto', 'important');
            document.body.classList.remove('modal-open');
        }
        document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    }

    function bypassAgeGate() {
        const disclaimerEl = document.querySelector('#disclaimer, .disclaimer');
        if (disclaimerEl) {
            const btn = disclaimerEl.querySelector('button, a, input[type="button"], input[type="submit"]');
            if (btn && !enterButtonClicked) {
                enterButtonClicked = true;
                try { btn.click(); } catch (_) {}
            }
            if (!disclaimerApiSent) {
                disclaimerApiSent = true;
                fetch('/user/disclaimer', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                }).catch(() => {});
            }
            disclaimerEl.remove();
            restoreScroll();
        }

        if (!enterButtonClicked) {
            const candidates = document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]');
            for (const el of candidates) {
                const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
                if (/i\s*am\s*18\s*or\s*older/i.test(text) && /enter/i.test(text)) {
                    enterButtonClicked = true;
                    try { el.click(); } catch (_) {}
                    setTimeout(() => {
                        let parent = el.parentElement;
                        while (parent && parent !== document.body && parent !== document.documentElement) {
                            const style = window.getComputedStyle(parent);
                            if (style.position === 'fixed' && parent.offsetHeight >= window.innerHeight * 0.6) {
                                parent.remove();
                                break;
                            }
                            parent = parent.parentElement;
                        }
                        restoreScroll();
                    }, 100);
                    break;
                }
            }
        }
    }

    const earlyObserver = new MutationObserver(() => {
        bypassAgeGate();
        if (config.blockAds || config.hideSuggestedUsers) {
            scheduleCleanAds();
        }
    });
    earlyObserver.observe(document.documentElement, { childList: true, subtree: true });
    const ageCheckTimer = setInterval(bypassAgeGate, 150);
    setTimeout(() => clearInterval(ageCheckTimer), 5000);

    // ==================== 6. 工具函式與快取 ====================
    function loadCache() {
        try {
            return JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}');
        } catch (_) {
            return {};
        }
    }

    const albumCache = loadCache();
    function saveCache(key, value) {
        albumCache[key] = value;
        try {
            const keys = Object.keys(albumCache);
            if (keys.length > 250) delete albumCache[keys[0]];
            sessionStorage.setItem(CACHE_KEY, JSON.stringify(albumCache));
        } catch (_) {}
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function cssEscapeSafe(str) {
        if (window.CSS && typeof window.CSS.escape === 'function') {
            return window.CSS.escape(str);
        }
        return String(str).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
    }

    function resolveUrl(raw, base = window.location.href) {
        if (!raw) return '';
        try {
            return new URL(raw, base).href;
        } catch (_) {
            return raw;
        }
    }

    function normalizePageUrl(raw, base = window.location.href) {
        if (!raw) return null;
        const trimmed = String(raw).trim();
        if (!trimmed || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return null;
        try {
            const u = new URL(trimmed, base);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
            u.hash = '';
            return u.href;
        } catch (_) {
            return null;
        }
    }

    function buildAuthorProfileUrl(author) {
        const clean = String(author || '').replace(/^@+/, '').trim();
        if (!clean) return '';
        return `${window.location.origin}/${encodeURIComponent(clean)}`;
    }

    function extractAuthorFromDoc(doc, baseUrl, fallbackAuthor = '', fallbackAuthorUrl = '') {
        const linkEl = doc.querySelector('a#user_name, a.user-name, #user_name a, .user-name a, .album-user a');
        const textEl = doc.querySelector('#user_name, .user-name');
        const author = ((linkEl?.textContent || textEl?.textContent || fallbackAuthor || '')).replace(/^@+/, '').trim();
        const rawHref = linkEl?.getAttribute('href');
        const authorUrl = rawHref ? resolveUrl(rawHref, baseUrl) : (fallbackAuthorUrl || buildAuthorProfileUrl(author));
        return { author, authorUrl };
    }

    function formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    function formatRateLabel(rate) {
        return `${rate}x`;
    }

    function getFullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    let toastTimer = null;
    function showToast(msg) {
        const host = getFullscreenElement() || document.body;
        if (!host) return;
        let toast = document.getElementById('ef-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ef-toast';
        }
        if (toast.parentElement !== host) {
            host.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    function isPortrait(width, height) {
        return width > 0 && height > 0 && height / width > PORTRAIT_RATIO_THRESHOLD;
    }

    function getImageDimensions(url, timeoutMs = 8000) {
        return new Promise((resolve) => {
            if (!url || url.startsWith('data:image/gif')) {
                resolve(null);
                return;
            }
            const img = new Image();
            let done = false;
            const finish = (res) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(res);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => finish(null);
            img.src = url;
        });
    }

    function extractVideoSrc(videoEl, baseUrl = window.location.href) {
        if (!videoEl) return null;
        const direct = videoEl.getAttribute('src') || videoEl.getAttribute('data-src') || videoEl.currentSrc;
        if (direct && !direct.startsWith('blob:')) return resolveUrl(direct, baseUrl);
        const source = videoEl.querySelector('source[src], source[data-src]');
        const sAttr = source ? (source.getAttribute('src') || source.getAttribute('data-src')) : null;
        return sAttr ? resolveUrl(sAttr, baseUrl) : null;
    }

    function extractPosterUrl(videoEl, container, baseUrl = window.location.href) {
        const attrPoster = videoEl?.getAttribute('poster') || videoEl?.getAttribute('data-poster');
        if (attrPoster) return resolveUrl(attrPoster, baseUrl);

        const vjsPoster = container?.querySelector('.vjs-poster');
        if (vjsPoster) {
            const bg = vjsPoster.style.backgroundImage || window.getComputedStyle(vjsPoster).backgroundImage;
            const match = bg && bg.match(/url\(["']?(.*?)["']?\)/i);
            if (match && match[1]) return resolveUrl(match[1], baseUrl);
        }
        return null;
    }

    // ==================== 7. 影片池、黑名單連動與收藏操作 ====================
    const allDiscoveredVideos = [];
    const feedVideos = [];
    const seenVideoSrcs = new Set();
    let pendingSkipAlbumUrl = null;

    function addFeedVideo(item) {
        if (!item || !item.src || seenVideoSrcs.has(item.src)) return;
        const normalizedItem = {
            ...item,
            author: String(item.author || '').replace(/^@+/, '').trim(),
            authorUrl: item.authorUrl || buildAuthorProfileUrl(item.author),
        };
        seenVideoSrcs.add(normalizedItem.src);
        allDiscoveredVideos.push(normalizedItem);

        if (isBlockedContent(normalizedItem.author, normalizedItem.title)) {
            return;
        }

        feedVideos.push(normalizedItem);
        const newIdx = feedVideos.length - 1;

        if (feedMode === 'explore') {
            appendSlideToFeed(normalizedItem, newIdx);
            if (feedOpen && pendingSkipAlbumUrl && normalizedItem.albumUrl !== pendingSkipAlbumUrl) {
                pendingSkipAlbumUrl = null;
                scrollToSlide(newIdx, 'auto');
                activateSlide(newIdx);
                showToast('⏭️ 已自動切到下一篇新影片');
            } else if (feedOpen) {
                updateAlbumPositionBadge(activeSlideIndex);
            }
        }
        updateStats();
        updateModeTabLabels();
    }

    function syncBlocklistEffects() {
        document.querySelectorAll('[data-ef-processed]').forEach((el) => {
            const blocked = !!isBlockedContent(el.dataset.efAuthor, el.dataset.efTitle);
            el.dataset.efBlocked = blocked ? '1' : '';
            applyElementVisibility(el);
        });

        feedVideos.length = 0;
        for (const item of allDiscoveredVideos) {
            if (!isBlockedContent(item.author, item.title)) {
                feedVideos.push(item);
            }
        }

        if (feedMode === 'author' && currentBingeAuthor && blockedAuthorLowerSet.has(currentBingeAuthor.toLowerCase())) {
            switchFeedMode('explore');
        } else if (feedMode === 'explore') {
            const targetIdx = feedVideos.length > 0 ? Math.min(activeSlideIndex, feedVideos.length - 1) : 0;
            rebuildFeedSlides(targetIdx);
        } else {
            updateModeTabLabels();
        }
        updateStats();
        updatePageDividers();
    }

    function blockAuthor(authorName) {
        const clean = String(authorName || '').replace(/^@+/, '').trim();
        if (!clean) {
            showToast('此影片沒有標記作者名稱');
            return false;
        }
        if (blockedAuthorLowerSet.has(clean.toLowerCase())) {
            showToast(`@${clean} 已在封鎖名單中`);
            return false;
        }
        blockedAuthors.unshift(clean);
        saveBlocklists();
        syncBlocklistEffects();
        if (document.getElementById('ef-blacklist-modal')?.classList.contains('open')) {
            renderBlacklistModal();
        }
        showToast(`🚫 已封鎖作者 @${clean}`);
        return true;
    }

    function addBlockedKeywords(rawText) {
        const parts = String(rawText || '')
            .split(/[,，\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        let added = 0;
        for (const kw of parts) {
            if (!blockedKeywordLowerList.includes(kw.toLowerCase())) {
                blockedKeywords.unshift(kw);
                blockedKeywordLowerList.unshift(kw.toLowerCase());
                added++;
            }
        }
        if (added > 0) {
            saveBlocklists();
            syncBlocklistEffects();
            renderBlacklistModal();
            showToast(`已新增 ${added} 筆標題封鎖關鍵字`);
        } else {
            showToast('沒有新的關鍵字可新增');
        }
    }

    function toggleFavorite(item, forceAdd = false) {
        if (!item || !item.src) return false;
        const exists = favSrcSet.has(item.src);

        if (exists && !forceAdd) {
            favorites = favorites.filter((f) => f.src !== item.src);
            favSrcSet.delete(item.src);
            saveFavorites();
            showToast('已從收藏清單移除');
        } else if (!exists) {
            const cleanAuthor = String(item.author || '').replace(/^@+/, '').trim();
            favorites.unshift({
                src: item.src,
                poster: item.poster || '',
                title: item.title || 'Erome 影片',
                author: cleanAuthor,
                authorUrl: item.authorUrl || buildAuthorProfileUrl(cleanAuthor),
                albumUrl: item.albumUrl || window.location.href,
                savedAt: Date.now(),
            });
            favSrcSet.add(item.src);
            saveFavorites();
            showToast('❤️ 已加入收藏清單');
        }

        syncFavButtons();
        updateStats();
        updateModeTabLabels();
        if (document.getElementById('ef-fav-modal')?.classList.contains('open')) {
            renderFavManagerList();
        }
        return favSrcSet.has(item.src);
    }

    // ==================== 8. 相簿內頁 (/a/...) 過濾 ====================
    const IS_ALBUM_PAGE = /^\/a\//.test(window.location.pathname);

    function processAlbumPage() {
        const pageTitle = document.querySelector('h1')?.textContent?.trim() || document.title || 'Erome 相簿';
        const { author: pageAuthor, authorUrl: pageAuthorUrl } = extractAuthorFromDoc(document, window.location.href);

        const groups = document.querySelectorAll('.media-group');
        groups.forEach((group) => {
            if (group.dataset.efProcessed || group.dataset.efAdBlocked === '1') return;
            group.dataset.efProcessed = '1';
            group.dataset.efTitle = pageTitle;
            group.dataset.efAuthor = pageAuthor;

            const videoEl = group.querySelector('video');
            if (!videoEl) {
                group.dataset.efType = 'photo';
                applyElementVisibility(group);
                updateStats();
                return;
            }

            group.dataset.efType = 'pending';
            applyElementVisibility(group);

            const classifyBySize = (w, h) => {
                if (!w || !h) return false;
                const vertical = isPortrait(w, h);
                group.dataset.efType = vertical ? 'vertical' : 'horizontal';
                if (vertical) {
                    const src = extractVideoSrc(videoEl);
                    const poster = extractPosterUrl(videoEl, group);
                    if (src) {
                        addFeedVideo({
                            src,
                            poster: poster || '',
                            title: pageTitle,
                            author: pageAuthor,
                            authorUrl: pageAuthorUrl,
                            albumUrl: window.location.href,
                        });
                    }
                }
                applyElementVisibility(group);
                updateStats();
                return true;
            };

            videoEl.addEventListener('loadedmetadata', () => {
                classifyBySize(videoEl.videoWidth, videoEl.videoHeight);
            });

            if (classifyBySize(videoEl.videoWidth, videoEl.videoHeight)) return;

            setTimeout(() => {
                if (group.dataset.efType === 'pending') {
                    group.dataset.efType = 'unknown';
                    applyElementVisibility(group);
                    updateStats();
                }
            }, 6000);

            const posterUrl = extractPosterUrl(videoEl, group);
            if (posterUrl) {
                getImageDimensions(posterUrl).then((dim) => {
                    if (group.dataset.efType !== 'pending') return;
                    if (dim) {
                        classifyBySize(dim.width, dim.height);
                    } else {
                        videoEl.preload = 'metadata';
                    }
                });
            } else {
                videoEl.preload = 'metadata';
            }
        });
    }

    // ==================== 9. 列表頁過濾 + 指定相簿開刷 + 深度掃描 ====================
    const scanQueue = [];
    const inFlightScans = new Map();
    let activeScans = 0;
    let rateLimitedUntil = 0;
    const seenAlbumIds = new Set();

    function setCardBadge(card, text, isScanning = false) {
        const container = card.querySelector('.album-thumbnail-container') || card;
        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        let badge = container.querySelector('.ef-badge');
        if (!text) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'ef-badge';
            container.appendChild(badge);
        }
        badge.textContent = text;
        badge.classList.toggle('ef-scanning', isScanning);
    }

    function ensureCardPlayButton(card, meta) {
        const container = card.querySelector('.album-thumbnail-container') || card;
        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        let btn = container.querySelector('.ef-card-play-btn');
        if (card.dataset.efType !== 'vertical') {
            if (btn) btn.remove();
            return;
        }
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ef-card-play-btn';
            btn.title = '直接從這篇相簿開始抖音模式上下滑動';
            btn.textContent = '▶ 開刷';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                openFeedFromAlbumCard(btn, meta);
            });
            container.appendChild(btn);
        }
        attachCardPreview(card, meta);
    }

    async function openFeedFromAlbumCard(btn, meta) {
        const { card, albumUrl, cacheId, fallbackTitle, fallbackAuthor, fallbackAuthorUrl } = meta;

        let targetIdx = feedVideos.findIndex((v) => v.albumUrl === albumUrl);
        if (targetIdx !== -1) {
            openFeedMode('explore', targetIdx);
            return;
        }

        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 載入中';
        showToast('⏳ 正在載入該相簿的豎屏影片...');

        try {
            const qIdx = scanQueue.findIndex((j) => j.albumUrl === albumUrl);
            if (qIdx !== -1) scanQueue.splice(qIdx, 1);

            if (inFlightScans.has(albumUrl)) {
                await inFlightScans.get(albumUrl);
            } else {
                await inspectAlbumVerticalVideos({
                    card,
                    albumUrl,
                    cacheId,
                    fallbackTitle,
                    fallbackAuthor,
                    fallbackAuthorUrl,
                    priority: true,
                });
            }

            targetIdx = feedVideos.findIndex((v) => v.albumUrl === albumUrl);
            if (targetIdx !== -1) {
                openFeedMode('explore', targetIdx);
            } else if (isBlockedContent(card.dataset.efAuthor, card.dataset.efTitle)) {
                showToast('此相簿符合黑名單規則，已略過');
            } else {
                showToast('此相簿沒有可播放的豎屏影片');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }

    function processListingPage() {
        const albumsBox = getAlbumsContainer();
        if (albumsBox) albumsBox.classList.add('ef-grid-container');

        const cards = document.querySelectorAll('.album, div[id^="album-"]');
        cards.forEach((card) => {
            if (card.dataset.efProcessed || card.dataset.efAdBlocked === '1') return;

            if (!isValidAlbumCard(card)) {
                markAsBlockedAd(card);
                return;
            }

            const linkEl = card.querySelector('a.album-link, a[href*="/a/"]');
            const rawHref = linkEl ? linkEl.getAttribute('href') : null;
            const albumUrl = resolveUrl(rawHref, window.location.href);
            const fallbackTitle = card.querySelector('.album-title')?.textContent?.trim() || 'Erome 相簿';

            const authorEl = card.querySelector('.album-user');
            const authorLinkEl = authorEl?.tagName === 'A' ? authorEl : authorEl?.querySelector('a[href]');
            const fallbackAuthor = (authorEl?.textContent || '').replace(/^@+/, '').trim();
            const fallbackAuthorUrl = authorLinkEl?.getAttribute('href')
                ? resolveUrl(authorLinkEl.getAttribute('href'), window.location.href)
                : buildAuthorProfileUrl(fallbackAuthor);

            card.dataset.efProcessed = '1';
            if (!card.dataset.efPage) card.dataset.efPage = '1';
            card.dataset.efAlbumUrl = albumUrl;
            card.dataset.efTitle = fallbackTitle;
            card.dataset.efAuthor = fallbackAuthor;

            const thumbElForShape = card.querySelector('img.album-thumbnail, img');
            if (thumbElForShape) {
                thumbElForShape.classList.add('ef-cover-img');
                const coverBox = card.querySelector('.album-thumbnail-container')
                    || thumbElForShape.closest('a.album-link')
                    || thumbElForShape.parentElement;
                if (coverBox && coverBox !== card) {
                    coverBox.classList.add('ef-cover-box');
                }
            }

            card.classList.add('ef-album-card');

            // 1) 隱藏封面上的左下角觀看次數與右下角圖片／影片數量
            const coverArea = card.querySelector('.ef-cover-box') || card.querySelector('.album-thumbnail-container');
            if (coverArea) {
                coverArea.querySelectorAll('div, span, p, small').forEach((el) => {
                    if (isOurUiElement(el)) return;
                    if (el.classList.contains('ef-badge') || el.classList.contains('ef-preview-wrap') || el.classList.contains('ef-preview-status')) return;
                    if (el.querySelector('img.album-thumbnail, .ef-cover-img, video, .ef-badge, .ef-card-play-btn, .ef-preview-wrap')) return;
                    el.classList.add('ef-clean-hide');
                });
            }

            // 2) 精準鎖定標題連結本體，並往上把同層所有非封面兄弟節點（圓形頭像、作者名等）一律隱藏
            const rawTitleEl = card.querySelector('.album-title');
            const titleEl = rawTitleEl
                ? (rawTitleEl.tagName === 'A' ? rawTitleEl : (rawTitleEl.querySelector('a[href*="/a/"]') || rawTitleEl))
                : Array.from(card.querySelectorAll('a[href*="/a/"]')).find(
                    (a) => !a.querySelector('img') && (a.textContent || '').trim().length > 0
                );

            if (titleEl) {
                titleEl.classList.add('ef-clean-title');

                // 若標題內夾帶頭像圖示先隱藏，再把純文字包進跑馬燈節點
                if (!titleEl.querySelector('.ef-marquee-inner')) {
                    titleEl.querySelectorAll('img, svg, [class*="avatar"]').forEach((el) => el.classList.add('ef-clean-hide'));
                    const cleanText = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
                    if (cleanText) {
                        const innerSpan = document.createElement('span');
                        innerSpan.className = 'ef-marquee-inner';
                        innerSpan.textContent = cleanText;
                        titleEl.textContent = '';
                        titleEl.appendChild(innerSpan);
                    }
                }

                // 由標題逐層往上走到 card，只保留「封面分支」與「標題分支」，其餘頭像與作者一律隱藏
                let curNode = titleEl;
                while (curNode && curNode !== card) {
                    const parentNode = curNode.parentElement;
                    if (!parentNode) break;
                    Array.from(parentNode.children).forEach((sib) => {
                        if (sib === curNode || isOurUiElement(sib)) return;
                        if (coverArea && (sib === coverArea || sib.contains(coverArea) || coverArea.contains(sib))) return;
                        sib.classList.add('ef-clean-hide');
                    });
                    if (parentNode !== card) {
                        parentNode.classList.add('ef-clean-title-wrap');
                    }
                    curNode = parentNode;
                }
            }

            const cacheId = new URL(albumUrl).pathname;
            if (cacheId) seenAlbumIds.add(cacheId);

            if (isBlockedContent(fallbackAuthor, fallbackTitle)) {
                card.dataset.efBlocked = '1';
                card.dataset.efType = 'blocked';
                applyElementVisibility(card);
                updateStats();
                updatePageDividers();
                return;
            }

            const meta = { card, albumUrl, cacheId, fallbackTitle, fallbackAuthor, fallbackAuthorUrl };

            const hasVideoBadge = !!card.querySelector('.album-videos');
            if (!hasVideoBadge) {
                card.dataset.efType = 'photo';
                applyElementVisibility(card);
                updateStats();
                updatePageDividers();
                return;
            }

            if (cacheId && albumCache[cacheId]) {
                const cached = albumCache[cacheId];
                card.dataset.efType = cached.vertical ? 'vertical' : 'horizontal';
                if (cached.vertical && Array.isArray(cached.videos)) {
                    setCardBadge(card, `📱 豎屏 ×${cached.videos.length}`);
                    ensureCardPlayButton(card, meta);
                    cached.videos.forEach((v) => addFeedVideo(v));
                }
                applyElementVisibility(card);
                updateStats();
                updatePageDividers();
                return;
            }

            const thumbImg = card.querySelector('img.album-thumbnail, img');
            const rawThumb = thumbImg
                ? (thumbImg.dataset.src || thumbImg.getAttribute('data-src') || thumbImg.currentSrc || thumbImg.getAttribute('src'))
                : null;
            const thumbUrl = rawThumb ? resolveUrl(rawThumb, window.location.href) : null;

            card.dataset.efType = 'pending';
            applyElementVisibility(card);
            updatePageDividers();

            getImageDimensions(thumbUrl).then((dim) => {
                if (card.dataset.efBlocked === '1') return;

                const thumbIsPortrait = !!(dim && isPortrait(dim.width, dim.height));
                if (thumbIsPortrait) {
                    card.dataset.efType = 'vertical';
                    setCardBadge(card, '📱 豎屏');
                    ensureCardPlayButton(card, meta);
                    applyElementVisibility(card);
                    updateStats();
                    updatePageDividers();
                }

                if (config.deepScan && albumUrl && cacheId) {
                    enqueueAlbumScan({ ...meta, priority: thumbIsPortrait });
                } else if (!thumbIsPortrait) {
                    card.dataset.efType = dim ? 'horizontal' : 'unknown';
                    applyElementVisibility(card);
                    updateStats();
                    updatePageDividers();
                }
            });
        });
    }

    function enqueueAlbumScan(job) {
        if (!config.onlyVertical && !job.priority) {
            setCardBadge(job.card, '🔍 掃描中', true);
        }
        if (job.priority) {
            scanQueue.unshift(job);
        } else {
            scanQueue.push(job);
        }
        updateStats();
        updatePageDividers();
        runScanQueue();
    }

    async function runScanQueue() {
        if (!config.deepScan) return;
        while (activeScans < SCAN_CONCURRENCY && scanQueue.length > 0) {
            const now = Date.now();
            if (now < rateLimitedUntil) {
                setTimeout(runScanQueue, rateLimitedUntil - now + 100);
                return;
            }
            const job = scanQueue.shift();
            if (job.card.dataset.efBlocked === '1') continue;
            activeScans++;
            inspectAlbumVerticalVideos(job)
                .finally(() => {
                    activeScans--;
                    updateStats();
                    updatePageDividers();
                    updateFeedTailText();
                    setTimeout(runScanQueue, SCAN_DELAY_MS);
                });
        }
    }

    async function fetchAndParseAlbumVerticals(albumUrl, cacheId, fallbackTitle = 'Erome 相簿', fallbackAuthor = '', fallbackAuthorUrl = '') {
        const res = await fetch(albumUrl, { credentials: 'same-origin' });
        if (res.status === 429) {
            return { rateLimited: true };
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const albumTitle = doc.querySelector('h1')?.textContent?.trim() || fallbackTitle;
        const { author: albumAuthor, authorUrl: albumAuthorUrl } = extractAuthorFromDoc(
            doc,
            albumUrl,
            fallbackAuthor,
            fallbackAuthorUrl
        );

        const videoNodes = Array.from(doc.querySelectorAll('video')).slice(0, MAX_VIDEOS_PER_ALBUM);
        const candidates = videoNodes
            .map((v) => ({
                src: extractVideoSrc(v, albumUrl),
                poster: extractPosterUrl(v, v.parentElement, albumUrl) || '',
            }))
            .filter((item) => item.poster);

        const dims = await Promise.all(candidates.map((c) => getImageDimensions(c.poster, 6000)));
        let checkedCount = 0;
        const verticalVideos = [];

        candidates.forEach((c, idx) => {
            const dim = dims[idx];
            if (!dim) return;
            checkedCount++;
            if (isPortrait(dim.width, dim.height)) {
                verticalVideos.push({
                    src: c.src,
                    poster: c.poster,
                    title: albumTitle,
                    author: albumAuthor,
                    authorUrl: albumAuthorUrl,
                    albumUrl,
                });
            }
        });

        const playable = verticalVideos.filter((v) => v.src);
        if (verticalVideos.length > 0 && cacheId) {
            saveCache(cacheId, { vertical: true, videos: playable });
        } else if (checkedCount > 0 && cacheId) {
            saveCache(cacheId, { vertical: false, videos: [] });
        }

        return {
            rateLimited: false,
            albumTitle,
            albumAuthor,
            albumAuthorUrl,
            videoNodesCount: videoNodes.length,
            hasMediaGroup: !!doc.querySelector('.media-group'),
            checkedCount,
            verticalVideos,
            playable,
        };
    }

    function inspectAlbumVerticalVideos(job) {
        const { card, albumUrl, cacheId, fallbackTitle, fallbackAuthor, fallbackAuthorUrl, priority } = job;
        if (inFlightScans.has(albumUrl)) {
            return inFlightScans.get(albumUrl);
        }

        const task = (async () => {
            try {
                const parsed = await fetchAndParseAlbumVerticals(
                    albumUrl,
                    cacheId,
                    fallbackTitle,
                    fallbackAuthor,
                    fallbackAuthorUrl
                );

                if (parsed.rateLimited) {
                    rateLimitedUntil = Date.now() + 10000;
                    scanQueue.unshift(job);
                    setCardBadge(card, '⏳ 限速等待', true);
                    updateStats('限速暫停 10 秒');
                    return;
                }

                card.dataset.efTitle = parsed.albumTitle;
                card.dataset.efAuthor = parsed.albumAuthor;

                if (isBlockedContent(parsed.albumAuthor, parsed.albumTitle)) {
                    card.dataset.efBlocked = '1';
                    card.dataset.efType = 'blocked';
                    applyElementVisibility(card);
                    return;
                }

                const nextMeta = {
                    card,
                    albumUrl,
                    cacheId,
                    fallbackTitle: parsed.albumTitle,
                    fallbackAuthor: parsed.albumAuthor,
                    fallbackAuthorUrl: parsed.albumAuthorUrl,
                };

                if (parsed.verticalVideos.length > 0) {
                    card.dataset.efType = 'vertical';
                    setCardBadge(card, `📱 豎屏 ×${parsed.verticalVideos.length}`);
                    ensureCardPlayButton(card, nextMeta);
                    parsed.playable.forEach((v) => addFeedVideo(v));
                    applyElementVisibility(card);
                    return;
                }

                if (parsed.checkedCount > 0) {
                    if (priority) {
                        card.dataset.efType = 'vertical';
                        setCardBadge(card, '📱 豎屏');
                    } else {
                        card.dataset.efType = 'horizontal';
                        setCardBadge(card, '');
                    }
                    ensureCardPlayButton(card, nextMeta);
                    applyElementVisibility(card);
                    return;
                }

                if (parsed.videoNodesCount === 0 && parsed.hasMediaGroup) {
                    card.dataset.efType = 'photo';
                    setCardBadge(card, '');
                } else {
                    card.dataset.efType = priority ? 'vertical' : 'unknown';
                    setCardBadge(card, priority ? '📱 豎屏' : '');
                }
                ensureCardPlayButton(card, nextMeta);
                applyElementVisibility(card);
            } catch (_) {
                card.dataset.efType = priority ? 'vertical' : 'unknown';
                setCardBadge(card, priority ? '📱 豎屏' : '');
                ensureCardPlayButton(card, { card, albumUrl, cacheId, fallbackTitle, fallbackAuthor, fallbackAuthorUrl });
                applyElementVisibility(card);
            }
        })();

        inFlightScans.set(albumUrl, task);
        task.finally(() => inFlightScans.delete(albumUrl));
        return task;
    }

    // ==================== 10. 網站最底部無限滾動 ====================
    const INITIAL_NORMALIZED_URL = normalizePageUrl(window.location.href) || window.location.href;
    let nextPageUrl = null;
    let lastFetchedPageUrl = INITIAL_NORMALIZED_URL;
    let currentPageCount = 1;
    let isLoadingNextPage = false;
    let reachedTrueEnd = false;
    let nextPageCooldownUntil = 0;
    let autoEmptyPageStreak = 0;
    const loadedPageUrls = new Set([INITIAL_NORMALIZED_URL]);

    function getCurrentPageNumber(urlStr) {
        try {
            const u = new URL(urlStr);
            const qPage = parseInt(u.searchParams.get('page') || '', 10);
            if (Number.isFinite(qPage) && qPage >= 1) return qPage;
            const pathMatch = u.pathname.match(/\/page\/(\d+)(?:\/|$)/i);
            if (pathMatch) return parseInt(pathMatch[1], 10);
        } catch (_) {}
        return 1;
    }

    function isValidNextPageUrl(rawHref, baseUrl, visitedSet = loadedPageUrls) {
        const norm = normalizePageUrl(rawHref, baseUrl);
        if (!norm) return null;
        const baseNorm = normalizePageUrl(baseUrl);
        if (norm === baseNorm || visitedSet.has(norm)) return null;
        try {
            const u = new URL(norm);
            if (u.origin !== window.location.origin) return null;
            if (/^\/(a|login|register|logout|user\/disclaimer)\b/i.test(u.pathname)) return null;
        } catch (_) {
            return null;
        }
        return norm;
    }

    function findNextPageUrl(doc, baseUrl = window.location.href, visitedSet = loadedPageUrls) {
        const curUrl = new URL(baseUrl);
        const curPage = getCurrentPageNumber(baseUrl);
        const targetPage = String(curPage + 1);
        const curQuery = curUrl.searchParams.get('q');

        const isDisabled = (el) =>
            !el ||
            el.classList.contains('disabled') ||
            el.getAttribute('aria-disabled') === 'true' ||
            !!el.closest('.disabled, [aria-disabled="true"]');

        const relNextList = doc.querySelectorAll('link[rel="next"][href], a[rel="next"][href]');
        for (const el of relNextList) {
            if (el.tagName === 'A' && isDisabled(el)) continue;
            const valid = isValidNextPageUrl(el.getAttribute('href'), baseUrl, visitedSet);
            if (valid) return { url: valid, fallback: false };
        }

        const pageLinks = doc.querySelectorAll('.pagination a[href], [class*="paginat"] a[href], a[href*="page="]');
        for (const a of pageLinks) {
            if (isDisabled(a)) continue;
            const valid = isValidNextPageUrl(a.getAttribute('href'), baseUrl, visitedSet);
            if (!valid) continue;
            try {
                const u = new URL(valid);
                if (u.searchParams.get('page') !== targetPage) continue;
                if (curQuery !== null && u.searchParams.get('q') !== curQuery) continue;
                if (curUrl.pathname !== '/' && u.pathname !== curUrl.pathname) continue;
                return { url: valid, fallback: false };
            } catch (_) {}
        }

        const activeNext = doc.querySelector(
            '.pagination li.active + li:not(.disabled) a[href], .pagination .page-item.active + .page-item:not(.disabled) a[href], .pagination .active + a[href]'
        );
        if (activeNext && !isDisabled(activeNext)) {
            const valid = isValidNextPageUrl(activeNext.getAttribute('href'), baseUrl, visitedSet);
            if (valid) return { url: valid, fallback: false };
        }

        const pagLinks = doc.querySelectorAll('.pagination a[href], [class*="paginat"] a[href], [aria-label*="paginat" i] a[href]');
        for (const a of pagLinks) {
            if (isDisabled(a)) continue;
            const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (t === targetPage || /^(›|»|→|next|下一頁|>)$/i.test(t)) {
                const valid = isValidNextPageUrl(a.getAttribute('href'), baseUrl, visitedSet);
                if (valid) return { url: valid, fallback: false };
            }
        }

        const hasAlbums = !!doc.querySelector('.album, div[id^="album-"]');
        if (hasAlbums) {
            try {
                const fallbackUrl = new URL(baseUrl);
                fallbackUrl.hash = '';
                fallbackUrl.searchParams.set('page', targetPage);
                const valid = isValidNextPageUrl(fallbackUrl.href, baseUrl, visitedSet);
                if (valid) return { url: valid, fallback: true };
            } catch (_) {}
        }

        return null;
    }

    function setNextPageFromDoc(doc, baseUrl) {
        const info = findNextPageUrl(doc, baseUrl, loadedPageUrls);
        nextPageUrl = info ? info.url : null;
        if (!nextPageUrl) reachedTrueEnd = true;
    }

    function getAlbumsContainer() {
        const explicit = document.querySelector('#albums');
        if (explicit) return explicit;
        const firstCard = document.querySelector('.album, div[id^="album-"]');
        return firstCard ? firstCard.parentElement : null;
    }

    function isNearWebsiteBottom() {
        const scrollTop = window.scrollY || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const docHeight = Math.max(
            document.documentElement.scrollHeight || 0,
            document.body ? document.body.scrollHeight : 0
        );
        return scrollTop + viewportHeight >= docHeight - WEBSITE_BOTTOM_THRESHOLD_PX;
    }

    function getPageScanSummary(pageNum) {
        const cards = document.querySelectorAll(`[data-ef-page="${pageNum}"]`);
        let visible = 0;
        let pending = 0;
        cards.forEach((c) => {
            if (c.dataset.efType === 'pending') pending++;
            if (!c.classList.contains('ef-hidden') && !c.classList.contains('ef-ad-hidden')) visible++;
        });
        return { total: cards.length, visible, pending };
    }

    function updatePageDividers() {
        if (IS_ALBUM_PAGE) return;
        document.querySelectorAll('.ef-page-divider[data-page]').forEach((div) => {
            const pageNum = Number(div.dataset.page);
            const { total, visible, pending } = getPageScanSummary(pageNum);
            if (!config.onlyVertical) {
                div.textContent = `── 第 ${pageNum} 頁（顯示 ${visible} / 共 ${total} 篇）──`;
            } else if (pending > 0) {
                div.textContent = `── 第 ${pageNum} 頁 · 篩選豎屏中（已顯示 ${visible} 篇｜剩餘 ${pending} 篇）──`;
            } else if (visible > 0) {
                div.textContent = `── 第 ${pageNum} 頁（共 ${visible} 篇豎屏影片）──`;
            } else {
                div.textContent = `── 第 ${pageNum} 頁（本頁沒有符合條件的豎屏影片）──`;
            }
        });

        if (!feedOpen && config.onlyVertical && config.autoNextPage && currentPageCount > 1 && nextPageUrl && !isLoadingNextPage) {
            const latest = getPageScanSummary(currentPageCount);
            if (latest.total > 0 && latest.pending === 0) {
                if (latest.visible > 0) {
                    autoEmptyPageStreak = 0;
                } else if (autoEmptyPageStreak < MAX_AUTO_EMPTY_PAGES && isNearWebsiteBottom() && Date.now() >= nextPageCooldownUntil) {
                    autoEmptyPageStreak++;
                    loadNextPage(false);
                }
            }
        }
    }

    function checkWebsiteBottomAndLoad(isUserGesture = false) {
        if (IS_ALBUM_PAGE || feedOpen || pickerActive || !config.autoNextPage || !nextPageUrl || isLoadingNextPage) return;
        if (isUserGesture) autoEmptyPageStreak = 0;
        if (Date.now() < nextPageCooldownUntil) return;

        const latest = getPageScanSummary(currentPageCount);
        if (currentPageCount > 1 && latest.pending > 0 && latest.visible === 0) return;

        if (isNearWebsiteBottom()) {
            loadNextPage(false);
        }
    }

    function setupInfiniteScroll() {
        if (IS_ALBUM_PAGE) return;
        setNextPageFromDoc(document, lastFetchedPageUrl);

        const container = getAlbumsContainer();
        if (!container || !document.body) return;

        let sentinel = document.getElementById('ef-infinite-sentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = 'ef-infinite-sentinel';
            sentinel.innerHTML = `
                <span id="ef-infinite-status"></span>
                <button id="ef-load-more-btn" type="button">載入第 2 頁</button>
            `;
            document.body.appendChild(sentinel);
            sentinel.querySelector('#ef-load-more-btn').addEventListener('click', () => {
                autoEmptyPageStreak = 0;
                loadNextPage(true);
            });
        }
        updateInfiniteUI();

        let scrollRaf = false;
        window.addEventListener(
            'scroll',
            () => {
                if (scrollRaf) return;
                scrollRaf = true;
                requestAnimationFrame(() => {
                    scrollRaf = false;
                    checkWebsiteBottomAndLoad(false);
                });
            },
            { passive: true }
        );

        window.addEventListener(
            'wheel',
            (e) => {
                if (e.deltaY > 0) checkWebsiteBottomAndLoad(true);
            },
            { passive: true }
        );

        let touchStartY = 0;
        window.addEventListener(
            'touchstart',
            (e) => {
                if (e.touches && e.touches.length === 1) {
                    touchStartY = e.touches[0].clientY;
                }
            },
            { passive: true }
        );
        window.addEventListener(
            'touchend',
            (e) => {
                if (e.changedTouches && e.changedTouches.length === 1) {
                    const dy = touchStartY - e.changedTouches[0].clientY;
                    if (dy > 25) checkWebsiteBottomAndLoad(true);
                }
            },
            { passive: true }
        );
    }

    function updateInfiniteUI(customMsg = '', allowRetry = false) {
        const statusEl = document.getElementById('ef-infinite-status');
        const btn = document.getElementById('ef-load-more-btn');
        if (!statusEl || !btn) return;

        if (customMsg) {
            statusEl.textContent = customMsg;
            btn.disabled = !allowRetry;
            btn.style.display = allowRetry ? 'inline-block' : 'none';
            if (allowRetry) btn.textContent = '重試載入下一頁';
            return;
        }
        if (isLoadingNextPage) {
            statusEl.textContent = `⏳ 正在載入第 ${currentPageCount + 1} 頁...`;
            btn.disabled = true;
            btn.style.display = 'inline-block';
            btn.textContent = '載入中...';
        } else if (nextPageUrl) {
            statusEl.textContent = `已載入 ${currentPageCount} 頁（滑至網站最底部自動接續下一頁）`;
            btn.disabled = false;
            btn.style.display = 'inline-block';
            btn.textContent = `載入第 ${currentPageCount + 1} 頁`;
        } else {
            statusEl.textContent = `已到達最後一頁（共 ${currentPageCount} 頁）`;
            btn.style.display = 'none';
        }
    }

    async function loadNextPage(manual = false) {
        if (IS_ALBUM_PAGE || isLoadingNextPage) return;
        if (!manual && Date.now() < nextPageCooldownUntil) return;

        if (!nextPageUrl && !reachedTrueEnd) {
            setNextPageFromDoc(document, lastFetchedPageUrl);
        }
        if (!nextPageUrl) {
            updateInfiniteUI();
            return;
        }

        let targetUrl = normalizePageUrl(nextPageUrl, lastFetchedPageUrl);
        if (!targetUrl || loadedPageUrls.has(targetUrl)) {
            const retryNext = findNextPageUrl(document, lastFetchedPageUrl, loadedPageUrls);
            if (retryNext && !loadedPageUrls.has(retryNext.url)) {
                targetUrl = retryNext.url;
                nextPageUrl = retryNext.url;
            } else {
                reachedTrueEnd = true;
                nextPageUrl = null;
                updateInfiniteUI();
                return;
            }
        }

        isLoadingNextPage = true;
        let keepCustomStatus = false;
        updateInfiniteUI();
        updateFeedTailText();

        try {
            let res = await fetch(targetUrl, { credentials: 'same-origin' });
            if (res.status === 429) {
                nextPageCooldownUntil = Date.now() + 10000;
                keepCustomStatus = true;
                updateInfiniteUI('⚠️ 請求過快，請稍候 10 秒再滑到底部或點擊重試', true);
                return;
            }
            if (res.status === 404) {
                reachedTrueEnd = true;
                nextPageUrl = null;
                return;
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);

            let finalUrl = normalizePageUrl(res.url || targetUrl, targetUrl) || targetUrl;
            let html = await res.text();
            let doc = new DOMParser().parseFromString(html, 'text/html');
            let uniqueCards = extractUniqueCards(doc, finalUrl);

            if (uniqueCards.length === 0 && currentPageCount === 1 && new URL(targetUrl).pathname === '/') {
                const explorePage2 = normalizePageUrl('/explore?page=2', window.location.origin);
                if (explorePage2 && !loadedPageUrls.has(explorePage2)) {
                    loadedPageUrls.add(targetUrl);
                    const altRes = await fetch(explorePage2, { credentials: 'same-origin' });
                    if (altRes.ok) {
                        targetUrl = explorePage2;
                        finalUrl = normalizePageUrl(altRes.url || explorePage2, explorePage2) || explorePage2;
                        html = await altRes.text();
                        doc = new DOMParser().parseFromString(html, 'text/html');
                        uniqueCards = extractUniqueCards(doc, finalUrl);
                    }
                }
            }

            loadedPageUrls.add(targetUrl);
            if (finalUrl) loadedPageUrls.add(finalUrl);

            if (uniqueCards.length === 0) {
                reachedTrueEnd = true;
                nextPageUrl = null;
                if (!feedOpen) showToast(`已到達最後一頁（共 ${currentPageCount} 頁）`);
                return;
            }

            lastFetchedPageUrl = finalUrl;
            saveResumeBookmark(finalUrl);
            currentPageCount++;
            const thisPageNum = currentPageCount;
            nextPageCooldownUntil = Date.now() + 1200;

            const container = getAlbumsContainer();
            const prevScrollY = window.scrollY;

            cleanAds();

            if (container) {
                const frag = document.createDocumentFragment();
                const divider = document.createElement('div');
                divider.className = 'ef-page-divider';
                divider.dataset.page = String(thisPageNum);
                divider.textContent = `── 第 ${thisPageNum} 頁 · 載入中 ──`;
                frag.appendChild(divider);

                uniqueCards.forEach((rawCard) => {
                    const imported = document.importNode(rawCard, true);
                    imported.dataset.efPage = String(thisPageNum);

                    imported.querySelectorAll('img').forEach((img) => {
                        const ds = img.getAttribute('data-src');
                        if (ds && (!img.getAttribute('src') || img.getAttribute('src').includes('data:image'))) {
                            img.setAttribute('src', resolveUrl(ds, finalUrl));
                        }
                        img.classList.remove('lazyload', 'lazy');
                        img.classList.add('lazyloaded', 'ef-loaded-img');
                    });

                    if (config.onlyVertical) {
                        imported.classList.add('ef-hidden');
                    }

                    frag.appendChild(imported);
                });

                container.appendChild(frag);
                if (!feedOpen) {
                    requestAnimationFrame(() => {
                        if (Math.abs(window.scrollY - prevScrollY) > 80) {
                            window.scrollTo(0, prevScrollY);
                        }
                    });
                }
            }

            setNextPageFromDoc(doc, lastFetchedPageUrl);

            document.querySelectorAll('.pagination').forEach((p) => {
                p.style.display = 'none';
            });

            cleanAds();
            processListingPage();
            updatePageDividers();
            if (!feedOpen) showToast(`已載入第 ${thisPageNum} 頁，正在篩選豎屏影片`);
        } catch (_) {
            keepCustomStatus = true;
            updateInfiniteUI('載入下一頁失敗，請點擊重試', true);
        } finally {
            isLoadingNextPage = false;
            if (!keepCustomStatus) {
                updateInfiniteUI();
            }
            updateStats();
            updatePageDividers();
            updateFeedTailText();
        }
    }

    function extractUniqueCards(doc, baseUrl, excludeSet = seenAlbumIds) {
        const rawCards = Array.from(doc.querySelectorAll('.album, div[id^="album-"]'));
        const localSeen = new Set();
        const result = [];
        for (const card of rawCards) {
            const linkEl = card.querySelector('a.album-link, a[href*="/a/"]');
            const rawHref = linkEl ? linkEl.getAttribute('href') : null;
            if (!rawHref) continue;
            const resolvedHref = resolveUrl(rawHref, baseUrl);
            if (!isSameOriginUrl(resolvedHref)) continue;

            let albumId = null;
            try {
                const u = new URL(resolvedHref);
                if (!/\/a\//.test(u.pathname)) continue;
                albumId = u.pathname;
            } catch (_) {
                continue;
            }
            if (excludeSet.has(albumId) || localSeen.has(albumId)) continue;
            localSeen.add(albumId);
            result.push(card);
        }
        return result;
    }

    // ==================== 10.5 斷點續刷（記住上次頁碼） ====================
    const RESUME_STORAGE_KEY = 'ef_page_bookmarks_v1';

    function getResumeRouteKey(urlStr = window.location.href) {
        try {
            const u = new URL(urlStr, window.location.origin);
            // 首頁 / 與 /explore 共用斷點，回首頁就能直接接續上次頁數
            const path = u.pathname === '/' ? '/explore' : (u.pathname.replace(/\/+$/, '') || '/');
            const params = new URLSearchParams(u.search);
            params.delete('page');
            const qs = params.toString();
            return qs ? `${path}?${qs}` : path;
        } catch (_) {
            return window.location.pathname || '/';
        }
    }

    function loadResumeBookmarks() {
        try {
            const raw = GM_getValue(RESUME_STORAGE_KEY, {});
            return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        } catch (_) {
            return {};
        }
    }

    function saveResumeBookmark(urlStr) {
        if (IS_ALBUM_PAGE || !urlStr) return;
        const realPage = getCurrentPageNumber(urlStr);
        if (realPage <= 1) return;

        const key = getResumeRouteKey(urlStr);
        const map = loadResumeBookmarks();
        map[key] = {
            page: realPage,
            url: normalizePageUrl(urlStr) || urlStr,
            updatedAt: Date.now(),
        };

        // 最多保留最近 40 個列表／搜尋紀錄，避免儲存空間膨脹
        const entries = Object.entries(map).sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
        GM_setValue(RESUME_STORAGE_KEY, Object.fromEntries(entries.slice(0, 40)));
    }

    function clearResumeBookmark(key) {
        const map = loadResumeBookmarks();
        if (map[key]) {
            delete map[key];
            GM_setValue(RESUME_STORAGE_KEY, map);
        }
    }

    function initResumeBreakpoint() {
        if (IS_ALBUM_PAGE || !document.body) return;

        injectStyle(`
            #ef-resume-bar {
                position: fixed;
                top: calc(12px + env(safe-area-inset-top, 0px));
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483641;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-wrap: wrap;
                gap: 8px;
                max-width: calc(100vw - 24px);
                padding: 8px 12px;
                border-radius: 14px;
                background: rgba(20, 20, 28, 0.94);
                border: 1px solid rgba(235, 99, 149, 0.55);
                box-shadow: 0 8px 26px rgba(0, 0, 0, 0.55);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                color: #f3f4f6;
            }
            #ef-resume-bar .ef-rb-text {
                font-weight: 600;
                color: #ffd1e1;
            }
            #ef-resume-bar .ef-rb-actions {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            #ef-resume-bar button {
                border-radius: 999px;
                padding: 5px 11px;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                border: 1px solid rgba(255, 255, 255, 0.18);
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                white-space: nowrap;
            }
            #ef-resume-bar .ef-rb-go {
                background: linear-gradient(135deg, #eb6395, #ff4d79);
                border-color: transparent;
            }
        `);

        const curPage = getCurrentPageNumber(window.location.href);
        const routeKey = getResumeRouteKey(window.location.href);

        // 若已位於第 2 頁以上，順手更新斷點紀錄，不顯示跳轉條
        if (curPage > 1) {
            saveResumeBookmark(window.location.href);
            return;
        }

        const map = loadResumeBookmarks();
        const saved = map[routeKey];
        if (!saved || !saved.url || Number(saved.page) <= 1) return;

        const diffMin = Math.max(1, Math.round((Date.now() - (saved.updatedAt || Date.now())) / 60000));
        const timeHint = diffMin < 60
            ? `${diffMin} 分鐘前`
            : diffMin < 1440
                ? `${Math.floor(diffMin / 60)} 小時前`
                : `${Math.floor(diffMin / 1440)} 天前`;

        if (document.getElementById('ef-resume-bar')) return;
        const bar = document.createElement('div');
        bar.id = 'ef-resume-bar';
        bar.innerHTML = `
            <span class="ef-rb-text">🔖 上次刷到第 ${Number(saved.page)} 頁（${timeHint}）</span>
            <div class="ef-rb-actions">
                <button class="ef-rb-go" type="button">🚀 跳至第 ${Number(saved.page)} 頁</button>
                <button class="ef-rb-clear" type="button" title="清除此列表斷點">清除</button>
                <button class="ef-rb-close" type="button" title="暫時關閉">✕</button>
            </div>
        `;
        document.body.appendChild(bar);

        bar.querySelector('.ef-rb-go').addEventListener('click', () => {
            window.location.href = saved.url;
        });
        bar.querySelector('.ef-rb-clear').addEventListener('click', () => {
            clearResumeBookmark(routeKey);
            bar.remove();
            showToast('🗑️ 已清除此列表的斷點紀錄');
        });
        bar.querySelector('.ef-rb-close').addEventListener('click', () => {
            bar.remove();
        });
    }

    // ==================== 10.6 列表頁封面點一下預覽／點第二下開啟 ====================
    let activePreviewWrap = null;
    let activePreviewContainer = null;
    let activePreviewCard = null;

    function startTitleMarquee(card) {
        stopTitleMarquee();
        if (!card) return;
        activePreviewCard = card;
        card.classList.add('ef-card-previewing');

        const titleEl = card.querySelector('.ef-clean-title');
        const inner = titleEl?.querySelector('.ef-marquee-inner');
        if (!titleEl || !inner) return;

        // 計算實際超出寬度，只有字數超過一行才啟動跑馬燈
        const overflow = Math.ceil(Math.max(titleEl.scrollWidth, inner.scrollWidth) - titleEl.clientWidth);
        if (overflow > 4) {
            const shift = -(overflow + 10);
            const dur = Math.max(3.6, Math.min(20, overflow / 42 + 2.4));
            inner.style.setProperty('--ef-marquee-shift', `${shift}px`);
            inner.style.setProperty('--ef-marquee-dur', `${dur.toFixed(2)}s`);
            card.classList.add('ef-marquee-active');
        }
    }

    function stopTitleMarquee() {
        if (!activePreviewCard) return;
        activePreviewCard.classList.remove('ef-card-previewing', 'ef-marquee-active');
        activePreviewCard = null;
    }
    
    let activePreviewTimer = null;
    let previewToken = 0;
    let previewStartScrollY = 0;

    function initCardPreview() {
        if (IS_ALBUM_PAGE) return;

        injectStyle(`
            .ef-preview-active {
                outline: 2px solid #eb6395 !important;
                outline-offset: -2px;
            }
            .ef-preview-wrap {
                position: absolute;
                inset: 0;
                z-index: 15;
                background: #000;
                pointer-events: none;
                overflow: hidden;
                border-radius: inherit;
            }
            .ef-preview-video {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
                background: #000;
            }
            .ef-preview-status {
                position: absolute;
                left: 8px;
                bottom: 8px;
                z-index: 16;
                padding: 3px 9px;
                border-radius: 999px;
                font-size: 11px;
                font-weight: 700;
                color: #fff;
                background: rgba(15, 15, 22, 0.82);
                border: 1px solid rgba(235, 99, 149, 0.55);
                backdrop-filter: blur(4px);
                pointer-events: none;
            }
        `);

        // 捲動超過 60px 時才停止預覽（避免手機輕點微晃就誤關預覽）
        window.addEventListener(
            'scroll',
            () => {
                if (activePreviewContainer && Math.abs(window.scrollY - previewStartScrollY) > 60) {
                    stopCardPreview();
                }
            },
            { passive: true }
        );

        // 點擊封面以外的區域自動停止預覽
        document.addEventListener('click', (e) => {
            if (!activePreviewContainer) return;
            if (!activePreviewContainer.contains(e.target)) {
                stopCardPreview();
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) stopCardPreview();
        });
    }

    function stopCardPreview() {
        stopTitleMarquee();
        clearTimeout(activePreviewTimer);
        activePreviewTimer = null;
        previewToken++;

        if (activePreviewContainer) {
            activePreviewContainer.classList.remove('ef-preview-active');
            activePreviewContainer = null;
        }
        if (activePreviewWrap) {
            const video = activePreviewWrap.querySelector('video');
            if (video) {
                try {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                } catch (_) {}
            }
            activePreviewWrap.remove();
            activePreviewWrap = null;
        }
    }

    function getCachedFirstVerticalVideo(meta) {
        const inPool = feedVideos.find((v) => v.albumUrl === meta.albumUrl && v.src);
        if (inPool) return inPool;

        if (meta.cacheId && albumCache[meta.cacheId]?.videos?.length > 0) {
            const cachedFirst = albumCache[meta.cacheId].videos.find((v) => v.src);
            if (cachedFirst) return cachedFirst;
        }
        return null;
    }

    async function startCardPreview(container, meta) {
        if (IS_ALBUM_PAGE || feedOpen || pickerActive) return;

        stopCardPreview();
        const myToken = ++previewToken;

        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        activePreviewContainer = container;
        previewStartScrollY = window.scrollY;
        container.classList.add('ef-preview-active');
        const previewCard = meta?.card || container.closest('.album, div[id^="album-"]');
        if (previewCard) startTitleMarquee(previewCard);

        const wrap = document.createElement('div');
        wrap.className = 'ef-preview-wrap';
        wrap.innerHTML = `<div class="ef-preview-status">⏳ 預覽載入中 · 再點開啟</div>`;
        container.appendChild(wrap);
        activePreviewWrap = wrap;

        let targetVideo = getCachedFirstVerticalVideo(meta);

        // 若背景深度掃描還沒掃到這篇，當下優先抓一次
        if (!targetVideo) {
            try {
                const qIdx = scanQueue.findIndex((j) => j.albumUrl === meta.albumUrl);
                if (qIdx !== -1) scanQueue.splice(qIdx, 1);

                if (inFlightScans.has(meta.albumUrl)) {
                    await inFlightScans.get(meta.albumUrl);
                } else {
                    await inspectAlbumVerticalVideos({ ...meta, priority: true });
                }
            } catch (_) {}

            if (myToken !== previewToken || !wrap.isConnected) return;
            targetVideo = getCachedFirstVerticalVideo(meta);
        }

        if (myToken !== previewToken || !wrap.isConnected) return;

        if (!targetVideo || !targetVideo.src) {
            const statusEl = wrap.querySelector('.ef-preview-status');
            if (statusEl) statusEl.textContent = '無可預覽影片 · 再點開啟';
            return;
        }

        const video = document.createElement('video');
        video.className = 'ef-preview-video';
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.preload = 'auto';
        if (targetVideo.poster) video.poster = targetVideo.poster;
        video.src = targetVideo.src;

        const statusEl = wrap.querySelector('.ef-preview-status');
        video.addEventListener('playing', () => {
            if (statusEl) statusEl.textContent = '🔇 預覽中 · 再點開啟';
        });
        video.addEventListener('error', () => {
            if (statusEl) statusEl.textContent = '預覽失敗 · 再點開啟';
        });

        wrap.prepend(video);
        video.play().catch(() => {});
    }

    function attachCardPreview(card, meta) {
        if (IS_ALBUM_PAGE) return;
        const container = card.querySelector('.album-thumbnail-container') || card;
        if (container.dataset.efPreviewBound === '1') return;
        container.dataset.efPreviewBound = '1';

        // 封面第 1 下點擊：靜音預覽；第 2 下點擊：放行打開相簿內容
        container.addEventListener(
            'click',
            (e) => {
                if (feedOpen || pickerActive) return;
                if (e.target && e.target.closest && e.target.closest('.ef-card-play-btn')) return;

                if (activePreviewContainer !== container) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    startCardPreview(container, meta);
                    return;
                }

                // 已經在預覽中 → 不攔截，直接打開相簿（延遲釋放預覽資源以防開新分頁繼續播放）
                setTimeout(stopCardPreview, 150);
            },
            true
        );

        // 電腦滑鼠仍保留懸停自動預覽（僅限真實滑鼠，不會干擾手機觸控）
        container.addEventListener('pointerenter', (e) => {
            if (e.pointerType !== 'mouse' || feedOpen || pickerActive) return;
            if (activePreviewContainer === container) return;
            clearTimeout(activePreviewTimer);
            activePreviewTimer = setTimeout(() => {
                startCardPreview(container, meta);
            }, 350);
        });

        container.addEventListener('pointerleave', (e) => {
            if (e.pointerType !== 'mouse') return;
            clearTimeout(activePreviewTimer);
            if (activePreviewContainer === container) {
                stopCardPreview();
            }
        });
    }

    // ==================== 11. 視覺化「點選隱藏」工具 ====================
    let pickerActive = false;
    let pickerLockedEl = null;
    let pickerHistoryStack = [];

    function generateSmartSelector(el) {
        if (!el || el.nodeType !== 1) return '';

        if (el.id && !/^album-|^ef-/i.test(el.id)) {
            const idSel = `#${cssEscapeSafe(el.id)}`;
            try {
                if (document.querySelectorAll(idSel).length === 1) return idSel;
            } catch (_) {}
        }

        if (el.hasAttribute('data-zoneid')) {
            return `${el.tagName.toLowerCase()}[data-zoneid="${cssEscapeSafe(el.getAttribute('data-zoneid'))}"]`;
        }
        if (el.tagName === 'IFRAME' && el.getAttribute('src')) {
            try {
                const host = new URL(el.getAttribute('src'), location.href).hostname;
                if (host && host !== location.hostname) {
                    return `iframe[src*="${cssEscapeSafe(host)}"]`;
                }
            } catch (_) {}
        }

        const cleanClasses = Array.from(el.classList || []).filter(
            (c) => c && !/^ef-|^active$|^open$|^show$|^hidden$|^lazyload/i.test(c)
        );
        if (cleanClasses.length > 0) {
            const classSel = `${el.tagName.toLowerCase()}.${cleanClasses.slice(0, 3).map(cssEscapeSafe).join('.')}`;
            try {
                const count = document.querySelectorAll(classSel).length;
                if (count >= 1 && count <= 8) return classSel;
            } catch (_) {}
        }

        const pathParts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < 5) {
            if (cur.id && !/^album-|^ef-/i.test(cur.id)) {
                pathParts.unshift(`#${cssEscapeSafe(cur.id)}`);
                break;
            }
            const tag = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (!parent) {
                pathParts.unshift(tag);
                break;
            }
            const sameTagSiblings = Array.from(parent.children).filter((ch) => ch.tagName === cur.tagName);
            if (sameTagSiblings.length > 1) {
                const idx = sameTagSiblings.indexOf(cur) + 1;
                pathParts.unshift(`${tag}:nth-of-type(${idx})`);
            } else {
                pathParts.unshift(tag);
            }
            cur = parent;
            depth++;
        }
        return pathParts.join(' > ');
    }

    function isForbiddenPickerTarget(el) {
        if (!el || el.nodeType !== 1) return true;
        if (el === document.body || el === document.documentElement) return true;
        if (isOurUiElement(el)) return true;
        if (el.id === 'albums' || el.querySelector('#albums, .media-group')) return true;
        return false;
    }

    function positionHighlightBox(el, locked = false) {
        const box = document.getElementById('ef-picker-highlight');
        if (!box) return;
        if (!el || !el.isConnected) {
            box.style.display = 'none';
            return;
        }
        const rect = el.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${Math.max(rect.width, 4)}px`;
        box.style.height = `${Math.max(rect.height, 4)}px`;
        box.classList.toggle('locked', locked);
    }

    function updatePickerBarUI() {
        const info = document.getElementById('ef-picker-info');
        const btnParent = document.getElementById('ef-pk-parent');
        const btnChild = document.getElementById('ef-pk-child');
        const btnConfirm = document.getElementById('ef-pk-confirm');
        const btnUndo = document.getElementById('ef-pk-undo');
        const btnManage = document.getElementById('ef-pk-manage');
        if (!info) return;

        if (btnManage) btnManage.textContent = `📋 規則 (${customHiddenSelectors.length})`;
        if (btnUndo) btnUndo.disabled = customHiddenSelectors.length === 0;

        if (!pickerLockedEl) {
            info.textContent = '🎯 請點擊頁面上想隱藏的廣告或區塊（點選後可調整範圍再確認隱藏）';
            if (btnParent) btnParent.disabled = true;
            if (btnChild) btnChild.disabled = true;
            if (btnConfirm) btnConfirm.disabled = true;
            return;
        }

        const rect = pickerLockedEl.getBoundingClientRect();
        const sel = generateSmartSelector(pickerLockedEl);
        info.textContent = `已選中 (${Math.round(rect.width)}×${Math.round(rect.height)})：${sel}`;
        if (btnParent) btnParent.disabled = isForbiddenPickerTarget(pickerLockedEl.parentElement);
        if (btnChild) btnChild.disabled = pickerHistoryStack.length === 0;
        if (btnConfirm) btnConfirm.disabled = false;
    }

    function createPickerUI() {
        if (document.getElementById('ef-picker-bar') || !document.body) return;

        const highlight = document.createElement('div');
        highlight.id = 'ef-picker-highlight';
        document.body.appendChild(highlight);

        const bar = document.createElement('div');
        bar.id = 'ef-picker-bar';
        bar.innerHTML = `
            <div id="ef-picker-drag-handle" title="按住此處拖曳移動工具列">
                <span>⠿ 按住拖曳移動</span>
                <button id="ef-pk-flip" class="ef-small-btn" type="button" style="padding:3px 9px;font-size:11px;">⇅ 移到底部</button>
            </div>
            <div id="ef-picker-info"></div>
            <div id="ef-picker-actions">
                <button id="ef-pk-confirm" class="ef-small-btn success" type="button" disabled>🙈 隱藏此區塊</button>
                <button id="ef-pk-parent" class="ef-small-btn" type="button" disabled>⬆️ 擴大一層</button>
                <button id="ef-pk-child" class="ef-small-btn" type="button" disabled>⬇️ 縮小一層</button>
                <button id="ef-pk-undo" class="ef-small-btn" type="button">↩️ 復原上一筆</button>
                <button id="ef-pk-manage" class="ef-small-btn" type="button">📋 規則 (0)</button>
                <button id="ef-pk-exit" class="ef-small-btn danger" type="button">✕ 結束</button>
            </div>
        `;
        document.body.appendChild(bar);

        const flipBtn = bar.querySelector('#ef-pk-flip');

        const updateFlipLabel = () => {
            if (!flipBtn) return;
            const rect = bar.getBoundingClientRect();
            const isInLowerHalf = rect.top + rect.height / 2 > window.innerHeight / 2;
            flipBtn.textContent = isInLowerHalf ? '⇅ 移到頂部' : '⇅ 移到底部';
        };

        const setBarPosition = (left, top) => {
            const rect = bar.getBoundingClientRect();
            const margin = 8;
            const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
            const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
            const clampedLeft = Math.max(margin, Math.min(left, maxLeft));
            const clampedTop = Math.max(margin, Math.min(top, maxTop));

            bar.style.transform = 'none';
            bar.style.bottom = 'auto';
            bar.style.right = 'auto';
            bar.style.left = `${Math.round(clampedLeft)}px`;
            bar.style.top = `${Math.round(clampedTop)}px`;
            bar.dataset.efPositioned = '1';
            updateFlipLabel();
        };

        // 視窗縮放或手機旋轉時，確保工具列維持在可視範圍內
        window.addEventListener('resize', () => {
            if (bar.classList.contains('open') && bar.dataset.efPositioned === '1') {
                const rect = bar.getBoundingClientRect();
                setBarPosition(rect.left, rect.top);
            }
        });

        // 一鍵快速切換停靠頂部／底部
        flipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = bar.getBoundingClientRect();
            const isInLowerHalf = rect.top + rect.height / 2 > window.innerHeight / 2;
            const centeredLeft = (window.innerWidth - rect.width) / 2;
            const targetTop = isInLowerHalf ? 12 : (window.innerHeight - rect.height - 16);
            setBarPosition(centeredLeft, targetTop);
        });

        // 自由拖曳（手把區、提示文字區及非按鈕空白處皆可按住拖曳）
        let dragging = false;
        let dragPointerId = null;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragOriginLeft = 0;
        let dragOriginTop = 0;

        bar.addEventListener('pointerdown', (e) => {
            if (e.target && e.target.closest && e.target.closest('button')) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;

            const rect = bar.getBoundingClientRect();
            dragging = true;
            dragPointerId = e.pointerId;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragOriginLeft = rect.left;
            dragOriginTop = rect.top;

            bar.classList.add('dragging');
            setBarPosition(dragOriginLeft, dragOriginTop);
            try { bar.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
            e.stopPropagation();
        });

        bar.addEventListener('pointermove', (e) => {
            if (!dragging || e.pointerId !== dragPointerId) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            setBarPosition(dragOriginLeft + dx, dragOriginTop + dy);
            e.preventDefault();
            e.stopPropagation();
        });

        const endDrag = (e) => {
            if (!dragging || (dragPointerId !== null && e.pointerId !== dragPointerId)) return;
            dragging = false;
            bar.classList.remove('dragging');
            try { bar.releasePointerCapture(dragPointerId); } catch (_) {}
            dragPointerId = null;
        };
        bar.addEventListener('pointerup', endDrag);
        bar.addEventListener('pointercancel', endDrag);

        bar.querySelector('#ef-pk-parent').addEventListener('click', () => {
            if (!pickerLockedEl || isForbiddenPickerTarget(pickerLockedEl.parentElement)) return;
            pickerHistoryStack.push(pickerLockedEl);
            pickerLockedEl = pickerLockedEl.parentElement;
            positionHighlightBox(pickerLockedEl, true);
            updatePickerBarUI();
        });

        bar.querySelector('#ef-pk-child').addEventListener('click', () => {
            if (pickerHistoryStack.length === 0) return;
            pickerLockedEl = pickerHistoryStack.pop();
            positionHighlightBox(pickerLockedEl, true);
            updatePickerBarUI();
        });

        bar.querySelector('#ef-pk-confirm').addEventListener('click', () => {
            if (!pickerLockedEl) return;
            const sel = generateSmartSelector(pickerLockedEl);
            if (!sel) {
                showToast('無法產生該元素的隱藏規則');
                return;
            }
            if (!customHiddenSelectors.includes(sel)) {
                customHiddenSelectors.push(sel);
                saveCustomHiddenSelectors();
                updateStats();
            }
            pickerLockedEl = null;
            pickerHistoryStack = [];
            positionHighlightBox(null);
            updatePickerBarUI();
            showToast('✅ 已永久隱藏此區塊');
        });

        bar.querySelector('#ef-pk-undo').addEventListener('click', () => {
            if (customHiddenSelectors.length === 0) return;
            customHiddenSelectors.pop();
            saveCustomHiddenSelectors();
            updateStats();
            updatePickerBarUI();
            showToast('↩️ 已復原上一筆隱藏規則');
        });

        bar.querySelector('#ef-pk-manage').addEventListener('click', () => {
            openHiddenRulesModal();
        });

        bar.querySelector('#ef-pk-exit').addEventListener('click', stopElementPicker);
    }

    function onPickerMouseMove(e) {
        if (!pickerActive || pickerLockedEl) return;
        const target = e.target;
        if (isForbiddenPickerTarget(target)) {
            positionHighlightBox(null);
            return;
        }
        positionHighlightBox(target, false);
    }

    function onPickerClick(e) {
        if (!pickerActive) return;
        if (isOurUiElement(e.target)) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (isForbiddenPickerTarget(e.target)) {
            showToast('此為主內容區或保護區域，無法直接隱藏');
            return;
        }

        pickerLockedEl = e.target;
        pickerHistoryStack = [];
        positionHighlightBox(pickerLockedEl, true);
        updatePickerBarUI();
    }

    function onPickerScrollResize() {
        if (pickerActive && pickerLockedEl) {
            positionHighlightBox(pickerLockedEl, true);
        }
    }

    function onPickerKeydown(e) {
        if (pickerActive && e.key === 'Escape') {
            stopElementPicker();
        }
    }

    function startElementPicker() {
        if (feedOpen) closeFeedMode();
        createPickerUI();
        pickerActive = true;
        pickerLockedEl = null;
        pickerHistoryStack = [];

        const panel = document.getElementById('ef-panel');
        if (panel) panel.style.display = 'none';

        document.getElementById('ef-picker-bar')?.classList.add('open');
        positionHighlightBox(null);
        updatePickerBarUI();

        document.addEventListener('mousemove', onPickerMouseMove, true);
        document.addEventListener('click', onPickerClick, true);
        window.addEventListener('scroll', onPickerScrollResize, { passive: true });
        window.addEventListener('resize', onPickerScrollResize, { passive: true });
        window.addEventListener('keydown', onPickerKeydown, true);
    }

    function stopElementPicker() {
        pickerActive = false;
        pickerLockedEl = null;
        pickerHistoryStack = [];

        document.getElementById('ef-picker-bar')?.classList.remove('open');
        positionHighlightBox(null);

        const panel = document.getElementById('ef-panel');
        if (panel) panel.style.display = '';

        document.removeEventListener('mousemove', onPickerMouseMove, true);
        document.removeEventListener('click', onPickerClick, true);
        window.removeEventListener('scroll', onPickerScrollResize);
        window.removeEventListener('resize', onPickerScrollResize);
        window.removeEventListener('keydown', onPickerKeydown, true);
    }

    function createHiddenRulesModal() {
        if (document.getElementById('ef-hidden-rules-modal') || !document.body) return;
        const modal = document.createElement('div');
        modal.id = 'ef-hidden-rules-modal';
        modal.className = 'ef-modal-backdrop';
        modal.innerHTML = `
            <div class="ef-modal-card">
                <div class="ef-modal-head">
                    <span id="ef-hidden-rules-title">🎯 自訂隱藏元件規則</span>
                    <button id="ef-hr-close" class="ef-small-btn" type="button">✕ 關閉</button>
                </div>
                <div class="ef-modal-tools">
                    <button id="ef-hr-start-picker" class="ef-small-btn primary" type="button">🎯 開始點選畫面元素</button>
                    <button id="ef-hr-clear" class="ef-small-btn danger" type="button">🗑️ 清空所有規則</button>
                </div>
                <div id="ef-hr-list" class="ef-modal-body"></div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeHiddenRulesModal();
        });
        modal.querySelector('#ef-hr-close').addEventListener('click', closeHiddenRulesModal);
        modal.querySelector('#ef-hr-start-picker').addEventListener('click', () => {
            closeHiddenRulesModal();
            startElementPicker();
        });
        modal.querySelector('#ef-hr-clear').addEventListener('click', () => {
            if (customHiddenSelectors.length === 0) return;
            if (!window.confirm(`確定要清空全部 ${customHiddenSelectors.length} 條自訂隱藏規則嗎？`)) return;
            customHiddenSelectors = [];
            saveCustomHiddenSelectors();
            updateStats();
            updatePickerBarUI();
            renderHiddenRulesList();
            showToast('已清空所有自訂隱藏規則');
        });
    }

    function renderHiddenRulesList() {
        const listEl = document.getElementById('ef-hr-list');
        const titleEl = document.getElementById('ef-hidden-rules-title');
        if (!listEl) return;
        if (titleEl) titleEl.textContent = `🎯 自訂隱藏元件規則 (${customHiddenSelectors.length})`;

        if (customHiddenSelectors.length === 0) {
            listEl.innerHTML = `<div style="text-align:center;color:#9ca3af;padding:28px 12px;">尚未設定自訂隱藏規則。<br>點擊上方「開始點選畫面元素」即可選取並隱藏任意廣告或干擾區塊。</div>`;
            return;
        }

        listEl.innerHTML = '';
        customHiddenSelectors.forEach((sel, idx) => {
            const row = document.createElement('div');
            row.className = 'ef-rule-row';
            row.innerHTML = `
                <code>${escapeHtml(sel)}</code>
                <button class="ef-small-btn danger" type="button">移除</button>
            `;
            row.querySelector('button').addEventListener('click', () => {
                customHiddenSelectors.splice(idx, 1);
                saveCustomHiddenSelectors();
                updateStats();
                updatePickerBarUI();
                renderHiddenRulesList();
                showToast('已移除規則並恢復顯示');
            });
            listEl.appendChild(row);
        });
    }

    function openHiddenRulesModal() {
        createHiddenRulesModal();
        renderHiddenRulesList();
        document.getElementById('ef-hidden-rules-modal')?.classList.add('open');
    }

    function closeHiddenRulesModal() {
        document.getElementById('ef-hidden-rules-modal')?.classList.remove('open');
    }

    // ==================== 12. 黑名單管理彈窗 ====================
    function createBlacklistModal() {
        if (document.getElementById('ef-blacklist-modal') || !document.body) return;
        const modal = document.createElement('div');
        modal.id = 'ef-blacklist-modal';
        modal.className = 'ef-modal-backdrop';
        modal.innerHTML = `
            <div class="ef-modal-card">
                <div class="ef-modal-head">
                    <span id="ef-bl-title">🚫 黑名單管理</span>
                    <button id="ef-bl-close" class="ef-small-btn" type="button">✕ 關閉</button>
                </div>
                <div class="ef-modal-body">
                    <div>
                        <div class="ef-section-title">🔤 標題關鍵字黑名單（不分大小寫，可用逗號一次輸入多個）</div>
                        <div class="ef-input-row">
                            <input id="ef-bl-kw-input" class="ef-text-input" type="text" placeholder="輸入不想看到的標題關鍵字...">
                            <button id="ef-bl-kw-add" class="ef-small-btn primary" type="button">新增</button>
                        </div>
                        <div id="ef-bl-kw-list" class="ef-chip-list"></div>
                    </div>
                    <div style="border-top:1px solid rgba(255,255,255,0.1);padding-top:12px;">
                        <div class="ef-section-title">👤 封鎖作者名單（亦可在抖音模式右側點 🚫 一鍵封鎖）</div>
                        <div class="ef-input-row">
                            <input id="ef-bl-author-input" class="ef-text-input" type="text" placeholder="輸入作者名稱...">
                            <button id="ef-bl-author-add" class="ef-small-btn primary" type="button">封鎖</button>
                        </div>
                        <div id="ef-bl-author-list" class="ef-chip-list"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeBlacklistModal();
        });
        modal.querySelector('#ef-bl-close').addEventListener('click', closeBlacklistModal);

        const kwInput = modal.querySelector('#ef-bl-kw-input');
        const addKw = () => {
            if (!kwInput.value.trim()) return;
            addBlockedKeywords(kwInput.value);
            kwInput.value = '';
        };
        modal.querySelector('#ef-bl-kw-add').addEventListener('click', addKw);
        kwInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addKw();
        });

        const authorInput = modal.querySelector('#ef-bl-author-input');
        const addAuth = () => {
            if (!authorInput.value.trim()) return;
            if (blockAuthor(authorInput.value)) {
                authorInput.value = '';
                renderBlacklistModal();
            }
        };
        modal.querySelector('#ef-bl-author-add').addEventListener('click', addAuth);
        authorInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addAuth();
        });
    }

    function renderBlacklistModal() {
        const titleEl = document.getElementById('ef-bl-title');
        const kwListEl = document.getElementById('ef-bl-kw-list');
        const authListEl = document.getElementById('ef-bl-author-list');
        if (!kwListEl || !authListEl) return;

        const total = blockedAuthors.length + blockedKeywords.length;
        if (titleEl) titleEl.textContent = `🚫 黑名單管理 (${total})`;

        if (blockedKeywords.length === 0) {
            kwListEl.innerHTML = `<span style="font-size:12px;color:#9ca3af;">目前沒有封鎖關鍵字</span>`;
        } else {
            kwListEl.innerHTML = '';
            blockedKeywords.forEach((kw, idx) => {
                const chip = document.createElement('span');
                chip.className = 'ef-chip';
                chip.innerHTML = `<span>${escapeHtml(kw)}</span><button type="button" title="移除">✕</button>`;
                chip.querySelector('button').addEventListener('click', () => {
                    blockedKeywords.splice(idx, 1);
                    saveBlocklists();
                    syncBlocklistEffects();
                    renderBlacklistModal();
                    showToast(`已解除關鍵字「${kw}」`);
                });
                kwListEl.appendChild(chip);
            });
        }

        if (blockedAuthors.length === 0) {
            authListEl.innerHTML = `<span style="font-size:12px;color:#9ca3af;">目前沒有封鎖作者</span>`;
        } else {
            authListEl.innerHTML = '';
            blockedAuthors.forEach((author, idx) => {
                const chip = document.createElement('span');
                chip.className = 'ef-chip';
                chip.innerHTML = `<span>@${escapeHtml(author)}</span><button type="button" title="解除封鎖">✕</button>`;
                chip.querySelector('button').addEventListener('click', () => {
                    blockedAuthors.splice(idx, 1);
                    saveBlocklists();
                    syncBlocklistEffects();
                    renderBlacklistModal();
                    showToast(`已解除封鎖 @${author}`);
                });
                authListEl.appendChild(chip);
            });
        }
    }

    function openBlacklistModal() {
        createBlacklistModal();
        const modal = document.getElementById('ef-blacklist-modal');
        const host = getFullscreenElement() || document.body;
        if (modal && host && modal.parentElement !== host) {
            host.appendChild(modal);
        }
        renderBlacklistModal();
        modal?.classList.add('open');
    }

    function closeBlacklistModal() {
        document.getElementById('ef-blacklist-modal')?.classList.remove('open');
    }

    // ==================== 13. 點擊 @作者名 快速追片引擎 ====================
    let currentBingeAuthor = '';
    let currentBingeAuthorUrl = '';
    let authorSessionId = 0;
    const authorVideos = [];
    const authorSeenSrcs = new Set();
    const authorSeenAlbums = new Set();
    const authorScanQueue = [];
    let authorActiveScans = 0;
    let authorNextPageUrl = null;
    let authorLoadedPages = new Set();
    let authorIsLoadingPage = false;
    let authorPageCount = 0;

    function resetAuthorBingeState() {
        authorSessionId++;
        currentBingeAuthor = '';
        currentBingeAuthorUrl = '';
        authorVideos.length = 0;
        authorSeenSrcs.clear();
        authorSeenAlbums.clear();
        authorScanQueue.length = 0;
        authorActiveScans = 0;
        authorNextPageUrl = null;
        authorLoadedPages.clear();
        authorIsLoadingPage = false;
        authorPageCount = 0;
        updateAuthorBarUI();
    }

    function updateAuthorBarUI() {
        const bar = document.getElementById('ef-author-bar');
        const label = document.getElementById('ef-author-bar-label');
        const profileLink = document.getElementById('ef-author-profile-link');
        if (!bar) return;

        if (feedMode !== 'author' || !currentBingeAuthor) {
            bar.classList.remove('show');
            return;
        }
        bar.classList.add('show');
        const scanning = authorActiveScans + authorScanQueue.length;
        if (label) {
            label.textContent = scanning > 0 || authorIsLoadingPage
                ? `👤 追片 @${currentBingeAuthor} (${authorVideos.length} 部 · 掃描中)`
                : `👤 追片 @${currentBingeAuthor} (共 ${authorVideos.length} 部豎屏)`;
        }
        if (profileLink) {
            profileLink.href = currentBingeAuthorUrl || buildAuthorProfileUrl(currentBingeAuthor);
        }
    }

    function addAuthorVideo(item, sid) {
        if (sid !== authorSessionId || feedMode !== 'author') return;
        if (!item || !item.src || authorSeenSrcs.has(item.src)) return;

        const cleanItem = {
            ...item,
            author: String(item.author || currentBingeAuthor).replace(/^@+/, '').trim(),
            authorUrl: item.authorUrl || currentBingeAuthorUrl,
        };

        authorSeenSrcs.add(cleanItem.src);
        authorVideos.push(cleanItem);
        const newIdx = authorVideos.length - 1;

        appendSlideToFeed(cleanItem, newIdx);

        if (feedOpen && pendingSkipAlbumUrl && cleanItem.albumUrl !== pendingSkipAlbumUrl) {
            pendingSkipAlbumUrl = null;
            scrollToSlide(newIdx, 'auto');
            activateSlide(newIdx);
            showToast('⏭️ 已切到該作者下一篇影片');
        } else if (feedOpen) {
            updateAlbumPositionBadge(activeSlideIndex);
        }

        updateAuthorBarUI();
        updateFeedCounter();
        updateFeedTailText();
    }

    function openAuthorFeed(authorName, authorUrl = '', startSrc = '') {
        const cleanAuthor = String(authorName || '').replace(/^@+/, '').trim();
        if (!cleanAuthor) {
            showToast('此影片沒有標記作者名稱');
            return;
        }

        if (feedMode === 'explore') exploreLastIndex = activeSlideIndex;
        if (feedMode === 'favorites') favoritesLastIndex = activeSlideIndex;

        authorSessionId++;
        const sid = authorSessionId;
        currentBingeAuthor = cleanAuthor;
        currentBingeAuthorUrl = authorUrl || buildAuthorProfileUrl(cleanAuthor);
        authorVideos.length = 0;
        authorSeenSrcs.clear();
        authorSeenAlbums.clear();
        authorScanQueue.length = 0;
        authorActiveScans = 0;
        authorNextPageUrl = null;
        authorLoadedPages = new Set();
        authorIsLoadingPage = false;
        authorPageCount = 0;

        // 1) 先把目前已掃到的同作者影片塞進來，讓使用者無縫繼續看
        const targetLower = cleanAuthor.toLowerCase();
        const seeded = [];
        for (const srcList of [allDiscoveredVideos, favorites]) {
            for (const v of srcList) {
                if (!v || !v.src || authorSeenSrcs.has(v.src)) continue;
                const a = String(v.author || '').replace(/^@+/, '').trim().toLowerCase();
                if (a === targetLower) {
                    authorSeenSrcs.add(v.src);
                    seeded.push({
                        ...v,
                        author: cleanAuthor,
                        authorUrl: v.authorUrl || currentBingeAuthorUrl,
                    });
                }
            }
        }
        seeded.forEach((v) => authorVideos.push(v));

        // 切換到作者追片模式
        feedMode = 'author';
        document.getElementById('ef-tab-explore')?.classList.remove('active');
        document.getElementById('ef-tab-fav')?.classList.remove('active');
        updateAuthorBarUI();

        const startIdx = startSrc ? Math.max(0, authorVideos.findIndex((v) => v.src === startSrc)) : 0;
        rebuildFeedSlides(startIdx);
        showToast(`👤 開始追片 @${cleanAuthor}，背景載入更多豎屏影片...`);

        // 2) 背景抓取作者主頁相簿列表
        loadAuthorProfilePage(currentBingeAuthorUrl, sid);
    }

    async function loadAuthorProfilePage(pageUrl, sid = authorSessionId) {
        if (sid !== authorSessionId || feedMode !== 'author' || !pageUrl || authorIsLoadingPage) return;
        const normUrl = normalizePageUrl(pageUrl, window.location.origin);
        if (!normUrl || authorLoadedPages.has(normUrl)) {
            authorNextPageUrl = null;
            updateFeedTailText();
            return;
        }

        authorIsLoadingPage = true;
        updateAuthorBarUI();
        updateFeedTailText();

        try {
            const res = await fetch(normUrl, { credentials: 'same-origin' });
            if (sid !== authorSessionId) return;

            if (res.status === 429) {
                showToast('⚠️ 作者頁面請求過快，請稍候幾秒再試');
                return;
            }
            if (!res.ok) {
                authorNextPageUrl = null;
                return;
            }

            const finalUrl = normalizePageUrl(res.url || normUrl, normUrl) || normUrl;
            authorLoadedPages.add(normUrl);
            authorLoadedPages.add(finalUrl);

            const html = await res.text();
            if (sid !== authorSessionId) return;

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const cards = extractUniqueCards(doc, finalUrl, authorSeenAlbums);

            if (cards.length === 0) {
                authorNextPageUrl = null;
                return;
            }

            authorPageCount++;
            const nextInfo = findNextPageUrl(doc, finalUrl, authorLoadedPages);
            authorNextPageUrl = nextInfo ? nextInfo.url : null;

            for (const card of cards) {
                const linkEl = card.querySelector('a.album-link, a[href*="/a/"]');
                const rawHref = linkEl ? linkEl.getAttribute('href') : null;
                if (!rawHref) continue;
                const albumUrl = resolveUrl(rawHref, finalUrl);
                let cacheId = null;
                try {
                    cacheId = new URL(albumUrl).pathname;
                } catch (_) {
                    continue;
                }
                if (authorSeenAlbums.has(cacheId)) continue;
                authorSeenAlbums.add(cacheId);

                // 略過純圖片相簿
                if (!card.querySelector('.album-videos')) continue;

                const title = card.querySelector('.album-title')?.textContent?.trim() || 'Erome 相簿';
                if (isBlockedContent('', title)) continue;

                // 優先讀快取
                if (albumCache[cacheId]) {
                    const cached = albumCache[cacheId];
                    if (cached.vertical && Array.isArray(cached.videos)) {
                        cached.videos.forEach((v) => addAuthorVideo(v, sid));
                    }
                    continue;
                }

                authorScanQueue.push({
                    albumUrl,
                    cacheId,
                    fallbackTitle: title,
                    fallbackAuthor: currentBingeAuthor,
                    fallbackAuthorUrl: currentBingeAuthorUrl,
                });
            }

            runAuthorScanQueue(sid);
        } catch (_) {
            showToast('讀取作者主頁失敗');
        } finally {
            if (sid === authorSessionId) {
                authorIsLoadingPage = false;
                updateAuthorBarUI();
                updateFeedCounter();
                updateFeedTailText();
            }
        }
    }

    async function runAuthorScanQueue(sid) {
        if (sid !== authorSessionId || feedMode !== 'author') return;
        while (authorActiveScans < SCAN_CONCURRENCY && authorScanQueue.length > 0) {
            if (sid !== authorSessionId) return;
            const now = Date.now();
            if (now < rateLimitedUntil) {
                setTimeout(() => runAuthorScanQueue(sid), rateLimitedUntil - now + 120);
                return;
            }
            const job = authorScanQueue.shift();
            authorActiveScans++;
            fetchAndParseAlbumVerticals(
                job.albumUrl,
                job.cacheId,
                job.fallbackTitle,
                job.fallbackAuthor,
                job.fallbackAuthorUrl
            )
                .then((parsed) => {
                    if (sid !== authorSessionId) return;
                    if (parsed.rateLimited) {
                        rateLimitedUntil = Date.now() + 10000;
                        authorScanQueue.unshift(job);
                        return;
                    }
                    if (parsed.playable && parsed.playable.length > 0) {
                        parsed.playable.forEach((v) => addAuthorVideo(v, sid));
                    }
                })
                .catch(() => {})
                .finally(() => {
                    if (sid !== authorSessionId) return;
                    authorActiveScans--;
                    updateAuthorBarUI();
                    updateFeedCounter();
                    updateFeedTailText();
                    setTimeout(() => runAuthorScanQueue(sid), SCAN_DELAY_MS);
                });
        }
    }

    // ==================== 14. 抖音式全螢幕上下滑動播放器 ====================
    let feedOpen = false;
    let feedMuted = false;
    let feedFocusMode = false;
    let feedMode = 'explore'; // 'explore' | 'favorites' | 'author'
    let activeSlideIndex = 0;
    let exploreLastIndex = 0;
    let favoritesLastIndex = 0;
    let feedObserver = null;
    let slideElements = [];

    function getActiveFeedList() {
        if (feedMode === 'favorites') return favorites;
        if (feedMode === 'author') return authorVideos;
        return feedVideos;
    }

    function toggleFullscreen() {
        const overlay = document.getElementById('ef-feed-overlay');
        if (!overlay) return;

        if (!getFullscreenElement()) {
            const req = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
            if (typeof req === 'function') {
                Promise.resolve(req.call(overlay)).catch(() => {
                    showToast('此瀏覽器目前不支援全螢幕 API');
                });
            } else {
                showToast('此瀏覽器不支援網頁全螢幕');
            }
        } else {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            if (typeof exit === 'function') {
                Promise.resolve(exit.call(document)).catch(() => {});
            }
        }
    }

    function syncFullscreenButton() {
        const btn = document.getElementById('ef-feed-fullscreen');
        if (!btn) return;
        const isFs = !!getFullscreenElement();
        btn.textContent = isFs ? '🗗' : '⛶';
        btn.title = isFs ? '退出全螢幕 (F)' : '切換全螢幕 (F)';
        btn.classList.toggle('active', isFs);
    }

    function setFocusMode(enabled, notify = true) {
        feedFocusMode = !!enabled;
        const overlay = document.getElementById('ef-feed-overlay');
        if (overlay) overlay.classList.toggle('focus-mode', feedFocusMode);
        const btn = document.getElementById('ef-feed-focus');
        if (btn) btn.classList.toggle('active', feedFocusMode);
        if (notify) {
            showToast(feedFocusMode ? '👁️ 專注模式已開啟（點右下角恢復介面）' : '已恢復操作介面');
        }
    }

    function skipToNextAlbum() {
        const list = getActiveFeedList();
        const cur = list[activeSlideIndex];
        if (!cur) return;

        if (feedMode === 'explore' && IS_ALBUM_PAGE) {
            showToast('目前位於單一相簿內頁，無下一篇可跳轉');
            return;
        }

        let nextIdx = -1;
        for (let i = activeSlideIndex + 1; i < list.length; i++) {
            if (list[i].albumUrl !== cur.albumUrl) {
                nextIdx = i;
                break;
            }
        }

        if (nextIdx !== -1) {
            pendingSkipAlbumUrl = null;
            const skippedClips = nextIdx - activeSlideIndex - 1;
            scrollToSlide(nextIdx, 'auto');
            activateSlide(nextIdx);
            showToast(skippedClips > 0 ? `⏭️ 已略過本篇剩餘 ${skippedClips} 部，切換至下一篇` : '⏭️ 已切換至下一篇');
            return;
        }

        if (feedMode === 'favorites') {
            showToast('後方沒有其他篇的收藏影片了');
            return;
        }

        pendingSkipAlbumUrl = cur.albumUrl;
        scrollToSlide(slideElements.length, 'auto');

        if (feedMode === 'author') {
            if (authorNextPageUrl && !authorIsLoadingPage) {
                loadAuthorProfilePage(authorNextPageUrl, authorSessionId);
                showToast(`⏳ 正在載入 @${currentBingeAuthor} 下一頁相簿...`);
            } else if (authorActiveScans + authorScanQueue.length > 0) {
                showToast(`🔍 正在掃描 @${currentBingeAuthor} 更多相簿，找到後自動切換...`);
            } else {
                pendingSkipAlbumUrl = null;
                showToast(`已是 @${currentBingeAuthor} 的最後一篇囉`);
            }
            return;
        }

        if (nextPageUrl && !isLoadingNextPage) {
            loadNextPage(true);
            showToast('⏳ 正在載入下一頁尋找下一篇影片...');
        } else if (activeScans + scanQueue.length > 0) {
            showToast('🔍 正在掃描下一篇影片，找到後自動切換...');
        } else {
            pendingSkipAlbumUrl = null;
            showToast('已經是最後一篇囉');
        }
    }

    function updateAlbumPositionBadge(index) {
        const slide = slideElements[index];
        const list = getActiveFeedList();
        const item = list[index];
        if (!slide || !item) return;

        const badge = slide.querySelector('.ef-album-pos');
        if (!badge) return;

        let totalInAlbum = 0;
        let currentPos = 0;
        for (let i = 0; i < list.length; i++) {
            if (list[i].albumUrl === item.albumUrl) {
                totalInAlbum++;
                if (i === index) currentPos = totalInAlbum;
            }
        }

        if (totalInAlbum > 1) {
            badge.textContent = `本篇 ${currentPos}/${totalInAlbum}`;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    function createFeedOverlay() {
        if (document.getElementById('ef-feed-overlay') || !document.body) return;

        const overlay = document.createElement('div');
        overlay.id = 'ef-feed-overlay';
        if (config.feedCoverMode) overlay.classList.add('cover-mode');

        overlay.innerHTML = `
            <div id="ef-feed-topbar">
                <div class="ef-topbar-group">
                    <button id="ef-feed-close" class="ef-pill-btn" type="button" title="退出抖音模式 (Esc)">✕</button>
                    <button id="ef-feed-fullscreen" class="ef-pill-btn" type="button" title="切換全螢幕 (F)">⛶</button>
                </div>
                <div class="ef-topbar-group">
                    <div class="ef-mode-tabs">
                        <button id="ef-tab-explore" class="ef-mode-tab active" type="button">探索 (0)</button>
                        <button id="ef-tab-fav" class="ef-mode-tab" type="button">❤️ (0)</button>
                    </div>
                </div>
                <div class="ef-topbar-group">
                    <button id="ef-feed-grid-btn" class="ef-pill-btn" type="button" title="九宮格縮圖抽屜 (G)">⊞</button>
                    <button id="ef-feed-focus" class="ef-pill-btn" type="button" title="專注模式：隱藏所有按鈕 (H)">👁️</button>
                    <button id="ef-feed-manage-fav" class="ef-pill-btn" type="button" title="管理收藏清單">📋</button>
                </div>
            </div>
            <div id="ef-feed-counter">0 / 0</div>
            <div id="ef-author-bar">
                <span id="ef-author-bar-label">👤 追片中</span>
                <div class="ef-author-bar-actions">
                    <a id="ef-author-profile-link" class="ef-author-bar-btn" href="#" target="_blank" rel="noopener">🔗 作者主頁</a>
                    <button id="ef-author-exit-btn" class="ef-author-bar-btn" type="button">↩ 返回探索</button>
                </div>
            </div>
            <button id="ef-focus-exit-btn" type="button" title="退出專注模式 (H)">👁️ 顯示按鈕</button>
            <div id="ef-speed-pill">⏩ ${LONG_PRESS_SPEED}x 倍速播放中</div>
            <div id="ef-feed-scroller">
                <div id="ef-feed-tail" class="ef-slide" data-slide-index="tail">
                    <div id="ef-feed-tail-msg">正在掃描豎屏影片...</div>
                    <button id="ef-feed-tail-btn" type="button" style="display:none;">載入下一頁影片</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector('#ef-feed-grid-btn').addEventListener('click', toggleGridDrawer);
        overlay.querySelector('#ef-feed-close').addEventListener('click', closeFeedMode);
        overlay.querySelector('#ef-feed-fullscreen').addEventListener('click', toggleFullscreen);
        overlay.querySelector('#ef-feed-focus').addEventListener('click', () => setFocusMode(!feedFocusMode));
        overlay.querySelector('#ef-focus-exit-btn').addEventListener('click', () => setFocusMode(false));
        overlay.querySelector('#ef-tab-explore').addEventListener('click', () => switchFeedMode('explore'));
        overlay.querySelector('#ef-tab-fav').addEventListener('click', () => switchFeedMode('favorites'));
        overlay.querySelector('#ef-author-exit-btn').addEventListener('click', () => switchFeedMode('explore'));
        overlay.querySelector('#ef-feed-manage-fav').addEventListener('click', openFavManager);
        overlay.querySelector('#ef-feed-tail-btn').addEventListener('click', () => {
            if (feedMode === 'explore') {
                loadNextPage(true);
            } else if (feedMode === 'author') {
                if (authorNextPageUrl) {
                    loadAuthorProfilePage(authorNextPageUrl, authorSessionId);
                } else {
                    switchFeedMode('explore');
                }
            } else {
                switchFeedMode('explore');
            }
        });

        document.addEventListener('fullscreenchange', syncFullscreenButton);
        document.addEventListener('webkitfullscreenchange', syncFullscreenButton);

        const scroller = overlay.querySelector('#ef-feed-scroller');
        feedObserver = new IntersectionObserver(
            (entries) => {
                if (!feedOpen) return;
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    const idxAttr = entry.target.dataset.slideIndex;
                    if (idxAttr === 'tail') {
                        pauseAllFeedVideos();
                        updateFeedCounter();
                        if (feedMode === 'explore' && !IS_ALBUM_PAGE && nextPageUrl && !isLoadingNextPage) {
                            loadNextPage(false);
                        } else if (feedMode === 'author' && authorNextPageUrl && !authorIsLoadingPage) {
                            loadAuthorProfilePage(authorNextPageUrl, authorSessionId);
                        }
                        return;
                    }
                    const idx = Number(idxAttr);
                    if (!Number.isNaN(idx)) {
                        pendingSkipAlbumUrl = null;
                        activateSlide(idx);
                    }
                });
            },
            { root: scroller, threshold: 0.65 }
        );
        feedObserver.observe(overlay.querySelector('#ef-feed-tail'));

        window.addEventListener('keydown', (e) => {
            if (!feedOpen) return;
            if (
                document.getElementById('ef-fav-modal')?.classList.contains('open') ||
                document.getElementById('ef-blacklist-modal')?.classList.contains('open')
            ) {
                if (e.key === 'Escape') {
                    closeFavManager();
                    closeBlacklistModal();
                }
                return;
            }
            if (isGridDrawerOpen()) {
                if (e.key === 'Escape' || e.key === 'g' || e.key === 'G') {
                    e.preventDefault();
                    closeGridDrawer();
                }
                return;
            }
            if (e.key === 'Escape') {
                if (!getFullscreenElement()) closeFeedMode();
            } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
                e.preventDefault();
                scrollToSlide(activeSlideIndex + 1);
            } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
                e.preventDefault();
                scrollToSlide(activeSlideIndex - 1);
            } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
                e.preventDefault();
                seekCurrentSlide(DOUBLE_TAP_SEEK_SEC);
            } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
                e.preventDefault();
                seekCurrentSlide(-DOUBLE_TAP_SEEK_SEC);
            } else if (e.key === ' ') {
                e.preventDefault();
                togglePlaySlide(activeSlideIndex);
            } else if (e.key === 'm' || e.key === 'M') {
                toggleFeedMute();
            } else if (e.key === 'l' || e.key === 'L') {
                const item = getActiveFeedList()[activeSlideIndex];
                if (item) toggleFavorite(item);
            } else if (e.key === 'r' || e.key === 'R') {
                cyclePlaybackRate();
            } else if (e.key === 'f' || e.key === 'F') {
                toggleFullscreen();
            } else if (e.key === 'h' || e.key === 'H') {
                setFocusMode(!feedFocusMode);
            } else if (e.key === 'n' || e.key === 'N') {
                skipToNextAlbum();
            } else if (e.key === 'b' || e.key === 'B') {
                const item = getActiveFeedList()[activeSlideIndex];
                if (item) blockAuthor(item.author);
            } else if (e.key === 'g' || e.key === 'G') {
                e.preventDefault();
                toggleGridDrawer();
            }
        });
    }

    function spawnGestureFx(slide, text, side) {
        const fx = document.createElement('div');
        fx.className = `ef-gesture-fx ${side}`;
        fx.textContent = text;
        slide.appendChild(fx);
        setTimeout(() => fx.remove(), 700);
    }

    function spawnHeartBurst(slide, clientX, clientY) {
        const rect = slide.getBoundingClientRect();
        const heart = document.createElement('div');
        heart.className = 'ef-heart-burst';
        heart.textContent = '❤️';
        heart.style.left = `${clientX - rect.left}px`;
        heart.style.top = `${clientY - rect.top}px`;
        slide.appendChild(heart);
        setTimeout(() => heart.remove(), 800);
    }

    function seekSlideVideo(slide, video, deltaSec) {
        if (!video || !Number.isFinite(video.duration)) return;
        const nextTime = Math.max(0, Math.min(video.duration, video.currentTime + deltaSec));
        video.currentTime = nextTime;
        spawnGestureFx(
            slide,
            deltaSec > 0 ? `⏩ +${deltaSec}秒` : `⏪ ${deltaSec}秒`,
            deltaSec > 0 ? 'right' : 'left'
        );
    }

    function seekCurrentSlide(deltaSec) {
        const slide = slideElements[activeSlideIndex];
        const video = slide?.querySelector('video');
        if (slide && video) seekSlideVideo(slide, video, deltaSec);
    }

    let scrubHudStyleInjected = false;

    function ensureScrubHud() {
        const overlay = document.getElementById('ef-feed-overlay');
        if (!overlay) return null;

        if (!scrubHudStyleInjected) {
            scrubHudStyleInjected = true;
            injectStyle(`
                /* 允許原生上下滑動切影片，同時將左右橫滑交給腳本控制進度 */
                .ef-slide video {
                    touch-action: pan-y;
                }
                #ef-scrub-hud {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.96);
                    z-index: 44;
                    min-width: 196px;
                    padding: 12px 16px;
                    border-radius: 14px;
                    background: rgba(15, 15, 22, 0.88);
                    border: 1px solid rgba(235, 99, 149, 0.55);
                    box-shadow: 0 8px 26px rgba(0, 0, 0, 0.55);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    text-align: center;
                    pointer-events: none;
                    opacity: 0;
                    transition: opacity 0.12s ease, transform 0.12s ease;
                }
                #ef-scrub-hud.show {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
                #ef-scrub-delta {
                    font-size: 13px;
                    font-weight: 700;
                    color: #f9a8d4;
                    margin-bottom: 4px;
                }
                #ef-scrub-time {
                    font-size: 16px;
                    font-weight: 700;
                    color: #fff;
                    font-variant-numeric: tabular-nums;
                    margin-bottom: 8px;
                }
                #ef-scrub-bar {
                    width: 100%;
                    height: 4px;
                    border-radius: 999px;
                    background: rgba(255, 255, 255, 0.24);
                    overflow: hidden;
                }
                #ef-scrub-bar-fill {
                    width: 0%;
                    height: 100%;
                    background: linear-gradient(90deg, #eb6395, #ff4d79);
                    border-radius: 999px;
                }
                #ef-scrub-scale {
                    margin-top: 8px;
                    display: inline-block;
                    padding: 2px 9px;
                    border-radius: 999px;
                    font-size: 11px;
                    font-weight: 700;
                    color: #e5e7eb;
                    background: rgba(255, 255, 255, 0.12);
                }
                #ef-scrub-scale.boost {
                    color: #fff;
                    background: rgba(235, 99, 149, 0.85);
                }
                #ef-scrub-scale.fine {
                    color: #cffafe;
                    background: rgba(14, 165, 233, 0.55);
                }
                #ef-scrub-hint {
                    margin-top: 4px;
                    font-size: 10px;
                    color: rgba(255, 255, 255, 0.62);
                }
            `);
        }

        let hud = document.getElementById('ef-scrub-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'ef-scrub-hud';
            hud.innerHTML = `
                <div id="ef-scrub-delta">⏩ +0秒</div>
                <div id="ef-scrub-time">0:00 / 0:00</div>
                <div id="ef-scrub-bar"><div id="ef-scrub-bar-fill"></div></div>
                <div id="ef-scrub-scale">標準範圍 1x</div>
                <div id="ef-scrub-hint">⬆️ 上滑加大範圍 · ⬇️ 下滑精準微調</div>
            `;
            overlay.appendChild(hud);
        }
        return hud;
    }

    function updateScrubHud(targetTime, duration, deltaSec, scale = 1, scaleLabel = '標準範圍 1x') {
        const hud = ensureScrubHud();
        if (!hud) return;
        const deltaEl = hud.querySelector('#ef-scrub-delta');
        const timeEl = hud.querySelector('#ef-scrub-time');
        const fillEl = hud.querySelector('#ef-scrub-bar-fill');
        const scaleEl = hud.querySelector('#ef-scrub-scale');

        const rounded = Math.round(deltaSec);
        if (deltaEl) {
            if (rounded > 0) deltaEl.textContent = `⏩ +${rounded}秒`;
            else if (rounded < 0) deltaEl.textContent = `⏪ ${rounded}秒`;
            else deltaEl.textContent = '↔ 0秒';
        }
        if (timeEl) {
            timeEl.textContent = `${formatTime(targetTime)} / ${formatTime(duration)}`;
        }
        if (fillEl && duration > 0) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (targetTime / duration) * 100))}%`;
        }
        if (scaleEl) {
            scaleEl.textContent = scaleLabel;
            scaleEl.classList.toggle('boost', scale > 1);
            scaleEl.classList.toggle('fine', scale < 1);
        }
        hud.classList.add('show');
    }

    function hideScrubHud() {
        document.getElementById('ef-scrub-hud')?.classList.remove('show');
    }

    function attachVideoGestures(slide, video, item, index) {
        ensureScrubHud();
        video.addEventListener('contextmenu', (e) => e.preventDefault());
        slide.addEventListener('contextmenu', (e) => {
            if (e.target === video || e.target === slide) e.preventDefault();
        });

        let pointerDown = false;
        let activePointerId = null;
        let startX = 0;
        let startY = 0;
        let moved = false;
        let dragAxis = null; // null | 'x' | 'y'
        let scrubOriginY = 0;
        let lastClientX = 0;
        let scrubStartTime = 0;
        let scrubTargetTime = 0;
        let isLongPressing = false;
        let longPressTimer = null;
        let lastTapTime = 0;
        let singleTapTimer = null;

        const speedPill = () => document.getElementById('ef-speed-pill');

        const endLongPress = () => {
            clearTimeout(longPressTimer);
            longPressTimer = null;
            if (isLongPressing) {
                isLongPressing = false;
                video.playbackRate = config.playbackRate;
                speedPill()?.classList.remove('show');
                return true;
            }
            return false;
        };

        const endScrub = (commit) => {
            if (dragAxis !== 'x') return false;
            dragAxis = null;
            delete slide.dataset.efScrubbing;
            hideScrubHud();

            if (activePointerId !== null) {
                try { video.releasePointerCapture(activePointerId); } catch (_) {}
            }

            if (commit && Number.isFinite(video.duration) && video.duration > 0) {
                video.currentTime = scrubTargetTime;
            } else if (Number.isFinite(video.duration) && video.duration > 0) {
                const progress = slide.querySelector('.ef-progress');
                const timeText = slide.querySelector('.ef-time-text');
                if (progress) progress.value = String((video.currentTime / video.duration) * 100);
                if (timeText) timeText.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
            }
            return true;
        };

        // 手機端橫滑時阻擋上下捲動微偏移，確保上下調整靈敏度時不會誤切影片
        video.addEventListener(
            'touchmove',
            (e) => {
                if (dragAxis === 'x' && e.cancelable) {
                    e.preventDefault();
                }
            },
            { passive: false }
        );

        video.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            pointerDown = true;
            activePointerId = e.pointerId;
            moved = false;
            dragAxis = null;
            isLongPressing = false;
            startX = e.clientX;
            startY = e.clientY;

            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
                if (!pointerDown || moved || dragAxis) return;
                isLongPressing = true;
                clearTimeout(singleTapTimer);
                const boostRate = config.playbackRate >= LONG_PRESS_SPEED ? 2.5 : LONG_PRESS_SPEED;
                video.playbackRate = boostRate;
                if (video.paused) video.play().catch(() => {});
                const pill = speedPill();
                if (pill) {
                    pill.textContent = `⏩ ${boostRate}x 倍速播放中`;
                    pill.classList.add('show');
                }
            }, 300);
        });

        video.addEventListener('pointermove', (e) => {
            if (!pointerDown || e.pointerId !== activePointerId) return;
            if (isLongPressing) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (!dragAxis) {
                if (Math.hypot(dx, dy) <= 10) return;
                moved = true;
                clearTimeout(longPressTimer);
                clearTimeout(singleTapTimer);

                // 水平位移大於垂直位移且影片已載入時長 → 鎖定進入橫滑快轉／倒退
                if (
                    Math.abs(dx) > 10 &&
                    Math.abs(dx) > Math.abs(dy) * 1.05 &&
                    Number.isFinite(video.duration) &&
                    video.duration > 0
                ) {
                    dragAxis = 'x';
                    scrubOriginY = e.clientY;
                    lastClientX = e.clientX;
                    scrubStartTime = video.currentTime;
                    scrubTargetTime = video.currentTime;
                    slide.dataset.efScrubbing = '1';
                    try { video.setPointerCapture(e.pointerId); } catch (_) {}
                    updateScrubHud(scrubTargetTime, video.duration, 0, 1, '標準範圍 1x');
                } else {
                    dragAxis = 'y';
                    return;
                }
            }

            if (dragAxis === 'x') {
                const duration = video.duration;
                if (!Number.isFinite(duration) || duration <= 0) return;

                // 依據手指相對起點的「上下位移」動態切換滑動範圍倍率
                // 若希望「往上或往下滑一律放大範圍」，把下行改為：const offsetY = Math.abs(scrubOriginY - e.clientY);
                const offsetY = scrubOriginY - e.clientY;
                let scale = 1;
                let scaleLabel = '標準範圍 1x';
                if (offsetY >= 150) {
                    scale = 5;
                    scaleLabel = '🚀 極速大範圍 5x';
                } else if (offsetY >= 95) {
                    scale = 3;
                    scaleLabel = '⚡ 大範圍 3x';
                } else if (offsetY >= 40) {
                    scale = 2;
                    scaleLabel = '⏩ 加大範圍 2x';
                } else if (offsetY <= -95) {
                    scale = 0.25;
                    scaleLabel = '🎯 超精準微調 0.25x';
                } else if (offsetY <= -40) {
                    scale = 0.5;
                    scaleLabel = '🔍 精準微調 0.5x';
                }

                const rect = slide.getBoundingClientRect();
                const stepX = e.clientX - lastClientX;
                lastClientX = e.clientX;

                // 基準範圍（1x）：短片為全片長，長片上限 150 秒；再乘上上下位移倍率
                const baseSpanSec = duration <= 90 ? duration : Math.min(duration * 0.6, 150);
                const deltaStep = (stepX / Math.max(rect.width, 200)) * baseSpanSec * scale;

                scrubTargetTime = Math.max(0, Math.min(duration, scrubTargetTime + deltaStep));
                const actualDelta = scrubTargetTime - scrubStartTime;

                updateScrubHud(scrubTargetTime, duration, actualDelta, scale, scaleLabel);

                const progress = slide.querySelector('.ef-progress');
                const timeText = slide.querySelector('.ef-time-text');
                if (progress) progress.value = String((scrubTargetTime / duration) * 100);
                if (timeText) timeText.textContent = `${formatTime(scrubTargetTime)} / ${formatTime(duration)}`;
            }
        });

        const handlePointerEnd = (e, isCancel = false) => {
            if (!pointerDown || e.pointerId !== activePointerId) return;
            pointerDown = false;

            const wasScrubbing = endScrub(!isCancel);
            activePointerId = null;
            if (wasScrubbing) return;

            const wasLongPress = endLongPress();
            if (wasLongPress || isCancel || moved) return;

            const now = Date.now();
            const tapDelta = now - lastTapTime;

            if (tapDelta > 0 && tapDelta < 240) {
                clearTimeout(singleTapTimer);
                lastTapTime = 0;
                const rect = slide.getBoundingClientRect();
                const ratioX = (e.clientX - rect.left) / Math.max(rect.width, 1);

                if (ratioX < 0.33) {
                    seekSlideVideo(slide, video, -DOUBLE_TAP_SEEK_SEC);
                } else if (ratioX > 0.67) {
                    seekSlideVideo(slide, video, DOUBLE_TAP_SEEK_SEC);
                } else {
                    toggleFavorite(item, true);
                    spawnHeartBurst(slide, e.clientX, e.clientY);
                }
            } else {
                lastTapTime = now;
                clearTimeout(singleTapTimer);
                singleTapTimer = setTimeout(() => {
                    lastTapTime = 0;
                    togglePlaySlide(index);
                }, 240);
            }
        };

        video.addEventListener('pointerup', (e) => handlePointerEnd(e, false));
        video.addEventListener('pointercancel', (e) => handlePointerEnd(e, true));
        video.addEventListener('pointerleave', (e) => {
            if (pointerDown && dragAxis !== 'x' && e.pointerType === 'mouse') {
                pointerDown = false;
                activePointerId = null;
                endLongPress();
            }
        });
    }

    function appendSlideToFeed(item, index) {
        const scroller = document.getElementById('ef-feed-scroller');
        const tail = document.getElementById('ef-feed-tail');
        if (!scroller || !tail) return;

        const slide = document.createElement('div');
        slide.className = 'ef-slide';
        slide.dataset.slideIndex = String(index);
        slide.dataset.videoSrc = item.src;

        const liked = isFavorited(item.src);
        const cleanAuthor = String(item.author || '').replace(/^@+/, '').trim();
        const isCurrentBinge = feedMode === 'author' && cleanAuthor.toLowerCase() === currentBingeAuthor.toLowerCase();

        slide.innerHTML = `
            <video
                playsinline
                webkit-playsinline
                preload="none"
                poster="${escapeHtml(item.poster)}"
                data-src="${escapeHtml(item.src)}"
            ></video>
            <div class="ef-pause-indicator">▶</div>
            <div class="ef-side-actions">
                <div class="ef-action-wrap">
                    <button class="ef-action-btn ef-btn-fav ${liked ? 'is-fav' : ''}" type="button" title="收藏影片 (L)">${liked ? '❤️' : '🤍'}</button>
                    <span class="ef-action-label ef-lbl-fav">${liked ? '已收藏' : '收藏'}</span>
                </div>
                <div class="ef-action-wrap">
                    <button class="ef-action-btn ef-btn-skip-album" type="button" title="跳過本篇剩餘影片，直接看下一篇 (N)">⏭️</button>
                    <span class="ef-action-label">下一篇</span>
                </div>
                <div class="ef-action-wrap">
                    <button class="ef-action-btn ef-btn-block-author" type="button" title="封鎖此作者 (B)">🚫</button>
                    <span class="ef-action-label">封鎖作者</span>
                </div>
                <div class="ef-action-wrap">
                    <button class="ef-action-btn ef-btn-speed" type="button" title="切換倍速 (R)">${formatRateLabel(config.playbackRate)}</button>
                    <span class="ef-action-label">倍速</span>
                </div>
                <div class="ef-action-wrap">
                    <button class="ef-action-btn ef-btn-mute" type="button" title="靜音切換 (M)">${feedMuted ? '🔇' : '🔊'}</button>
                    <span class="ef-action-label ef-lbl-mute">${feedMuted ? '靜音' : '聲音'}</span>
                </div>
                <div class="ef-action-wrap">
                    <button class="ef-action-btn ef-btn-loop" type="button" title="單片循環 / 播完連播">${config.feedAutoNext ? '⏬' : '🔁'}</button>
                    <span class="ef-action-label ef-lbl-loop">${config.feedAutoNext ? '連播' : '循環'}</span>
                </div>
                <div class="ef-action-wrap">
                    <button class="ef-action-btn ef-btn-fit" type="button" title="切換畫面比例">${config.feedCoverMode ? '🔲' : '🖼️'}</button>
                    <span class="ef-action-label ef-lbl-fit">${config.feedCoverMode ? '滿版' : '完整'}</span>
                </div>
                <div class="ef-action-wrap">
                    <a class="ef-action-btn" href="${escapeHtml(item.albumUrl)}" target="_blank" rel="noopener" title="開啟原相簿">🔗</a>
                    <span class="ef-action-label">原相簿</span>
                </div>
            </div>
            <div class="ef-slide-bottom">
                <div class="ef-slide-meta-row">
                    ${cleanAuthor ? `
                        <button class="ef-slide-author-btn" type="button" title="${isCurrentBinge ? '點擊開啟作者主頁' : '點擊快速追刷這位作者的全部豎屏影片'}">
                            <span>@${escapeHtml(cleanAuthor)}</span>
                            <span class="ef-slide-author-tag">${isCurrentBinge ? '主頁 ↗' : '追片 ▸'}</span>
                        </button>
                    ` : ''}
                    <span class="ef-album-pos"></span>
                </div>
                <div class="ef-slide-title">${escapeHtml(item.title)}</div>
                <div class="ef-progress-wrap">
                    <input class="ef-progress" type="range" min="0" max="100" step="0.1" value="0">
                    <span class="ef-time-text">0:00 / 0:00</span>
                </div>
            </div>
        `;

        const video = slide.querySelector('video');
        const progress = slide.querySelector('.ef-progress');
        const timeText = slide.querySelector('.ef-time-text');
        let isSeeking = false;

        attachVideoGestures(slide, video, item, index);

        // 點擊 @作者名 快速追片（若已在該作者追片模式內，改開作者外部主頁）
        const authorBtn = slide.querySelector('.ef-slide-author-btn');
        if (authorBtn) {
            authorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isCurrentBinge) {
                    const url = item.authorUrl || buildAuthorProfileUrl(cleanAuthor);
                    if (url) window.open(url, '_blank', 'noopener');
                } else {
                    openAuthorFeed(cleanAuthor, item.authorUrl, item.src);
                }
            });
        }

        video.addEventListener('ended', () => {
            const list = getActiveFeedList();
            if (config.feedAutoNext && index + 1 < list.length) {
                scrollToSlide(index + 1);
            } else {
                video.currentTime = 0;
                video.playbackRate = config.playbackRate;
                video.play().catch(() => {});
            }
        });

        video.addEventListener('timeupdate', () => {
            if (isSeeking || slide.dataset.efScrubbing === '1' || !video.duration) return;
            progress.value = String((video.currentTime / video.duration) * 100);
            timeText.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
        });

        video.addEventListener('loadedmetadata', () => {
            video.playbackRate = config.playbackRate;
            timeText.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
        });

        video.addEventListener('play', () => {
            slide.classList.remove('paused');
            if (!document.getElementById('ef-speed-pill')?.classList.contains('show')) {
                video.playbackRate = config.playbackRate;
            }
        });
        video.addEventListener('pause', () => slide.classList.add('paused'));

        const stopProp = (e) => e.stopPropagation();
        progress.addEventListener('click', stopProp);
        progress.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            isSeeking = true;
        });
        progress.addEventListener('input', (e) => {
            e.stopPropagation();
            if (video.duration) {
                const target = (Number(progress.value) / 100) * video.duration;
                video.currentTime = target;
                timeText.textContent = `${formatTime(target)} / ${formatTime(video.duration)}`;
            }
        });
        progress.addEventListener('change', (e) => {
            e.stopPropagation();
            isSeeking = false;
        });
        progress.addEventListener('pointerup', (e) => {
            e.stopPropagation();
            isSeeking = false;
        });

        slide.querySelector('.ef-btn-fav').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(item);
        });
        slide.querySelector('.ef-btn-skip-album').addEventListener('click', (e) => {
            e.stopPropagation();
            skipToNextAlbum();
        });
        slide.querySelector('.ef-btn-block-author').addEventListener('click', (e) => {
            e.stopPropagation();
            blockAuthor(cleanAuthor);
        });
        slide.querySelector('.ef-btn-speed').addEventListener('click', (e) => {
            e.stopPropagation();
            cyclePlaybackRate();
        });
        slide.querySelector('.ef-btn-mute').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFeedMute();
        });
        slide.querySelector('.ef-btn-loop').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFeedAutoNext();
        });
        slide.querySelector('.ef-btn-fit').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFeedFitMode();
        });

        scroller.insertBefore(slide, tail);
        slideElements[index] = slide;
        if (feedObserver) feedObserver.observe(slide);

        const activeList = getActiveFeedList();
        if (feedOpen && activeList.length === 1) {
            scrollToSlide(0, 'auto');
            activateSlide(0);
        }
        updateFeedCounter();
        updateFeedTailText();
    }

    function rebuildFeedSlides(targetIndex = 0) {
        const scroller = document.getElementById('ef-feed-scroller');
        if (!scroller) return;

        pendingSkipAlbumUrl = null;
        pauseAllFeedVideos();
        slideElements.forEach((el) => {
            if (el) {
                if (feedObserver) feedObserver.unobserve(el);
                el.remove();
            }
        });
        slideElements = [];

        const list = getActiveFeedList();
        list.forEach((item, idx) => appendSlideToFeed(item, idx));

        updateModeTabLabels();
        updateAuthorBarUI();
        updateFeedCounter();
        updateFeedTailText();

        if (list.length > 0) {
            const clamped = Math.max(0, Math.min(targetIndex, list.length - 1));
            scrollToSlide(clamped, 'auto');
            if (feedOpen) activateSlide(clamped);
        } else {
            activeSlideIndex = 0;
        }
    }

    function switchFeedMode(mode, jumpToIndex = null) {
        if (feedMode === 'explore') exploreLastIndex = activeSlideIndex;
        if (feedMode === 'favorites') favoritesLastIndex = activeSlideIndex;
        if (feedMode === 'author' && mode !== 'author') {
            resetAuthorBingeState();
        }

        feedMode = mode;
        document.getElementById('ef-tab-explore')?.classList.toggle('active', mode === 'explore');
        document.getElementById('ef-tab-fav')?.classList.toggle('active', mode === 'favorites');
        updateAuthorBarUI();

        const targetIdx = jumpToIndex !== null
            ? jumpToIndex
            : (mode === 'favorites' ? favoritesLastIndex : exploreLastIndex);

        rebuildFeedSlides(targetIdx);
    }

    function updateModeTabLabels() {
        const expTab = document.getElementById('ef-tab-explore');
        const favTab = document.getElementById('ef-tab-fav');
        if (expTab) expTab.textContent = `探索 (${feedVideos.length})`;
        if (favTab) favTab.textContent = `❤️ (${favorites.length})`;
    }

    function activateSlide(index) {
        activeSlideIndex = index;
        if (feedMode === 'explore') exploreLastIndex = index;
        else if (feedMode === 'favorites') favoritesLastIndex = index;

        updateFeedCounter();
        updateAlbumPositionBadge(index);

        slideElements.forEach((slide, i) => {
            if (!slide) return;
            const video = slide.querySelector('video');
            if (!video) return;

            const dist = Math.abs(i - index);
            if (dist <= 2) {
                if (!video.getAttribute('src') && video.dataset.src) {
                    video.setAttribute('src', video.dataset.src);
                    video.preload = i === index ? 'auto' : 'metadata';
                }
            } else if (dist > 3 && video.getAttribute('src')) {
                video.pause();
                video.removeAttribute('src');
                video.load();
            }

            if (i !== index && !video.paused) {
                video.pause();
            }
        });

        const currentSlide = slideElements[index];
        if (currentSlide) {
            const video = currentSlide.querySelector('video');
            if (video) {
                video.muted = feedMuted;
                video.playbackRate = config.playbackRate;
                const playPromise = video.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => {
                        feedMuted = true;
                        video.muted = true;
                        syncFeedActionButtons();
                        video.play().catch(() => {});
                    });
                }
            }
        }

        if (feedMode === 'explore' && !IS_ALBUM_PAGE && index >= feedVideos.length - 3 && nextPageUrl && !isLoadingNextPage) {
            loadNextPage(false);
        } else if (feedMode === 'author' && index >= authorVideos.length - 3 && authorNextPageUrl && !authorIsLoadingPage) {
            loadAuthorProfilePage(authorNextPageUrl, authorSessionId);
        }
    }

    function pauseAllFeedVideos() {
        slideElements.forEach((slide) => {
            const v = slide?.querySelector('video');
            if (v && !v.paused) v.pause();
        });
    }

    function togglePlaySlide(index) {
        const slide = slideElements[index];
        const video = slide?.querySelector('video');
        if (!video) return;
        if (video.paused) {
            video.muted = feedMuted;
            video.playbackRate = config.playbackRate;
            video.play().catch(() => {});
        } else {
            video.pause();
        }
    }

    function scrollToSlide(targetIndex, behavior = 'smooth') {
        const scroller = document.getElementById('ef-feed-scroller');
        if (!scroller) return;
        const clamped = Math.max(0, Math.min(targetIndex, slideElements.length));
        const targetEl = clamped < slideElements.length
            ? slideElements[clamped]
            : document.getElementById('ef-feed-tail');
        if (targetEl) {
            targetEl.scrollIntoView({ behavior, block: 'start' });
        }
    }

    function cyclePlaybackRate() {
        const idx = SPEED_STEPS.indexOf(config.playbackRate);
        config.playbackRate = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
        saveConfig();

        const currentVideo = slideElements[activeSlideIndex]?.querySelector('video');
        if (currentVideo) currentVideo.playbackRate = config.playbackRate;

        syncFeedActionButtons();
        showToast(`播放速度：${formatRateLabel(config.playbackRate)}`);
    }

    function toggleFeedMute() {
        feedMuted = !feedMuted;
        const currentVideo = slideElements[activeSlideIndex]?.querySelector('video');
        if (currentVideo) currentVideo.muted = feedMuted;
        syncFeedActionButtons();
    }

    function toggleFeedAutoNext() {
        config.feedAutoNext = !config.feedAutoNext;
        saveConfig();
        syncFeedActionButtons();
        showToast(config.feedAutoNext ? '已切換：播完自動滑下一部' : '已切換：單片循環播放');
    }

    function toggleFeedFitMode() {
        config.feedCoverMode = !config.feedCoverMode;
        saveConfig();
        const overlay = document.getElementById('ef-feed-overlay');
        if (overlay) overlay.classList.toggle('cover-mode', config.feedCoverMode);
        syncFeedActionButtons();
    }

    function syncFavButtons() {
        document.querySelectorAll('.ef-slide[data-video-src]').forEach((slide) => {
            const liked = isFavorited(slide.dataset.videoSrc);
            const btn = slide.querySelector('.ef-btn-fav');
            const lbl = slide.querySelector('.ef-lbl-fav');
            if (btn) {
                btn.textContent = liked ? '❤️' : '🤍';
                btn.classList.toggle('is-fav', liked);
            }
            if (lbl) lbl.textContent = liked ? '已收藏' : '收藏';
        });
    }

    function syncFeedActionButtons() {
        document.querySelectorAll('.ef-btn-speed').forEach((b) => (b.textContent = formatRateLabel(config.playbackRate)));
        document.querySelectorAll('.ef-btn-mute').forEach((b) => (b.textContent = feedMuted ? '🔇' : '🔊'));
        document.querySelectorAll('.ef-lbl-mute').forEach((l) => (l.textContent = feedMuted ? '靜音' : '聲音'));
        document.querySelectorAll('.ef-btn-loop').forEach((b) => (b.textContent = config.feedAutoNext ? '⏬' : '🔁'));
        document.querySelectorAll('.ef-lbl-loop').forEach((l) => (l.textContent = config.feedAutoNext ? '連播' : '循環'));
        document.querySelectorAll('.ef-btn-fit').forEach((b) => (b.textContent = config.feedCoverMode ? '🔲' : '🖼️'));
        document.querySelectorAll('.ef-lbl-fit').forEach((l) => (l.textContent = config.feedCoverMode ? '滿版' : '完整'));
    }

    function updateFeedCounter() {
        const el = document.getElementById('ef-feed-counter');
        if (!el) return;
        const total = getActiveFeedList().length;
        const cur = total > 0 ? Math.min(activeSlideIndex + 1, total) : 0;
        if (feedMode === 'author') {
            const scanning = authorActiveScans + authorScanQueue.length;
            el.textContent = scanning > 0 ? `${cur} / ${total} · 掃描中(${scanning})` : `${cur} / ${total}`;
            return;
        }
        const scanning = activeScans + scanQueue.length;
        el.textContent = (feedMode === 'explore' && scanning > 0)
            ? `${cur} / ${total} · 掃描中(${scanning})`
            : `${cur} / ${total}`;
        scheduleRefreshGridDrawer();
    }

    function updateFeedTailText() {
        const msg = document.getElementById('ef-feed-tail-msg');
        const btn = document.getElementById('ef-feed-tail-btn');
        if (!msg || !btn) return;

        if (feedMode === 'favorites') {
            if (favorites.length === 0) {
                msg.textContent = '目前還沒有收藏任何影片（在探索模式雙擊畫面中央或點 ❤️ 即可收藏）';
            } else {
                msg.textContent = `已看完所有收藏（共 ${favorites.length} 部）`;
            }
            btn.textContent = '回到探索模式';
            btn.style.display = 'inline-block';
            return;
        }

        if (feedMode === 'author') {
            const scanning = authorActiveScans + authorScanQueue.length;
            if (authorIsLoadingPage) {
                msg.textContent = `⏳ 正在載入 @${currentBingeAuthor} 的相簿清單...`;
                btn.style.display = 'none';
            } else if (scanning > 0) {
                msg.textContent = `🔍 正在掃描 @${currentBingeAuthor} 的豎屏影片（剩餘 ${scanning} 篇）...`;
                btn.style.display = 'none';
            } else if (authorNextPageUrl) {
                msg.textContent = `已看完 @${currentBingeAuthor} 本頁的豎屏影片`;
                btn.textContent = '載入該作者下一頁';
                btn.style.display = 'inline-block';
            } else {
                msg.textContent = authorVideos.length > 0
                    ? `已看完 @${currentBingeAuthor} 全部豎屏影片（共 ${authorVideos.length} 部）`
                    : `沒有在 @${currentBingeAuthor} 主頁找到其他豎屏影片`;
                btn.textContent = '返回探索模式';
                btn.style.display = 'inline-block';
            }
            return;
        }

        const scanning = activeScans + scanQueue.length;
        if (isLoadingNextPage) {
            msg.textContent = `⏳ 正在載入第 ${currentPageCount + 1} 頁並搜尋豎屏影片...`;
            btn.style.display = 'none';
        } else if (scanning > 0) {
            msg.textContent = `🔍 正在背景掃描豎屏影片（剩餘 ${scanning} 個相簿）...`;
            btn.style.display = 'none';
        } else if (!IS_ALBUM_PAGE && nextPageUrl) {
            msg.textContent = '目前頁面豎屏影片已看完了';
            btn.textContent = '載入下一頁影片';
            btn.style.display = 'inline-block';
        } else {
            msg.textContent = feedVideos.length > 0 ? '已經到底囉，沒有更多豎屏影片了' : '此頁面沒有偵測到豎屏影片';
            btn.style.display = 'none';
        }
    }

    function openFeedMode(mode = 'explore', startIndex = null) {
        stopCardPreview();
        if (pickerActive) stopElementPicker();
        createFeedOverlay();
        const overlay = document.getElementById('ef-feed-overlay');
        if (!overlay) return;

        document.querySelectorAll('video').forEach((v) => {
            if (!overlay.contains(v) && !v.paused) v.pause();
        });

        feedOpen = true;
        overlay.classList.add('open');
        document.documentElement.classList.add('ef-feed-open');
        document.body.classList.add('ef-feed-open');
        syncFullscreenButton();

        switchFeedMode(mode, startIndex);

        if (mode === 'explore' && feedVideos.length === 0 && !IS_ALBUM_PAGE && nextPageUrl && activeScans === 0 && scanQueue.length === 0) {
            loadNextPage(false);
        }
    }

    function closeFeedMode() {
        closeGridDrawer();
        feedOpen = false;
        pendingSkipAlbumUrl = null;
        pauseAllFeedVideos();

        if (feedMode === 'author') {
            resetAuthorBingeState();
            feedMode = 'explore';
        }

        if (getFullscreenElement()) {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            if (typeof exit === 'function') Promise.resolve(exit.call(document)).catch(() => {});
        }
        if (feedFocusMode) setFocusMode(false, false);

        const overlay = document.getElementById('ef-feed-overlay');
        if (overlay) overlay.classList.remove('open');
        document.documentElement.classList.remove('ef-feed-open');
        document.body.classList.remove('ef-feed-open');
        restoreScroll();
    }

    // ==================== 14.5 抖音模式九宮格縮圖抽屜 ====================
    let gridDrawerStyleInjected = false;
    let gridDrawerRefreshTimer = null;

    function ensureGridDrawer() {
        const overlay = document.getElementById('ef-feed-overlay');
        if (!overlay) return null;

        if (!gridDrawerStyleInjected) {
            gridDrawerStyleInjected = true;
            injectStyle(`
                #ef-grid-drawer {
                    position: absolute;
                    inset: 0;
                    z-index: 45;
                    background: rgba(0, 0, 0, 0.58);
                    backdrop-filter: blur(4px);
                    -webkit-backdrop-filter: blur(4px);
                    display: none;
                    flex-direction: column;
                    justify-content: flex-end;
                    align-items: center;
                }
                #ef-grid-drawer.open {
                    display: flex;
                }
                #ef-grid-sheet {
                    width: 100%;
                    max-width: 640px;
                    height: 76%;
                    max-height: 82vh;
                    background: rgba(18, 18, 24, 0.96);
                    border-top: 1px solid rgba(255, 255, 255, 0.16);
                    border-left: 1px solid rgba(255, 255, 255, 0.08);
                    border-right: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 18px 18px 0 0;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    box-shadow: 0 -12px 36px rgba(0, 0, 0, 0.65);
                    animation: efDrawerUp 0.18s ease-out;
                }
                @keyframes efDrawerUp {
                    from { transform: translateY(28px); opacity: 0.7; }
                    to { transform: translateY(0); opacity: 1; }
                }
                #ef-grid-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    padding: 12px 14px;
                    background: rgba(255, 255, 255, 0.04);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }
                #ef-grid-title {
                    font-size: 14px;
                    font-weight: 700;
                    color: #f9fafb;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .ef-grid-head-actions {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    flex-shrink: 0;
                }
                #ef-grid-body {
                    flex: 1;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                    overscroll-behavior: contain;
                    padding: 10px 10px calc(18px + env(safe-area-inset-bottom, 0px));
                }
                #ef-grid-list {
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 7px;
                }
                .ef-grid-item {
                    position: relative;
                    aspect-ratio: 9 / 14;
                    border-radius: 9px;
                    overflow: hidden;
                    background: #111116;
                    border: 1.5px solid rgba(255, 255, 255, 0.1);
                    cursor: pointer;
                    padding: 0;
                    text-align: left;
                }
                .ef-grid-item.is-active {
                    border: 2px solid #eb6395;
                    box-shadow: 0 0 0 2px rgba(235, 99, 149, 0.35);
                }
                .ef-grid-item img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                    background: #0b0b0f;
                }
                .ef-grid-placeholder {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 24px;
                    color: rgba(255, 255, 255, 0.35);
                }
                .ef-grid-num {
                    position: absolute;
                    top: 5px;
                    left: 5px;
                    padding: 1px 6px;
                    border-radius: 999px;
                    font-size: 10px;
                    font-weight: 700;
                    color: #fff;
                    background: rgba(0, 0, 0, 0.65);
                    backdrop-filter: blur(4px);
                }
                .ef-grid-item.is-active .ef-grid-num {
                    background: #eb6395;
                }
                .ef-grid-fav {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    font-size: 12px;
                    filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.9));
                }
                .ef-grid-playing {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    padding: 3px 8px;
                    border-radius: 999px;
                    font-size: 10px;
                    font-weight: 700;
                    color: #fff;
                    background: rgba(235, 99, 149, 0.9);
                    white-space: nowrap;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
                }
                .ef-grid-caption {
                    position: absolute;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    padding: 18px 6px 5px;
                    background: linear-gradient(to top, rgba(0, 0, 0, 0.88), transparent);
                    font-size: 10px;
                    color: rgba(255, 255, 255, 0.92);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                #ef-grid-footer {
                    margin-top: 12px;
                    text-align: center;
                }
            `);
        }

        let drawer = document.getElementById('ef-grid-drawer');
        if (!drawer) {
            drawer = document.createElement('div');
            drawer.id = 'ef-grid-drawer';
            drawer.innerHTML = `
                <div id="ef-grid-sheet">
                    <div id="ef-grid-head">
                        <span id="ef-grid-title">⊞ 影片總覽</span>
                        <div class="ef-grid-head-actions">
                            <button id="ef-grid-locate" class="ef-small-btn" type="button">📍 目前位置</button>
                            <button id="ef-grid-close" class="ef-small-btn" type="button">✕</button>
                        </div>
                    </div>
                    <div id="ef-grid-body">
                        <div id="ef-grid-list"></div>
                        <div id="ef-grid-footer"></div>
                    </div>
                </div>
            `;
            overlay.appendChild(drawer);

            drawer.addEventListener('click', (e) => {
                if (e.target === drawer) closeGridDrawer();
            });
            drawer.querySelector('#ef-grid-close').addEventListener('click', closeGridDrawer);
            drawer.querySelector('#ef-grid-locate').addEventListener('click', () => {
                scrollActiveGridItemIntoView('smooth');
            });
        }
        return drawer;
    }

    function isGridDrawerOpen() {
        return !!document.getElementById('ef-grid-drawer')?.classList.contains('open');
    }

    function scrollActiveGridItemIntoView(behavior = 'auto') {
        const activeCell = document.querySelector('#ef-grid-list .ef-grid-item.is-active');
        if (activeCell) {
            activeCell.scrollIntoView({ behavior, block: 'center' });
        }
    }

    function renderGridDrawer() {
        const drawer = ensureGridDrawer();
        if (!drawer) return;

        const titleEl = drawer.querySelector('#ef-grid-title');
        const listEl = drawer.querySelector('#ef-grid-list');
        const footerEl = drawer.querySelector('#ef-grid-footer');
        const list = getActiveFeedList();

        const modeName = feedMode === 'favorites'
            ? '❤️ 收藏總覽'
            : feedMode === 'author'
                ? `👤 @${currentBingeAuthor} 總覽`
                : '⊞ 探索總覽';

        const scanning = feedMode === 'author'
            ? (authorActiveScans + authorScanQueue.length)
            : (feedMode === 'explore' ? (activeScans + scanQueue.length) : 0);

        if (titleEl) {
            titleEl.textContent = scanning > 0
                ? `${modeName} (${list.length} 部 · 掃描中 ${scanning})`
                : `${modeName} (${list.length} 部)`;
        }

        listEl.innerHTML = '';
        if (list.length === 0) {
            listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#9ca3af;padding:40px 12px;font-size:13px;">目前尚無可顯示的豎屏影片</div>`;
        } else {
            const frag = document.createDocumentFragment();
            list.forEach((item, idx) => {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = `ef-grid-item${idx === activeSlideIndex ? ' is-active' : ''}`;
                const caption = item.author ? `@${item.author} · ${item.title}` : (item.title || 'Erome 影片');
                const liked = isFavorited(item.src);

                cell.innerHTML = `
                    ${item.poster
                        ? `<img src="${escapeHtml(item.poster)}" alt="" loading="lazy">`
                        : `<div class="ef-grid-placeholder">🎬</div>`}
                    <span class="ef-grid-num">#${idx + 1}</span>
                    ${liked ? `<span class="ef-grid-fav">❤️</span>` : ''}
                    ${idx === activeSlideIndex ? `<span class="ef-grid-playing">▶ 播放中</span>` : ''}
                    <div class="ef-grid-caption">${escapeHtml(caption)}</div>
                `;

                cell.addEventListener('click', () => {
                    closeGridDrawer();
                    scrollToSlide(idx, 'auto');
                    activateSlide(idx);
                });
                frag.appendChild(cell);
            });
            listEl.appendChild(frag);
        }

        // 底部載入更多按鈕（探索／作者追片模式）
        footerEl.innerHTML = '';
        if (feedMode === 'explore' && !IS_ALBUM_PAGE && nextPageUrl) {
            const moreBtn = document.createElement('button');
            moreBtn.type = 'button';
            moreBtn.className = 'ef-small-btn primary';
            moreBtn.disabled = isLoadingNextPage;
            moreBtn.textContent = isLoadingNextPage ? '⏳ 載入下一頁中...' : `➕ 載入第 ${currentPageCount + 1} 頁更多影片`;
            moreBtn.addEventListener('click', () => loadNextPage(true));
            footerEl.appendChild(moreBtn);
        } else if (feedMode === 'author' && authorNextPageUrl) {
            const moreBtn = document.createElement('button');
            moreBtn.type = 'button';
            moreBtn.className = 'ef-small-btn primary';
            moreBtn.disabled = authorIsLoadingPage;
            moreBtn.textContent = authorIsLoadingPage ? '⏳ 載入中...' : '➕ 載入該作者下一頁';
            moreBtn.addEventListener('click', () => loadAuthorProfilePage(authorNextPageUrl, authorSessionId));
            footerEl.appendChild(moreBtn);
        }
    }

    function openGridDrawer() {
        if (!feedOpen) return;
        const drawer = ensureGridDrawer();
        if (!drawer) return;
        renderGridDrawer();
        drawer.classList.add('open');
        document.getElementById('ef-feed-grid-btn')?.classList.add('active');
        requestAnimationFrame(() => scrollActiveGridItemIntoView('auto'));
    }

    function closeGridDrawer() {
        document.getElementById('ef-grid-drawer')?.classList.remove('open');
        document.getElementById('ef-feed-grid-btn')?.classList.remove('active');
    }

    function toggleGridDrawer() {
        if (isGridDrawerOpen()) closeGridDrawer();
        else openGridDrawer();
    }

    function scheduleRefreshGridDrawer() {
        if (!isGridDrawerOpen()) return;
        clearTimeout(gridDrawerRefreshTimer);
        gridDrawerRefreshTimer = setTimeout(() => {
            if (isGridDrawerOpen()) renderGridDrawer();
        }, 250);
    }

    // ==================== 15. 全設定一鍵完整備份／還原 + 收藏管理 ====================
    function downloadJsonFile(payload, filename) {
        const jsonStr = JSON.stringify(payload, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.dataset.efAllowClick = '1';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
        }, 1000);
    }

    function exportFullBackupJson() {
        const payload = {
            app: 'erome-vertical-script',
            type: 'full-backup',
            version: '4.1.0',
            exportedAt: new Date().toISOString(),
            config: { ...config },
            favorites,
            blockedAuthors,
            blockedKeywords,
            customHiddenSelectors,
        };
        const dateTag = new Date().toISOString().slice(0, 10);
        downloadJsonFile(payload, `erome-full-backup-${dateTag}.json`);
        showToast(
            `💾 完整備份已下載（收藏 ${favorites.length} / 黑名單 ${blockedAuthors.length + blockedKeywords.length} / 隱藏規則 ${customHiddenSelectors.length}）`
        );
    }

    function exportFavoritesJson() {
        if (favorites.length === 0) {
            showToast('收藏清單目前是空的，無資料可匯出');
            return;
        }
        const payload = {
            app: 'erome-vertical-script',
            type: 'favorites-only',
            version: '4.1.0',
            exportedAt: new Date().toISOString(),
            count: favorites.length,
            favorites,
        };
        const dateTag = new Date().toISOString().slice(0, 10);
        downloadJsonFile(payload, `erome-favorites-${dateTag}.json`);
        showToast(`💾 已匯出 ${favorites.length} 筆收藏（JSON）`);
    }

    function syncControlPanelInputs() {
        const coverSel = document.getElementById('ef-sel-cover-shape');
        if (coverSel) coverSel.value = config.coverShape || 'portrait';
        const sizeSlider = document.getElementById('ef-rng-cover-size');
        const sizeLabel = document.getElementById('ef-size-label');
        const sizeReset = document.getElementById('ef-size-reset');
        const m = getCoverLayoutMetrics(config.coverSize);
        if (sizeSlider) sizeSlider.value = String(m.active ? m.size : 50);
        if (sizeLabel) sizeLabel.textContent = m.active ? `${m.size}% · ${m.cols}欄` : '原樣';
        if (sizeReset) sizeReset.style.display = m.active ? 'inline-block' : 'none';

        syncRootFeatureClasses();

        const setChk = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };
        setChk('ef-chk-adblock', config.blockAds);
        setChk('ef-chk-suggested', config.hideSuggestedUsers);
        setChk('ef-chk-clean-card', config.cleanCardUi);
        setChk('ef-chk-vertical', config.onlyVertical);
        setChk('ef-chk-photos', config.hidePhotos);
        setChk('ef-chk-infinite', config.autoNextPage);
        setChk('ef-chk-deep', config.deepScan);

        const panel = document.getElementById('ef-panel');
        const toggleIcon = document.getElementById('ef-toggle-icon');
        if (panel) panel.classList.toggle('collapsed', !!config.panelCollapsed);
        if (toggleIcon) toggleIcon.textContent = config.panelCollapsed ? '＋' : '－';

        const overlay = document.getElementById('ef-feed-overlay');
        if (overlay) overlay.classList.toggle('cover-mode', !!config.feedCoverMode);
    }

    function importJsonBackupOrFavorites(rawText) {
        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch (_) {
            showToast('❌ JSON 格式錯誤，請確認檔案內容');
            return;
        }

        const isArrayOnly = Array.isArray(parsed);
        const isObj = parsed && typeof parsed === 'object' && !isArrayOnly;
        if (!isArrayOnly && !isObj) {
            showToast('❌ 無法辨識的備份檔格式');
            return;
        }

        let favAdded = 0;
        let blAdded = 0;
        let ruleAdded = 0;
        let configRestored = false;

        // 1) 還原偏好設定
        if (isObj && parsed.config && typeof parsed.config === 'object') {
            const boolKeys = [
                'blockAds',
                'hideSuggestedUsers',
                'onlyVertical',
                'hidePhotos',
                'autoNextPage',
                'deepScan',
                'panelCollapsed',
                'feedAutoNext',
                'feedCoverMode',
                'cleanCardUi',
            ];

            boolKeys.forEach((k) => {
                if (typeof parsed.config[k] === 'boolean') {
                    config[k] = parsed.config[k];
                    configRestored = true;
                }
            });
            const rate = Number(parsed.config.playbackRate);
            if (Number.isFinite(rate) && rate >= 0.25 && rate <= 4.0) {
                config.playbackRate = rate;
                configRestored = true;
            }
            if (['portrait', 'tall', 'landscape', 'original'].includes(parsed.config.coverShape)) {
                config.coverShape = parsed.config.coverShape;
                configRestored = true;
            }
            const cSize = Number(parsed.config.coverSize);
            if (cSize === 0 || (Number.isFinite(cSize) && cSize >= 18 && cSize <= 50)) {
                config.coverSize = Math.round(cSize);
                configRestored = true;
            }
            if (configRestored) saveConfig();
        }

        // 2) 合併匯入收藏清單（相容舊版僅收藏 JSON 與純陣列）
        const favList = isArrayOnly ? parsed : (Array.isArray(parsed.favorites) ? parsed.favorites : null);
        if (favList) {
            const newlyAdded = [];
            for (const raw of favList) {
                if (!raw || typeof raw.src !== 'string' || !/^https?:\/\//i.test(raw.src.trim())) continue;
                const cleanSrc = raw.src.trim();
                if (favSrcSet.has(cleanSrc)) continue;
                favSrcSet.add(cleanSrc);
                const cleanAuthor = typeof raw.author === 'string' ? raw.author.replace(/^@+/, '').trim() : '';
                newlyAdded.push({
                    src: cleanSrc,
                    poster: typeof raw.poster === 'string' ? raw.poster : '',
                    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Erome 影片',
                    author: cleanAuthor,
                    authorUrl: typeof raw.authorUrl === 'string' && /^https?:\/\//i.test(raw.authorUrl)
                        ? raw.authorUrl
                        : buildAuthorProfileUrl(cleanAuthor),
                    albumUrl: typeof raw.albumUrl === 'string' && /^https?:\/\//i.test(raw.albumUrl)
                        ? raw.albumUrl
                        : 'https://www.erome.com/',
                    savedAt: Number(raw.savedAt) || Date.now(),
                });
                favAdded++;
            }
            if (newlyAdded.length > 0) {
                favorites = [...newlyAdded, ...favorites];
                saveFavorites();
            }
        }

        // 3) 合併匯入封鎖作者與標題關鍵字
        if (isObj && Array.isArray(parsed.blockedAuthors)) {
            for (const raw of parsed.blockedAuthors) {
                const clean = String(raw || '').replace(/^@+/, '').trim();
                if (clean && !blockedAuthorLowerSet.has(clean.toLowerCase())) {
                    blockedAuthors.push(clean);
                    blockedAuthorLowerSet.add(clean.toLowerCase());
                    blAdded++;
                }
            }
        }
        if (isObj && Array.isArray(parsed.blockedKeywords)) {
            for (const raw of parsed.blockedKeywords) {
                const clean = String(raw || '').trim();
                if (clean && !blockedKeywordLowerList.includes(clean.toLowerCase())) {
                    blockedKeywords.push(clean);
                    blockedKeywordLowerList.push(clean.toLowerCase());
                    blAdded++;
                }
            }
        }
        if (blAdded > 0) saveBlocklists();

        // 4) 合併匯入自訂點選隱藏規則
        if (isObj && Array.isArray(parsed.customHiddenSelectors)) {
            for (const raw of parsed.customHiddenSelectors) {
                const sel = String(raw || '').trim();
                if (!sel || customHiddenSelectors.includes(sel)) continue;
                try {
                    document.createDocumentFragment().querySelector(sel);
                    customHiddenSelectors.push(sel);
                    ruleAdded++;
                } catch (_) {}
            }
            if (ruleAdded > 0) saveCustomHiddenSelectors();
        }

        // 5) 即時套用到所有 UI 與過濾邏輯
        syncControlPanelInputs();
        applyCustomHiddenStyles();
        processSuggestedUsers();
        cleanAds();
        syncBlocklistEffects();
        applyAllFilters();
        syncFavButtons();
        syncFeedActionButtons();
        updateModeTabLabels();
        updateStats();
        if (document.getElementById('ef-fav-modal')?.classList.contains('open')) renderFavManagerList();
        if (document.getElementById('ef-blacklist-modal')?.classList.contains('open')) renderBlacklistModal();
        if (document.getElementById('ef-hidden-rules-modal')?.classList.contains('open')) renderHiddenRulesList();
        if (feedOpen && feedMode === 'favorites' && favAdded > 0) rebuildFeedSlides(0);

        const summaryParts = [];
        if (configRestored) summaryParts.push('設定已套用');
        if (favAdded > 0) summaryParts.push(`收藏 +${favAdded}`);
        if (blAdded > 0) summaryParts.push(`黑名單 +${blAdded}`);
        if (ruleAdded > 0) summaryParts.push(`隱藏規則 +${ruleAdded}`);

        if (summaryParts.length > 0) {
            showToast(`✅ 還原完成：${summaryParts.join('、')}`);
        } else {
            showToast('ℹ️ 檔案內容皆已存在，無新增項目');
        }
    }

    function triggerJsonImportPicker() {
        let input = document.getElementById('ef-global-import-input');
        if (!input) {
            input = document.createElement('input');
            input.id = 'ef-global-import-input';
            input.type = 'file';
            input.accept = '.json,application/json';
            input.style.display = 'none';
            input.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => importJsonBackupOrFavorites(String(reader.result || ''));
                reader.onerror = () => showToast('❌ 讀取檔案失敗');
                reader.readAsText(file, 'utf-8');
            });
            document.body.appendChild(input);
        }
        input.value = '';
        input.click();
    }

    function createFavManagerModal() {
        if (document.getElementById('ef-fav-modal') || !document.body) return;

        const modal = document.createElement('div');
        modal.id = 'ef-fav-modal';
        modal.className = 'ef-modal-backdrop';
        modal.innerHTML = `
            <div class="ef-modal-card">
                <div class="ef-modal-head">
                    <span id="ef-fav-modal-title">❤️ 我的收藏清單</span>
                    <button id="ef-fav-close-btn" class="ef-small-btn" type="button">✕ 關閉</button>
                </div>
                <div class="ef-modal-tools">
                    <button id="ef-fav-play-all" class="ef-small-btn primary" type="button">🎬 抖音播放</button>
                    <button id="ef-fav-export-json" class="ef-small-btn" type="button">💾 匯出收藏</button>
                    <button id="ef-fav-import-json" class="ef-small-btn" type="button">📥 匯入 JSON</button>
                    <button id="ef-fav-copy-links" class="ef-small-btn" type="button">📋 複製連結</button>
                    <button id="ef-fav-clear-all" class="ef-small-btn danger" type="button">🗑️ 清空</button>
                </div>
                <div id="ef-fav-list" class="ef-modal-body"></div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeFavManager();
        });
        modal.querySelector('#ef-fav-close-btn').addEventListener('click', closeFavManager);
        modal.querySelector('#ef-fav-play-all').addEventListener('click', () => {
            closeFavManager();
            openFeedMode('favorites', 0);
        });
        modal.querySelector('#ef-fav-export-json').addEventListener('click', exportFavoritesJson);
        modal.querySelector('#ef-fav-import-json').addEventListener('click', triggerJsonImportPicker);

        modal.querySelector('#ef-fav-copy-links').addEventListener('click', () => {
            if (favorites.length === 0) {
                showToast('收藏清單目前是空的');
                return;
            }
            const uniqueAlbums = Array.from(new Set(favorites.map((f) => f.albumUrl).filter(Boolean)));
            const text = uniqueAlbums.join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(
                    () => showToast(`已複製 ${uniqueAlbums.length} 筆相簿連結`),
                    () => fallbackCopy(text, uniqueAlbums.length)
                );
            } else {
                fallbackCopy(text, uniqueAlbums.length);
            }
        });

        modal.querySelector('#ef-fav-clear-all').addEventListener('click', () => {
            if (favorites.length === 0) return;
            if (!window.confirm(`確定要清空全部 ${favorites.length} 部收藏影片嗎？`)) return;
            favorites = [];
            favSrcSet.clear();
            saveFavorites();
            syncFavButtons();
            updateStats();
            updateModeTabLabels();
            renderFavManagerList();
            if (feedOpen && feedMode === 'favorites') rebuildFeedSlides(0);
            showToast('已清空所有收藏');
        });
    }

    function fallbackCopy(text, count) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        (getFullscreenElement() || document.body).appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast(`已複製 ${count} 筆相簿連結`);
        } catch (_) {
            showToast('複製失敗，請手動開啟相簿');
        }
        ta.remove();
    }

    function renderFavManagerList() {
        const listEl = document.getElementById('ef-fav-list');
        const titleEl = document.getElementById('ef-fav-modal-title');
        if (!listEl) return;

        if (titleEl) titleEl.textContent = `❤️ 我的收藏清單 (${favorites.length})`;

        if (favorites.length === 0) {
            listEl.innerHTML = `<div style="text-align:center;color:#9ca3af;padding:36px 12px;">還沒有收藏影片喔！<br>在抖音模式點右側 ❤️ 或雙擊畫面中央即可收藏，或點上方「匯入 JSON」還原備份。</div>`;
            return;
        }

        listEl.innerHTML = '';
        favorites.forEach((item, idx) => {
            const row = document.createElement('div');
            row.className = 'ef-fav-item';
            const dateStr = item.savedAt ? new Date(item.savedAt).toLocaleDateString() : '';
            row.innerHTML = `
                <img class="ef-fav-thumb" src="${escapeHtml(item.poster)}" alt="" loading="lazy">
                <div class="ef-fav-info">
                    <div class="ef-fav-title">${escapeHtml(item.title)}</div>
                    <div class="ef-fav-meta">${item.author ? `@${escapeHtml(item.author)} · ` : ''}${escapeHtml(dateStr)}</div>
                </div>
                <div class="ef-fav-item-actions">
                    <a class="ef-small-btn" href="${escapeHtml(item.albumUrl)}" target="_blank" rel="noopener" style="text-decoration:none;">🔗</a>
                    <button class="ef-small-btn danger ef-fav-del" type="button">✕</button>
                </div>
            `;

            const jumpPlay = () => {
                closeFavManager();
                openFeedMode('favorites', idx);
            };
            row.querySelector('.ef-fav-thumb').addEventListener('click', jumpPlay);
            row.querySelector('.ef-fav-info').addEventListener('click', jumpPlay);
            row.querySelector('.ef-fav-del').addEventListener('click', () => {
                toggleFavorite(item);
                if (feedOpen && feedMode === 'favorites') {
                    rebuildFeedSlides(Math.min(activeSlideIndex, Math.max(0, favorites.length - 1)));
                }
            });
            listEl.appendChild(row);
        });
    }

    function openFavManager() {
        createFavManagerModal();
        const modal = document.getElementById('ef-fav-modal');
        const host = getFullscreenElement() || document.body;
        if (modal && host && modal.parentElement !== host) {
            host.appendChild(modal);
        }
        renderFavManagerList();
        modal?.classList.add('open');
    }

    function closeFavManager() {
        document.getElementById('ef-fav-modal')?.classList.remove('open');
    }

    // ==================== 16. 顯示控制與浮動面板 ====================
    function applyElementVisibility(el) {
        const type = el.dataset.efType;
        let shouldHide = el.dataset.efBlocked === '1';

        if (!shouldHide && config.onlyVertical) {
            if (type === 'horizontal' || type === 'pending') shouldHide = true;
            if (type === 'photo' && config.hidePhotos) shouldHide = true;
        }
        el.classList.toggle('ef-hidden', shouldHide);

        if (!config.onlyVertical) {
            const badge = el.querySelector('.ef-badge.ef-scanning');
            if (badge) badge.remove();
        }
    }

    function applyAllFilters() {
        document.querySelectorAll('[data-ef-processed]').forEach(applyElementVisibility);
        updateStats();
        updatePageDividers();
    }

    function updateStats(extraNote = '') {
        const statsEl = document.getElementById('ef-stats');
        const feedBtn = document.getElementById('ef-open-feed-btn');
        const favBtn = document.getElementById('ef-open-fav-btn');
        const blBtn = document.getElementById('ef-open-bl-btn');
        const hrBtn = document.getElementById('ef-open-hr-btn');

        const blTotal = blockedAuthors.length + blockedKeywords.length;
        if (feedBtn) feedBtn.textContent = `🎬 抖音滑動模式 (${feedVideos.length})`;
        if (favBtn) favBtn.textContent = `❤️ 收藏 (${favorites.length})`;
        if (blBtn) blBtn.textContent = `🚫 黑名單 (${blTotal})`;
        if (hrBtn) hrBtn.textContent = `管理 (${customHiddenSelectors.length})`;
        updateFeedCounter();

        if (!statsEl) return;
        const all = document.querySelectorAll('[data-ef-processed]');
        let hidden = 0;
        all.forEach((el) => {
            if (el.classList.contains('ef-hidden')) hidden++;
        });

        const scanningCount = activeScans + scanQueue.length;
        let text = `豎屏影片: ${feedVideos.length} 部 ｜ 已隱藏: ${hidden}`;
        if (!IS_ALBUM_PAGE) {
            text += `\n已載入頁數: 第 ${currentPageCount} 頁`;
            if (scanningCount > 0) text += ` ｜ 掃描中: ${scanningCount}`;
        }
        if (config.blockAds) {
            text += `\n已攔截廣告: ${adsBlockedCount}`;
        }
        if (extraNote) text += `\n狀態: ${extraNote}`;
        statsEl.textContent = text;
    }

    function createControlPanel() {
        if (document.getElementById('ef-panel') || !document.body) return;

        const panel = document.createElement('div');
        panel.id = 'ef-panel';
        if (config.panelCollapsed) panel.classList.add('collapsed');

        const blTotal = blockedAuthors.length + blockedKeywords.length;
        panel.innerHTML = `
            <div id="ef-header" title="點擊展開或收合">
                <span>📱 豎屏工具</span>
                <span id="ef-toggle-icon">${config.panelCollapsed ? '＋' : '－'}</span>
            </div>
            <div id="ef-body">
                <button id="ef-open-feed-btn" class="ef-panel-btn" type="button">🎬 抖音滑動模式 (0)</button>
                <div class="ef-btn-grid">
                    <button id="ef-open-fav-btn" class="ef-panel-btn ef-panel-subbtn" type="button">❤️ 收藏 (${favorites.length})</button>
                    <button id="ef-open-bl-btn" class="ef-panel-btn ef-panel-subbtn" type="button">🚫 黑名單 (${blTotal})</button>
                </div>
                <div class="ef-btn-split">
                    <button id="ef-start-picker-btn" class="ef-panel-btn ef-panel-subbtn" type="button">🎯 點選隱藏元件</button>
                    <button id="ef-open-hr-btn" class="ef-panel-btn ef-panel-subbtn" type="button">管理 (${customHiddenSelectors.length})</button>
                </div>
                <div class="ef-btn-grid">
                    <button id="ef-full-backup-btn" class="ef-panel-btn ef-panel-subbtn" type="button" title="打包備份所有開關、收藏、黑名單與隱藏規則">💾 完整備份</button>
                    <button id="ef-full-restore-btn" class="ef-panel-btn ef-panel-subbtn" type="button" title="匯入備份檔還原設定與資料（亦相容舊版收藏 JSON）">📥 還原備份</button>
                </div>
                <label class="ef-row">
                    <span>去除網站廣告</span>
                    <input type="checkbox" id="ef-chk-adblock" ${config.blockAds ? 'checked' : ''}>
                </label>
                <label class="ef-row">
                    <span>隱藏 Suggested users</span>
                    <input type="checkbox" id="ef-chk-suggested" ${config.hideSuggestedUsers ? 'checked' : ''}>
                </label>
                ${!IS_ALBUM_PAGE ? `
                <label class="ef-row">
                    <span>精簡封面與標題</span>
                    <input type="checkbox" id="ef-chk-clean-card" ${config.cleanCardUi ? 'checked' : ''}>
                </label>` : ''}
                <label class="ef-row">
                    <span>只看豎屏影片</span>
                    <input type="checkbox" id="ef-chk-vertical" ${config.onlyVertical ? 'checked' : ''}>
                </label>
                ${!IS_ALBUM_PAGE ? `
                <label class="ef-row">
                    <span>封面比例</span>
                    <select id="ef-sel-cover-shape" class="ef-select">
                        <option value="portrait" ${config.coverShape === 'portrait' ? 'selected' : ''}>直式長方 (2:3)</option>
                        <option value="tall" ${config.coverShape === 'tall' ? 'selected' : ''}>滿屏直式 (9:16)</option>
                        <option value="landscape" ${config.coverShape === 'landscape' ? 'selected' : ''}>橫式長方 (16:9)</option>
                        <option value="original" ${config.coverShape === 'original' ? 'selected' : ''}>網站原樣</option>
                    </select>
                </label>
                <div class="ef-size-control">
                    <div class="ef-size-head">
                        <span>封面大小</span>
                        <div class="ef-size-head-right">
                            <span id="ef-size-label"></span>
                            <button id="ef-size-reset" class="ef-reset-mini" type="button">原樣</button>
                        </div>
                    </div>
                    <div class="ef-size-slider-row">
                        <span>小</span>
                        <input id="ef-rng-cover-size" type="range" min="18" max="50" step="1" value="${config.coverSize >= 18 && config.coverSize <= 50 ? config.coverSize : 50}">
                        <span>大</span>
                    </div>
                </div>` : ''}
                <label class="ef-row">
                    <span>隱藏純圖片</span>
                    <input type="checkbox" id="ef-chk-photos" ${config.hidePhotos ? 'checked' : ''}>
                </label>
                ${!IS_ALBUM_PAGE ? `
                <label class="ef-row">
                    <span>滑至網站底接下頁</span>
                    <input type="checkbox" id="ef-chk-infinite" ${config.autoNextPage ? 'checked' : ''}>
                </label>
                <label class="ef-row">
                    <span>列表深度掃描</span>
                    <input type="checkbox" id="ef-chk-deep" ${config.deepScan ? 'checked' : ''}>
                </label>` : ''}
                <div id="ef-stats">初始化中...</div>
            </div>
        `;

        document.body.appendChild(panel);

        panel.querySelector('#ef-header').addEventListener('click', () => {
            config.panelCollapsed = !config.panelCollapsed;
            panel.classList.toggle('collapsed', config.panelCollapsed);
            panel.querySelector('#ef-toggle-icon').textContent = config.panelCollapsed ? '＋' : '－';
            saveConfig();
        });

        panel.querySelector('#ef-open-feed-btn').addEventListener('click', () => openFeedMode('explore'));
        panel.querySelector('#ef-open-fav-btn').addEventListener('click', openFavManager);
        panel.querySelector('#ef-open-bl-btn').addEventListener('click', openBlacklistModal);
        panel.querySelector('#ef-start-picker-btn').addEventListener('click', startElementPicker);
        panel.querySelector('#ef-open-hr-btn').addEventListener('click', openHiddenRulesModal);
        panel.querySelector('#ef-full-backup-btn').addEventListener('click', exportFullBackupJson);
        panel.querySelector('#ef-full-restore-btn').addEventListener('click', triggerJsonImportPicker);

        panel.querySelector('#ef-chk-adblock').addEventListener('change', (e) => {
            config.blockAds = e.target.checked;
            saveConfig();
            cleanAds();
            updateStats();
            showToast(config.blockAds ? '🛡️ 已開啟去除網站廣告' : '已關閉去廣告');
        });

        panel.querySelector('#ef-chk-suggested').addEventListener('change', (e) => {
            config.hideSuggestedUsers = e.target.checked;
            saveConfig();
            processSuggestedUsers();
            showToast(config.hideSuggestedUsers ? '已隱藏 Suggested users' : '已顯示 Suggested users');
        });

        const cleanCardChk = panel.querySelector('#ef-chk-clean-card');
        if (cleanCardChk) {
            cleanCardChk.addEventListener('change', (e) => {
                config.cleanCardUi = e.target.checked;
                saveConfig();
                syncRootFeatureClasses();
            });
        }

        panel.querySelector('#ef-chk-vertical').addEventListener('change', (e) => {
            config.onlyVertical = e.target.checked;
            saveConfig();
            applyAllFilters();
        });

        panel.querySelector('#ef-chk-photos').addEventListener('change', (e) => {
            config.hidePhotos = e.target.checked;
            saveConfig();
            applyAllFilters();
        });

        const coverSel = panel.querySelector('#ef-sel-cover-shape');
        if (coverSel) {
            coverSel.addEventListener('change', (e) => {
                config.coverShape = e.target.value;
                saveConfig();
                syncRootFeatureClasses();
            });
        }

        const sizeSlider = panel.querySelector('#ef-rng-cover-size');
        const sizeResetBtn = panel.querySelector('#ef-size-reset');
        const updateSizeLabel = () => {
            const lbl = document.getElementById('ef-size-label');
            if (!lbl) return;
            const m = getCoverLayoutMetrics(config.coverSize);
            lbl.textContent = m.active ? `${m.size}% · ${m.cols}欄` : '原樣';
            if (sizeResetBtn) sizeResetBtn.style.display = m.active ? 'inline-block' : 'none';
        };
        updateSizeLabel();

        if (sizeSlider) {
            sizeSlider.addEventListener('input', (e) => {
                config.coverSize = Number(e.target.value);
                saveConfig();
                syncRootFeatureClasses();
                updateSizeLabel();
            });
        }
        if (sizeResetBtn) {
            sizeResetBtn.addEventListener('click', () => {
                config.coverSize = 0;
                saveConfig();
                syncRootFeatureClasses();
                if (sizeSlider) sizeSlider.value = '50';
                updateSizeLabel();
            });
        }

        const infChk = panel.querySelector('#ef-chk-infinite');
        if (infChk) {
            infChk.addEventListener('change', (e) => {
                config.autoNextPage = e.target.checked;
                saveConfig();
            });
        }

        const deepChk = panel.querySelector('#ef-chk-deep');
        if (deepChk) {
            deepChk.addEventListener('change', (e) => {
                config.deepScan = e.target.checked;
                saveConfig();
                if (config.deepScan) {
                    document.querySelectorAll('.album[data-ef-type="horizontal"], div[id^="album-"][data-ef-type="horizontal"]').forEach((c) => {
                        delete c.dataset.efProcessed;
                    });
                    processListingPage();
                    runScanQueue();
                }
            });
        }

        updateStats();
    }

    // ==================== 17. 啟動入口 ====================
    function init() {
        applyCustomHiddenStyles();
        bypassAgeGate();
        processSuggestedUsers();
        cleanAds();
        createControlPanel();
        createFeedOverlay();
        createFavManagerModal();
        createBlacklistModal();
        createHiddenRulesModal();

        const runProcessor = () => {
            processSuggestedUsers();
            cleanAds();
            if (IS_ALBUM_PAGE) {
                processAlbumPage();
            } else {
                processListingPage();
            }
            updateStats();
        };

        runProcessor();
        setupInfiniteScroll();
        initResumeBreakpoint();
        initCardPreview();

        [600, 1600, 3200].forEach((ms) => setTimeout(() => {
            processSuggestedUsers();
            cleanAds();
            updateStats();
        }, ms));

        let debounceTimer = null;
        const contentObserver = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(runProcessor, 250);
        });
        contentObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
