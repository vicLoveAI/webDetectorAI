// ===== DOM Elements =====
const summarizeView = document.getElementById('summarize-view');
const settingsView = document.getElementById('settings-view');
const settingsBtn = document.getElementById('settings-btn');
const summarizeBtn = document.getElementById('summarize-btn');
const summarizeBtnText = document.getElementById('summarize-btn-text');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const streamingIndicator = document.getElementById('streaming-indicator');
const cancelStreamBtn = document.getElementById('cancel-stream-btn');
const errorEl = document.getElementById('error');
const resultArea = document.getElementById('result-area');
const resultLabel = document.getElementById('result-label');
const resultContent = document.getElementById('result-content');
const copyBtn = document.getElementById('copy-btn');
const tokenInfo = document.getElementById('token-info');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const testConnectionBtn = document.getElementById('test-connection-btn');
const settingsStatus = document.getElementById('settings-status');
const toggleKeyBtn = document.getElementById('toggle-key-btn');
const fetchModelsBtn = document.getElementById('fetch-models-btn');
const modelList = document.getElementById('model-list');
const modelListLoading = document.getElementById('model-list-loading');
const modelListError = document.getElementById('model-list-error');
const tokenDialog = document.getElementById('token-dialog');
const tokenDialogMsg = document.getElementById('token-dialog-msg');
const tokenCancelBtn = document.getElementById('token-cancel-btn');
const tokenConfirmBtn = document.getElementById('token-confirm-btn');

// Settings inputs
const langSelect = document.getElementById('lang-select');
const apiBaseInput = document.getElementById('api-base');
const apiKeyInput = document.getElementById('api-key');
const modelNameInput = document.getElementById('model-name');

// ===== State =====
let currentView = 'summarize';
let originalMarkdown = '';
let currentStreamId = null;
let pendingConfirm = null; // resolver for token confirmation

// ===== Default Settings =====
const DEFAULT_SETTINGS = {
  language: 'auto',
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  modelName: 'gpt-3.5-turbo'
};

// ===== View Switching =====
settingsBtn.addEventListener('click', () => {
  if (currentView === 'summarize') {
    showSettingsView();
  } else {
    showSummarizeView();
  }
});

function showSummarizeView() {
  currentView = 'summarize';
  summarizeView.classList.add('active');
  settingsView.classList.remove('active');
  settingsBtn.textContent = '⚙️';
}

function showSettingsView() {
  currentView = 'settings';
  summarizeView.classList.remove('active');
  settingsView.classList.add('active');
  settingsBtn.textContent = '←';
  loadSettingsIntoForm();
}

// ===== Settings Management =====
async function loadSettingsIntoForm() {
  const settings = await getSettings();
  langSelect.value = settings.language;
  apiBaseInput.value = settings.apiBase;
  apiKeyInput.value = settings.apiKey;
  modelNameInput.value = settings.modelName;
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => resolve(items));
  });
}

function getCurrentFormSettings() {
  return {
    language: langSelect.value,
    apiBase: apiBaseInput.value.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.apiBase,
    apiKey: apiKeyInput.value.trim(),
    modelName: modelNameInput.value.trim() || DEFAULT_SETTINGS.modelName
  };
}

saveSettingsBtn.addEventListener('click', async () => {
  const settings = getCurrentFormSettings();
  if (!settings.apiKey) {
    showSettingsMessage('请输入 API Key', 'error');
    return;
  }
  if (!settings.apiBase) {
    showSettingsMessage('请输入 API 基础地址', 'error');
    return;
  }

  chrome.storage.sync.set(settings, () => {
    if (chrome.runtime.lastError) {
      showSettingsMessage('保存失败: ' + chrome.runtime.lastError.message, 'error');
    } else {
      showSettingsMessage('✅ 设置已保存', 'success');
      setTimeout(() => {
        settingsStatus.classList.add('hidden');
        showSummarizeView();
      }, 900);
    }
  });
});

function showSettingsMessage(msg, type) {
  settingsStatus.textContent = msg;
  settingsStatus.className = 'settings-status ' + type;
  settingsStatus.classList.remove('hidden');
}

// ===== Password Visibility Toggle =====
toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.textContent = isPassword ? '🙈' : '👁️';
});

// ===== Test Connection (via background) =====
testConnectionBtn.addEventListener('click', async () => {
  const settings = getCurrentFormSettings();
  if (!settings.apiKey) {
    showSettingsMessage('请先输入 API Key', 'error');
    return;
  }

  testConnectionBtn.disabled = true;
  testConnectionBtn.textContent = '⏳ 测试中…';
  settingsStatus.classList.add('hidden');

  try {
    const response = await safeSendMessage({
      action: 'api:testConnection',
      baseUrl: settings.apiBase,
      apiKey: settings.apiKey,
      modelName: settings.modelName
    });

    if (response && response.success) {
      showSettingsMessage('✅ ' + response.data.message, 'success');
    } else {
      showSettingsMessage('❌ ' + (response?.error || '未收到响应，请重试'), 'error');
    }
  } catch (err) {
    showSettingsMessage('❌ 测试失败: ' + err.message, 'error');
  } finally {
    testConnectionBtn.disabled = false;
    testConnectionBtn.textContent = '🔌 测试连接';
  }
});

// ===== Fetch Models (via background) =====
fetchModelsBtn.addEventListener('click', async () => {
  const apiBase = apiBaseInput.value.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.apiBase;
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    modelListError.textContent = '请先输入 API Key';
    modelListError.classList.remove('hidden');
    modelList.classList.add('hidden');
    return;
  }

  fetchModelsBtn.disabled = true;
  fetchModelsBtn.textContent = '⏳ 查询中';
  modelList.classList.add('hidden');
  modelListError.classList.add('hidden');
  modelListLoading.classList.remove('hidden');

  try {
    const response = await safeSendMessage({
      action: 'api:fetchModels',
      baseUrl: apiBase,
      apiKey: apiKey
    });

    if (!response || !response.success) {
      throw new Error(response?.error || '未收到响应，请重试');
    }

    const models = response.data;
    modelList.innerHTML = models.map(id => {
      const selected = id === modelNameInput.value ? ' selected' : '';
      return `<div class="model-list-item${selected}" data-model="${escapeHtml(id)}">${escapeHtml(id)}</div>`;
    }).join('');

    modelList.classList.remove('hidden');

    modelList.querySelectorAll('.model-list-item').forEach(item => {
      item.addEventListener('click', () => {
        modelNameInput.value = item.dataset.model;
        modelList.querySelectorAll('.model-list-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        setTimeout(() => modelList.classList.add('hidden'), 200);
      });
    });

    showSettingsMessage(`✅ 获取到 ${models.length} 个可用模型`, 'success');
  } catch (err) {
    modelListError.textContent = err.message;
    modelListError.classList.remove('hidden');
  } finally {
    modelListLoading.classList.add('hidden');
    fetchModelsBtn.disabled = false;
    fetchModelsBtn.textContent = '📡 查询模型';
  }
});

// Close model list when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#model-list') && !e.target.closest('#fetch-models-btn') && !e.target.closest('#model-name')) {
    modelList.classList.add('hidden');
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Safe Message Sender (handles service worker restarts, retries) =====
async function safeSendMessage(message, { timeoutMs = 8000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`sendMessage retry ${attempt}/${retries} for ${message.action}`);
      await new Promise(r => setTimeout(r, 500)); // brief delay before retry
    }

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`sendMessage timeout for ${message.action} after ${timeoutMs}ms`);
        resolve({ _timeout: true });
      }, timeoutMs);

      chrome.runtime.sendMessage(message).then((response) => {
        clearTimeout(timer);
        if (response === undefined || response === null) {
          console.warn(`sendMessage for ${message.action} returned ${response} (no listener?)`);
          resolve({ _noListener: true });
        } else {
          resolve(response);
        }
      }).catch((err) => {
        clearTimeout(timer);
        console.warn(`sendMessage for ${message.action} failed:`, err.message);
        resolve({ _error: err.message });
      });
    });

    // If we got a real response (not a sentinel), return it
    if (result && !result._timeout && !result._noListener && !result._error) {
      return result;
    }

    // On last attempt, return null to signal failure
    if (attempt === retries) {
      console.error(`sendMessage for ${message.action} failed after ${retries + 1} attempts`);
      return null;
    }
  }
}

// ===== Summarize Flow =====
summarizeBtn.addEventListener('click', async () => {
  const settings = await getSettings();

  if (!settings.apiKey) {
    showError('请先在设置中配置 API Key。\n点击右上角 ⚙️ 进入设置页。');
    return;
  }
  if (!settings.apiBase) {
    showError('请先在设置中配置 API 基础地址。');
    return;
  }

  // Reset UI
  errorEl.classList.add('hidden');
  resultArea.classList.add('hidden');
  tokenInfo.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  loadingText.textContent = '正在提取页面内容…';
  summarizeBtn.disabled = true;
  summarizeBtnText.textContent = '⏳ 分析中…';

  try {
    // Step 1: Get current tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length || !tabs[0].id) {
      throw new Error('无法获取当前标签页，请刷新后重试');
    }

    // Step 2: Extract page content
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: extractPageContent
    });

    const extracted = results?.[0]?.result;

    if (!extracted) {
      throw new Error('无法提取页面内容。\n\n可能原因：\n• 页面尚未加载完成\n• 这是一个受保护的页面\n• 页面内容为空');
    }

    if (!extracted.text || extracted.text.trim().length < 10) {
      throw new Error('页面文字内容不足，无法生成摘要。\n请尝试在包含文章、新闻、博客等文字内容的页面上使用。');
    }

    // Step 3: Ping background to ensure service worker is alive
    const pingRes = await safeSendMessage({ action: 'api:ping' }, { timeoutMs: 3000, retries: 0 });
    if (!pingRes || !pingRes.success) {
      throw new Error('扩展后台服务未响应。\n\n请尝试：\n• 刷新当前页面后重试\n• 在 chrome://extensions 中重新加载扩展\n• 关闭并重新打开此弹窗');
    }

    // Step 4: Estimate tokens
    loadingText.textContent = '正在评估 Token 用量…';
    const estimateRes = await safeSendMessage({
      action: 'api:estimateTokens',
      content: extracted,
      modelName: settings.modelName
    });

    if (!estimateRes || !estimateRes.success) {
      console.warn('Token estimation failed:', estimateRes?.error || 'no response');
      // Continue anyway — non-critical path
    }

    // Step 5: Confirm if high token usage
    if (estimateRes?.success && estimateRes.data.isHigh) {
      const shouldProceed = await showTokenConfirmDialog(estimateRes.data);
      if (!shouldProceed) {
        loadingEl.classList.add('hidden');
        summarizeBtn.disabled = false;
        summarizeBtnText.textContent = '🔍 一键探测';
        return;
      }
    }

    // Update token info
    if (estimateRes?.success) {
      tokenInfo.textContent = estimateRes.data.message;
      tokenInfo.classList.remove('hidden');
    }

    // Step 6: Update UI for streaming
    loadingEl.classList.add('hidden');
    streamingIndicator.classList.remove('hidden');
    resultArea.classList.remove('hidden');
    resultLabel.textContent = getResultLabel(extracted.pageType);
    resultContent.innerHTML = '<p style="color:#aaa;">等待 AI 响应…</p>';
    resultContent.classList.add('streaming');
    originalMarkdown = '';

    // Step 7: Start streaming API call
    const streamId = 'popup_' + Date.now();
    currentStreamId = streamId;

    const startRes = await safeSendMessage({
      action: 'api:summarize',
      settings: settings,
      content: extracted,
      streamId: streamId
    }, { timeoutMs: 10000, retries: 2 });

    if (!startRes || !startRes.success) {
      if (!startRes) {
        throw new Error('无法连接到扩展后台服务。\n\n请尝试：\n• 在 chrome://extensions 中重新加载扩展\n• 检查扩展是否已启用');
      }
      throw new Error(startRes.error || '启动摘要失败，请检查 API 配置后重试');
    }

  } catch (err) {
    loadingEl.classList.add('hidden');
    streamingIndicator.classList.add('hidden');
    resultContent.classList.remove('streaming');
    showError(err.message || '未知错误，请重试');
    summarizeBtn.disabled = false;
    summarizeBtnText.textContent = '🔍 一键探测';
    currentStreamId = null;
  }
});

function getResultLabel(pageType) {
  switch (pageType) {
    case 'video': return '🎬 视频概要';
    case 'image': return '🖼️ 图片概要';
    case 'audio': return '🎵 音频概要';
    default: return '📝 文章概要';
  }
}

// ===== Token Confirmation Dialog =====
function showTokenConfirmDialog(estimate) {
  return new Promise((resolve) => {
    tokenDialogMsg.textContent = estimate.message + '\n\n是否继续？';
    if (estimate.exceedsLimit) {
      tokenDialogMsg.innerHTML = `<span style="color:#c53030;">⚠️ ${estimate.message}</span><br><br>继续可能会产生较高费用或失败，是否确认？`;
    }
    tokenDialog.classList.remove('hidden');
    pendingConfirm = resolve;
  });
}

tokenConfirmBtn.addEventListener('click', () => {
  tokenDialog.classList.add('hidden');
  if (pendingConfirm) {
    pendingConfirm(true);
    pendingConfirm = null;
  }
});

tokenCancelBtn.addEventListener('click', () => {
  tokenDialog.classList.add('hidden');
  if (pendingConfirm) {
    pendingConfirm(false);
    pendingConfirm = null;
  }
});

// ===== Cancel Stream =====
cancelStreamBtn.addEventListener('click', async () => {
  if (currentStreamId) {
    await safeSendMessage({
      action: 'api:cancelStream',
      streamId: currentStreamId
    });
    finishStream('已取消');
  }
});

// ===== Handle Stream Messages from Background =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Always respond to avoid Chrome warnings about unhandled messages
  const respond = () => {
    try { sendResponse({ received: true }); } catch {}
  };

  // Streaming messages
  if (message.action === 'stream:' + currentStreamId) {
    handleStreamMessage(message.data);
    respond();
    return;
  }

  // Legacy: background-initiated summary
  if (message.action === 'showSummary') {
    if (message.summary) {
      originalMarkdown = message.summary;
      resultContent.innerHTML = renderMarkdown(message.summary);
      resultArea.classList.remove('hidden');
      loadingEl.classList.add('hidden');
      streamingIndicator.classList.add('hidden');
      resultContent.classList.remove('streaming');
      errorEl.classList.add('hidden');
      summarizeBtn.disabled = false;
      summarizeBtnText.textContent = '🔍 一键探测';
    }
    respond();
    return;
  }

  if (message.action === 'showSummaryError') {
    loadingEl.classList.add('hidden');
    streamingIndicator.classList.add('hidden');
    showError(message.error);
    summarizeBtn.disabled = false;
    summarizeBtnText.textContent = '🔍 一键探测';
    respond();
    return;
  }

  // Background-initiated stream (from context menu/shortcut)
  if (message.action === 'showStreamReady') {
    showStreamFromBackground(message.streamId, message.estimate);
    respond();
    return;
  }
});

function handleStreamMessage(data) {
  switch (data.type) {
    case 'chunk':
      originalMarkdown = data.fullContent;
      resultContent.innerHTML = renderMarkdown(data.fullContent);
      // Auto-scroll to bottom
      resultContent.scrollTop = resultContent.scrollHeight;
      break;

    case 'done':
      originalMarkdown = data.fullContent;
      resultContent.innerHTML = renderMarkdown(data.fullContent);
      finishStream();
      break;

    case 'error':
      resultContent.innerHTML = '';
      showError(data.error);
      finishStream();
      break;

    case 'cancelled':
      if (!originalMarkdown) {
        resultContent.innerHTML = '';
      }
      finishStream('已取消');
      break;
  }
}

function finishStream(cancelMsg) {
  streamingIndicator.classList.add('hidden');
  resultContent.classList.remove('streaming');
  summarizeBtn.disabled = false;
  summarizeBtnText.textContent = '🔍 一键探测';
  currentStreamId = null;

  if (cancelMsg && !originalMarkdown) {
    resultContent.innerHTML = `<p style="color:#999;text-align:center;">${cancelMsg}</p>`;
  }
}

// ===== Show Stream from Background (context menu / shortcut) =====
async function showStreamFromBackground(streamId, estimate) {
  currentStreamId = streamId;
  loadingEl.classList.add('hidden');
  streamingIndicator.classList.remove('hidden');
  resultArea.classList.remove('hidden');
  resultLabel.textContent = '📝 概要结果';
  resultContent.innerHTML = '<p style="color:#aaa;">等待 AI 响应…</p>';
  resultContent.classList.add('streaming');
  originalMarkdown = '';

  if (estimate) {
    tokenInfo.textContent = estimate.message;
    tokenInfo.classList.remove('hidden');
  }

  summarizeBtn.disabled = true;
  summarizeBtnText.textContent = '⏳ 接收中…';
}

// ===== Error Display =====
function showError(msg) {
  errorEl.textContent = '❌ ' + msg;
  errorEl.classList.remove('hidden');
}

// ===== Copy Markdown =====
copyBtn.addEventListener('click', async () => {
  if (!originalMarkdown) return;
  try {
    await navigator.clipboard.writeText(originalMarkdown);
    copyBtn.textContent = '✅ 已复制';
    setTimeout(() => { copyBtn.textContent = '📋 复制 Markdown'; }, 2000);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = originalMarkdown;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    copyBtn.textContent = '✅ 已复制';
    setTimeout(() => { copyBtn.textContent = '📋 复制 Markdown'; }, 2000);
  }
});

// ===== Check Stored Results from Background =====
async function checkStoredResult() {
  try {
    const result = await chrome.storage.local.get(['lastSummary', 'activeStream']);
    if (result.activeStream?.timestamp) {
      const age = Date.now() - result.activeStream.timestamp;
      if (age < 60 * 1000) {
        // There's an active stream from background — connect to it
        showStreamFromBackground(result.activeStream.streamId, result.activeStream.estimate);
      }
      await chrome.storage.local.remove('activeStream');
    } else if (result.lastSummary?.timestamp) {
      const age = Date.now() - result.lastSummary.timestamp;
      if (age < 5 * 60 * 1000) {
        if (result.lastSummary.markdown) {
          originalMarkdown = result.lastSummary.markdown;
          resultContent.innerHTML = renderMarkdown(originalMarkdown);
          resultArea.classList.remove('hidden');
        } else if (result.lastSummary.error) {
          showError(result.lastSummary.error);
        }
      }
      await chrome.storage.local.remove('lastSummary');
    }
  } catch (e) {
    // Silently ignore
  }
}

// ===== Content Extraction (injected into page) =====
function extractPageContent() {
  const data = {};

  data.title = document.title || '';
  data.url = window.location.href;
  data.hostname = window.location.hostname;

  const metaTags = {};
  document.querySelectorAll('meta[name], meta[property], meta[itemprop]').forEach(meta => {
    const name = meta.getAttribute('name') || meta.getAttribute('property') || meta.getAttribute('itemprop');
    const content = meta.getAttribute('content');
    if (name && content) metaTags[name] = content;
  });
  data.metaTags = metaTags;
  data.ogTitle = metaTags['og:title'] || '';
  data.ogDescription = metaTags['og:description'] || '';
  data.description = metaTags['description'] || '';
  data.keywords = metaTags['keywords'] || '';

  data.lang = document.documentElement.lang ||
    document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content') ||
    metaTags['og:locale'] || '';

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

    // Capture thumbnail for vision API
    const videoEl = document.querySelector('video');
    const posterUrl = videoEl?.getAttribute('poster');
    const ytThumb = document.querySelector('img.ytp-cued-thumbnail-overlay-image, img[src*="vi_webp"], img[src*="maxresdefault"], img[src*="hqdefault"]');
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
    const thumbImg = document.querySelector('img[class*="thumbnail"], img[alt*="thumbnail"]');
    const thumbUrl = posterUrl || ytThumb?.src || ogImage || thumbImg?.src || '';
    if (thumbUrl && thumbUrl.startsWith('http')) {
      data.videoThumbnail = thumbUrl;
    }

    // Try canvas frame capture (only works for same-origin video)
    try {
      if (videoEl && videoEl.videoWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        data.videoFrame = canvas.toDataURL('image/jpeg', 0.6);
      }
    } catch (e) { /* cross-origin video, expected */ }
  } else if (data.pageType === 'audio') {
    data.audioTitle = document.querySelector('h1')?.innerText?.trim() || data.ogTitle || data.title;
    data.channelName = document.querySelector('[class*="artist"], [class*="author"], [class*="uploader"], [class*="channel"]')?.innerText?.trim() || '';

    // Look for transcripts, lyrics, show notes
    const transcriptSelectors = [
      '.transcript', '[class*="transcript"]', '[class*="lyrics"]', '[class*="lyric"]',
      '[class*="shownotes"]', '[class*="show-notes"]', '[class*="description-text"]',
      '[class*="episode-notes"]', '[class*="track-description"]',
      '.TrackPage__lyrics', '.Lyrics__Container', '[data-testid="lyrics"]'
    ];
    for (const sel of transcriptSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 50) {
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

    // Collect actual image URLs for vision API
    const images = [];
    const candidateImgs = document.querySelectorAll('img');
    for (const img of candidateImgs) {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
      if (!src || !src.startsWith('http')) continue;
      if (img.naturalWidth < 150 || img.naturalHeight < 150) continue;
      const lowerSrc = src.toLowerCase();
      if (/avatar|icon|logo|button|badge|pixel|track|emoji|favicon/i.test(lowerSrc)) continue;
      if (/\.svg(\?|$)/i.test(src)) continue;
      if (/googleads|doubleclick|facebook\.com\/tr|analytics|pixel\.quantserve/i.test(lowerSrc)) continue;
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
    if (article) {
      mainText = article.innerText;
    } else if (main) {
      mainText = main.innerText;
    } else {
      const selectors = [
        '[role="main"]', '.post-content', '.article-content', '.entry-content',
        '.post-body', '.article-body', '#article-content', '.content-body',
        '.markdown-body', '.prose', '[data-testid="post-content"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.length > 100) { mainText = el.innerText; break; }
      }
    }

    if (mainText.length < 100) {
      const bodyClone = document.body.cloneNode(true);
      const exclude = [
        'nav', 'header', 'footer', 'script', 'style', 'noscript', 'iframe',
        'svg', 'canvas', 'audio', 'video', 'input', 'textarea', 'select',
        'button', 'code', 'pre', 'template',
        '.nav', '.navbar', '.header', '.footer', '.sidebar', '.aside', '.menu',
        '.comments', '.advertisement', '.ads', '.ad', '.social-share',
        '.related-posts', '.recommended', '.cookie-banner', '.popup',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
        '[aria-hidden="true"]'
      ].join(',');
      bodyClone.querySelectorAll(exclude).forEach(el => el.remove());
      mainText = bodyClone.innerText;
    }
  }

  mainText = mainText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, '  ').trim();

  let maxLen = data.pageType === 'article' ? 8000
    : data.pageType === 'video' ? 4000
    : 3000;
  if (data.pageType === 'image' && data.images && data.images.length > 0) {
    maxLen = 2000;
  }
  if (mainText.length > maxLen) {
    mainText = mainText.substring(0, maxLen) + '\n\n[内容已截断…]';
  }

  data.text = mainText;
  return data;
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  showSummarizeView();
  checkStoredResult();
});
