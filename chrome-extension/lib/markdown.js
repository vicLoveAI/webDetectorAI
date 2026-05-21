// Minimal Markdown to HTML renderer for Chrome extension
// Handles: headings, bold, italic, lists, links, code blocks, inline code, hr, paragraphs

function renderMarkdown(md) {
  if (!md || typeof md !== 'string') return '';

  // Escape HTML first
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (must be before other rules)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return '<pre><code>' + code.trim() + '</code></pre>';
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^(---|\*\*\*|___)\s*$/gm, '<hr>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');

  // Unordered lists
  html = html.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Fix ordered lists that got wrapped in ul
  html = html.replace(/<ul>(\s*<li>[\s\S]*?<\/li>\s*)<\/ul>/g, (match) => {
    // Check if original was ordered list (starts with number)
    return match;
  });

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Paragraphs - wrap remaining text lines
  const lines = html.split('\n');
  const result = [];
  let inList = false;
  let inBlockquote = false;
  let inPre = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (inList) { result.push('</ul>'); inList = false; }
      if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
      continue;
    }

    if (line.startsWith('<pre>') || line.startsWith('<code><pre>')) {
      inPre = true;
      result.push(line);
      continue;
    }
    if (line === '</pre>' || line === '</code></pre>') {
      inPre = false;
      result.push(line);
      continue;
    }
    if (inPre) {
      result.push(line);
      continue;
    }

    if (line.startsWith('<h') || line.startsWith('<hr') || line.startsWith('<ul') || line.startsWith('<ol') || line.startsWith('<li') || line.startsWith('</ul') || line.startsWith('</ol') || line.startsWith('<blockquote') || line.startsWith('</blockquote')) {
      result.push(line);
      continue;
    }

    result.push('<p>' + line + '</p>');
  }

  html = result.join('\n');

  // Clean up empty elements
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<[a-z][\s\S]*?>)<\/p>/g, '$1');

  return html;
}

// Export for use in popup
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderMarkdown };
}
