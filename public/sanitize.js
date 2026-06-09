// sanitize.js — client-side HTML sanitizer for calendar event descriptions.
//
// Only allows a small whitelist of safe inline/block tags.
// <a> href attributes are validated to http/https/mailto only.
// Everything else (script, style, onclick, data-*, etc.) is stripped.
//
// Usage:
//   const clean = sanitizeHtml('<b>hello</b> <script>bad</script>');
//   element.innerHTML = clean;

(function (global) {
  const ALLOWED = new Set(['br', 'a', 'b', 'i', 'u', 'strong', 'em', 'p', 'span']);

  function walkNode(src) {
    // Text nodes — safe as-is
    if (src.nodeType === Node.TEXT_NODE) return src.cloneNode();

    // Skip everything that isn't an element (comments, processing instructions, etc.)
    if (src.nodeType !== Node.ELEMENT_NODE) return null;

    const tag = src.tagName.toLowerCase();

    if (!ALLOWED.has(tag)) {
      // Disallowed tag — keep its children but unwrap the tag itself
      const frag = document.createDocumentFragment();
      src.childNodes.forEach(c => {
        const n = walkNode(c);
        if (n) frag.appendChild(n);
      });
      return frag;
    }

    const el = document.createElement(tag);

    if (tag === 'a') {
      const href = (src.getAttribute('href') || '').trim();
      // Only allow safe URL schemes
      if (/^(https?:|mailto:)/i.test(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      // Carry over visible text / child nodes regardless of href validity
    }

    src.childNodes.forEach(c => {
      const n = walkNode(c);
      if (n) el.appendChild(n);
    });
    return el;
  }

  function sanitizeHtml(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = document.createElement('div');
    doc.body.childNodes.forEach(c => {
      const n = walkNode(c);
      if (n) out.appendChild(n);
    });
    return out.innerHTML;
  }

  // Export for both module and browser-global contexts
  if (typeof module !== 'undefined') {
    module.exports = { sanitizeHtml };
  } else {
    global.sanitizeHtml = sanitizeHtml;
  }
})(typeof window !== 'undefined' ? window : this);
