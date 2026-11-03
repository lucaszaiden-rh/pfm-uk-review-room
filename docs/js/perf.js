// Explainable heuristic. Every factor, weight and wording lives in the encrypted weights JSON.

function luminance(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
  if (!m) return 0;
  const [r, g, b] = m.slice(1, 4).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const isNeon = (fill) => /rgba\((19[2-9]|20\d|21[0-6]),\s*(24\d|25[0-5]),\s*([0-2]?\d)\b/.test(fill || '');

// Reads the facts the factors test against from the current (edited) state of a piece.
export function facts(spec, state) {
  const headline = state.texts.headline ?? '';
  const headRuns = state.runs.headline || [];
  const headLayer = spec.layers.find((l) => l.role === 'headline');
  const bgDark = luminance(spec.background.css) < 0.05 && !state.hasPlate;
  return {
    concept: spec.concept,
    headline,
    headlineFlat: headline.replace(/\s+/g, ' ').trim(),
    headlineLines: state.headlineLines ?? headline.split('\n').length,
    tags: new Set(state.tags),
    kinds: new Set(spec.layers.map((l) => l.kind)),
    headFamily: headLayer?.style.family || '',
    neonNumber: headRuns.some((r) => isNeon(r.fill) && /\d/.test(r.t)),
    bgDark,
    safeZoneIssues: state.safeZoneIssues || [],
    format: spec.format,
  };
}

function testFactor(f, x) {
  const t = f.test;
  switch (t.type) {
    case 'always': return true;
    case 'headline-regex': return new RegExp(t.pattern, 'i').test(x.headlineFlat);
    case 'headline-all': return t.patterns.every((p) => x.headlineFlat.includes(p));
    case 'headline-words-max': return x.headlineFlat.split(' ').filter(Boolean).length <= t.value;
    case 'headline-lines-max': return x.headlineLines <= t.value;
    case 'visual-tag': return x.tags.has(t.tag);
    case 'visual-tag-any': return t.tags.some((g) => x.tags.has(g)) && !(t.unless && x.tags.has(t.unless));
    case 'has-layer': return x.kinds.has(t.kind);
    case 'localization': return x.bgDark && x.headFamily === t.family && x.neonNumber;
    case 'safe-zone': return x.format === '9x16' && x.safeZoneIssues.length > 0;
    default: return false;
  }
}

export function score(weights, x) {
  const drivers = [];
  let total = weights.base ?? 50;
  for (const f of weights.factors || []) {
    if (f.concept && f.concept !== x.concept) continue;
    const hit = testFactor(f, x);
    const side = hit ? f.pass : f.fail;
    if (!side) continue;
    const ov = (f.concepts && f.concepts[x.concept]) || {};
    const weight = ov.weight ?? side.weight;
    total += weight;
    drivers.push({ id: f.id, label: side.label, weight, fix: side.fix, evidence: ov.evidence || f.evidence, rule: f.rule });
  }
  total = Math.max(0, Math.min(100, Math.round(total)));
  drivers.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const top = drivers.slice(0, 5);
  const ev = weights.evidenceScore || { strong: 3, medium: 2, weak: 1 };
  const avgEv = top.length ? top.reduce((s, d) => s + (ev[d.evidence] || 1), 0) / top.length : 1;
  let confidence = avgEv >= (weights.confidence?.strongAt ?? 2.4) ? 'Medium' : 'Low';
  if (weights.confidence?.cap === 'Low') confidence = 'Low';
  const worst = drivers.filter((d) => d.weight < 0 && d.fix).sort((a, b) => a.weight - b.weight)[0];
  return { score: total, drivers: top, confidence, suggestion: worst ? worst.fix : 'Strongest drivers are in place. Keep the offer number and the hero as they are.' };
}

export function expectation(value, mean, bands) {
  const d = value - mean;
  if (d >= (bands?.above ?? 6)) return { key: 'above', label: 'Above set average' };
  if (d <= (bands?.below ?? -6)) return { key: 'below', label: 'Below set average' };
  return { key: 'at', label: 'At set average' };
}
