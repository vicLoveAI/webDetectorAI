// ===== Background Service Worker =====
// Handles: context menu, keyboard shortcuts, streaming API proxy

const DEFAULT_SETTINGS = {
  language: 'auto',
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  modelName: 'gpt-3.5-turbo'
};

// Track active stream controllers for cancellation
const activeStreams = new Map();

// ========== Install ==========
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'summarize-page',
    title: '🔍 一键探测网页概要',
    contexts: ['page']
  });
});

// ========== Context Menu ==========
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'summarize-page' && tab?.id) {
    handleSummarizeRequest(tab);
  }
});

// ========== Keyboard Shortcut ==========
chrome.commands.onCommand.addListener((command) => {
  if (command === 'summarize-page') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) handleSummarizeRequest(tabs[0]);
    });
  }
});

// ========== Message Router ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[BG] received:', message.action);

  if (message.action === 'api:ping') {
    sendResponse({ success: true, data: { alive: true, timestamp: Date.now() } });
    return true;
  }

  if (message.action === 'api:summarize') {
    try {
      console.log('[BG] starting stream summarize, streamId:', message.streamId);
      handleStreamSummarize(message.settings, message.content, message.streamId);
      sendResponse({ success: true, streaming: true });
    } catch (err) {
      console.error('[BG] handleStreamSummarize error:', err);
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }

  if (message.action === 'api:cancelStream') {
    try {
      const controller = activeStreams.get(message.streamId);
      if (controller) {
        controller.abort();
        activeStreams.delete(message.streamId);
      }
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }

  if (message.action === 'api:estimateTokens') {
    try {
      const estimate = estimateTokens(message.content, message.modelName);
      sendResponse({ success: true, data: estimate });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }

  if (message.action === 'api:fetchModels') {
    handleApiFetchModels(message.baseUrl, message.apiKey)
      .then(models => sendResponse({ success: true, data: models }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'api:testConnection') {
    handleApiTestConnection(message.baseUrl, message.apiKey, message.modelName)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Unknown action — respond with error so sender doesn't get undefined
  console.warn('[BG] unknown action:', message.action);
  sendResponse({ success: false, error: 'Unknown action: ' + (message.action || 'undefined') });
  return true;
});

// ========== Token Estimation ==========
function estimateImageTokens(imageCount) {
  if (!imageCount) return 0;
  // OpenAI: 85 base tokens per image at "auto"/"low" detail
  return imageCount * 85;
}

function estimateTokens(content, modelName) {
  let totalChars = 0;

  if (content.text) {
    totalChars += content.text.length;
  }
  if (content.ogTitle) totalChars += content.ogTitle.length;
  if (content.ogDescription) totalChars += content.ogDescription.length;
  if (content.description) totalChars += content.description.length;
  if (content.videoTitle) totalChars += content.videoTitle.length;

  // Rough token estimation: English ~4 chars/token, CJK ~1.5 chars/token
  const cjkChars = (content.text || '').match(/[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/g) || [];
  const nonCjkChars = totalChars - cjkChars.length;

  let estimatedTokens = Math.ceil(cjkChars.length / 1.5 + nonCjkChars / 4);
  // Add system prompt + response tokens (~500)
  let totalEstimate = estimatedTokens + 500;

  // Add image tokens if present
  const imageCount = (content.images?.length || 0) + (content.videoThumbnail ? 1 : 0) + (content.videoFrame ? 1 : 0);
  if (imageCount > 0) {
    totalEstimate += estimateImageTokens(imageCount);
  }

  // Check if model has known context limits
  const contextLimits = {
    'gpt-3.5-turbo': 4096,
    'gpt-3.5-turbo-16k': 16384,
    'gpt-4': 8192,
    'gpt-4-32k': 32768,
    'gpt-4-turbo': 128000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4.1': 1000000,
    'gpt-4.1-mini': 1000000,
    'gpt-5': 128000,
    'deepseek-chat': 65536,
    'deepseek-reasoner': 65536,
    'claude-3-opus': 200000,
    'claude-3.5-sonnet': 200000,
    'claude-4': 200000,
    'gemini-1.5-pro': 1000000,
    'gemini-2.0-flash': 1000000,
  };

  const contextLimit = contextLimits[modelName] || 8192;
  const exceedsLimit = totalEstimate > contextLimit * 0.9;
  const isHigh = totalEstimate > 3000;

  return {
    estimatedTokens: totalEstimate,
    contextLimit: contextLimit,
    exceedsLimit: exceedsLimit,
    isHigh: isHigh,
    inputChars: totalChars,
    message: exceedsLimit
      ? `⚠️ 预估消耗 ${totalEstimate} tokens（超出模型 ${contextLimit} 限制的 90%），可能失败或产生较高费用`
      : isHigh
        ? `预估消耗约 ${totalEstimate} tokens，费用较高`
        : `预估消耗约 ${totalEstimate} tokens`
  };
}

// ========== Streaming Summarize ==========
async function handleStreamSummarize(settings, content, streamId) {
  console.log('[BG] handleStreamSummarize start, pageType:', content.pageType, 'textLen:', content.text?.length);
  const langInstruction = buildLangInstruction(settings.language, content);
  const systemPrompt = buildSystemPrompt(content.pageType);
  const userMessage = buildUserMessage(content, langInstruction);

  // Determine if we should use vision API format
  const hasImages = userMessage.images && userMessage.images.length > 0;
  const isVision = isVisionModel(settings.modelName);
  const useVision = hasImages && isVision;

  if (hasImages && !isVision) {
    console.log('[BG] images present but model does not support vision, using text-only');
  }
  if (useVision) {
    console.log('[BG] vision mode enabled, images:', userMessage.images.length);
  }

  const apiUrl = `${settings.apiBase}/chat/completions`;
  console.log('[BG] calling API:', apiUrl, 'model:', settings.modelName);
  const controller = new AbortController();
  activeStreams.set(streamId, controller);

  // Longer timeout for vision (image upload can be slow)
  const timeoutMs = useVision ? 120000 : 60000;
  const timeoutId = setTimeout(() => {
    controller.abort();
    activeStreams.delete(streamId);
  }, timeoutMs);

  // Build user content: array for vision, string for text-only
  let userContent;
  if (useVision) {
    userContent = [{ type: 'text', text: userMessage.text }];
    for (const imgUrl of userMessage.images) {
      userContent.push({
        type: 'image_url',
        image_url: { url: imgUrl, detail: 'auto' }
      });
    }
  } else {
    userContent = userMessage.text;
  }

  const maxTokens = useVision ? 1500 : 800;

  try {
    let response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.5,
        max_tokens: maxTokens,
        stream: true
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');

      // If vision format was rejected (400), retry with text-only
      if (useVision && (response.status === 400)) {
        console.log('[BG] vision format rejected (400), retrying with text-only');
        const retryResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`
          },
          body: JSON.stringify({
            model: settings.modelName,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage.text }
            ],
            temperature: 0.5,
            max_tokens: 800,
            stream: true
          }),
          signal: controller.signal
        });

        if (!retryResponse.ok) {
          const retryErrBody = await retryResponse.text().catch(() => '');
          const errMsg = formatApiError(retryResponse.status, settings.modelName, retryErrBody);
          console.error('[BG] retry also failed:', retryResponse.status, errMsg);
          sendToPopup(streamId, { type: 'error', error: errMsg });
          activeStreams.delete(streamId);
          return;
        }
        response = retryResponse;
      } else {
        const errMsg = formatApiError(response.status, settings.modelName, errBody);
        console.error('[BG] API error:', response.status, errMsg);
        sendToPopup(streamId, { type: 'error', error: errMsg });
        activeStreams.delete(streamId);
        return;
      }
    }

    clearTimeout(timeoutId);

    console.log('[BG] stream started, reading body...');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              sendToPopup(streamId, { type: 'chunk', content: delta, fullContent: fullContent });
            }
          } catch {
            // Skip unparseable SSE data
          }
        }
      }
    }

    // Handle remaining buffer
    if (buffer.startsWith('data: ') && buffer.slice(6).trim() !== '[DONE]') {
      try {
        const parsed = JSON.parse(buffer.slice(6).trim());
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          sendToPopup(streamId, { type: 'chunk', content: delta, fullContent: fullContent });
        }
      } catch {}
    }

    console.log('[BG] stream complete, content length:', fullContent.length);
    sendToPopup(streamId, { type: 'done', fullContent: fullContent });
    activeStreams.delete(streamId);

  } catch (err) {
    clearTimeout(timeoutId);
    activeStreams.delete(streamId);

    console.error('[BG] stream error:', err.name, err.message);
    if (err.name === 'AbortError') {
      sendToPopup(streamId, { type: 'cancelled' });
    } else if (err.message?.includes('Failed to fetch')) {
      sendToPopup(streamId, { type: 'error', error: '网络连接失败，请检查 API 地址' });
    } else {
      sendToPopup(streamId, { type: 'error', error: err.message });
    }
  }
}

function sendToPopup(streamId, data) {
  chrome.runtime.sendMessage({
    action: 'stream:' + streamId,
    data: data
  }).catch(() => {
    // Popup may have closed — stop streaming
    const controller = activeStreams.get(streamId);
    if (controller) {
      controller.abort();
      activeStreams.delete(streamId);
    }
  });
}

// ========== Prompt Builders ==========
function buildLangInstruction(language, content) {
  switch (language) {
    case 'auto': {
      const code = content.lang || detectLanguageFromText(content.text);
      return `请使用${langCodeToName(code)}输出摘要。`;
    }
    case 'zh-CN': return '请使用简体中文输出摘要。';
    case 'en': return 'Please output the summary in English.';
    case 'ja': return '日本語で要約を出力してください。';
    case 'ko': return '한국어로 요약을 출력하세요.';
    case 'fr': return 'Veuillez produire le résumé en français.';
    case 'de': return 'Bitte geben Sie die Zusammenfassung auf Deutsch aus.';
    default: return '请使用简体中文输出摘要。';
  }
}

function buildSystemPrompt(pageType) {
  const base = `你是一个专业的网页内容摘要助手。根据提供的网页内容生成简洁的 Markdown 格式概要。`;

  const strategies = {
    article: `当前页面类型：文章/文本

输出结构（Markdown 格式）：
## 标题
[文章标题]

## 摘要
[2-3句话概括文章核心内容，100-200字]

## 要点
- [关键点1]
- [关键点2]
- [关键点3]

## 结论
[文章的主要结论或观点]

要求：简明扼要，突出核心信息，帮助读者快速判断是否值得阅读全文。`,

    video: `当前页面类型：视频

你将收到视频的缩略图/封面图以及文本信息（标题、描述等）。请仔细观察缩略图并进行视觉分析。

输出结构（Markdown 格式）：
## 视频信息
- **标题**：[视频标题]
- **作者/频道**：[如有]
- **时长**：[如有]

## 画面内容分析
[基于缩略图/封面图描述画面中的场景、人物、物体、氛围等]

## 内容概要
[综合视觉信息和文本描述，2-3句话概括视频内容]

## 关键看点
- [看点1]
- [看点2]
- [看点3]

要求：综合视觉和文本信息进行分析，让用户快速了解视频内容和画面风格。`,

    image: `当前页面类型：图片集/相册

你将收到页面中主要图片的链接。请观察每一张图片的视觉内容并进行详细分析。

输出结构（Markdown 格式）：
## 图片集概要
[基于实际看到的图片内容，描述整体主题和风格]

## 图片详细分析
- **图片 1**：[描述视觉内容：主体、场景、构图、色彩、氛围等]
- **图片 2**：[同上]
- **图片 3**：[同上]

要求：重点描述图片中实际看到的视觉内容、构图和风格特点，而非仅依赖文本提示。`,

    audio: `当前页面类型：音频/播客

输出结构（Markdown 格式）：
## 音频信息
- **标题**：[音频标题]
- **作者/主播**：[如有]
- **时长**：[如有]

## 内容概要
[2-3句话描述音频主要内容]

## 关键内容
- [要点1]
- [要点2]
- [要点3]

要求：让用户快速了解音频内容是否值得收听。`
  };

  return base + '\n\n' + (strategies[pageType] || strategies.article);
}

function buildUserMessage(content, langInstruction) {
  const pageLabel = content.pageType === 'video' ? '视频页面'
    : content.pageType === 'image' ? '图片页面'
    : content.pageType === 'audio' ? '音频页面'
    : '文章页面';

  let msg = `请为以下${pageLabel}内容生成概要。\n\n`;

  if (content.ogTitle) msg += `页面标题: ${content.ogTitle}\n`;
  else if (content.title) msg += `页面标题: ${content.title}\n`;
  if (content.ogDescription) msg += `页面描述: ${content.ogDescription}\n`;
  else if (content.description) msg += `页面描述: ${content.description}\n`;
  if (content.videoTitle) msg += `视频标题: ${content.videoTitle}\n`;
  if (content.videoDescription) msg += `视频描述: ${content.videoDescription}\n`;
  if (content.audioTitle) msg += `音频标题: ${content.audioTitle}\n`;
  if (content.channelName) msg += `作者/频道: ${content.channelName}\n`;
  if (content.duration) msg += `时长: ${content.duration}\n`;
  if (content.transcript) msg += `\n转录文本/歌词:\n${content.transcript}\n`;
  if (content.imageAlts?.length) msg += `\n图片描述列表:\n${content.imageAlts.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n`;

  msg += `\n页面正文:\n${content.text}\n\n${langInstruction}`;

  // Collect image URLs for vision API
  const images = [];
  if (content.images?.length > 0) {
    for (const img of content.images) images.push(img.url);
  }
  if (content.videoThumbnail && content.videoThumbnail.startsWith('http')) {
    images.push(content.videoThumbnail);
  }
  if (content.videoFrame && content.videoFrame.startsWith('data:')) {
    images.push(content.videoFrame);
  }

  if (images.length > 0) {
    return { text: msg, images: images };
  }
  return { text: msg };
}

// ========== API: Fetch Models ==========
async function handleApiFetchModels(baseUrl, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('API Key 无效或无权访问模型列表');
      if (response.status === 404) throw new Error('此 API 不支持查询模型列表，请手动输入模型名称');
      const body = await response.text().catch(() => '');
      throw new Error(`请求失败 (${response.status}): ${body.substring(0, 100)}`);
    }

    const data = await response.json();
    if (!data.data?.length) throw new Error('未获取到可用模型列表');
    return data.data.filter(m => m.id).map(m => m.id).sort();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('请求超时');
    if (err.message?.includes('Failed to fetch')) throw new Error('无法连接到 API 地址');
    throw err;
  }
}

// ========== API: Test Connection ==========
async function handleApiTestConnection(baseUrl, apiKey, modelName) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json().catch(() => null);
      return { status: 'ok', modelCount: data?.data?.length || 0, message: `连接成功，可用模型数: ${data?.data?.length || 0}` };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'error', message: 'API Key 无效或无权访问' };
    }
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'error', message: '连接超时' };
    if (e.message?.includes('Failed to fetch')) return { status: 'error', message: '无法连接到 API 地址' };
  }

  // Fallback: lightweight chat completion
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) return { status: 'ok', modelCount: 0, message: '连接成功（API 可用，不支持模型列表查询）' };
    if (response.status === 401 || response.status === 403) return { status: 'error', message: 'API Key 无效或无权访问' };
    if (response.status === 404) return { status: 'error', message: `模型 "${modelName}" 不存在` };
    const body = await response.text().catch(() => '');
    return { status: 'error', message: `API 返回错误 (${response.status}): ${body.substring(0, 80)}` };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'error', message: '连接超时' };
    return { status: 'error', message: e.message };
  }
}

// ========== Context Menu / Shortcut Full Flow ==========
async function handleSummarizeRequest(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent
    });

    const content = results?.[0]?.result;
    if (!content || !content.text || content.text.trim().length < 10) {
      showPageNotification(tab.id, '页面内容不足，无法生成摘要');
      return;
    }

    const settings = await new Promise(resolve => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, resolve);
    });
    if (!settings.apiKey) {
      showPageNotification(tab.id, '请先在扩展弹窗中配置 API Key');
      return;
    }

    const estimate = estimateTokens(content, settings.modelName);

    // For context menu/shortcut, auto-proceed (can't show confirmation dialog)
    const streamId = 'shortcut_' + Date.now();
    handleStreamSummarize(settings, content, streamId);

    // Store streamId for popup to pick up
    await chrome.storage.local.set({
      activeStream: { streamId, timestamp: Date.now(), estimate }
    });

    try {
      await chrome.runtime.sendMessage({
        action: 'showStreamReady',
        streamId: streamId,
        estimate: estimate
      });
    } catch {}

  } catch (err) {
    console.error('Summarize error:', err);
    try {
      await chrome.runtime.sendMessage({ action: 'showSummaryError', error: err.message });
    } catch {}
  }
}

// ========== Page Notification ==========
function showPageNotification(tabId, message, bg = '#fff0f0', color = '#c53030', border = '#fed7d7') {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (msg, bgColor, textColor, borderColor) => {
      const div = document.createElement('div');
      div.textContent = msg;
      div.style.cssText = [
        'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
        `padding:10px 16px`, `background:${bgColor}`, `border:1px solid ${borderColor}`,
        `color:${textColor}`, 'border-radius:8px', 'font-size:14px',
        'box-shadow:0 4px 16px rgba(0,0,0,0.15)', 'max-width:320px',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
        'animation:ceSlideIn 0.3s ease'
      ].join(';');

      if (!document.getElementById('ce-ext-style')) {
        const style = document.createElement('style');
        style.id = 'ce-ext-style';
        style.textContent = '@keyframes ceSlideIn{from{transform:translateX(100px);opacity:0}to{transform:translateX(0);opacity:1}}';
        document.head.appendChild(style);
      }
      document.body.appendChild(div);
      setTimeout(() => {
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.3s';
        setTimeout(() => div.remove(), 300);
      }, 4000);
    },
    args: [message, bg, color, border]
  }).catch(() => {});
}

// ========== Helpers ==========
function formatApiError(status, modelName, body) {
  switch (status) {
    case 400: return `请求参数错误 (400)。模型 "${modelName}" 可能不支持`;
    case 401: return 'API Key 无效 (401)。请检查 API Key 是否正确';
    case 403: return 'API 访问被拒绝 (403)。请检查 Key 权限和账户余额';
    case 404: return `API 端点或模型 "${modelName}" 不存在 (404)`;
    case 429: return 'API 调用频率超限 (429)，请稍后重试';
    case 500: case 502: case 503: return `API 服务器错误 (${status})，请稍后重试`;
    default: return `API 返回错误 (${status}): ${body.substring(0, 150)}`;
  }
}

function isVisionModel(modelName) {
  if (!modelName) return false;
  const lower = modelName.toLowerCase();
  const patterns = [
    'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-4-vision', 'gpt-5',
    'claude-3', 'claude-3.5', 'claude-4', 'claude-opus', 'claude-sonnet', 'claude-haiku',
    'gemini-1.5', 'gemini-2', 'gemini-pro', 'gemini-flash',
    'vision', 'multimodal', 'qvq', 'qwen-vl', 'qwen2-vl', 'pixtral', 'llava', 'cogvlm',
    'yi-vision', 'glm-4v'
  ];
  return patterns.some(p => lower.includes(p));
}

function langCodeToName(code) {
  if (!code) return '中文';
  const map = {
    'zh': '中文', 'zh-CN': '中文', 'zh-TW': '繁体中文',
    'en': '英文', 'en-US': '英文', 'en-GB': '英文',
    'ja': '日语', 'ja-JP': '日语', 'ko': '韩语', 'ko-KR': '韩语',
    'fr': '法语', 'de': '德语', 'es': '西班牙语', 'ru': '俄语',
  };
  return map[code] || map[code.split('-')[0]] || code;
}

function detectLanguageFromText(text) {
  if (!text) return 'zh-CN';
  const len = text.length || 1;
  if ((text.match(/[一-鿿㐀-䶿]/g) || []).length > len * 0.08) return 'zh-CN';
  if ((text.match(/[぀-ゟ゠-ヿ]/g) || []).length > len * 0.03) return 'ja';
  if ((text.match(/[가-힯]/g) || []).length > len * 0.03) return 'ko';
  return 'en';
}

// ========== Content Extraction (injected into page) ==========
function extractPageContent() {
  const data = {};

  data.title = document.title || '';
  data.url = window.location.href;
  data.hostname = window.location.hostname;

  // Meta tags
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

  // Language
  data.lang = document.documentElement.lang ||
    document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content') ||
    metaTags['og:locale'] || '';

  // Page type detection
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

  // --- Extract content based on page type ---
  let mainText = '';

  if (data.pageType === 'video') {
    // YouTube
    data.videoTitle = document.querySelector('h1.style-scope.ytd-watch-metadata')?.innerText?.trim()
      || document.querySelector('#title h1 yt-formatted-string')?.innerText?.trim()
      || document.querySelector('h1')?.innerText?.trim()
      || data.ogTitle || data.title;

    data.channelName = document.querySelector('#owner yt-formatted-string a')?.innerText?.trim()
      || document.querySelector('ytd-channel-name yt-formatted-string a')?.innerText?.trim()
      || '';

    data.videoDescription = document.querySelector('#description-inline-expander yt-attributed-string')?.innerText?.trim()
      || document.querySelector('#description yt-formatted-string')?.innerText?.trim()
      || '';

    // Duration
    const timeEl = document.querySelector('.ytp-time-duration')
      || document.querySelector('span.ytp-time-duration');
    if (timeEl) data.duration = timeEl.innerText.trim();

    // Bilibili
    if (!data.videoTitle) {
      data.videoTitle = document.querySelector('.video-title')?.innerText?.trim()
        || document.querySelector('h1.video-title')?.innerText?.trim()
        || data.title;
    }

    mainText = [data.videoTitle, data.videoDescription].filter(Boolean).join('\n\n');
    if (mainText.length < 100) {
      mainText = document.querySelector('article, main, [role="main"]')?.innerText
        || document.body.innerText.substring(0, 3000);
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

    // Look for transcripts, lyrics, show notes in the DOM
    const transcriptSelectors = [
      '.transcript', '[class*="transcript"]', '[class*="lyrics"]', '[class*="lyric"]',
      '[class*="shownotes"]', '[class*="show-notes"]', '[class*="description-text"]',
      '[class*="episode-notes"]', '[class*="track-description"]',
      '.TrackPage__lyrics', '.Lyrics__Container', '[data-testid="lyrics"]',
      '[class*="podcast-episode-description"]', '[class*="episode-description"]'
    ];
    for (const sel of transcriptSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 50) {
        data.transcript = el.innerText.trim().substring(0, 5000);
        break;
      }
    }

    mainText = document.querySelector('article, main, [role="main"]')?.innerText
      || document.body.innerText.substring(0, 3000);
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
      // Deduplicate by URL
      if (images.some(i => i.url === src)) continue;
      images.push({ url: src, alt: (img.alt || '').substring(0, 200) });
      if (images.length >= 5) break;
    }
    data.images = images;

    // Also get surrounding text context
    const article = document.querySelector('article, main, [role="main"]');
    if (article) {
      mainText = article.innerText.substring(0, 3000);
    } else {
      // Get headings and captions
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.innerText.trim()).join('\n');
      mainText = headings + '\n\n' + alts.slice(0, 10).join('\n');
    }
  } else {
    // Article / text page
    const article = document.querySelector('article');
    const main = document.querySelector('main');
    const contentSelectors = [
      '[role="main"]', '.post-content', '.article-content', '.entry-content',
      '.post-body', '.article-body', '#article-content', '.content-body',
      '.markdown-body', '.prose', '[data-testid="post-content"]'
    ];

    if (article) {
      mainText = article.innerText;
    } else if (main) {
      mainText = main.innerText;
    } else {
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.length > 100) {
          mainText = el.innerText;
          break;
        }
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

  // Clean whitespace
  mainText = mainText
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim();

  // Truncate — keep more for articles, less for multimedia
  // For image pages with vision, keep text short since images are analyzed visually
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
