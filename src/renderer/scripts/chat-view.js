/**
 * Chat View Renderer
 * Handles rendering conversation messages, formatting Markdown,
 * highlighting code blocks with highlight.js, and rendering math via KaTeX.
 */
class ChatView {
  constructor() {
    this.container = document.getElementById('chat-messages-container');
    this.welcomeScreen = document.getElementById('chat-welcome-screen');
  }

  /**
   * Clears the chat container and shows the welcome screen if empty.
   */
  clear() {
    this.container.innerHTML = '';
    if (this.welcomeScreen) {
      this.container.appendChild(this.welcomeScreen);
      this.welcomeScreen.style.display = 'flex';
    }
  }

  /**
   * Renders the complete message history for an active conversation.
   * @param {Array<Object>} messages
   */
  renderMessages(messages) {
    this.container.innerHTML = '';

    if (!messages || messages.length === 0) {
      if (this.welcomeScreen) {
        this.container.appendChild(this.welcomeScreen);
        this.welcomeScreen.style.display = 'flex';
      }
      return;
    }

    if (this.welcomeScreen) {
      this.welcomeScreen.style.display = 'none';
    }

    messages.forEach((msg) => {
      this.appendMessage(msg, false);
    });

    this.scrollToBottom();
  }

  /**
   * Appends a single message element to the viewport.
   * @param {Object} msg
   * @param {boolean} [shouldScroll=true]
   */
  appendMessage(msg, shouldScroll = true) {
    if (this.welcomeScreen) {
      this.welcomeScreen.style.display = 'none';
    }

    const isUser = msg.role === 'user';
    const messageEl = document.createElement('div');
    messageEl.className = `message ${isUser ? 'message--user' : 'message--model'}`;

    // Avatar
    const avatarEl = document.createElement('div');
    avatarEl.className = 'message__avatar';
    if (isUser) {
      avatarEl.innerHTML = '<svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
    } else {
      avatarEl.innerHTML = '<svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path></svg>';
    }

    // Bubble
    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'message__bubble';

    // Attachments preview (if any)
    if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const attachmentsContainer = document.createElement('div');
      attachmentsContainer.className = 'message__attachments';

      msg.attachments.forEach((filePath) => {
        const img = document.createElement('img');
        img.className = 'message__attachment-img';
        img.src = `file://${filePath}`;
        img.alt = 'Attached screenshot';
        img.loading = 'lazy';
        attachmentsContainer.appendChild(img);
      });

      bubbleEl.appendChild(attachmentsContainer);
    }

    // Message Content
    const contentEl = document.createElement('div');
    contentEl.className = 'message__content';

    if (isUser) {
      contentEl.textContent = msg.content || '';
    } else {
      contentEl.innerHTML = this.parseMarkdown(msg.content || '');
      this.enhanceCodeAndMath(contentEl);
    }

    bubbleEl.appendChild(contentEl);
    messageEl.appendChild(avatarEl);
    messageEl.appendChild(bubbleEl);
    this.container.appendChild(messageEl);

    if (shouldScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * Minimalist, robust Markdown parser for desktop chat.
   * @param {string} text
   * @returns {string} HTML string
   */
  parseMarkdown(text) {
    if (!text) return '';

    // Escape HTML tags to prevent XSS
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Fenced code blocks ```lang ... ```
    html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const validLang = lang ? lang.trim() : '';
      return `<pre><code class="language-${validLang}">${code.trim()}</code></pre>`;
    });

    // Inline code `...`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic *text*
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Lists
    html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gms, '<ul>$1</ul>');

    // Paragraphs
    const blocks = html.split(/\n{2,}/);
    html = blocks
      .map((block) => {
        const trimmed = block.trim();
        if (
          trimmed.startsWith('<h') ||
          trimmed.startsWith('<pre') ||
          trimmed.startsWith('<ul') ||
          trimmed.startsWith('$$')
        ) {
          return trimmed;
        }
        return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');

    return html;
  }

  /**
   * Applies syntax highlighting via highlight.js and renders LaTeX via KaTeX.
   * @param {HTMLElement} element
   */
  enhanceCodeAndMath(element) {
    // 1. Highlight code blocks
    if (window.hljs) {
      element.querySelectorAll('pre code').forEach((block) => {
        try {
          window.hljs.highlightElement(block);
        } catch (_e) {
          // Fallback unhighlighted
        }
      });
    }

    // 2. Render KaTeX expressions
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
        });
      } catch (_e) {
        // Fallback raw text
      }
    }
  }

  scrollToBottom() {
    const viewport = document.getElementById('chat-viewport');
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }
}

window.ChatView = ChatView;
