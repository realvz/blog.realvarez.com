document.addEventListener('DOMContentLoaded', (event) => {
    init_mode();
    convertAltTextToCaptions();
    convertWikiLinks();
    initAnalyticsSignals();
});

function convertWikiLinks() {
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );

    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
        if (node.textContent.includes('[[') && node.textContent.includes(']]')) {
            textNodes.push(node);
        }
    }

    textNodes.forEach(textNode => {
        const newContent = textNode.textContent.replace(/\[\[([^\]]+)\]\]/g, '$1');
        if (newContent !== textNode.textContent) {
            textNode.textContent = newContent;
        }
    });
}

function convertAltTextToCaptions() {
    const images = document.querySelectorAll('img');
    images.forEach(img => {
        if (img.alt && img.alt.trim() !== '') {
            const figure = document.createElement('figure');
            const figcaption = document.createElement('figcaption');
            
            figcaption.textContent = img.alt;
            img.parentNode.insertBefore(figure, img);
            figure.appendChild(img);
            figure.appendChild(figcaption);
        }
    });
}

function updateGiscusTheme() {
    const theme = localStorage.theme === 'dark' ? 'dark' : 'light';
    const iframe = document.querySelector('iframe.giscus-frame');
    if (iframe) {
        iframe.contentWindow.postMessage(
            { giscus: { setConfig: { theme: theme } } },
            'https://giscus.app'
        );
    }
}

function init_mode() {
    const darkmodeCheckbox = document.getElementById("darkmode");
    const htmlElement = document.documentElement;

    if (localStorage.theme === 'dark') {
        darkmodeCheckbox.checked = true;
        htmlElement.classList.add('dark');
    } else {
        darkmodeCheckbox.checked = false;
        htmlElement.classList.remove('dark');
    }
    updateGiscusTheme();
}

function change_mode() {
    const darkmodeCheckbox = document.getElementById("darkmode");
    const htmlElement = document.documentElement;

    if (darkmodeCheckbox.checked) {
        localStorage.theme = 'dark';
        htmlElement.classList.add('dark');
    } else {
        localStorage.theme = 'light';
        htmlElement.classList.remove('dark');
    }
    updateGiscusTheme();
}

function initAnalyticsSignals() {
    if (typeof window.gtag !== 'function') {
        return;
    }

    initOutboundLinkTracking();

    if (getPageType() === 'blog_post') {
        initReaderSignals();
    }
}

function initOutboundLinkTracking() {
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link) {
            return;
        }

        const url = new URL(link.href, window.location.href);
        if (url.origin === window.location.origin) {
            return;
        }

        trackEvent('reader_outbound_click', {
            page_type: getPageType(),
            link_url: url.href,
            link_domain: url.hostname,
            link_text: (link.textContent || '').trim().slice(0, 120)
        });
    });
}

function initReaderSignals() {
    const thresholds = [25, 50, 75, 90];
    const sentThresholds = new Set();
    let maxScrollPercent = 0;
    let postReadTracked = false;

    const onScroll = () => {
        maxScrollPercent = Math.max(maxScrollPercent, getScrollPercent());

        thresholds.forEach((threshold) => {
            if (maxScrollPercent >= threshold && !sentThresholds.has(threshold)) {
                sentThresholds.add(threshold);
                trackEvent('reader_scroll_depth', {
                    page_type: 'blog_post',
                    post_title: getPostTitle(),
                    percent_scrolled: threshold
                });
            }
        });

        if (maxScrollPercent >= 90 && !postReadTracked) {
            postReadTracked = true;
            trackEvent('reader_post_read', {
                page_type: 'blog_post',
                post_title: getPostTitle(),
                max_scroll_percent: Math.round(maxScrollPercent)
            });
        }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();
}

function getScrollPercent() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const documentHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
    );
    const scrollableHeight = Math.max(documentHeight - viewportHeight, 1);

    return Math.min(100, ((scrollTop / scrollableHeight) * 100));
}

function getPageType() {
    const path = window.location.pathname;
    if (path === '/') {
        return 'home';
    }
    if (path === '/blog/') {
        return 'blog_index';
    }
    if (path.startsWith('/blog/')) {
        return 'blog_post';
    }
    return 'page';
}

function getPostTitle() {
    const heading = document.querySelector('main h1');
    return heading ? heading.textContent.trim() : document.title;
}

function trackEvent(name, params = {}) {
    if (typeof window.gtag !== 'function') {
        return;
    }

    window.gtag('event', name, {
        page_path: window.location.pathname,
        ...params
    });
}
