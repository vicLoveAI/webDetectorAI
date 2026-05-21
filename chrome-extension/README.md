# Web Content AI Summarizer

One-click web page content summarization with streaming Markdown output. Supports custom LLM API configuration (OpenAI and all compatible APIs).

## Features

- **One-Click Summarize** — Click the toolbar icon, right-click context menu, or press `Ctrl+Shift+S` (Mac: `Cmd+Shift+S`)
- **Streaming Output** — AI-generated content appears in real-time, no need to wait for the full response
- **Markdown Rendering** — Results displayed as formatted Markdown with one-click copy
- **Multimodal Vision Support** — For image/video pages, sends actual images to vision-capable models (GPT-4o, Claude, Gemini, etc.) for visual content analysis instead of relying solely on text metadata
- **Content Type Recognition** — Auto-detects article/video/audio/image pages and applies different extraction and summarization strategies
- **Token Estimation** — Estimates token consumption before calling the API, with a confirmation dialog for high usage
- **Multi-Language Output** — Follows page language or specify output language (Chinese, English, Japanese, Korean, French, German)
- **Custom API** — Supports OpenAI and all OpenAI-compatible APIs (DeepSeek, Qwen, LiteLLM, etc.)
- **Model Discovery** — Fetch available models from your API endpoint with one click
- **Connection Test** — Verify your API configuration before use

## Installation

1. Open Chrome, navigate to `chrome://extensions/`
2. Enable **"Developer mode"** (toggle in top right)
3. Click **"Load unpacked"**
4. Select the extension folder (the directory containing `manifest.json`)
5. The extension icon will appear in your browser toolbar

## Configuration

### 1. Get an API Key

#### OpenAI
1. Visit [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Sign up / Log in and create an API Key
3. In the extension settings, enter:
   - API Base URL: `https://api.openai.com/v1`
   - API Key: `sk-...`
   - Click "Fetch Models" to get available models

#### DeepSeek
1. Visit [https://platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
2. Get your API Key
3. In settings, enter:
   - API Base URL: `https://api.deepseek.com/v1`
   - Model: `deepseek-chat`
   - **Note**: DeepSeek models do not support vision/image analysis

#### Other Compatible Providers
Any service compatible with the OpenAI Chat Completions API will work. For vision/image analysis, use a model that supports multimodal input (GPT-4o, GPT-4.1, Claude 3/4, Gemini 1.5/2.0, etc.).

### 2. Test Connection (Recommended)

1. Click the **"Test Connection"** button to verify your API is accessible
2. A success message will show "Connection successful" with available model count
3. If it fails, check the error message for details

### 3. Discover Available Models

1. Enter your API Base URL and API Key
2. Click the **"Fetch Models"** button
3. Click a model name from the dropdown to select it

## Usage

1. Open any webpage (blog post, news article, video page, image gallery, etc.)
2. **Option A**: Click the extension icon → click **"Summarize"**
3. **Option B**: Right-click on the page → select **"Summarize Page Content"**
4. **Option C**: Press `Ctrl+Shift+S` (Mac: `Cmd+Shift+S`)
5. The summary will appear in **real-time streaming**, no waiting for full generation
6. Click **"Copy Markdown"** to copy the raw text
7. Click **"Cancel"** during generation to stop

## Content Extraction Strategies

| Page Type | Extracted Content | Summary Format |
|-----------|------------------|----------------|
| Article/Blog | Title, description, body text (up to 8000 chars) | Title → Summary → Key Points → Conclusion |
| Video | Title, channel, duration, description, **thumbnail/frame for vision analysis** | Video Info → Visual Analysis → Content Summary → Key Highlights |
| Audio/Podcast | Title, creator, description, **transcripts/lyrics/show notes** | Audio Info → Content Summary → Key Content |
| Image Gallery | **Image URLs (up to 5) for vision analysis**, alt text, page context | Gallery Overview → Detailed Image Descriptions |

**Vision mode** is automatically enabled when:
- The page type is image, video, or audio with visual elements
- Your configured model supports multimodal input (e.g., GPT-4o, Claude, Gemini)
- If the model doesn't support vision, the extension falls back to text-only mode

## Token Estimation

- Pre-flight token estimation before each API call
- Normal usage (< 3,000 tokens): direct call
- High usage (3,000+ tokens): confirmation dialog
- Exceeds 90% of model limit: warning dialog
- Image tokens are included in estimates when vision mode is active (85 tokens/image)
- User can confirm or cancel in the dialog

## Privacy & Security

- **No data collection** — This extension collects absolutely no user data
- API Key stored locally via Chrome `storage.sync` encryption
- API Key input field is a password type with show/hide toggle
- All API requests are proxied through the background service worker using HTTPS
- Page text content is only sent to your own configured third-party API endpoint
- No ads, no tracking, no telemetry

## Tech Stack

- Manifest V3
- Vanilla HTML/CSS/JS (zero framework dependencies)
- Built-in lightweight Markdown renderer (zero dependencies)
- OpenAI Chat Completions API with SSE streaming
- Background Service Worker proxies all API requests
- No `host_permissions` required (Chrome Web Store compliant)

## License

MIT License
