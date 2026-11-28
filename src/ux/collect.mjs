/**
 * Coletor executado dentro da página (via page.evaluate). Precisa ser autocontido:
 * o Playwright serializa a função, então nada de referências externas.
 * Só mede e devolve dados crus; a decisão fica em evaluate.mjs.
 */
export const collectPageMetrics = ({ maxTexts = 400 } = {}) => {
  const doc = document.documentElement;

  const describe = (el) => {
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;
    if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
    const cls = [...el.classList].slice(0, 2).join('.');
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${text ? ` ("${text}")` : ''}`;
  };

  const isVisible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // Elementos que passam da borda direita, do mais largo para o menos.
  const widest = [...document.body.querySelectorAll('*')]
    .filter((el) => getComputedStyle(el).position !== 'fixed')
    .map((el) => ({ el, right: Math.round(el.getBoundingClientRect().right) }))
    .filter(({ right }) => right > window.innerWidth + 1)
    .sort((a, b) => b.right - a.right)
    // Mantém só o elemento mais externo de cada cadeia, que é o culpado acionável.
    .filter(({ el }, _i, all) => !all.some((o) => o.el !== el && o.el.contains(el)))
    .slice(0, 3)
    .map(({ el, right }) => ({ selector: describe(el), right }));

  const interactiveSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const interactive = [...document.querySelectorAll(interactiveSelector)].filter(isVisible);

  const targets = interactive.map((el) => {
    const rect = el.getBoundingClientRect();
    const parentText = (el.parentElement?.textContent || '').trim();
    const ownText = (el.textContent || '').trim();
    // Exceção WCAG 2.5.8: link dentro de frase não precisa de alvo mínimo.
    const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && parentText.length > ownText.length + 10;
    return { selector: describe(el), width: rect.width, height: rect.height, inline };
  });

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (text) return text;
    }
    if (el.labels && el.labels.length > 0) {
      const text = [...el.labels].map((l) => l.textContent || '').join(' ').trim();
      if (text) return text;
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value;
    const imgAlt = [...el.querySelectorAll('img[alt], svg title')].map((n) => n.getAttribute('alt') || n.textContent || '').join(' ').trim();
    if (imgAlt) return imgAlt;
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return (el.innerText || el.textContent || '').trim();
    return '';
  };

  const unnamed = interactive
    .filter((el) => !accessibleName(el))
    .map((el) => ({ selector: describe(el), role: el.getAttribute('role') || el.tagName.toLowerCase() }));

  const imagesWithoutAlt = [...document.querySelectorAll('img')]
    .filter((img) => isVisible(img) && !img.hasAttribute('alt'))
    .map((img) => ({ selector: describe(img) }));

  // Fundo efetivo: sobe na árvore até achar cor opaca. Imagem/gradiente no caminho torna a medição incerta.
  const effectiveBackground = (el) => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      const bg = style.backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (alpha > 0) {
          layers.push({ r: parts[0], g: parts[1], b: parts[2], a: alpha });
          if (alpha >= 1) break;
        }
      }
    }
    let base = { r: 255, g: 255, b: 255 };
    for (const layer of layers.reverse()) {
      base = {
        r: layer.r * layer.a + base.r * (1 - layer.a),
        g: layer.g * layer.a + base.g * (1 - layer.a),
        b: layer.b * layer.a + base.b * (1 - layer.a),
      };
    }
    return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
  };

  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode() && texts.length < maxTexts) {
    const node = walker.currentNode;
    const text = (node.textContent || '').trim();
    const el = node.parentElement;
    if (!text || !el || seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    const background = effectiveBackground(el);
    if (!background) continue;
    texts.push({
      selector: describe(el),
      text: text.replace(/\s+/g, ' ').slice(0, 40),
      color: style.color,
      background,
      fontSize: parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
    });
  }

  return {
    scrollWidth: doc.scrollWidth,
    innerWidth: window.innerWidth,
    widest,
    targets,
    unnamed,
    imagesWithoutAlt,
    texts,
  };
};
