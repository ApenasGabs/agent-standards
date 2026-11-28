/**
 * Transforma as métricas coletadas na página em achados do Eixo UX.
 * Tudo aqui é puro: a página só mede, quem decide é este módulo.
 */

const clamp = (v) => Math.min(255, Math.max(0, v));

/** Aceita `rgb()`/`rgba()` (formato do getComputedStyle) e hex. Devolve null para o que não dá para medir. */
export const parseColor = (value) => {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const alphaRaw = rgb[4];
    const a = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
    return { r: clamp(Number(rgb[1])), g: clamp(Number(rgb[2])), b: clamp(Number(rgb[3])), a };
  }
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  return null;
};

/** Compõe uma cor com transparência sobre um fundo opaco. */
export const blend = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** Razão de contraste WCAG 2.x entre duas cores opacas. */
export const contrastRatio = (fg, bg) => {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
};

/** Texto grande (WCAG): ≥ 24px, ou ≥ 18.66px em negrito. */
export const isLargeText = (fontSize, fontWeight) => fontSize >= 24 || (fontSize >= 18.66 && Number(fontWeight) >= 700);

const MAX_PER_CHECK = 10;

const finding = (ruleId, severity, description, selector = null) => ({ ruleId, severity, description, selector });

const capped = (items, build) => {
  const out = items.slice(0, MAX_PER_CHECK).map(build);
  if (items.length > MAX_PER_CHECK) out.push(finding(out[0].ruleId, 'info', `…e mais ${items.length - MAX_PER_CHECK} ocorrência(s) do mesmo tipo.`));
  return out;
};

/**
 * @param {object} metrics resultado de collectPageMetrics
 * @param {{ width: number, touch: boolean }} viewport
 * @param {{ minTapTarget: number, minContrast: number }} thresholds
 */
export const evaluateMetrics = (metrics, viewport, thresholds) => {
  // Sem a viewport aplicada, todas as outras medidas descrevem outra tela.
  if (Math.abs(metrics.innerWidth - viewport.width) > 1) {
    return [
      finding(
        'ux-viewport-mismatch',
        'hard',
        `A página renderizou com ${metrics.innerWidth}px de largura, não ${viewport.width}px: resultado inválido. Conecte pelo protocolo Playwright (não CDP).`
      ),
    ];
  }
  const out = [];
  if (metrics.scrollWidth > metrics.innerWidth + 1) {
    out.push(
      finding(
        'ux-horizontal-overflow',
        'hard',
        `Overflow horizontal: conteúdo com ${metrics.scrollWidth}px numa viewport de ${metrics.innerWidth}px.` +
          (metrics.widest?.length ? ` Mais largos: ${metrics.widest.map((w) => `${w.selector} (${w.right}px)`).join(', ')}.` : ''),
        metrics.widest?.[0]?.selector ?? null
      )
    );
  }

  if (viewport.touch) {
    const small = (metrics.targets ?? []).filter((t) => !t.inline && (t.width < thresholds.minTapTarget || t.height < thresholds.minTapTarget));
    out.push(
      ...(small.length > 0
        ? capped(small, (t) =>
            finding('ux-tap-target', 'medium', `Alvo de toque com ${Math.round(t.width)}×${Math.round(t.height)}px (mínimo ${thresholds.minTapTarget}×${thresholds.minTapTarget}).`, t.selector)
          )
        : [])
    );
  }

  const unnamed = metrics.unnamed ?? [];
  if (unnamed.length > 0) {
    out.push(...capped(unnamed, (u) => finding('ux-accessible-name', 'medium', `${u.role} sem nome acessível (texto, aria-label ou label associado).`, u.selector)));
  }

  const noAlt = metrics.imagesWithoutAlt ?? [];
  if (noAlt.length > 0) {
    out.push(...capped(noAlt, (i) => finding('ux-image-alt', 'medium', 'Imagem sem atributo `alt` (use `alt=""` se for decorativa).', i.selector)));
  }

  const lowContrast = (metrics.texts ?? [])
    .map((t) => {
      const fg = parseColor(t.color);
      const bg = parseColor(t.background);
      if (!fg || !bg || bg.a < 1) return null;
      const ratio = contrastRatio(fg.a < 1 ? blend(fg, bg) : fg, bg);
      const min = isLargeText(t.fontSize, t.fontWeight) ? Math.min(3, thresholds.minContrast) : thresholds.minContrast;
      return ratio < min ? { ...t, ratio, min } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.ratio - b.ratio);
  if (lowContrast.length > 0) {
    out.push(
      ...capped(lowContrast, (t) =>
        finding('ux-contrast', 'medium', `Contraste ${t.ratio}:1 (mínimo ${t.min}:1) em "${t.text}" — ${t.color} sobre ${t.background}.`, t.selector)
      )
    );
  }
  return out;
};

/** Erros de runtime capturados durante a navegação. */
export const evaluateRuntime = ({ pageErrors = [], consoleErrors = [], navigation = null }) => [
  ...(navigation && !navigation.ok ? [finding('ux-navigation', 'hard', `A rota não carregou: ${navigation.reason}.`)] : []),
  ...pageErrors.slice(0, 5).map((e) => finding('ux-page-error', 'hard', `Exceção não tratada na página: ${e}`)),
  ...consoleErrors.slice(0, 5).map((e) => finding('ux-console-error', 'medium', `console.error: ${e}`)),
];

/**
 * Temas genéricos podem não pegar em apps com mecanismo próprio. Se todos os temas renderizam o
 * mesmo fundo numa rota/viewport, a matriz de temas é ilusória: melhor dizer isso do que aprovar.
 */
export const markThemesNotApplied = (matrix) => {
  const groups = new Map();
  for (const m of matrix) {
    if (!m.canvas) continue;
    const key = `${m.route}|${m.viewport.width}x${m.viewport.height}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const entries of groups.values()) {
    const themes = [...new Set(entries.map((e) => e.theme))];
    if (themes.length < 2 || new Set(entries.map((e) => e.canvas)).size !== 1) continue;
    for (const e of entries) {
      e.findings.push(
        finding(
          'ux-theme-not-applied',
          'medium',
          `Os temas ${themes.join(', ')} renderizaram o mesmo fundo (${e.canvas}): o app não aplicou o tema por esse mecanismo. Configure ux.themes no projeto ou confirme que ele tem um tema só.`
        )
      );
    }
  }
  return matrix;
};

export const summarize = (matrix) => {
  const all = matrix.flatMap((m) => m.findings);
  const hard = all.filter((f) => f.severity === 'hard').length;
  const medium = all.filter((f) => f.severity === 'medium').length;
  return { combinations: matrix.length, hard, medium, status: hard > 0 ? 'NEEDS_CHANGES' : medium > 0 ? 'NEEDS_CONFIRMATION' : 'APPROVED' };
};
