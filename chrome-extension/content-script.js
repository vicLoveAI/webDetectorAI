// ===== Content Script (standby) =====
// This script is available for use via chrome.scripting.executeScript
// It can also be manually injected for testing purposes.
//
// The extension currently uses executeScript with inline functions in
// popup.js and background.js for content extraction.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractContent') {
    try {
      const data = extractPageContent();
      sendResponse({ success: true, data: data });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
});

function extractPageContent() {
  const data = {};

  data.title = document.title || '';
  data.url = window.location.href;
  data.hostname = window.location.hostname;

  const metaTags = {};
  document.querySelectorAll('meta[name], meta[property], meta[itemprop]').forEach((meta) => {
    const name = meta.getAttribute('name') || meta.getAttribute('property') || meta.getAttribute('itemprop');
    const content = meta.getAttribute('content');
    if (name && content) metaTags[name] = content;
  });
  data.metaTags = metaTags;
  data.ogTitle = metaTags['og:title'] || '';
  data.ogDescription = metaTags['og:description'] || '';
  data.description = metaTags['description'] || '';
  data.keywords = metaTags['keywords'] || '';

  const htmlLang = document.documentElement.lang;
  const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
  data.lang = htmlLang || metaLang || metaTags['og:locale'] || '';

  const url = window.location.href;
  if (/youtube\.com\/watch|bilibili\.com\/video|vimeo\.com|tiktok\.com/i.test(url)) {
    data.pageType = 'video';
  } else if (/instagram\.com\/p\/|pinterest\.com\/pin|imgur\.com\/gallery|flickr\.com\/photos/i.test(url)) {
    data.pageType = 'image';
  } else if (/soundcloud\.com\/|spotify\.com\/|music\.163\.com|podcasts\.apple\.com|xima\.fm/i.test(url)) {
    data.pageType = 'audio';
  } else {
    data.pageType = 'article';
  }

  let mainText = '';

  if (data.pageType === 'video') {
    data.videoTitle = document.querySelector('h1')?.innerText?.trim() || data.ogTitle || data.title;
    data.channelName = document.querySelector('[class*="owner"] a, [class*="channel"] a, [class*="uploader"] a')?.innerText?.trim() || '';
    data.videoDescription = document.querySelector('[class*="description"]')?.innerText?.trim() || '';
    const timeEl = document.querySelector('[class*="duration"], .ytp-time-duration, span[class*="time"]');
    if (timeEl) data.duration = timeEl.innerText.trim();
    mainText = [data.videoTitle, data.videoDescription].filter(Boolean).join('\n\n');
    if (mainText.length < 100) {
      mainText = document.querySelector('article, main, [role="main"]')?.innerText || document.body.innerText.substring(0, 3000);
    }
    // Capture thumbnail for vision
    const videoEl = document.querySelector('video');
    const posterUrl = videoEl?.getAttribute('poster');
    const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
    const thumbImg = document.querySelector('img[class*="thumbnail"]');
    const thumbUrl = posterUrl || ogImg || thumbImg?.src || '';
    if (thumbUrl && thumbUrl.startsWith('http')) data.videoThumbnail = thumbUrl;
    try {
      if (videoEl && videoEl.videoWidth > 0) {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 180;
        c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
        data.videoFrame = c.toDataURL('image/jpeg', 0.6);
      }
    } catch (e) {}
  } else if (data.pageType === 'audio') {
    data.audioTitle = document.querySelector('h1')?.innerText?.trim() || data.ogTitle || data.title;
    data.channelName = document.querySelector('[class*="artist"], [class*="author"], [class*="uploader"], [class*="channel"]')?.innerText?.trim() || '';
    // Look for transcripts/lyrics/show notes
    const tsSelectors = [
      '.transcript', '[class*="transcript"]', '[class*="lyrics"]', '[class*="lyric"]',
      '[class*="shownotes"]', '[class*="show-notes"]', '[class*="episode-notes"]'
    ];
    for (const sel of tsSelectors) {
      const el = document.querySelector(sel);
      if (el?.innerText?.trim().length > 50) {
        data.transcript = el.innerText.trim().substring(0, 5000);
        break;
      }
    }
    mainText = document.querySelector('article, main, [role="main"]')?.innerText || document.body.innerText.substring(0, 3000);
  } else if (data.pageType === 'image') {
    const alts = [];
    document.querySelectorAll('img[alt]').forEach(img => {
      if (img.alt.trim()) alts.push(img.alt.trim());
    });
    data.imageAlts = alts.slice(0, 15);
    // Collect actual image URLs for vision
    const images = [];
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
      if (!src || !src.startsWith('http')) continue;
      if (img.naturalWidth < 150 || img.naturalHeight < 150) continue;
      if (/avatar|icon|logo|button|badge|pixel|track|emoji|favicon/i.test(src.toLowerCase())) continue;
      if (/\.svg(\?|$)/i.test(src)) continue;
      if (/googleads|doubleclick|analytics/i.test(src.toLowerCase())) continue;
      if (images.some(i => i.url === src)) continue;
      images.push({ url: src, alt: (img.alt || '').substring(0, 200) });
      if (images.length >= 5) break;
    }
    data.images = images;
    const article = document.querySelector('article, main, [role="main"]');
    mainText = article ? article.innerText.substring(0, 3000) : alts.slice(0, 10).join('\n');
  } else {
    const article = document.querySelector('article');
    const main = document.querySelector('main');
    const contentSelectors = [
      '[role="main"]', '.post-content', '.article-content', '.entry-content',
      '.post-body', '.article-body', '.markdown-body', '.prose'
    ];
    if (article) mainText = article.innerText;
    else if (main) mainText = main.innerText;
    else {
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.length > 100) { mainText = el.innerText; break; }
      }
    }
    if (mainText.length < 100) {
      const bodyClone = document.body.cloneNode(true);
      const exclude = [
        'nav', 'header', 'footer', 'script', 'style', 'noscript', 'iframe',
        'svg', 'canvas', 'audio', 'video', 'input', 'textarea', 'select', 'button', 'code', 'pre',
        '.nav', '.navbar', '.header', '.footer', '.sidebar', '.aside', '.menu',
        '.comments', '.advertisement', '.ads', '.ad', '.social-share',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[aria-hidden="true"]'
      ].join(',');
      bodyClone.querySelectorAll(exclude).forEach(el => el.remove());
      mainText = bodyClone.innerText;
    }
  }

  mainText = mainText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, '  ').trim();
  let maxLen = data.pageType === 'article' ? 8000 : data.pageType === 'video' ? 4000 : 3000;
  if (data.pageType === 'image' && data.images?.length > 0) maxLen = 2000;
  if (mainText.length > maxLen) {
    mainText = mainText.substring(0, maxLen) + '\n\n[内容已截断…]';
  }
  data.text = mainText;
  return data;
}
