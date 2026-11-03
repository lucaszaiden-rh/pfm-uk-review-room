// Generic in-situ mockups (no third-party marks), built from real geometry and scaled uniformly.

const icon = {
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor"/></svg>',
  bubble: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5S16.4 19 12 19c-1 0-2-.2-2.9-.5L5 20l1-3.6c-1.3-1.3-2-3-2-4.9z" fill="currentColor"/></svg>',
  mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-3.5L7 20z" fill="currentColor"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5l7 7-7 7v-4c-5 0-8 1.5-10 5 .5-5.5 3.5-9.5 10-10.5z" fill="currentColor"/></svg>',
  oHeart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  oBubble: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5S16.4 19 12 19c-1 0-2-.2-2.9-.5L5 20l1-3.6c-1.3-1.3-2-3-2-4.9z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  oSend: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4L3 11l7 2.5L12.5 20z M10 13.5L20 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  oMark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-3.5L7 20z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
};

// iPhone 15 Pro in pt: screen 393 x 852 (1179 x 2556 @3x); 21 pt bezel ≈ 71.6 x 146.6 mm body.
export const DEVICE = {
  screenW: 393,
  screenH: 852,
  bezel: 21,
  radius: 55,
  island: { w: 126, h: 37, top: 11 },
  get bodyW() { return this.screenW + 2 * this.bezel; },
  get bodyH() { return this.screenH + 2 * this.bezel; },
};

// Laptop browser viewport and article column, CSS px.
export const PAGE = { w: 1280, h: 800, chrome: 40, column: 680, aside: 304, gap: 48 };

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const statusBar = () => `<div class="status" aria-hidden="true">
  <span class="ear"><span class="time">9:41</span></span>
  <span class="ear"><span class="sig"><i></i><i></i><i></i><i></i></span><span class="batt"><i></i></span></span>
</div>`;

function phoneShell(availW, availH, theme) {
  const pt = Math.max(0.1, Math.min(availW / DEVICE.bodyW, availH / DEVICE.bodyH));
  const root = el(`<div class="phone ${theme}" style="--pt:${pt}px;width:${DEVICE.bodyW * pt}px;height:${DEVICE.bodyH * pt}px">
    <div class="screen" style="width:${DEVICE.screenW * pt}px;height:${DEVICE.screenH * pt}px">
      <div class="island" aria-hidden="true"></div>
      ${statusBar()}
      <div class="home-ind" aria-hidden="true"></div>
    </div>
  </div>`);
  return { root, screen: root.querySelector('.screen'), pt };
}

// Returns { root, slot, scale, place?, expect? }; place positions the art-wrap inside a cover-cropped slot.
export function buildMock({ kind, W, H, availW, availH, caption, advertiser = 'Advertiser', mark = '' }) {
  const cap = esc((caption || '').replace(/\s+/g, ' ').trim());
  const av = mark ? `<div class="av has-mark">${mark}</div>` : '<div class="av"><i></i></div>';
  if (kind === 'flat') {
    const scale = Math.min(availW / W, availH / H);
    const root = el('<div class="flat"></div>');
    return { root, slot: root, scale };
  }

  if (kind === 'phone') {
    const { root, screen, pt } = phoneShell(availW, availH, 'is-video');
    const sw = DEVICE.screenW * pt;
    const sh = DEVICE.screenH * pt;
    const scale = Math.max(sw / W, sh / H);
    const place = { left: (sw - W * scale) / 2, top: (sh - H * scale) / 2 };
    const ui = el(`<div class="feed-ui">
      <div class="tabs-top"><span>Following</span><span class="on">For you</span></div>
      <div class="rr">
        ${av}
        <div>${icon.heart}<span>12.4k</span></div>
        <div>${icon.bubble}<span>318</span></div>
        <div>${icon.mark}<span>1,206</span></div>
        <div>${icon.send}<span>Share</span></div>
      </div>
      <div class="cap"><b>${esc(advertiser)}</b><span class="spons">Sponsored</span><span class="txt">${cap}</span></div>
      <div class="prog"><i></i></div>
    </div>`);
    screen.insertBefore(ui, screen.querySelector('.island'));
    return { root, slot: screen, scale, place, overlay: null, uiLayer: ui, expect: { screen, screenAspect: DEVICE.screenW / DEVICE.screenH, place, scale } };
  }

  if (kind === 'post') {
    const { root, screen, pt } = phoneShell(availW, availH, 'is-feed');
    const mw = DEVICE.screenW * pt;
    const scale = mw / W;
    const feed = el(`<div class="feed">
      <div class="feed-top"><span class="wordmark"></span><span class="ico">${icon.oHeart}</span><span class="ico">${icon.oSend}</span></div>
      <article class="post">
        <div class="post-head">${av}<div><b>${esc(advertiser)}</b><small>Sponsored</small></div><span class="more">•••</span></div>
        <div class="post-media" style="width:${W * scale}px;height:${H * scale}px"></div>
        <div class="post-cta"><span>Learn more</span>${icon.chev}</div>
        <div class="post-actions">${icon.oHeart}${icon.oBubble}${icon.oSend}<span class="sp">${icon.oMark}</span></div>
        <div class="post-text"><b>${esc(advertiser)}</b> ${cap}</div>
      </article>
      <div class="post-next"><div class="av"></div><span></span></div>
    </div>`);
    screen.insertBefore(feed, screen.querySelector('.island'));
    return { root, slot: feed.querySelector('.post-media'), scale, expect: { screen, screenAspect: DEVICE.screenW / DEVICE.screenH } };
  }

  const u = Math.max(0.1, Math.min(availW / PAGE.w, availH / PAGE.h));
  const slotW = PAGE.column * u;
  const scale = slotW / W;
  const root = el(`<div class="article" style="--u:${u}px;width:${PAGE.w * u}px;height:${PAGE.h * u}px">
    <div class="browser-bar"><span class="dots"><i></i><i></i><i></i></span><span class="url"></span></div>
    <div class="article-nav"><div class="logo"></div><span></span><span></span><span></span><span></span></div>
    <div class="article-grid">
      <div class="article-body">
        <div class="kick"></div>
        <div class="h"></div><div class="h s"></div>
        <div class="meta"></div>
        <div class="p"></div><div class="p"></div><div class="p s"></div>
        <div class="ad-slot"><small>Advertisement</small><div class="slot" style="width:${W * scale}px;height:${H * scale}px"></div></div>
        <div class="p"></div><div class="p"></div><div class="p s"></div>
      </div>
      <aside class="article-aside"><div class="card"></div><div class="row"></div><div class="row s"></div><div class="row"></div><div class="row s"></div></aside>
    </div>
  </div>`);
  return { root, slot: root.querySelector('.slot'), scale, expect: { screen: root, screenAspect: PAGE.w / PAGE.h } };
}

export function mockKindFor(format, insitu) {
  if (!insitu) return 'flat';
  if (format === '9x16') return 'phone';
  if (format === '1.91x1') return 'article';
  return 'post';
}
