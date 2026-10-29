/* Versus Arena — vanilla JS single-page app (hash routing). */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const WD = '日月火水木金土';
  const jpDate = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]}) ${d.getHours()}時${pad2(d.getMinutes())}分`;
  };
  const fullDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}時${pad2(d.getMinutes())}分`;
  };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    return `${Math.floor(s / 86400)}日前`;
  };

  let CONFIG = null;
  // 「10月24日(土) 23時00分」 in Japan time, whatever the viewer's clock says
  const jstEnd = (iso) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.month}月${p.day}日(${p.weekday}) ${p.hour}時${p.minute}分`;
  };
  const SWITCH_HELP = `<p>スイッチ設定で、相手の1戦目使用キャラに応じて自分の1戦目使用キャラを切り替えられます（50体まで）。</p>
    <p>切り替えは相手が最初に選んだキャラに対して1回だけで、相手のスイッチ後のキャラには反応しません。</p>
    <p>ロビーで選んだキャラと同じキャラや、次の組み合わせ（ダッシュファイター）には切り替わりません。</p>
    <ul class="dots"><li>ピーチとデイジー</li><li>マルスとルキナ</li><li>サムスとダークサムス</li><li>ピットとブラックピット</li><li>ロイとクロム</li><li>リュウとケン</li><li>シモンとリヒター</li></ul>
    <p>スイッチ設定がある場合、マッチング待ちの間は自分の使用キャラと拒否ステージが「？」と表示されます（対戦相手が決まった時点で決まります）。</p>
    <p>切り替わった対戦は、レーティング対戦の対戦一覧と対戦履歴に「スイッチ」と表示されます。</p>
    <p><b>おまかせ</b>：1戦目使用キャラを「おまかせ」にすると、ゲームのキャラ選択で「おまかせ」を選んで戦います。おまかせを選んだ場合、スイッチ設定は使われません。</p>
    <p>2戦目以降、勝者はキャラクターを変更できません。直前の敗者のみ変更できます。</p>`;
  // Features this site shows as 準備中 (from config.json; these three are closed everywhere)
  const closed = (feature) => (CONFIG?.closed ?? ['tournaments', 'gacha', 'minimum']).includes(feature);
  // The default top-page text describes only what this site actually offers
  const defaultHomeIntro = () => {
    if (CONFIG?.edition === 'sbr') {
      return '{{site}} は、スマメイトの「レーティング対戦」を再現した、個人運営のファンサイトです。実力の近いプレイヤーとマッチングして対戦し、勝敗報告でレートが変動します。ランキングや対戦履歴もあります。\n\n'
        + '登録・ログインはDiscordアカウントだけ。メールアドレスやパスワードの登録は不要で、Discordから受け取る情報も最小限です。詳しくは下の「安全への取り組み」をご覧ください。';
    }
    const offers = [
      !closed('free') && '気軽に相手を募集できるフリー対戦',
      '実力に応じたレートで競うレーティング対戦',
      !closed('tournaments') && 'ユーザーが主催するトーナメント大会',
      !closed('diaries') && 'すべてのプレイヤーに公開されるプレイヤー日記',
    ].filter(Boolean);
    return `{{site}} は、オンライン対戦を楽しむプレイヤーのための対戦・交流サービスです。登録すると、${offers.join('、')}${offers.length > 1 ? 'などを' : 'を'}利用できます。`;
  };
  let me = null;
  const FREE_OPEN_MS = 3 * 3600_000;

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------- Storage (guarded) ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- Auth (server-side session in HttpOnly cookies) ----------
  // Tokens never reach JavaScript. The readable __Host-csrf cookie only marks
  // "signed in" and is echoed back in X-CSRF-Token on writes (double submit).
  const getCookie = (name) => {
    const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
  };
  const auth = {
    get signedIn() { return Boolean(getCookie('__Host-csrf')); },
    async logout() {
      try {
        const { logoutUrl } = await api('/api/auth/logout', { method: 'POST' });
        me = null;
        location.assign(logoutUrl);
      } catch {
        location.reload();
      }
    },
  };

  // ---------- API (same origin, cookies sent automatically) ----------
  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    // Signed in: double-submit token. Signed out (login/sign-up forms): any non-empty
    // custom header — the server additionally requires our exact Origin.
    if (method !== 'GET') headers['x-csrf-token'] = getCookie('__Host-csrf') || 'anon';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || (res.status === 401 ? 'ログインが必要です' : `エラー (${res.status})`));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function loadMe() {
    if (!auth.signedIn) { me = null; return; }
    try { me = await api('/api/me'); } catch (e) { if (e.status === 401) me = null; }
  }

  const loginButtons = () => `
    <button class="acc-btn acc-blue" data-login="">ログイン＆新規登録</button>`;
  // Every login button leads to the Discord login page
  function bindLoginButtons(root) {
    root.querySelectorAll('[data-login]').forEach((b) => b.addEventListener('click', () => {
      session.set('va.return', location.hash || '#/');
      location.hash = '#/login';
    }));
  }

  function renderDrawerAccount() {
    const head = $('#dr-login-head');
    const box_ = $('#dr-account');
    if (me) {
      head.textContent = 'ログイン中です';
      box_.innerHTML = `<div class="dr-row"><a href="#/mypage">マイページ</a><button id="dr-logout">ログアウト</button></div>
        ${me.isAdmin ? '<div class="dr-row"><a href="#/admin">管理ページ</a><a href="#/admin/contacts">お問い合わせ一覧</a></div>' : ''}`;
      $('#dr-logout').addEventListener('click', () => auth.logout());
    } else {
      head.textContent = 'ログインしていません';
      box_.innerHTML = '<div class="dr-row" data-style="grid-template-columns:1fr"><button type="button" data-login="">ログイン＆新規登録</button></div>';
      bindLoginButtons(box_);
    }
  }

  function setDrawer(open) {
    $('#drawer').classList.toggle('open', open);
    $('#drawer').setAttribute('aria-hidden', String(!open));
    $('#drawer-overlay').hidden = !open;
    $('#menu-btn').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('drawer-open', open);
  }

  function renderAccount() {
    renderDrawerAccount();
    renderNotice();
    const el = $('#account');
    if (me) {
      el.innerHTML = `
        <div class="acc-links">${me.isAdmin ? '<a href="#/admin">管理</a>' : ''}<a href="#/mypage">マイページ</a><button id="logout">ログアウト</button></div>`;
      $('#logout').addEventListener('click', () => auth.logout());
    } else {
      el.innerHTML = loginButtons();
      bindLoginButtons(el);
    }
  }

  function requireLogin(crumb = 'ログイン') {
    if (me) return true;
    app.innerHTML = layout({
      crumb,
      title: crumb,
      single: box('ログインが必要です', `<p>この機能を利用するにはログインしてください。アカウントは無料で作成できます。</p><div data-style="max-width:300px;display:grid;gap:6px">${loginButtons()}</div>`),
    });
    bindLoginButtons(app);
    return false;
  }

  // ---------- UI helpers ----------
  const fighterImg = (f) => {
    const i = window.FIGHTERS.indexOf(f);
    return i < 0 ? '' : `assets/fighters/${pad2(i + 1)}.png`;
  };
  // "おまかせ" (the game's random select) shows as a black tile with white text, sized like any fighter image
  const OMAKASE_TILE = '<svg viewBox="0 0 48 24" aria-hidden="true"><text x="24" y="16.2" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff">おまかせ</text></svg>';
  const fthumb = (f, cls = '') => (f === 'おまかせ'
    ? `<span class="fthumb omk-thumb ${cls}" title="おまかせ" role="img" aria-label="おまかせ">${OMAKASE_TILE}</span>`
    : f && fighterImg(f) ? `<span class="fthumb ${cls}" title="${esc(f)}"><img src="${fighterImg(f)}" alt="${esc(f)}" loading="lazy"></span>` : '');
  // A player's character = the one opponents voted for most; "?" until someone has voted
  const unknownThumb = (cls, title) => `<span class="fthumb ${cls}" title="${title}"><img src="assets/fighter-unknown.jpg" alt="${title}" loading="lazy"></span>`;
  const mainThumb = (f, cls = '') => fthumb(f, cls) || unknownThumb(cls, 'キャラ投票なし');
  // Profile image if the user uploaded one (falls back to the silhouette)
  const avatar = (cls = '', uid = '') =>
    `<span class="avatar ${cls}">${uid ? `<img src="avatars/${esc(uid)}.jpg" alt="" loading="lazy" data-fb>` : ''}</span>`;
  // Shown beside the site owner's name so players know who runs the site
  const ADMIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5 4.5 5.6v6.1c0 4.6 3.2 8.4 7.5 9.8 4.3-1.4 7.5-5.2 7.5-9.8V5.6L12 2.5z"/><path class="tick" d="m8.6 12.2 2.3 2.3 4.5-4.6"/></svg>';
  const adminBadge = (isAdmin) => (isAdmin ? `<span class="adm-badge" title="管理者">${ADMIN_SVG}<span>管理者</span></span>` : '');
  const userLink = (id, name, cls = '') => `<a class="${cls}" href="#/users/${esc(id)}">${esc(name)}</a>`;

  const box = (title, body, cls = '') => `<section><h2 class="box-head">${title}</h2><div class="box-body ${cls}">${body}</div></section>`;
  const boxList = (title, body) => `<section><h2 class="box-head">${title}</h2><div data-style="margin-top:14px">${body}</div></section>`;

  function layout({ crumb, title, side, main, single, sideRight = false, home = false }) {
    return `
      ${crumb ? `<ol class="crumb"><li><a href="#/">ホーム</a></li>${(Array.isArray(crumb) ? crumb : [crumb]).map((c) => `<li>${c}</li>`).join('')}</ol>` : ''}
      <h1 class="page-title ${home ? 'home' : ''}">${esc(title)}</h1>
      ${single ?? `<div class="cols ${sideRight ? 'side-right' : ''}"><aside class="col-side">${side}</aside><div class="col-main">${main}</div></div>`}`;
  }
  const crumbLink = (href, label) => `<a href="${href}">${esc(label)}</a>`;

  const fighterOptions = (selected, { omakase = false } = {}) =>
    `<option value="">（未設定）</option>${omakase ? `<option ${selected === 'おまかせ' ? 'selected' : ''}>おまかせ</option>` : ''}${window.FIGHTERS.map((f) => `<option ${f === selected ? 'selected' : ''}>${esc(f)}</option>`).join('')}`;
  const errorBox = (e) => `<div class="error-box">${esc(e.message || e)}</div>`;
  const formData = (form) => Object.fromEntries(new FormData(form).entries());
  const spinner = '<div class="spinner"></div>';

  async function withBusy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { toast(e.message); } finally { if (btn) btn.disabled = false; }
  }

  // Page-scoped timers are cleared on navigation. They also pause while the tab is hidden —
  // a phone in a pocket should not keep polling — and catch up the moment it is looked at again.
  let timers = [];
  let pollers = [];
  const every = (ms, fn) => {
    const id = setInterval(() => { if (!document.hidden) fn(); }, ms);
    timers.push(id);
    pollers.push(fn);
    return id;
  };
  const clearTimers = () => { timers.forEach(clearInterval); timers = []; pollers = []; };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const fn of pollers) { try { fn(); } catch { /* page may be mid-navigation */ } }
  });

  // ---------- Shared list renderers ----------
  function playerCell(id, name, fighter, extra = '') {
    if (!id) return `<div class="mrow-p">${avatar()}<div class="pinfo"><span class="pname wait">対戦相手を募集中…</span></div></div>`;
    return `<div class="mrow-p">${avatar('', id)}<div class="pinfo"><a class="pname" href="#/users/${esc(id)}">${esc(name)}</a>${mainThumb(fighter)}${extra}</div></div>`;
  }

  function freeStatus(r) {
    if (r.status === 'open' && Date.now() - new Date(r.createdAt).getTime() > FREE_OPEN_MS) return '<span class="tag tag-end">期限切れ</span>';
    return { open: '<span class="tag tag-open">募集中</span>', matched: '<span class="tag tag-live">対戦中</span>', closed: '<span class="tag tag-done">済</span>' }[r.status] || '';
  }
  const freeRows = (rooms) => rooms.length
    ? rooms.map((r) => `<div class="mrow link" data-href="#/free/${esc(r.roomId)}">
        <div class="mrow-id">${freeStatus(r)}<a class="no" href="#/free/${esc(r.roomId)}">${r.roomNo ?? '-'}</a><span class="ago">${ago(r.createdAt)}</span></div>
        ${playerCell(r.hostId, r.hostName, r.hostFighter)}
        ${playerCell(r.guestId, r.guestName, r.guestFighter)}
      </div>`).join('')
    : '<p class="empty">まだ募集はありません</p>';

  const rateStatusTag = (s) => ({ playing: '<span class="tag tag-live">対戦中</span>', done: '<span class="tag tag-end">終了</span>', disputed: '<span class="tag tag-warn">無効</span>', cancelled: '<span class="tag tag-end">中止</span>' }[s] || '');
  // Rated room list (lobby): layout measured from the original phone screenshot
  const PLUG = '<svg class="plug" viewBox="0 0 16 16" aria-label="有線"><path d="M10.5 1.5 8.8 3.2 7.6 2 6.2 3.4l1.2 1.2L5 7c-.9.9-1 2.3-.3 3.3L2 13l1 1 2.7-2.7c1 .7 2.4.6 3.3-.3l2.4-2.4 1.2 1.2 1.4-1.4-1.2-1.2 1.7-1.7-1.4-1.4-1.7 1.7-1.6-1.6 1.7-1.7z"/></svg>';
  const agoSec = (iso) => {
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `${s}秒前`;
    return ago(iso);
  };
  const rateRows = (matches) => matches.length
    ? matches.map((m) => {
      // Your own rooms open from the list; on a site with public rooms, every room does
      const mine = (me && m.players.includes(me.userId)) || CONFIG?.publicRooms;
      const label = { playing: ['対戦', 'rr-live'], done: ['終了', 'rr-end'], disputed: ['無効', 'rr-end'], cancelled: ['中止', 'rr-end'] }[m.status] || ['', ''];
      const cell = (uid) => {
        const p = m.playerInfo[uid] || {};
        return `<div class="rr-p">${avatar('rrav', uid)}<div class="rr-info"><a class="rr-name" href="#/users/${esc(uid)}">${p.wired ? PLUG : ''}<span>${esc(p.name || '')}</span></a>${fthumb(p.fighter, 'rrf') || '<span class="fthumb rrf"></span>'}${p.switched ? '<span class="rr-switch">スイッチ</span>' : ''}</div></div>`;
      };
      const over = m.status !== 'playing' && m.status !== 'waiting';
      return `<div class="rr-row mrow ${mine ? 'link' : ''} ${over ? 'rr-over' : ''}" ${mine ? `data-href="#/match/${esc(m.matchId)}"` : ''}>
        <div class="rr-id"><span class="rr-tag ${label[1]}">${label[0]}</span><b>${m.matchNo ?? '-'}</b><span class="rr-ago">${agoSec(m.matchedAt || m.createdAt)}</span></div>
        ${cell(m.players[0])}${cell(m.players[1])}
      </div>`;
    }).join('')
    : '<p class="empty">まだ対戦はありません</p>';

  function bindRowLinks(root) {
    root.querySelectorAll('.mrow[data-href]').forEach((r) => r.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // links inside the row (player names) win
      location.hash = r.dataset.href;
    }));
  }

  function countdown(t) {
    if (t.status === 'running') return '<div class="tcount"><span class="tag tag-live">開催中</span></div>';
    if (t.status === 'finished') return '<div class="tcount"><span class="tag tag-end">終了</span></div>';
    return `<div class="tcount" data-until="${esc(t.startAt)}"></div>`;
  }
  function tickCountdowns() {
    document.querySelectorAll('[data-until]').forEach((el) => {
      const ms = new Date(el.dataset.until).getTime() - Date.now();
      if (ms <= 0) { el.innerHTML = '<span class="lbl">エントリー受付終了</span>'; return; }
      const s = Math.floor(ms / 1000);
      el.innerHTML = `<span class="lbl">エントリー締切</span>まで残り <b>${Math.floor(s / 86400)}</b>日 <b>${pad2(Math.floor(s / 3600) % 24)}</b>時 <b>${pad2(Math.floor(s / 60) % 60)}</b>分 <b>${pad2(s % 60)}</b>秒`;
    });
  }

  const tourItems = (items) => items.length
    ? items.map((t) => `<div class="titem">
        <a class="ttitle" href="#/tournaments/${esc(t.tourId)}">${jpDate(t.startAt)} ${esc(t.title)}</a>
        <div class="tdesc">${esc(t.description || t.rule)}</div>
        ${countdown(t)}
        <div class="torg">${avatar('sm', t.organizerId)}<a href="#/users/${esc(t.organizerId)}">主催者：${esc(t.organizerName)}</a></div>
      </div>`).join('')
    : '<p class="empty">開催予定の大会はありません</p>';

  const isNew = (iso) => Date.now() - new Date(iso).getTime() < 86400_000;
  const diaryItems = (items) => items.length
    ? items.map((d) => `<div class="ditem">
        <a class="dtitle" href="#/users/${esc(d.userId)}/diaries/${esc(d.diaryId)}">${esc(d.title)}(${d.commentCount || 0})</a>${isNew(d.createdAt) ? '<span class="new">new!</span>' : ''}
        <div class="dexcerpt">${esc(d.body)}</div>
        <div class="dauthor">${avatar('sm', d.userId)}<a href="#/users/${esc(d.userId)}">${esc(d.userName)}</a></div>
      </div>`).join('')
    : '<p class="empty">まだ日記はありません</p>';

  function rankingRows(players, { compact = false, numbered = true, empty = 'まだランキング対象のプレイヤーがいません' } = {}) {
    if (!players.length) return `<p class="empty">${esc(empty)}</p>`;
    // Same row layout for the home box and the ranking page (measured from the original)
    return `<div class="rk2">${players.map((p, i) => `<div class="rk2-row"><span class="rk2-no">${numbered ? i + 1 : ''}</span>${avatar('rk2av', p.userId)}<a class="rk2-name" href="#/users/${esc(p.userId)}">${esc(p.name)}</a>${mainThumb(p.fighter, 'rk2f')}<span class="rk2-rate">${p.rating}</span></div>`).join('')}</div>`;
    // eslint-disable-next-line no-unreachable
    return `<div class="${compact ? 'rk-compact' : ''}">${players.map((p, i) => compact
      // Fixed-height row like the original home ranking; empty character box when not set
      ? `<div class="rk-row hr-row"><div class="rk-no">${i + 1}</div>${avatar('hr', p.userId)}<div class="hr-mid"><div class="rk-name">${userLink(p.userId, p.name)}</div>${mainThumb(p.fighter, 'hrc')}</div><div class="rk-rate">${p.rating}</div></div>`
      : `<div class="rk-row"><div class="rk-no">${i + 1}</div>${avatar('md', p.userId)}<div class="rk-name">${userLink(p.userId, p.name)}</div><div class="rk-f">${mainThumb(p.fighter)}</div><div class="rk-rate">${p.rating}</div></div>`).join('')}</div>`;
  }

  // ---------- Chat ----------
  function mountChat(root, basePath, { readOnly = false } = {}) {
    // Original layout: [更新する] / textarea / [コメントする] (right) / comment list (newest first)
    root.innerHTML = `
      <div class="cmt-area">
        <button type="button" class="btn-line rc-refresh" id="chat-refresh"><svg class="ic-refresh" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 2.4v4.2H9.4l1.6-1.6A4.6 4.6 0 0 0 3.5 6.7H1.6A6.4 6.4 0 0 1 12.3 3.7l1.3-1.3zM2.4 13.6V9.4h4.2L5 11a4.6 4.6 0 0 0 7.5-1.7h1.9A6.4 6.4 0 0 1 3.7 12.3l-1.3 1.3z"/></svg><span>更新する</span></button>
        ${readOnly ? '' : '<form id="chat-form"><textarea name="text" maxlength="300" rows="3" required></textarea><div class="cmt-submit"><button class="btn-blue2">コメントする</button></div></form>'}
        <div id="chat-log"><p class="cmt-none">コメントはありません。</p></div>
      </div>`;
    const log = $('#chat-log', root);
    let last = '';
    let empty = true;
    async function pull() {
      try {
        const { messages } = await api(`${basePath}/messages${last ? `?after=${encodeURIComponent(last)}` : ''}`);
        if (!messages.length) return;
        if (empty) { log.innerHTML = ''; empty = false; }
        for (const m of messages) {
          const div = document.createElement('div');
          div.className = 'rc';
          const d = new Date(m.at);
          div.innerHTML = `<div class="rc-head">${avatar('rcav', m.userId)}${userLink(m.userId, m.name)}<span class="rc-date">${d.getMonth() + 1}月${d.getDate()}日<br>${pad2(d.getHours())}時${pad2(d.getMinutes())}分</span></div><div class="rc-body">${esc(m.text)}</div>`;
          log.prepend(div);
          last = m.id;
        }
      } catch { /* transient */ }
    }
    pull();
    every(6000, pull);
    $('#chat-refresh', root).addEventListener('click', pull);
    const form = $('#chat-form', root);
    form?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = form.elements.text;
      const value = input.value.trim();
      if (!value) return;
      input.value = '';
      try { await api(`${basePath}/messages`, { method: 'POST', body: { text: value } }); await pull(); } catch (e) { toast(e.message); input.value = value; }
    });
  }

  // ---------- Notices ----------
  // ---------- Site settings (defaults; overridden by the admin page) ----------
  // "{{site}}" in any text is replaced with the site name.
  const SITE = {
    // The page shell may name the site (each deployment can differ); the admin page overrides it
    siteName: document.documentElement.dataset.siteName || 'Versus Arena',
    homeIntro: '', // empty = defaultHomeIntro()
    footer: 'ゲームタイトルおよびキャラクター名は、各権利者の商標または登録商標です。\n当サイトは個人が運営する非公式のファン向けWebサービスであり、ゲームの権利者・関連企業とは一切関係ありません。',
    notices: [
      { id: 'open', at: '2026-10-25', title: '【お知らせ】{{site}} を公開しました', body: 'フリー対戦・レーティング対戦・大会・プレイヤー日記・ランキングの各機能をご利用いただけます。ご意見・不具合のご報告はお問い合わせページからお寄せください。' },
    ],
    docs: null, // only pages the admin has edited; the rest come from defaultDocs()
  };
  const siteName = () => SITE.siteName;
  const fill = (s) => String(s ?? '').split('{{site}}').join(esc(SITE.siteName)); // for already-escaped / HTML text
  const fillText = (s) => fill(esc(s)); // for plain text
  const paras = (s) => String(s || '').split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${fillText(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

  function applySite() {
    document.title = siteName();
    const img = $('.logo img');
    if (img) img.alt = siteName();
    const txt = $('.logo-text');
    if (txt) txt.textContent = siteName();
    if (hasDoc('security') && !$('#drawer a[href="#/security"]')) {
      $('#drawer a[href="#/privacy"]')?.insertAdjacentHTML('afterend', '<a href="#/security">安全への取り組み</a>');
    }
    $('#footer').innerHTML = `${String(SITE.footer || '').split('\n').filter(Boolean).map((l) => `<p>${fillText(l)}</p>`).join('')}
      <p class="ft-links"><a href="#/terms">利用規約</a>　<a href="#/privacy">プライバシーポリシー</a>${hasDoc('security') ? '　<a href="#/security">安全への取り組み</a>' : ''}</p>
      <p>Copyright © ${new Date().getFullYear()} <a href="#/">${esc(siteName())}</a> All rights reserved.</p>`;
    renderNotice();
  }

  // The site-wide notice banner is intentionally not shown
  // The site-wide notice banner is not used; the slot carries the player's own reminder only
  // (a reply from the operators that has not been opened yet)
  function renderNotice() {
    $('#site-notice').innerHTML = me?.unreadReplies && !location.hash.startsWith('#/mypage/contacts')
      ? '<div class="alert alert-green reply-note">運営からお問い合わせへの返信があります。<a href="#/mypage/contacts">お問い合わせ履歴を見る</a></div>'
      : '';
  }

  // ---------- Pages ----------
  async function pageHome() {
    app.innerHTML = layout({
      title: siteName(),
      home: true,
      sideRight: true,
      main: `
        <div>
          ${paras(SITE.homeIntro || defaultHomeIntro())}
          ${hasDoc('security') ? '<p><a href="#/security">▶ 安全への取り組み</a></p>' : ''}
          ${me ? '' : '<p>ご利用にはアカウント登録（無料）が必要です。右上の「ログイン＆新規登録」からどうぞ。</p>'}
        </div>
        ${closed('diaries') ? '' : boxList('新着のプレイヤー日記', `<div id="home-diaries">${spinner}</div>`)}`,
      side: boxList('ランキング', `<div id="home-ranking">${spinner}</div><p data-style="text-align:right;margin-top:8px"><a href="#/ranking">もっと見る</a></p>`),
    });
    const [ranking, diaries] = await Promise.allSettled([api('/api/ranking?limit=10'), closed('diaries') ? null : api('/api/diaries')]);
    $('#home-ranking').innerHTML = ranking.status === 'fulfilled' ? rankingRows(ranking.value.players.slice(0, 10), { compact: true }) : errorBox(ranking.reason);
    if (!closed('diaries')) $('#home-diaries').innerHTML = diaries.status === 'fulfilled' ? diaryItems(diaries.value.diaries.slice(0, 5)) : errorBox(diaries.reason);
    tickCountdowns();
    every(1000, tickCountdowns);
  }

  // Free match
  // Rated match
  const stageTile = (s, x) => {
    const i = window.STAGES.indexOf(s);
    const short = { ポケモンスタジアム2: 'ポケスタ2', ホロウバスティオン: 'ホロバス' }[s] || s;
    return `<div class="stage ${x ? 'x' : ''}" title="${esc(s)}"><span class="simg"><img src="assets/stages/${pad2(i + 1)}.jpg" alt="" data-fb></span><span class="sname">${esc(short)}</span></div>`;
  };

  async function pageMatch(id) {
    let m;
    try { m = await api(`/api/matches/${id}`); } catch (e) {
      if (!me) { requireLogin('レーティング対戦'); return; }
      app.innerHTML = errorBox(e); return;
    }
    // On a site with public rooms anyone can look in; only the two players can act
    const member = Boolean(me && m.players.includes(me.userId));
    const waiting = m.status === 'waiting';
    const playing = m.status === 'playing';
    // A room both players cancelled is over; one cancelled under the old one-sided 対戦中止 can
    // still be settled by agreeing reports (unless the admin decided it)
    const bothCancelled = m.players.length === 2 && m.players.every((u) => m.reports?.[u] === 'cancel');
    const reportable = member && !m.correctedBy && (playing || (m.status === 'cancelled' && m.players.length === 2 && !bothCancelled));
    const isHost = member && m.hostId === me.userId;
    const oppId = member ? m.players.find((p) => p !== me.userId) : null;
    const mine = member ? m.playerInfo[me.userId] : null;
    const opp = oppId ? m.playerInfo[oppId] : null;
    const myReport = member ? m.reports?.[me.userId] : undefined;
    const oppReport = oppId ? m.reports?.[oppId] : undefined;
    // win + lose, or both 対戦中止, end the room; any other pair of reports disagrees
    const agreedReports = (x, y) => (x === 'win' && y === 'lose') || (x === 'lose' && y === 'win') || (x === 'cancel' && y === 'cancel');
    const REPORT_JA = { win: '勝ち', lose: '負け', cancel: '対戦中止' };
    const pw = m.roomPassword || '1122';

    // ----- top notice -----
    let alert = '';
    if (!member) {
      alert = playing ? '<div class="alert alert-yellow">このルームは対戦中です。</div>'
        : m.status === 'done' ? `<div class="alert alert-red">このルームは対戦終了しました。${m.correctedBy ? '<br>この対戦の結果は運営が確定しました。' : ''}</div>`
          : m.status === 'cancelled' ? `<div class="alert alert-red">${m.correctedBy ? '運営の判断により、この対戦は無効になりました。' : 'この対戦は中止されました。'}</div>`
            : m.status === 'disputed' ? '<div class="alert alert-red">この対戦は無効になりました。</div>' : '';
    } else if (waiting) {
      alert = `<div class="alert alert-yellow">あなたはこのルームに参加中です。<br>${m.room
        ? `部屋ID「<b>${esc(m.room.roomId)}</b>」、パスワード「<b>${esc(pw)}</b>」の部屋を立てて、対戦相手をお待ちください。`
        : `<b class="red">専用部屋を立てて、部屋IDとパスワード(${esc(pw)})を入力してください。</b>`}</div>
        <div class="room-set"><label for="room-id">部屋ID</label>
          <div class="room-set-row"><input id="room-id" maxlength="8" inputmode="latin" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" placeholder="部屋IDを入力" value="${esc(m.room?.roomId || '')}"><button type="button" class="btn-line" id="room-save">設定</button></div>
          ${me.lastRoomId ? `<button type="button" class="linklike room-last" id="room-last">⇒前回の部屋IDを呼び出す</button>` : ''}</div>`;
    } else if (playing) {
      alert = `<div class="alert alert-yellow">あなたはこのルームに参加中です。<br>部屋ID「<b>${esc(m.room?.roomId || '-')}</b>」、パスワード「<b>${esc(pw)}</b>」の部屋に参加してください。</div>`;
      if (oppReport === 'cancel' && myReport !== 'cancel') alert += '<div class="alert alert-red">相手が「対戦中止」を押しました。対戦していない場合は、あなたも「対戦中止」を押すとルームが終了します。対戦した場合は結果を報告してください。</div>';
    } else if (m.status === 'cancelled' && m.correctedBy) {
      alert = '<div class="alert alert-red">運営の判断により、この対戦は無効になりました（レートは変動しません）。</div>';
    } else if (m.status === 'done') {
      alert = `<div class="alert alert-red">このルームは対戦終了しました。${m.correctedBy ? '<br>この対戦の結果は運営が確定しました。' : ''}</div>
        <div class="alert alert-green">対戦相手の使用キャラクター投票と紹介文の記入にご協力ください。 <a href="#/users/${esc(oppId)}/intro">対戦相手の紹介ページへ</a></div>`;
    } else if (m.status === 'disputed') alert = '<div class="alert alert-red">双方の報告が一致しなかったため、この対戦は無効になりました（レートは変動しません）。</div>';
    else if (m.status === 'cancelled') {
      const both = myReport === 'cancel' && oppReport === 'cancel';
      alert = `<div class="alert alert-red">${!oppId ? 'この部屋は削除されました。'
        : both ? 'この対戦は中止されました（双方が「対戦中止」を押しました）。'
          : 'この対戦は中止されました。<br>対戦が終わっていた場合は、下の「結果送信」で報告してください。双方の報告が一致するとレートに反映されます。'}</div>`;
    }

    // ----- player panels -----
    // Like the original: while waiting, a player with switch settings shows "?" for the fighter and
    // the reject stages (both follow the opponent's pick). Only the host ever sees a waiting room.
    const switchPending = (uid, p) => waiting && member && uid === me.userId && p.fighter !== 'おまかせ' && Object.keys(me.switches || {}).length > 0;
    const rejectsOf = (p, vsFighter) => (vsFighter && p.rejectByFighter?.[vsFighter]) || p.rejectStages || [];
    const state = (uid) => {
      if (waiting) return '対戦相手募集中';
      if (m.status === 'done') return m.winnerId === uid ? '勝ち' : '負け';
      if (m.status === 'disputed') return '無効';
      const r = m.reports?.[uid];
      if (m.status === 'cancelled') return r && r !== 'cancel' ? `中止（${REPORT_JA[r]}で報告）` : '中止';
      return r ? (r === 'cancel' ? '中止' : REPORT_JA[r]) : '対戦中';
    };
    const rejectCell = (list) => (list.length
      ? `<div class="rj">${list.map((s) => { const i = window.STAGES.indexOf(s); const short = { ポケモンスタジアム2: 'ポケスタ2', ホロウバスティオン: 'ホロバス' }[s] || s; return `<span><img src="assets/stages/${pad2(i + 1)}.jpg" alt="" data-fb><small>${esc(short)}</small></span>`; }).join('')}</div>`
      : 'なし');
    const pbox = (uid, n) => {
      const p = m.playerInfo[uid];
      const other = m.playerInfo[m.players.find((x) => x !== uid)];
      return `<section class="pbox"><h2 class="box-head">プレイヤー${n}</h2>
        <a class="pbox-name" href="#/users/${esc(uid)}">${avatar('pb', uid)}${p.symbol ? `<span class="badge-sym">${esc(p.symbol)}</span>` : ''}<span>${esc(p.name)}</span></a>
        <table class="ptable">
          <tr><td>レート</td><td class="b">${p.rating ?? '—'}</td></tr>
          <tr class="char"><td>キャラ</td><td>${switchPending(uid, p) ? unknownThumb('pt', 'スイッチ設定により対戦相手に応じて決まります') : fthumb(p.fighter, 'pt') || esc(p.fighter || '-')}</td></tr>
          <tr class="rjrow"><td>拒否</td><td>${switchPending(uid, p) ? unknownThumb('pt', 'スイッチ設定により対戦相手に応じて決まります') : rejectCell(rejectsOf(p, other?.fighter))}</td></tr>
          <tr><td>状態</td><td>${state(uid)}</td></tr>
          <tr><td colspan="2">${esc(m.status === 'done' ? p.postComment : p.preComment) || '&nbsp;'}</td></tr>
        </table></section>`;
    };
    const waitBox = `<section class="pbox"><h2 class="box-head">プレイヤー2</h2>
      <div class="wait-box"><p>対戦相手を待っています・・・<br>画面が切り替わるまでお待ちください。</p>
        <div class="wait-spin"><span class="w-arc"></span><img class="w-mark" src="assets/waiting-core.png" alt=""></div>
        ${isHost ? '<button type="button" class="btn-line wait-del" id="room-delete">部屋を削除する</button>' : ''}</div></section>`;

    // ----- stages / report (only once matched) -----
    let rest = '';
    if (opp) {
      const game1X = [...rejectsOf(mine, opp.fighter), ...rejectsOf(opp, mine.fighter)];
      const laterX = rejectsOf(opp, mine.nextFighter || mine.fighter);
      const starters = window.STAGES.slice(0, window.STARTER_COUNT);
      rest = `
        <p class="section-label">自分の2戦目以降使用キャラ(直前の敗者の場合変更可)</p>
        <select id="next-fighter" class="center-select" ${playing ? '' : 'disabled'}>${fighterOptions(mine.nextFighter || mine.fighter, { omakase: true })}</select>
        <p class="section-label">この対戦で選択可能なステージ</p>
        <div class="stage-table">
          <div class="stage-head">1戦目</div>
          <div class="stage-row">${starters.map((s) => stageTile(s, game1X.includes(s))).join('')}</div>
          <div class="stage-head">2,3戦目<br>直前の敗者側が選択、勝者側はおまかせ<br>3戦目は1戦目勝利ステージ選択不可</div>
          <div class="stage-row">${window.STAGES.map((s) => stageTile(s, laterX.includes(s))).join('')}</div>
        </div>
        <p class="room-btns"><a class="btn-line" href="#/mypage/stages">☰ 自分の拒否ステージを確認</a></p>
        ${reportable ? `<section class="rs-sec"><h2 class="box-head">結果送信</h2>
          <div class="rs-btns"><button type="button" data-result="win" class="${myReport === 'win' ? 'on' : ''}">勝ち</button><button type="button" data-result="lose" class="${myReport === 'lose' ? 'on' : ''}">負け</button>${playing ? `<button type="button" id="cancel-match" class="${myReport === 'cancel' ? 'on' : ''}">対戦中止</button>` : ''}</div>
          ${myReport ? `<p class="rs-done">「${REPORT_JA[myReport]}」で報告済みです。${oppReport && !agreedReports(myReport, oppReport) ? '<b class="red">相手の報告と一致していません。</b>' : myReport === 'cancel' ? '相手も「対戦中止」を押すと、このルームは終了します。' : '相手の報告と一致した時点でレートに反映されます。'}押し直しもできます。<br><a href="#/rate">次の対戦相手を探す</a></p>` : ''}</section>` : ''}`;
    } else if (!member && m.players.length === 2) {
      // Spectator: the 1st-game stages both players' rejects leave (later games depend on who lost)
      const [a, b] = m.players.map((u) => m.playerInfo[u]);
      const game1X = [...rejectsOf(a, b.fighter), ...rejectsOf(b, a.fighter)];
      const starters = window.STAGES.slice(0, window.STARTER_COUNT);
      rest = `
        <p class="section-label">この対戦で選択可能なステージ</p>
        <div class="stage-table">
          <div class="stage-head">1戦目</div>
          <div class="stage-row">${starters.map((s) => stageTile(s, game1X.includes(s))).join('')}</div>
          <div class="stage-head">2,3戦目<br>直前の敗者側が選択、勝者側はおまかせ<br>3戦目は1戦目勝利ステージ選択不可</div>
          <div class="stage-row">${window.STAGES.map((s) => stageTile(s, false)).join('')}</div>
        </div>`;
    }

    app.innerHTML = layout({
      crumb: [crumbLink('#/rate', 'レーティング対戦'), `対戦ルーム ${m.matchNo ?? ''}`],
      title: `対戦ルーム ${m.matchNo ?? ''}`,
      single: `
        ${alert}
        <div class="players">${pbox(m.players[0], 1)}${m.players[1] ? pbox(m.players[1], 2) : (waiting ? waitBox : '')}</div>
        ${rest}
        <section data-style="margin-top:30px"><h2 class="box-head">コメント</h2><div data-style="margin-top:10px" id="chat"></div></section>
        ${member ? '<p class="room-btns"><button type="button" class="btn-line" id="open-memo">☰ 対策メモを開く</button></p>' : ''}
        ${member && playing && m.room ? `<div class="room-box sticky">部屋ID：<b>「${esc(m.room.roomId)}」</b>　パスワード：<b>「${esc(pw)}」</b></div>` : ''}`,
    });
    if (member && playing && m.room) document.body.classList.add('has-sticky');
    $('#open-memo')?.addEventListener('click', () => showMemoFor(opp ? (opp.nextFighter || opp.fighter) : ''));

    // ----- waiting room (host) -----
    const idInput = $('#room-id');
    // Normalise to upper-case alphanumerics, but never while an IME composition is in progress
    // (rewriting the value mid-composition duplicates/drops characters on iOS Japanese keyboards).
    const normalizeRoomId = () => {
      const raw = idInput.value;
      // full-width → half-width, then keep A-Z/0-9 only
      const clean = raw.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (clean === raw) return;
      // keep the caret after the same number of valid characters
      const before = raw.slice(0, idInput.selectionStart ?? raw.length);
      const caret = before.replace(/[Ａ-Ｚａ-ｚ０-９]/g, 'x').replace(/[^A-Za-z0-9]/g, '').length;
      idInput.value = clean;
      try { idInput.setSelectionRange(Math.min(caret, clean.length), Math.min(caret, clean.length)); } catch { /* not focused */ }
    };
    let composing = false;
    idInput?.addEventListener('compositionstart', () => { composing = true; });
    idInput?.addEventListener('compositionend', () => { composing = false; normalizeRoomId(); });
    idInput?.addEventListener('input', (e) => { if (!composing && !e.isComposing) normalizeRoomId(); });
    idInput?.addEventListener('blur', normalizeRoomId);
    idInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) $('#room-save').click(); });
    $('#room-last')?.addEventListener('click', () => { idInput.value = me.lastRoomId; });
    $('#room-save')?.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      normalizeRoomId();
      if (!idInput.value) { toast('部屋IDを英数字で入力してください'); return; }
      await api(`/api/matches/${id}/room`, { method: 'POST', body: { roomId: idInput.value } });
      me.lastRoomId = idInput.value;
      toast('部屋IDを設定しました');
      route();
    }));
    $('#room-delete')?.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      clearTimers(); // stop the waiting-room poll so it can't re-render this page mid-navigation
      await api(`/api/matches/${id}/cancel`, { method: 'POST' });
      await loadMe(); renderAccount();
      location.hash = '#/rate';
    }));

    // ----- playing -----
    $('#next-fighter')?.addEventListener('change', (ev) => withBusy(ev.target, async () => {
      await api(`/api/matches/${id}/fighter`, { method: 'POST', body: { fighter: ev.target.value } });
      toast('2戦目以降のキャラを変更しました');
    }));
    // No confirmation dialogs; results can be re-sent until both reports agree
    app.querySelectorAll('[data-result]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
      await api(`/api/matches/${id}/report`, { method: 'POST', body: { result: b.dataset.result } });
      await loadMe(); renderAccount(); route();
    })));
    $('#cancel-match')?.addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
      await api(`/api/matches/${id}/cancel`, { method: 'POST' });
      await loadMe(); renderAccount(); route();
    }));
    mountChat($('#chat'), `/api/matches/${id}`, { readOnly: !member || !(reportable || waiting) });

    // Waiting: poll fast (also keeps the room joinable). Playing: watch reports / room / opponent's next fighter.
    if (member && (waiting || reportable)) {
      const snap = (n) => JSON.stringify([n.status, n.reports, n.room, n.players.length, oppId ? n.playerInfo[oppId]?.nextFighter : null]);
      const before = snap(m);
      every(waiting ? 5000 : 7000, async () => {
        try {
          const n = await api(`/api/matches/${id}`);
          if (snap(n) !== before) {
            if (waiting && n.status === 'playing') toast('対戦相手が見つかりました！');
            await loadMe(); renderAccount(); route();
          }
        } catch { /* ignore */ }
      });
    }
  }

  // Tournaments
  function pageTournamentNew() {
    if (!requireLogin('大会を開催する')) return;
    const d = new Date(Date.now() + 7 * 86400_000);
    d.setHours(21, 0, 0, 0);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    app.innerHTML = layout({
      crumb: [crumbLink('#/tournaments', '大会トーナメント一覧'), '大会を開催する'],
      title: '大会を開催する',
      side: box('開催について', '<p>開催日時になったら、主催者が「締め切って大会を開始」を押すとトーナメント表が作成されます。</p><p>シングルエリミネーション形式で、参加者はランダムに配置されます。</p>'),
      main: box('大会情報', `<form id="tour-form">
          <div class="field"><label for="t-title">大会名</label><input id="t-title" name="title" maxlength="50" required></div>
          <div class="field"><label for="t-start">開催日時</label><input id="t-start" name="startAt" type="datetime-local" value="${local}" required></div>
          <div class="field"><label for="t-rule">ルール</label><input id="t-rule" name="rule" maxlength="60" required value="1on1 ストック3 7分 アイテムなし"></div>
          <div class="field"><label for="t-cap">定員</label><input id="t-cap" name="capacity" type="number" min="2" max="128" value="16" required><div class="hint">2〜128人</div></div>
          <div class="field"><label for="t-desc">大会説明</label><textarea id="t-desc" name="description" maxlength="2000" placeholder="参加条件、進行方法、連絡手段など"></textarea></div>
          <button class="btn btn-lg">開催する</button>
        </form>`),
    });
    $('#tour-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = formData(ev.target);
      body.startAt = new Date(body.startAt).toISOString();
      body.capacity = Number(body.capacity);
      await withBusy(ev.submitter, async () => {
        const t = await api('/api/tournaments', { method: 'POST', body });
        location.hash = `#/tournaments/${t.tourId}`;
      });
    });
  }

  const roundName = (r, total) => (r === total - 1 ? '決勝' : r === total - 2 ? '準決勝' : r === total - 3 ? '準々決勝' : `${r + 1}回戦`);

  async function pageTournament(id) {
    let data;
    try { data = await api(`/api/tournaments/${id}`); } catch (e) { app.innerHTML = errorBox(e); return; }
    const { tournament: t, entries } = data;
    const byId = Object.fromEntries(entries.map((e) => [e.userId, e]));
    const isOrg = me && t.organizerId === me.userId;
    const entered = me && byId[me.userId];

    let actions = '';
    if (t.status === 'recruiting') {
      if (!me) actions = `<div data-style="display:grid;gap:6px">${loginButtons()}</div>`;
      else if (entered) actions = '<button class="btn btn-gray btn-block" id="leave">エントリーを取り消す</button>';
      else if (t.entryCount < t.capacity) actions = '<button class="btn btn-lg btn-block" id="enter">エントリーする</button>';
      else actions = '<p class="muted">定員に達しました</p>';
      if (isOrg) actions += '<hr><button class="btn btn-outline btn-block" id="start">締め切って大会を開始</button>';
    }

    const slot = (pid, m, r, i) => {
      if (!pid) return `<div class="bm-slot empty">${m.bye && r === 0 ? '不戦' : '—'}</div>`;
      const e = byId[pid] || { name: '退会済み' };
      const canReport = t.status === 'running' && me && m.p1 && m.p2 && (isOrg || (!m.winner && (me.userId === m.p1 || me.userId === m.p2)));
      return `<div class="bm-slot ${m.winner === pid ? 'win' : ''}"><span class="row" data-style="gap:6px;flex-wrap:nowrap;min-width:0">${fthumb(e.fighter)}<span data-style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</span></span>
        ${canReport && m.winner !== pid ? `<button class="btn btn-outline btn-sm" data-r="${r}" data-i="${i}" data-w="${esc(pid)}" title="この選手の勝ちで報告">勝</button>` : ''}</div>`;
    };
    const bracket = t.bracket
      ? `<div class="bracket">${t.bracket.map((round, r) => `<div class="bracket-round"><h3>${roundName(r, t.bracket.length)}</h3>
          ${round.map((m, i) => `<div class="bm">${slot(m.p1, m, r, i)}${slot(m.p2, m, r, i)}</div>`).join('')}</div>`).join('')}</div>`
      : '<p class="empty">大会開始時にトーナメント表が作成されます</p>';

    app.innerHTML = layout({
      crumb: [crumbLink('#/tournaments', '大会トーナメント一覧'), esc(t.title)],
      title: t.title,
      side: `${box('大会情報', `
          ${t.status === 'finished' && t.championId ? `<p>🏆 優勝：<b>${esc(byId[t.championId]?.name || '')}</b></p>` : ''}
          <table class="tbl">
            <tr><th>開催日時</th><td>${jpDate(t.startAt)}</td></tr>
            <tr><th>主催者</th><td>${userLink(t.organizerId, t.organizerName)}</td></tr>
            <tr><th>ルール</th><td>${esc(t.rule)}</td></tr>
            <tr><th>参加者</th><td>${t.entryCount} / ${t.capacity}人</td></tr>
          </table>
          ${countdown(t)}
          <div data-style="margin-top:12px">${actions}</div>`)}
        ${box(`参加者（${entries.length}）`, entries.length ? `<ul class="list-plain">${entries.map((e) => `<li class="row">${fthumb(e.fighter) || avatar('sm')}${userLink(e.userId, e.name)}<span class="spacer"></span><span class="small muted">${e.rating}</span></li>`).join('')}</ul>` : '<p class="empty">まだエントリーはありません</p>')}`,
      main: `${box('トーナメント表', bracket)}${box('大会説明', t.description ? `<div class="prose">${esc(t.description)}</div>` : '<p class="muted">説明はありません</p>')}`,
    });
    bindLoginButtons(app);
    tickCountdowns();
    every(1000, tickCountdowns);
    const act = (sel, path, method, msg) => $(sel)?.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      await api(`/api/tournaments/${id}/${path}`, { method });
      route();
    }));
    act('#enter', 'entry', 'POST');
    act('#leave', 'entry', 'DELETE', 'エントリーを取り消します。よろしいですか？');
    act('#start', 'start', 'POST', 'エントリーを締め切り、トーナメント表を作成します。よろしいですか？');
    app.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      await api(`/api/tournaments/${id}/result`, { method: 'POST', body: { round: Number(b.dataset.r), index: Number(b.dataset.i), winnerId: b.dataset.w } });
      route();
    })));
  }

  // Fighters
  function pageFighters() {
    app.innerHTML = layout({
      crumb: 'ファイター一覧',
      title: 'ファイター一覧',
      single: `<section><h2 class="box-head">ファイター一覧</h2><div class="fgrid">${window.FIGHTERS.map((f, i) =>
        `<a class="ftile" href="#/fighters/${i}"><img src="${fighterImg(f)}" alt="" loading="lazy"><span>${esc(f)}</span></a>`).join('')}</div></section>`,
    });
  }

  // Ranking
  async function pageRanking() {
    app.innerHTML = layout({
      crumb: 'レートランキング',
      title: 'レートランキング',
      side: box('ランキングについて', '<p>レーティング対戦を1戦以上行ったプレイヤーのうち、レート上位100名のランキングです。</p><p>対戦結果が確定するたびにリアルタイムで更新されます。</p><hr><a href="#/fighters">ファイター別のランキングはこちら</a>'),
      main: boxList('レートランキング', `<p class="rk-note">※${fullDate(new Date().toISOString())}時点</p><div id="rk">${spinner}</div>`),
    });
    try { const { players } = await api('/api/ranking?limit=100'); $('#rk').innerHTML = rankingRows(players); } catch (e) { $('#rk').innerHTML = errorBox(e); }
  }

  // Diaries
  async function pageDiaries() {
    app.innerHTML = layout({
      crumb: 'プレイヤー日記一覧',
      title: 'プレイヤー日記一覧',
      side: box('プレイヤー日記について', `<p>プレイヤーが投稿した日記の一覧です。</p><p>登録すると、対戦の振り返りや攻略メモなどを日記として公開できます。</p>${me ? '<hr><a class="btn btn-block" href="#/diaries/new">日記を書く</a>' : ''}`),
      main: boxList('日記一覧', `<div id="dl">${spinner}</div>`),
    });
    try { const { diaries } = await api('/api/diaries'); $('#dl').innerHTML = diaryItems(diaries); } catch (e) { $('#dl').innerHTML = errorBox(e); }
  }

  function pageDiaryNew() {
    if (!requireLogin('日記を書く')) return;
    app.innerHTML = layout({
      crumb: [crumbLink('#/diaries', 'プレイヤー日記一覧'), '日記を書く'],
      title: '日記を書く',
      side: box('投稿について', '<p>日記はすべてのプレイヤーに公開されます。他のプレイヤーへの誹謗中傷は禁止です。</p>'),
      main: box('日記', `<form id="diary-form">
          <div class="field"><label for="d-title">タイトル</label><input id="d-title" name="title" maxlength="60" required></div>
          <div class="field"><label for="d-body">本文</label><textarea id="d-body" name="body" maxlength="5000" required data-style="min-height:260px"></textarea></div>
          <button class="btn btn-lg">公開する</button>
        </form>`),
    });
    $('#diary-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await withBusy(ev.submitter, async () => {
        const d = await api('/api/diaries', { method: 'POST', body: formData(ev.target) });
        location.hash = `#/users/${d.userId}/diaries/${d.diaryId}`;
      });
    });
  }

  // Users
  // Introduction page (public profile)
  async function pageIntro(uid) {
    let data, intro;
    try { [data, intro] = await Promise.all([api(`/api/users/${uid}`), api(`/api/users/${uid}/intros`)]); } catch (e) { app.innerHTML = errorBox(e); return; }
    const u = data.user;
    const canWrite = me && me.userId !== uid && data.user.allowIntro !== false && data.history.some((h) => h.opponentId === me.userId);
    const mineIntro = me && intro.intros.find((i) => i.authorId === me.userId);
    const PER = 20;
    let page = 0;

    // Single column, like the original: about → vote result → (write form) → intro list
    const list = intro.intros.filter((i) => i.text);
    app.innerHTML = layout({
      crumb: [userLink(uid, u.name), '紹介ページ'],
      title: '紹介ページ',
      single: `
        <section class="ip-sec"><h2 class="box-head">紹介ページについて</h2><div class="ip-about">
          レーティング対戦で対戦したプレイヤーが、使用キャラクターへの投票と紹介文を書けるページです。<br>
          使用キャラクターは直近10件の投票から集計されます。対戦相手の情報収集のため、投票にご協力ください。</div></section>
        <section class="ip-sec"><h2 class="box-head">今期使用キャラクター(直近10件の投票)</h2>
          ${intro.votes.length
            ? `<div class="vote-row">${intro.votes.map((v) => `<span class="vote">${fthumb(v.fighter, 'vt')}<span class="pct">${v.percent}%</span></span>`).join('')}</div>
               <button type="button" class="btn-line ip-voters-btn" id="voters-btn">投票したプレイヤーを見る(直近10件)</button>
               <ul class="list-plain ip-voters" id="voters" hidden>${intro.voters.map((v) => `<li class="row">${userLink(v.authorId, v.authorName)}<span class="spacer"></span>${fthumb(v.fighter)}</li>`).join('')}</ul>`
            : '<p class="ip-none">まだ投票はありません。</p>'}</section>
        ${canWrite ? `<section class="ip-sec"><h2 class="box-head">使用キャラ投票・紹介文</h2><form id="intro-form" class="ip-form">
            <div class="field"><label for="i-fighter">使用キャラクター</label><select id="i-fighter" name="fighter">${fighterOptions(mineIntro?.fighter || '')}</select></div>
            <div class="field"><label for="i-text">紹介文</label><textarea id="i-text" name="text" maxlength="500">${esc(mineIntro?.text || '')}</textarea></div>
            <div class="cmt-submit"><button class="btn-blue2">${mineIntro ? '更新する' : '投稿する'}</button></div></form></section>` : ''}
        <section class="ip-sec"><h2 class="box-head">紹介文 ${list.length}件</h2><div id="intros"></div><div class="pager" id="pager"></div></section>`,
    });
    $('#voters-btn')?.addEventListener('click', () => { $('#voters').hidden = !$('#voters').hidden; });

    function renderIntros() {
      const items = list.slice(page * PER, page * PER + PER);
      $('#intros').innerHTML = items.length ? items.map((i) => `<div class="ip-item">
          <div class="ip-head">${avatar('ip', i.authorId)}${userLink(i.authorId, i.authorName)}<span class="ip-meta">${i.fighter ? `${fthumb(i.fighter)}<br>` : ''}${fullDate(i.at).split(' ')[0]}</span></div>
          <div class="ip-body">${esc(i.text)}</div>
          ${me && (me.userId === uid || me.userId === i.authorId) ? `<div class="ip-del"><button type="button" class="linklike" data-del="${esc(i.authorId)}">紹介文削除</button></div>` : ''}
        </div>`).join('') : '<p class="ip-none">紹介文はありません。</p>';
      pager($('#pager'), list.length, PER, page, (p) => { page = p; renderIntros(); });
      app.querySelectorAll('[data-del]').forEach((a) => a.addEventListener('click', () => withBusy(null, async () => {
        await api(`/api/users/${uid}/intros/${a.dataset.del}`, { method: 'DELETE' });
        route();
      })));
    }
    renderIntros();
    $('#intro-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await withBusy(ev.submitter, async () => {
        await api(`/api/users/${uid}/intros`, { method: 'POST', body: formData(ev.target) });
        toast('投稿しました');
        route();
      });
    });
  }

  function pager(el, total, per, cur, onPage) {
    const pages = Math.ceil(total / per);
    if (pages <= 1) { el.innerHTML = ''; return; }
    const nums = [...new Set([0, cur - 1, cur, cur + 1, pages - 1].filter((p) => p >= 0 && p < pages))].sort((a, b) => a - b);
    let html = '';
    nums.forEach((p, i) => {
      if (i && p - nums[i - 1] > 1) html += '<button disabled>…</button>';
      html += `<button class="${p === cur ? 'cur' : ''}" data-p="${p}">${p + 1}</button>`;
    });
    if (cur < pages - 1) html += `<button data-p="${cur + 1}">&gt;</button>`;
    el.innerHTML = html;
    el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => onPage(Number(b.dataset.p))));
  }

  function ratingGraph(history) {
    const pts = [...history].reverse();
    if (!pts.length) return '<p class="empty">まだ対戦データがありません</p>';
    const series = [pts[0].ratingAfter != null ? pts[0].ratingAfter - pts[0].delta : 1500, ...pts.map((h) => h.ratingAfter ?? null)].filter((v) => v != null);
    const W = 700, H = 300, L = 50, R = 12, T = 12, B = 30;
    let lo = Math.min(...series), hi = Math.max(...series);
    lo = Math.floor((lo - 10) / 20) * 20; hi = Math.ceil((hi + 10) / 20) * 20;
    const x = (i) => L + (series.length === 1 ? 0 : (i / (series.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const step = Math.max(20, Math.ceil((hi - lo) / 10 / 20) * 20);
    let grid = '';
    for (let v = lo; v <= hi; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#666">${v.toLocaleString()}</text>`;
    const xstep = Math.max(1, Math.ceil(series.length / 7 / 10) * 10);
    for (let i = xstep; i < series.length; i += xstep) grid += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#666">${i}</text>`;
    const line = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<svg class="graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="レートの推移">${grid}<polyline points="${line}" fill="none" stroke="#3a9db0" stroke-width="2"/></svg>`;
  }

  async function pageUserDiaries(uid) {
    let data;
    try { data = await api(`/api/users/${uid}`); } catch (e) { app.innerHTML = errorBox(e); return; }
    app.innerHTML = layout({
      crumb: [userLink(uid, data.user.name), '日記一覧'],
      title: `${data.user.name} の日記`,
      side: box('プレイヤー日記について', `<p>${esc(data.user.name)} さんが投稿した日記の一覧です。</p>`),
      main: boxList('日記一覧', data.diaries.length
        ? data.diaries.map((d) => `<div class="ditem"><a class="dtitle" href="#/users/${esc(uid)}/diaries/${esc(d.diaryId)}">${esc(d.title)}</a>${isNew(d.createdAt) ? '<span class="new">new!</span>' : ''}<div class="small muted">${fullDate(d.createdAt)}</div></div>`).join('')
        : '<p class="empty">日記はありません</p>'),
    });
  }

  // Search
  async function pageSearch(q) {
    const query = decodeURIComponent(q).trim();
    $('#search-form').elements.q.value = query;
    app.innerHTML = layout({
      crumb: '検索結果',
      title: `「${query}」の検索結果`,
      sideRight: true,
      main: closed('diaries') ? boxList('プレイヤー', `<div id="s-players">${spinner}</div>`) : boxList('プレイヤー日記', `<div id="s-diaries">${spinner}</div>`),
      side: closed('diaries') ? '' : boxList('プレイヤー', `<div id="s-players">${spinner}</div>`),
    });
    const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(query.toLowerCase()));
    const [d, r] = await Promise.allSettled([closed('diaries') ? null : api('/api/diaries'), api(`/api/users?q=${encodeURIComponent(query)}`)]);
    if (!closed('diaries')) $('#s-diaries').innerHTML = d.status === 'fulfilled' ? diaryItems(d.value.diaries.filter((x) => has(x.title, x.body, x.userName))) : errorBox(d.reason);
    $('#s-players').innerHTML = r.status === 'fulfilled' ? rankingRows(r.value.players, { compact: true, numbered: false, empty: '該当するプレイヤーはいません' }) : errorBox(r.reason);
    tickCountdowns();
    every(1000, tickCountdowns);
  }

  // Static documents: [title, lead, [[heading, html], ...]]
  const DOCS = {
    about: ['サイトについて', '', [
      ['{{site}}とは', `<p>{{site}} は、オンライン対戦ゲームの対戦・交流を目的としたWebサービスです。Discordアカウントで登録すると、レーティング対戦をはじめとする機能を利用できます。</p>
        <p><a href="#/terms">利用規約はこちら</a>、<a href="#/privacy">プライバシーポリシーはこちら</a>。サービスを利用した時点で利用規約に同意したものとみなします。</p>
        <p class="strong-red">当サイトは個人が運営する非公式のWebサービスです。ゲームの権利者・関連企業とは一切関係ありません。</p>`],
      ['登録・ログインについて', '<p>登録・ログインにはDiscordアカウントを使用します。作成から1か月未満のDiscordアカウントでは登録できません。</p><p>スマートフォンでは、Discordアプリでログイン中のアカウントで登録・ログインされます。</p>'],
      ['フリー対戦について', '<p>フリー対戦では、1対1の対戦相手を気軽に募集できます。ルールやコメントを設定して募集を立てると、参加したプレイヤーと対戦できます。</p><p>部屋では対戦相手とメッセージをやり取りできます。対戦成績は記録されません。</p>'],
      ['レーティング対戦について', '<p>レーティング対戦では、近い実力のプレイヤーとマッチングします。決められたルールで対戦し、双方が勝敗を報告するとレートが変動します。</p><p><a href="#/rules">レーティング対戦のルールはこちら</a>。トラブルを防ぐため、必ずルールを守って対戦してください。</p>'],
      ['ランキングについて', '<p>レーティング対戦の結果によってレートが変動し、レート上位のプレイヤーがランキングに表示されます。ファイター別のランキングも確認できます。</p>'],
      ['プレイヤー日記について', '<p>登録すると、日記を書いて全プレイヤーに公開できます。他のプレイヤーへの誹謗中傷や迷惑行為にあたる投稿は削除することがあります。</p>'],
      ['紹介ページについて', '<p>レーティング対戦で対戦したプレイヤーは、相手の使用キャラクターへの投票と紹介文を書けます。対戦相手の情報収集にご活用ください。</p>'],
      ['規制について', '<p>ルールやマナーを守らないプレイヤーは、機能の利用を制限する場合があります。複数アカウントの利用やアカウントの貸し借りも制限の対象です。</p>'],
      ['問い合わせについて', '<p>お問い合わせは<a href="#/contact">お問い合わせページ</a>からお願いします。</p>'],
    ]],
    terms: ['利用規約', '<p>{{site}} の利用規約です。サービスを利用した時点で本規約に同意したものとみなしますので、必ず最後までお読みください。規約に違反した場合、機能の制限やアカウントの停止などを行うことがあります。</p>', [
      ['アカウント', `<ul class="dots">
        <li>登録・ログインにはDiscordアカウントを使用します。Discordの利用規約も守ってください。</li>
        <li>1人で複数のアカウントを使うこと、アカウントを他人に貸したり譲ったりすることは禁止です。</li>
        <li>作成から1か月未満のDiscordアカウントでは登録できません。</li>
        <li>Discordアカウントやその連携を自分で管理できなくなった場合（乗っ取り・削除など）、当サイトのアカウントを引き継げないことがあります。</li>
      </ul>`],
      ['禁止事項', `<ul class="dots">
        <li>荒らし行為・不正行為は禁止です。荒らしと思われる投稿には反応せず、無視してください。</li>
        <li>他のプレイヤーへの誹謗中傷、差別的な発言、嫌がらせは禁止です。丁寧な言葉づかいを心がけてください。</li>
        <li>公序良俗に反する表現や、未成年に悪影響を与える表現は禁止です。</li>
        <li>改造した本体・ソフト・周辺機器を使ってオンライン対戦に参加する行為は禁止です。</li>
        <li>虚偽の勝敗報告、談合、複数アカウントの利用など、レートを不正に操作する行為は禁止です。</li>
        <li>サーバーに過度な負荷をかける行為や、不正なアクセスを試みる行為は禁止です。悪質な場合は法的な対応を行うことがあります。</li>
      </ul>`],
      ['個人情報の取り扱い', '<p>個人情報の取り扱いについては、<a href="#/privacy">プライバシーポリシー</a>をご確認ください。</p>'],
      ['免責事項', '<p>当サイトは安全な運営に努めていますが、利用によって生じたトラブル・損失・損害について一切の責任を負いません。あらかじめご了承ください。</p>'],
      ['規約の変更', '<p>本規約は運営者の判断で変更することがあります。変更後の規約は、本ページに掲示した時点で効力を持ちます。</p>'],
    ]],
    privacy: ['プライバシーポリシー', '<p>{{site}} が利用者の情報をどのように扱うかを説明します。当サイトは、サービスの提供に必要な最小限の情報だけを扱う方針で運営しています。</p>', [
      ['取得する情報', `<ul class="dots">
        <li><b>Discordから受け取る情報</b>：ユーザーID、ユーザー名、表示名、アイコンです（ユーザー名は運営者の管理用で、公開されません）。また、利用対象のDiscordサーバーに参加しているかを確認するため、ログインのたびに参加サーバーの一覧を参照します（確認にのみ使い、保存しません）。メールアドレスやメッセージは受け取りません。</li>
        <li><b>利用者が入力した情報</b>：プレイヤー名、プロフィール、使用キャラクター、フレンドコード、TwitterのユーザーID、日記・コメント・紹介文、対戦の報告内容、お問い合わせの内容など。</li>
        <li><b>サービスの利用に伴う情報</b>：対戦履歴、レート、ポイント、アクセス時のIPアドレスやブラウザの種類など（不正利用の防止のため一時的に記録します）。</li>
        <li>以前メールアドレスで登録した方は、Discordと連携するまでの間だけ、そのメールアドレスを保存しています。連携した時点でサイトから削除します。</li>
      </ul>`],
      ['利用目的', `<ul class="dots">
        <li>ログインの管理と、本人であることの確認</li>
        <li>対戦のマッチング、レート・ランキング・対戦履歴の表示</li>
        <li>荒らし・複数アカウント・不正行為の防止と対応</li>
        <li>お問い合わせへの対応、サービスの改善</li>
      </ul>`],
      ['公開される情報', '<p>プレイヤー名、アイコン、プロフィール、使用キャラクター、TwitterのユーザーID（設定した場合）、レート、対戦成績、日記、紹介文は、他の利用者に公開されます。</p><p>DiscordのユーザーID・ユーザー名、フレンドコード、ポイント、メールアドレスは公開されません。フレンドコードは、フリー対戦で対戦相手にのみ表示されます。</p>'],
      ['Cookieについて', '<p>ログイン状態を保つため、Cookieを使用します。ログイン用のCookieはJavaScriptから読み取れない設定にし、他サイトから送信されないよう制限しています。広告やアクセス解析を目的としたCookieは使用していません。</p>'],
      ['第三者への提供', '<p>法令に基づく場合を除き、利用者の情報を第三者に提供することはありません。サービスの運営には Amazon Web Services（AWS）を利用しており、情報はAWSのサーバーに保存されます。</p>'],
      ['安全管理', '<p>通信はすべて暗号化（HTTPS）しています。不正アクセスへの対策として、アクセス制限や攻撃の検知を行っています。</p>'],
      ['アカウントの削除', '<p>アカウントの削除をご希望の場合は、<a href="#/contact">お問い合わせページ</a>からご連絡ください。削除すると、プロフィール・日記などの情報は削除されます。対戦相手の記録の整合性を保つため、過去の対戦履歴は残ります。</p><p>Discordの設定画面で当サイトとの連携を解除することもできます（解除しても当サイトのアカウントは削除されません）。</p>'],
      ['改定', '<p>本ポリシーは必要に応じて改定することがあります。改定後の内容は、本ページに掲示した時点で効力を持ちます。</p>'],
    ]],
    rules: ['対戦ルール', '<p>レーティング対戦のルールです。対戦前に必ずお読みください。ルールを守らないプレイヤーは規制の対象になります。</p>', [
      ['基本ルール', `<table class="kv"><tr><td>形式</td><td>1対1・2本先取（最大3戦）</td></tr><tr><td>ストック</td><td>3</td></tr><tr><td>時間</td><td>7分</td></tr><tr><td>アイテム</td><td>なし</td></tr><tr><td>ステージギミック</td><td>なし</td></tr></table>`],
      ['マッチング前の準備', '<ol><li>マイページで<a href="#/mypage/stages">拒否ステージ</a>（最大2つ）を設定します。</li><li>レーティング対戦ページで、1戦目に使用するキャラとレート制限を選んで「対戦相手を探す！」を押します。</li></ol>'],
      ['マッチングの流れ', '<ul><li>部屋IDが設定された待機中の部屋があれば、その部屋に入ってマッチングします。</li><li>入れる部屋がない場合は、あなたが部屋を立てる側になります。ゲーム内で専用部屋を作り、部屋IDを入力して「設定」を押してください。パスワードは対戦ルームに表示されたものを使います。</li><li>部屋を立てた側は、対戦相手が入るまで待機画面を開いたままにしてください。画面を閉じたりスマホがスリープしたりして5分以上たつと、募集の対象外になります（画面を開き直すと戻ります）。</li><li>募集をやめる場合は「部屋を削除する」を押してください。</li></ul>'],
      ['ステージの選び方', '<ul><li><b>1戦目</b>：スターターステージから、双方の拒否ステージを除いたステージを選びます（✕印のステージは選べません）。</li><li><b>2,3戦目</b>：直前の試合の敗者が選びます。勝者の拒否ステージは選べません。3戦目は1戦目の勝利ステージを選べません。</li></ul>'],
      ['スイッチ設定・おまかせ', SWITCH_HELP],
      ['2戦目以降のキャラ', '<p>直前の試合の敗者は、2戦目以降のキャラを変更できます。勝者は同じキャラを使い続けてください。対戦ルームの「自分の2戦目以降使用キャラ」で設定すると、相手に表示されます。</p>'],
      ['結果の報告', '<p>2本先取した時点で対戦終了です。対戦ルームの「結果送信」で「勝ち」または「負け」を押してください。報告は何度でも押し直せます。</p><p>マッチングから2分間は「勝ち」「負け」を報告できません（「対戦中止」はいつでも押せます）。</p><p>報告した時点で、相手の報告を待たずに次の対戦相手を探せます。双方の報告が一致した時点でレートが更新されます（相手があとから報告した場合も、そのときに反映されます）。</p><p>対戦できなかった場合は「対戦中止」を押してください。双方が「対戦中止」を押した時点でルームが終了します（レートは変動しません）。</p><p>報告が食い違っている間（「勝ち」と「勝ち」、「勝ち」と「対戦中止」など）はルームが終了せず、双方のマイページに「結果が不一致の対戦ルームがあります」と表示されます。コメント欄で相手と確認して、押し直してください。</p><p>相手が報告しない・不正な中止をされたなどのトラブルは、<a href="#/contact">お問い合わせ</a>からご連絡ください。</p>'],
      ['レートの計算', '<p>初期レートは1500です。イロレーティング方式（K=32）で計算し、格上に勝つほど大きく上がり、格下に負けるほど大きく下がります。</p>'],
      ['マナー', '<ul><li>マッチング後は速やかに対戦を始めてください。</li><li>回線切断などのトラブルが起きた場合は、コメント欄で相談して再戦または中止にしてください。</li><li>やむを得ず対戦できない場合は「対戦中止」を押してください。</li><li>対戦後は、相手の紹介ページで使用キャラクターへの投票にご協力ください。</li></ul>'],
    ]],
    faq: ['Q＆A', '', [
      ['利用は無料ですか？', '<p>はい、すべての機能を無料で利用できます。</p>'],
      ['Discordアカウントがないと使えませんか？', '<p>はい、登録・ログインにはDiscordアカウントが必要です。作成から1か月未満のDiscordアカウントでは登録できません。</p>'],
      ['スマホで別のDiscordアカウントでログインされます。', '<p>スマートフォンでは、Discordアプリでログイン中のアカウントが使われます。別のアカウントで使いたい場合は、Discordアプリ側のアカウントを切り替えてからログインしてください。</p>'],
      ['レートが反映されません。', '<p>双方の勝敗報告が一致した時点で反映されます。相手が未報告の場合は、相手が報告したときに反映されます（その間も次の対戦はできます）。報告が食い違っている場合は、コメント欄で確認して押し直してください。解決しない場合はお問い合わせからご連絡ください。</p>'],
      ['マッチングしません。', '<p>入れる部屋がない場合は、あなたが部屋を立てる側になります。部屋IDを設定し、待機画面を開いたままお待ちください。レート制限を「誰でも」にすると、マッチングしやすくなります。</p>'],
      ['大会のトーナメント表はどう作られますか？', '<p>主催者が大会を開始した時点で、参加者をランダムに配置したシングルエリミネーション形式で作成されます。</p>'],
      ['結果を間違えて報告しました。', '<p>レーティング対戦は、対戦中であれば報告を押し直せます。決着後の修正が必要な場合は、お問い合わせからご連絡ください。</p>'],
      ['「結果が不一致の対戦ルームがあります」と表示されます。', '<p>相手と報告が食い違っているルームがあります。表示されたリンクからルームを開き、コメント欄で相手と確認して押し直してください。解決しない場合はお問い合わせからご連絡ください。</p>'],
    ]],
    contact: ['お問い合わせ', '', [['お問い合わせ', '<p>不具合の報告や規約違反の通報は、運営者までご連絡ください。</p><p class="muted small">（連絡先は運営者が設定してください）</p>']]],
    links: ['リンク集', '', [['リンク集', '<p class="muted">リンクはまだ登録されていません。</p>']]],
  };
  // Smash・Ball・Run (public site, edition "sbr"): a rated-matches-only revival of スマメイト that
  // signs in with Discord alone. These replace the pages above; the rest (rules, contact) are shared.
  // Every claim in 安全への取り組み / プライバシーポリシー describes what the code and infrastructure do.
  const SBR_DOCS = {
    about: ['サイトについて', '', [
      ['{{site}}とは', `<p>{{site}} は、スマメイトの「レーティング対戦」を再現した、個人運営のファンサイトです。実力の近いプレイヤーとのマッチング、対戦ルーム、勝敗報告、レート・ランキング、対戦履歴など、レーティング対戦に必要な機能だけに絞って提供しています。</p>
        <p><a href="#/terms">利用規約はこちら</a>、<a href="#/privacy">プライバシーポリシーはこちら</a>、<a href="#/security">安全への取り組みはこちら</a>。サービスを利用した時点で利用規約に同意したものとみなします。</p>
        <p class="strong-red">当サイトは個人が運営するWebサービスです。スマメイトの運営者、ゲームの権利者・関連企業とは一切関係ありません。当サイトについてのお問い合わせを、これらの方々へ送らないようお願いします。</p>`],
      ['スマメイトとの違い', `<ul class="dots">
        <li>利用できるのは、レーティング対戦とランキング・対戦履歴・紹介ページだけです。フリー対戦、大会、プレイヤー日記、ポイント、メダルなどの機能はありません。</li>
        <li>登録・ログインはDiscordアカウントだけで行います。メールアドレスやパスワードの登録はありません。</li>
        <li>スマメイトのアカウント・レート・対戦成績は引き継げません。全員レート1500からのスタートです。</li>
        <li>フレンドコードの登録はありません。対戦はゲーム内の専用部屋（部屋ID・パスワード）で行います。</li>
      </ul>`],
      ['登録・ログインについて', '<p>登録・ログインにはDiscordアカウントを使用します。作成から1か月未満のDiscordアカウントでは登録できません。</p><p>スマートフォンでは、Discordアプリでログイン中のアカウントで登録・ログインされます。</p><p>Discordから受け取る情報や、安全のための対策は<a href="#/security">安全への取り組み</a>にまとめています。</p>'],
      ['レーティング対戦について', '<p>レーティング対戦では、近い実力のプレイヤーとマッチングします。決められたルールで対戦し、双方が勝敗を報告するとレートが変動します。対戦のルールや流れはスマメイトと同じです。</p><p><a href="#/rules">レーティング対戦のルールはこちら</a>。トラブルを防ぐため、必ずルールを守って対戦してください。</p>'],
      ['シーズンについて', '<p>レートとランキングは、一定の期間（シーズン）ごとに区切ってリセットすることがあります。区切りの日時が決まったら、レーティング対戦ページでお知らせします。前のシーズンの成績は保存しています。</p>'],
      ['ランキングについて', '<p>レーティング対戦の結果によってレートが変動し、レート上位のプレイヤーがランキングに表示されます。ファイター別のランキングも確認できます。</p>'],
      ['紹介ページについて', '<p>レーティング対戦で対戦したプレイヤーは、相手の使用キャラクターへの投票と紹介文を書けます。対戦相手の情報収集にご活用ください。</p>'],
      ['規制について', '<p>ルールやマナーを守らないプレイヤーは、機能の利用を制限する場合があります。複数アカウントの利用やアカウントの貸し借りも制限の対象です。</p>'],
      ['問い合わせについて', '<p>お問い合わせは<a href="#/contact">お問い合わせページ</a>からお願いします。</p>'],
    ]],
    security: ['安全への取り組み', '<p>{{site}} を安心して使っていただくために、どんな情報を受け取り、それをどう守っているかを、できるだけ具体的にまとめました。ご自身で確かめられる点は、その方法もあわせて書いています。</p>', [
      ['登録はDiscordアカウントだけ', '<p>登録・ログインはDiscordアカウントだけで行います。メールアドレス、パスワード、電話番号、本名、住所などを当サイトに入力する必要はありません。</p><p>パスワードの入力や二段階認証はDiscordの画面（discord.com）で行われ、当サイトはパスワードを受け取りも保存もしません。そのため、当サイトからパスワードが漏れることはありません。ログインの際は、ブラウザのアドレス欄が discord.com になっていることをご確認ください。</p>'],
      ['Discordから受け取る情報', `<p>ログインの際に当サイトがDiscordに求める権限は「identify」（あなたのユーザー情報の参照）だけです。Discordの認証画面にも、この内容が表示されます。</p>
        <figure class="doc-fig"><img src="assets/brand/discord-consent.jpg" width="1206" height="783" loading="lazy" alt="Discordの認証画面。Smash・Ball・Runのデベロッパーができるようになることとして「ユーザー名、アバター画像、バナーにアクセス」だけが表示されている"><figcaption>ログイン時に表示されるDiscordの認証画面（ユーザー名は伏せています）。当サイトが求める権限は「ユーザー名、アバター画像、バナーにアクセス」の1つだけです。</figcaption></figure>
        <ul class="dots">
          <li><b>受け取って保存するもの</b>：DiscordのユーザーID、ユーザー名、表示名</li>
          <li><b>受け取るが保存しないもの</b>：アイコン画像の情報など、ユーザー情報に含まれるその他の項目</li>
          <li><b>受け取らないもの</b>：メールアドレス、電話番号、参加しているサーバー、フレンド、メッセージ、支払い情報</li>
        </ul>
        <p>DiscordのユーザーIDとユーザー名は公開されません。お問い合わせや不正利用への対応にだけ使います。表示名は、プレイヤー名の初期値として使います（あとから変更できます）。</p>`],
      ['Discordアカウントを操作することはありません', '<p>ログインの確認に使う一時的な許可（アクセストークン）は、確認が済んだらその場で破棄し、保存していません。そのため当サイトが、あなたのDiscordアカウントでメッセージを送ったり、サーバーに参加させたり、あとから情報を取りに行ったりすることはできません。</p><p>当サイトに許可している内容は、Discordの「ユーザー設定」→「承認済みアプリ」でいつでも確認でき、そこから連携を解除することもできます（解除しても当サイトのアカウントは削除されません）。</p>'],
      ['公開される情報・されない情報', `<ul class="dots">
        <li><b>誰でも見られる</b>：プレイヤー名、プロフィール画像、プロフィール文、TwitterのユーザーID（設定した場合）、レート、対戦成績・対戦履歴、紹介文、キャラ投票の結果、対戦設定（接続環境など）、対戦ルームの内容（使用キャラ、拒否ステージ、対戦の状態、対戦前後のコメント、ルームのコメント）</li>
        <li><b>対戦相手だけが見られる</b>：ゲーム内の部屋ID（対戦する部屋に入るための情報）</li>
        <li><b>公開されない</b>：DiscordのユーザーID・ユーザー名、スイッチ設定、キャラ対策メモ、お問い合わせの内容</li>
      </ul>`],
      ['ログイン状態の保護', '<p>ログイン状態はCookieで保ちます。このCookieは、ページ上のプログラムから読み取れない設定（HttpOnly）、暗号化された通信でしか送られない設定（Secure）、他のサイトからは送られない設定（SameSite）にしています。悪意のあるページがあなたになりすまして操作することを防ぐ仕組み（CSRF対策）も入れています。</p><p>ログイン状態は最長7日で切れ、その後は再度ログインが必要です。ログアウトすると、ブラウザからログイン情報を消し、サーバー側でもそのログインを取り消します。</p>'],
      ['通信と保存データの暗号化', '<p>サイトとの通信はすべてHTTPSで暗号化しています（http:// でアクセスしても、暗号化された通信に切り替わります）。ブラウザのアドレス欄の鍵マークで確認できます。</p><p>データは Amazon Web Services（AWS）の東京リージョン（日本国内）に保存し、保存されたデータも暗号化しています。データベースや画像の置き場所は外から直接アクセスできない設定にし、当サイトのプログラムを通してだけ読み書きできるようにしています。</p>'],
      ['不正アクセス・攻撃への対策', `<ul class="dots">
        <li>AWSのWebアプリケーションファイアウォール（AWS WAF）で、既知の攻撃パターンや、悪用が報告されているIPアドレスからのアクセスを遮断しています。</li>
        <li>短時間に大量のアクセスや操作があると、自動的に制限がかかります。ログインの手続きにも回数の上限があります。</li>
        <li>ページ上で動くプログラムを当サイトのものだけに制限し、外部のスクリプトを読み込めない設定（コンテンツセキュリティポリシー）にしています。他のサイトに当サイトを埋め込むこともできません。</li>
        <li>サーバーの異常や攻撃の兆候、想定外の利用料の増加を検知すると、運営者に自動で通知が届きます。</li>
      </ul>`],
      ['サブ垢・不正な対戦への対策', `<ul class="dots">
        <li>作成から1か月未満のDiscordアカウントでは登録できません。</li>
        <li>1つのDiscordアカウントで作れる当サイトのアカウントは1つだけです。</li>
        <li>対戦結果は、双方の報告が一致したときだけレートに反映されます。</li>
      </ul>`],
      ['広告・アクセス解析なし', '<p>広告や、アクセス解析・トラッキングのためのツールやCookieは使っていません。ページの表示に外部のサービス（フォントの配信など）も使っていないため、閲覧の情報が広告会社や解析サービスなどの第三者に送られることはありません（ログインの際にDiscordの画面へ移動するときを除きます）。</p>'],
      ['プロフィール画像', '<p>プロフィール画像は、お使いの端末上で200×200ピクセルの画像に作り直してから送信します。さらにサーバー側でも、写真に含まれる撮影場所（位置情報）や撮影機器などの情報を取り除いてから公開します。</p>'],
      ['運営者が扱える情報', '<p>運営者は、お問い合わせや不正利用に対応するため、公開されている情報に加えて、DiscordのユーザーID・ユーザー名、お問い合わせの内容を確認できます。Discordのパスワードやメッセージなど、当サイトが受け取っていない情報は運営者にも見えません。</p>'],
      ['記録の保存期間', `<ul class="dots">
        <li>不正利用の調査のため、アクセスの記録（日時、IPアドレス、アクセスしたページ）を2週間保存します。この記録に、ログイン情報や入力した内容は含めていません。</li>
        <li>不具合の調査のため、エラーの記録を1か月保存します。</li>
        <li>障害に備えて、データのバックアップを最大35日分保存しています。</li>
      </ul>`],
      ['退会・データの削除', '<p>アカウントの削除をご希望の場合は、<a href="#/contact">お問い合わせ</a>からご連絡ください。プロフィール、プロフィール画像、設定などを削除し、Discordアカウントとのつながりも解除します。</p><p>対戦相手の記録の整合性を保つため、過去の対戦履歴、対戦ルームのコメント、他のプレイヤーに書いた紹介文、お問い合わせの内容は残ります。バックアップに残ったデータも、最大35日で消えます。</p>'],
      ['運営の方針', `<ul class="dots">
        <li>運営費は運営者が負担しています。広告の掲載、有料の機能、利用者の情報の販売や第三者への提供は行いません。</li>
        <li>サービスを終了する場合は、30日以上前にサイト上でお知らせします。終了後は、保存しているデータを30日以内にすべて削除します。</li>
        <li>情報の漏えいなど、利用者に影響のある問題が起きた場合は、判明してから原則3日以内にサイト上で公表し、影響を受けた方にお知らせします。</li>
      </ul>`],
      ['困ったときは', '<p>身に覚えのない操作がある、なりすましを見つけたなど、安全に関わることは<a href="#/contact">お問い合わせ</a>からご連絡ください。</p>'],
    ]],
    privacy: ['プライバシーポリシー', '<p>{{site}} が利用者の情報をどのように扱うかを説明します。当サイトは、サービスの提供に必要な最小限の情報だけを扱う方針で運営しています。</p>', [
      ['取得する情報', `<ul class="dots">
        <li><b>Discordから受け取る情報</b>：Discordの「identify」権限で受け取れるユーザー情報です。このうち保存するのは、ユーザーID、ユーザー名、表示名だけです。メールアドレス、参加しているサーバー、フレンド、メッセージは受け取りません。</li>
        <li><b>利用者が入力した情報</b>：プレイヤー名、プロフィール、プロフィール画像、TwitterのユーザーID、拒否ステージ、スイッチ設定、キャラ対策メモ、対戦ルームのコメント、紹介文・キャラ投票、対戦の報告内容、お問い合わせの内容など。</li>
        <li><b>サービスの利用に伴う情報</b>：対戦履歴、レート、アクセスの記録（日時、IPアドレス、アクセスしたページ）。</li>
      </ul>`],
      ['利用目的', `<ul class="dots">
        <li>ログインの管理と、本人であることの確認</li>
        <li>対戦のマッチング、レート・ランキング・対戦履歴の表示</li>
        <li>荒らし・複数アカウント・不正行為の防止と対応</li>
        <li>お問い合わせへの対応、サービスの改善</li>
      </ul>`],
      ['公開される情報', '<p>プレイヤー名、プロフィール画像、プロフィール、TwitterのユーザーID（設定した場合）、レート、対戦成績・対戦履歴、紹介文、キャラ投票の結果、対戦設定（接続環境など）、対戦ルームの内容（使用キャラ、拒否ステージ、対戦前後のコメント、ルームのコメント）は、誰でも閲覧できます。ゲーム内の部屋IDは、対戦相手にだけ表示されます。</p><p>DiscordのユーザーID・ユーザー名、スイッチ設定、キャラ対策メモ、お問い合わせの内容は公開されません。</p>'],
      ['Cookieについて', '<p>ログイン状態を保つため、Cookieを使用します。ログイン用のCookieはページ上のプログラムから読み取れない設定にし、他サイトから送信されないよう制限しています。広告やアクセス解析を目的としたCookieは使用していません。</p>'],
      ['第三者への提供', '<p>法令に基づく場合を除き、利用者の情報を第三者に提供することはありません。</p><p>サービスの運営には Amazon Web Services（AWS）を利用しており、情報はAWSの東京リージョンのサーバーに保存されます。ログインにはDiscordを利用します。</p>'],
      ['保存期間', '<p>アカウントの情報は、アカウントを削除するまで保存します。アクセスの記録は2週間、エラーの記録は1か月、バックアップは最大35日で自動的に消えます。</p>'],
      ['安全管理', '<p>通信の暗号化、保存データの暗号化、不正アクセスへの対策などを行っています。具体的な内容は<a href="#/security">安全への取り組み</a>をご覧ください。</p>'],
      ['アカウントの削除', '<p>アカウントの削除をご希望の場合は、<a href="#/contact">お問い合わせページ</a>からご連絡ください。削除すると、プロフィール・プロフィール画像・設定などの情報は削除されます。対戦相手の記録の整合性を保つため、過去の対戦履歴は残ります。バックアップに残ったデータも最大35日で消えます。</p><p>Discordの「ユーザー設定」→「承認済みアプリ」から、当サイトとの連携を解除することもできます（解除しても当サイトのアカウントは削除されません）。</p>'],
      ['保有している情報の開示・訂正・削除などのご請求', '<p>当サイトが保有しているご本人の情報について、開示・訂正・追加・削除・利用停止などをご希望の場合は、ご本人のアカウントでログインした状態で<a href="#/contact">お問い合わせ</a>からご連絡ください。</p><p>ログイン中のアカウントからの送信をもって本人確認とし、内容を確認のうえ、マイページの「お問い合わせ履歴」でご回答します。手数料はかかりません。</p>'],
      ['改定', '<p>本ポリシーは必要に応じて改定することがあります。改定後の内容は、本ページに掲示した時点で効力を持ちます。</p>'],
    ]],
    terms: ['利用規約', '<p>{{site}} の利用規約です。サービスを利用した時点で本規約に同意したものとみなしますので、必ず最後までお読みください。規約に違反した場合、機能の制限やアカウントの停止などを行うことがあります。</p>', [
      ['アカウント', `<ul class="dots">
        <li>登録・ログインにはDiscordアカウントを使用します。Discordの利用規約も守ってください。</li>
        <li>Discordの利用規約により、13歳未満の方は利用できません。未成年の方は、保護者の同意を得てから利用してください。</li>
        <li>1人で複数のアカウントを使うこと、アカウントを他人に貸したり譲ったりすることは禁止です。</li>
        <li>作成から1か月未満のDiscordアカウントでは登録できません。</li>
        <li>Discordアカウントやその連携を自分で管理できなくなった場合（乗っ取り・削除など）、当サイトのアカウントを引き継げないことがあります。</li>
      </ul>`],
      ['禁止事項', `<ul class="dots">
        <li>荒らし行為・不正行為は禁止です。荒らしと思われる投稿には反応せず、無視してください。</li>
        <li>他のプレイヤーへの誹謗中傷、差別的な発言、嫌がらせは禁止です。丁寧な言葉づかいを心がけてください。</li>
        <li>他の人の個人情報（本名、住所、連絡先など）を書き込むことは禁止です。</li>
        <li>公序良俗に反する表現や、未成年に悪影響を与える表現は禁止です。</li>
        <li>改造した本体・ソフト・周辺機器を使ってオンライン対戦に参加する行為は禁止です。</li>
        <li>虚偽の勝敗報告、談合、複数アカウントの利用など、レートを不正に操作する行為は禁止です。</li>
        <li>サーバーに過度な負荷をかける行為や、不正なアクセスを試みる行為は禁止です。悪質な場合は法的な対応を行うことがあります。</li>
      </ul>`],
      ['個人情報の取り扱い', '<p>個人情報の取り扱いについては、<a href="#/privacy">プライバシーポリシー</a>をご確認ください。</p>'],
      ['免責事項', '<p>当サイトは安全な運営に努めていますが、利用によって生じたトラブル・損失・損害について一切の責任を負いません。あらかじめご了承ください。</p>'],
      ['サービスの変更・終了', '<p>当サイトは、予告なく内容の変更、一時的な停止、または提供の終了をすることがあります。</p>'],
      ['規約の変更', '<p>本規約は運営者の判断で変更することがあります。変更後の規約は、本ページに掲示した時点で効力を持ちます。</p>'],
    ]],
    faq: ['Q＆A', '', [
      ['利用は無料ですか？', '<p>はい、無料で利用できます。</p>'],
      ['スマメイトのアカウントやレートは引き継げますか？', '<p>いいえ。{{site}} はスマメイトとは別のサイトのため、アカウント・レート・対戦成績は引き継げません。全員レート1500からのスタートです。</p>'],
      ['Discordアカウントがないと使えませんか？', '<p>はい、登録・ログインにはDiscordアカウントが必要です。作成から1か月未満のDiscordアカウントでは登録できません。</p>'],
      ['メールアドレスやパスワードの登録は必要ですか？', '<p>いいえ、必要ありません。登録・ログインはDiscordアカウントだけで行います。</p>'],
      ['Discordのメッセージやフレンドを見られることはありますか？', '<p>ありません。当サイトがDiscordから受け取るのは、ユーザーID・ユーザー名・表示名などの基本的なユーザー情報だけです。詳しくは<a href="#/security">安全への取り組み</a>をご覧ください。</p>'],
      ['スマホで別のDiscordアカウントでログインされます。', '<p>スマートフォンでは、Discordアプリでログイン中のアカウントが使われます。別のアカウントで使いたい場合は、Discordアプリ側のアカウントを切り替えてからログインしてください。</p>'],
      ['マッチングしません。', '<p>入れる部屋がない場合は、あなたが部屋を立てる側になります。部屋IDを設定し、待機画面を開いたままお待ちください。レート制限を「誰でも」にすると、マッチングしやすくなります。</p>'],
      ['すぐに結果を報告できません。', '<p>マッチングから2分間は「勝ち」「負け」を報告できません。対戦できなくなった場合の「対戦中止」はいつでも押せます。</p>'],
      ['レートが反映されません。', '<p>双方の勝敗報告が一致した時点で反映されます。相手が未報告の場合は、相手が報告したときに反映されます（その間も次の対戦はできます）。報告が食い違っている場合は、コメント欄で確認して押し直してください。解決しない場合はお問い合わせからご連絡ください。</p>'],
      ['結果を間違えて報告しました。', '<p>双方の報告が一致するまでは、何度でも押し直せます。決着後の修正が必要な場合は、お問い合わせからご連絡ください。</p>'],
      ['「結果が不一致の対戦ルームがあります」と表示されます。', '<p>相手と報告が食い違っているルームがあります。表示されたリンクからルームを開き、コメント欄で相手と確認して押し直してください。解決しない場合はお問い合わせからご連絡ください。</p>'],
      ['相手が「対戦中止」を押しました。', '<p>対戦していない場合は、あなたも「対戦中止」を押すとルームが終了します。対戦した場合は結果を報告してください（報告が食い違っている間は、ルームは終了しません）。</p>'],
      ['レートやランキングはリセットされますか？', '<p>シーズンの区切りで、全員のレートが1500に戻り、ランキングもリセットされることがあります。区切りの日時が決まったら、レーティング対戦ページでお知らせします。</p>'],
      ['退会したいです。', '<p><a href="#/contact">お問い合わせ</a>から「その他」を選んでご連絡ください。プロフィールやプロフィール画像などを削除します。あわせて、Discordの「ユーザー設定」→「承認済みアプリ」から当サイトとの連携を解除できます。</p>'],
    ]],
  };
  const toDoc = ([title, lead, secs]) => ({ title, lead, sections: secs.map(([h, html]) => ({ h, html })) });
  // This site's default pages: the shared ones, with its edition's versions in place
  const defaultDocs = () => Object.fromEntries(Object.entries({ ...DOCS, ...(CONFIG?.edition === 'sbr' ? SBR_DOCS : {}) }).map(([k, d]) => [k, toDoc(d)]));
  const DOC_LABELS = { about: 'サイトについて', terms: '利用規約', privacy: 'プライバシーポリシー', security: '安全への取り組み', rules: '対戦ルール', faq: 'Q＆A', contact: 'お問い合わせ', links: 'リンク集' };
  const rawFill = (s) => String(s ?? '').split('{{site}}').join(SITE.siteName); // for strings escaped later
  // Default pages leave out the sections about features this site has closed
  const DOC_SECTION_FEATURE = {
    'フリー対戦について': 'free',
    'プレイヤー日記について': 'diaries',
    '大会のトーナメント表はどう作られますか？': 'tournaments',
  };
  const builtinDoc = (key) => {
    const d = defaultDocs()[key];
    return d && { ...d, sections: d.sections.filter((s) => !closed(DOC_SECTION_FEATURE[s.h])) };
  };
  const getDoc = (key) => SITE.docs?.[key] || builtinDoc(key);
  const hasDoc = (key) => Boolean(getDoc(key));

  // Doc bodies are HTML written by the admin (trusted).
  function pageDoc(key) {
    const d = getDoc(key);
    const title = rawFill(d.title);
    app.innerHTML = layout({
      crumb: esc(title),
      title,
      single: `${d.lead ? `<div class="doc-lead">${fill(d.lead)}</div>` : ''}${d.sections.map((s) => `<section class="doc-sec"><h2 class="box-head">${fillText(s.h)}</h2><div class="doc-body">${fill(s.html)}</div></section>`).join('')}`,
    });
  }

  // ---------- Admin ----------
  function pageAdmin() {
    if (!requireLogin('管理ページ')) return;
    if (!me.isAdmin) {
      app.innerHTML = layout({ crumb: '管理ページ', title: '管理ページ', single: errorBox('このページは管理者のみ利用できます。') });
      return;
    }
    // Work on a deep copy; saved as a whole
    const draft = JSON.parse(JSON.stringify({
      siteName: SITE.siteName,
      homeIntro: SITE.homeIntro || defaultHomeIntro(),
      footer: SITE.footer,
      notices: SITE.notices,
      docs: Object.fromEntries(Object.keys(defaultDocs()).map((k) => [k, getDoc(k)])),
    }));
    let docKey = 'about';

    app.innerHTML = layout({
      crumb: '管理ページ',
      title: '管理ページ',
      side: `${box('管理ページについて', `<p>サイト名・トップページの紹介文・お知らせ・各ページの本文・フッターを編集できます。</p>
          <p>文中の <code>{{site}}</code> はサイト名に置き換わります。</p>
          <p class="small muted">各ページの本文はHTMLで記述できます（例：&lt;p&gt;段落&lt;/p&gt;、&lt;ul&gt;&lt;li&gt;項目&lt;/li&gt;&lt;/ul&gt;、&lt;a href="#/rules"&gt;リンク&lt;/a&gt;）。</p>
          <p><a class="btn btn-outline btn-block" href="#/admin/users">ユーザー管理</a></p>
          <p><a class="btn btn-outline btn-block" href="#/admin/matches">対戦結果の修正</a></p>
          <p><a class="btn btn-outline btn-block" href="#/admin/contacts">お問い合わせ一覧を見る</a></p>
          <p><a class="btn btn-outline btn-block" href="#/admin/audit">管理操作の履歴</a></p>
          <div class="adm-season"><b>シーズン</b><p class="small" id="season-now">読み込み中…</p>
            <label class="small" for="season-end-at">終了予定日時（入れるとレーティング対戦の画面に表示されます。空にして保存で非表示）</label>
            <div class="row"><input id="season-end-at" type="datetime-local"><button type="button" class="btn-line" id="season-end-save">保存</button></div>
            <div class="row" data-style="margin-top:10px"><input id="season-no" type="number" min="1" max="9999" inputmode="numeric" aria-label="新しいシーズン番号">
            <button type="button" class="btn-line" id="season-set">シーズンを変更</button></div>
            <p class="small red">次のシーズンに進めると、全員のレートが1500に戻り、ランキングもリセットされます（前シーズンの成績は保存されます）。元には戻せません。</p></div>
          <hr><button class="btn btn-lg btn-block" id="save">すべて保存して反映</button>
          <p class="small muted" data-style="margin-top:8px">保存するとすぐに全ユーザーの画面に反映されます。</p>`)}`,
      main: `
        ${box('基本設定', `
          <div class="field"><label for="a-name">サイト名</label><input id="a-name" maxlength="40" value="${esc(draft.siteName)}"><div class="hint">ブラウザのタブ、トップページの見出し、フッターなどに表示されます。</div></div>
          <div class="field"><label for="a-intro">トップページの紹介文</label><textarea id="a-intro" maxlength="3000" data-style="min-height:140px">${esc(draft.homeIntro)}</textarea><div class="hint">空行で段落が分かれます。</div></div>
          <div class="field"><label for="a-footer">フッター文</label><textarea id="a-footer" maxlength="1000">${esc(draft.footer)}</textarea><div class="hint">1行ずつ中央寄せで表示されます。最後にCopyright行が自動で付きます。</div></div>`)}
        ${box('お知らせ（更新履歴）', `<p class="small muted">お知らせは「更新履歴」ページ（<a href="#/updates">${esc(location.origin)}/#/updates</a>）に新しい順で一覧表示されます。サイト内にこのページへのリンクはないので、告知用のアカウントでURLをお知らせください。各お知らせの個別ページのURLは、保存後に下に表示されます。</p><div id="notices"></div><button class="btn btn-outline btn-sm" id="add-notice">＋ お知らせを追加</button>`)}
        ${box('ページ本文', `
          <div class="field"><label for="a-doc">編集するページ</label><select id="a-doc">${Object.keys(defaultDocs()).map((k) => `<option value="${k}">${DOC_LABELS[k]}</option>`).join('')}</select></div>
          <div id="doc-editor"></div>`)}`,
    });

    const nEl = $('#notices');
    function renderNotices() {
      nEl.innerHTML = draft.notices.map((n, i) => `<div class="box-body" data-style="margin:0 0 10px" data-i="${i}">
          <div class="row"><input data-f="at" value="${esc(n.at)}" data-style="max-width:140px" placeholder="日付"><input data-f="title" value="${esc(n.title)}" data-style="flex:1" placeholder="タイトル"></div>
          <textarea data-f="body" data-style="margin-top:6px;min-height:80px" placeholder="本文">${esc(n.body)}</textarea>
          ${SITE.notices.some((s) => s.id === n.id) ? `<p class="small muted" data-style="margin:6px 0 0;word-break:break-all">URL：${esc(location.origin)}/#/news/${esc(n.id)}</p>` : ''}
          <div class="row" data-style="margin-top:6px">${i ? '<button class="btn btn-outline btn-sm" data-act="up">↑ 上へ</button>' : ''}<span class="spacer"></span><button class="btn btn-gray btn-sm" data-act="del">削除</button></div>
        </div>`).join('') || '<p class="muted">お知らせはありません</p>';
    }
    nEl.addEventListener('input', (e) => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      if (i != null && e.target.dataset.f) draft.notices[i][e.target.dataset.f] = e.target.value;
    });
    nEl.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      const i = Number(e.target.closest('[data-i]')?.dataset.i);
      if (act === 'del') draft.notices.splice(i, 1);
      else if (act === 'up') [draft.notices[i - 1], draft.notices[i]] = [draft.notices[i], draft.notices[i - 1]];
      else return;
      renderNotices();
    });
    $('#add-notice').addEventListener('click', () => {
      const d = new Date();
      draft.notices.unshift({ id: `n${Date.now().toString(36)}`, at: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, title: '', body: '' });
      renderNotices();
    });
    renderNotices();

    const dEl = $('#doc-editor');
    function renderDoc() {
      const d = draft.docs[docKey];
      dEl.innerHTML = `
        <div class="field"><label>ページタイトル</label><input data-doc="title" maxlength="40" value="${esc(d.title)}"></div>
        <div class="field"><label>冒頭文（HTML・省略可）</label><textarea data-doc="lead" data-style="min-height:70px">${esc(d.lead)}</textarea></div>
        ${d.sections.map((s, i) => `<div class="box-body" data-style="margin:0 0 10px" data-s="${i}">
            <div class="field"><label>見出し ${i + 1}</label><input data-sf="h" maxlength="60" value="${esc(s.h)}"></div>
            <textarea data-sf="html" data-style="min-height:120px;font-family:monospace;font-size:.85rem">${esc(s.html)}</textarea>
            <div class="row" data-style="margin-top:6px">${i ? '<button class="btn btn-outline btn-sm" data-sact="up">↑ 上へ</button>' : ''}<span class="spacer"></span><button class="btn btn-gray btn-sm" data-sact="del">この見出しを削除</button></div>
          </div>`).join('')}
        <div class="row"><button class="btn btn-outline btn-sm" id="add-sec">＋ 見出しを追加</button><span class="spacer"></span><button class="btn btn-gray btn-sm" id="reset-doc">このページを初期内容に戻す</button><a class="btn btn-outline btn-sm" href="#/${docKey}" target="_blank">表示を確認（保存後）</a></div>`;
    }
    dEl.addEventListener('input', (e) => {
      const d = draft.docs[docKey];
      if (e.target.dataset.doc) d[e.target.dataset.doc] = e.target.value;
      const i = e.target.closest('[data-s]')?.dataset.s;
      if (i != null && e.target.dataset.sf) d.sections[i][e.target.dataset.sf] = e.target.value;
    });
    dEl.addEventListener('click', (e) => {
      const d = draft.docs[docKey];
      const i = Number(e.target.closest('[data-s]')?.dataset.s);
      if (e.target.dataset.sact === 'del') d.sections.splice(i, 1);
      else if (e.target.dataset.sact === 'up') [d.sections[i - 1], d.sections[i]] = [d.sections[i], d.sections[i - 1]];
      else if (e.target.id === 'add-sec') d.sections.push({ h: '新しい見出し', html: '<p></p>' });
      else if (e.target.id === 'reset-doc') draft.docs[docKey] = JSON.parse(JSON.stringify(builtinDoc(docKey)));
      else return;
      renderDoc();
    });
    $('#a-doc').addEventListener('change', (e) => { docKey = e.target.value; renderDoc(); });
    renderDoc();

    const localInput = (iso) => {
      const d = new Date(iso);
      const z = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
    };
    const showSeason = (s) => {
      $('#season-now').textContent = `現在：第${s.no}期${s.startedAt ? `（${fullDate(s.startedAt)} 開始）` : ''}${s.endsAt ? `／終了予定 ${jstEnd(s.endsAt)}` : ''}`;
      $('#season-no').value = s.no + 1;
      $('#season-end-at').value = s.endsAt ? localInput(s.endsAt) : '';
    };
    $('#season-end-save').addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
      const v = $('#season-end-at').value;
      showSeason(await api('/api/admin/season-end', { method: 'PUT', body: { endsAt: v ? new Date(v).toISOString() : '' } }));
      toast(v ? '終了予定日時を保存しました' : '終了予定日時の表示をやめました');
    }));
    api('/api/season').then(showSeason).catch(() => { $('#season-now').textContent = '取得できませんでした'; });
    $('#season-set').addEventListener('click', (ev) => {
      const b = ev.currentTarget;
      if (!b.dataset.armed) {
        b.dataset.armed = '1';
        b.textContent = 'もう一度タップで変更';
        setTimeout(() => { if (b.isConnected && b.dataset.armed) { b.textContent = 'シーズンを変更'; delete b.dataset.armed; } }, 3000);
        return;
      }
      delete b.dataset.armed;
      b.textContent = 'シーズンを変更';
      withBusy(b, async () => {
        const r = await api('/api/admin/season', { method: 'PUT', body: { no: Number($('#season-no').value) } });
        showSeason(r);
        toast(`第${r.no}期を開始しました（成績を保存 ${r.archived}人／リセット ${r.reset}人）`);
      });
    });
    $('#save').addEventListener('click', (ev) => withBusy(ev.target, async () => {
      draft.siteName = $('#a-name').value;
      draft.homeIntro = $('#a-intro').value;
      draft.footer = $('#a-footer').value;
      // Store only what differs from the built-in texts, so later improvements to the
      // built-in pages still reach every page nobody has edited
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const { site } = await api('/api/admin/site', {
        method: 'PUT',
        body: {
          ...draft,
          homeIntro: draft.homeIntro.trim() === defaultHomeIntro() ? '' : draft.homeIntro,
          docs: Object.fromEntries(Object.entries(draft.docs).filter(([k, d]) => !same(d, builtinDoc(k)))),
        },
      });
      Object.assign(SITE, site);
      applySite();
      toast('保存して反映しました');
    }));
  }
  function pageNews(id) {
    const n = SITE.notices.find((x) => x.id === id);
    if (!n) { app.innerHTML = errorBox('お知らせが見つかりません'); return; }
    app.innerHTML = layout({ crumb: [crumbLink('#/updates', '更新履歴'), 'お知らせ'], title: rawFill(n.title), single: box(esc(n.at), paras(n.body) || '<p class="muted">本文はありません</p>') });
  }
  // 更新履歴: every notice, newest first. Like the original, nothing on the site links here;
  // the URL is shared from the announcement account.
  function pageUpdates() {
    const items = SITE.notices || [];
    app.innerHTML = layout({
      crumb: '更新履歴',
      title: '更新履歴',
      single: items.length
        ? `<ul class="upd-list">${items.map((n) => `<li><span class="upd-at">${esc(n.at)}</span><a href="#/news/${esc(n.id)}">${fillText(n.title)}</a></li>`).join('')}</ul>`
        : '<p class="empty">まだ更新履歴はありません</p>',
    });
  }

  // ---------- Small UI helpers (option lists, modal) ----------
  const optList = (name, items, sel) =>
    `<div class="optlist" data-name="${name}">${items.map(([v, l]) => `<button type="button" class="${String(v) === String(sel) ? 'on' : ''}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
  function bindOptLists(root) {
    root.querySelectorAll('.optlist').forEach((list) => list.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      list.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      list.dispatchEvent(new CustomEvent('optchange', { detail: b.dataset.v, bubbles: true }));
    }));
  }
  const optValue = (root, name) => root.querySelector(`.optlist[data-name="${name}"] button.on`)?.dataset.v;

  function openModal(title, html, onMount) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><span>${esc(title)}</span><button aria-label="閉じる">×</button></div><div class="modal-body">${html}</div></div>`;
    const close = () => back.remove();
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.modal-head button')) close(); });
    document.body.appendChild(back);
    onMount?.(back.querySelector('.modal-body'), close);
    return close;
  }
  // Choose a fighter from the image grid (optionally "おまかせ")
  function pickFighter(title, { omakase = false } = {}, onPick) {
    openModal(title, fighterPicker(omakase), (body, close) => {
      body.addEventListener('click', (e) => {
        if (e.target.closest('[data-omakase]')) { close(); onPick('おまかせ'); return; }
        const b = e.target.closest('[data-fi]');
        if (b) { close(); onPick(window.FIGHTERS[Number(b.dataset.fi)]); }
      });
    });
  }

  // Switch settings { opponent's 1st fighter: my 1st fighter }: rows are edited here and stored with 保存する
  function openSwitches(onChange) {
    const F = window.FIGHTERS;
    // Stored maps come back in no particular order, so list them in fighter-number order
    const rows = Object.entries(me.switches || {}).sort(([a], [b]) => F.indexOf(a) - F.indexOf(b));
    const img = (f) => `<img src="${fighterImg(f)}" alt="${esc(f)}" title="${esc(f)}" loading="lazy">`;
    openModal('スイッチ設定', `<table class="sw-tbl"><thead><tr><th>相手キャラ</th><th>変更キャラ</th><th></th></tr></thead><tbody></tbody></table>
      <div class="sw-foot"><button type="button" class="btn btn-green" id="sw-save">保存する</button></div>`, (body, close) => {
      const tbody = body.querySelector('tbody');
      const render = () => {
        // Tap a fighter image in a saved row to choose that fighter again
        const cell = (i, side, f) => `<button type="button" class="sw-pick" data-edit="${i}" data-side="${side}" aria-label="${esc(f)}を変更">${img(f)}</button>`;
        tbody.innerHTML = rows.map(([theirs, mine], i) => `<tr><td>${cell(i, 'theirs', theirs)}</td><td>${cell(i, 'mine', mine)}</td><td><button type="button" class="sw-act del" data-del="${i}">削除</button></td></tr>`).join('')
          // The add row starts empty: 追加 asks for the opponent's fighter, then the one to switch to
          + '<tr><td></td><td></td><td><button type="button" class="sw-act add" data-add>追加</button></td></tr>';
      };
      render();
      tbody.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) { rows.splice(Number(del.dataset.del), 1); render(); return; }
        const edit = e.target.closest('[data-edit]');
        if (edit) {
          const i = Number(edit.dataset.edit);
          if (edit.dataset.side === 'mine') {
            pickFighter(`相手が「${rows[i][0]}」のときの変更キャラ`, {}, (mine) => { rows[i] = [rows[i][0], mine]; render(); });
          } else {
            pickFighter('相手キャラを選択', {}, (theirs) => {
              // One rule per opponent fighter: choosing one that already has a row replaces that row
              const dup = rows.findIndex(([t], j) => t === theirs && j !== i);
              rows[i] = [theirs, rows[i][1]];
              if (dup >= 0) rows.splice(dup, 1);
              render();
            });
          }
          return;
        }
        if (!e.target.closest('[data-add]')) return;
        if (rows.length >= 50) { toast('スイッチ設定は50体までです'); return; }
        pickFighter('相手キャラを選択', {}, (theirs) => {
          pickFighter(`相手が「${theirs}」のときの変更キャラ`, {}, (mine) => {
            const at = rows.findIndex(([t]) => t === theirs);
            if (at >= 0) rows[at] = [theirs, mine]; else rows.push([theirs, mine]);
            render();
          });
        });
      });
      body.querySelector('#sw-save').addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
        const u = await api('/api/me/switches', { method: 'PUT', body: { switches: Object.fromEntries(rows) } });
        me.switches = u.switches;
        onChange?.();
        close();
        toast('スイッチ設定を保存しました');
      }));
    });
  }
  const fighterPicker = (omakase = false) => `<div class="fpick">${omakase ? '<button type="button" class="omk" data-omakase>おまかせ</button>' : ''}${window.FIGHTERS.map((f, i) => `<button type="button" data-fi="${i}" title="${esc(f)}"><img src="${fighterImg(f)}" alt="${esc(f)}" loading="lazy"></button>`).join('')}</div>`;

  const WAIT_OPTS = [[15, '15分まで'], [30, '30分まで'], [45, '45分まで'], [60, '1時間まで']];
  const FREE_RATE_OPTS = [[0, '誰でも'], ...[100, 150, 200, 250, 300, 350, 400].map((n) => [n, `直近${n}以内`])];
  const GAME_OPTS = [[0, '飽き抜け'], [3, '3戦'], [5, '5戦'], [7, '7戦']];
  const METHOD_OPTS = [['room', '部屋ID＆パスワード'], ['friend', 'フレンドコード交換']];
  // Rated: within ±50 … ±300 (50 steps); anything wider is "anyone"
  const RATE_LIMIT_OPTS = [[0, '誰でも'], ...[50, 100, 150, 200, 250, 300, 350, 400].map((n) => [n, `直近${n}以内`])];
  const labelOf = (opts, v) => (opts.find(([k]) => String(k) === String(v)) || [, '-'])[1];

  // ---------- Free match ----------
  async function pageFree() {
    const form = me
      ? `<form id="room-form">
          <h3 class="sub-head">待ち時間</h3>${optList('waitMin', WAIT_OPTS, 15)}
          <h3 class="sub-head">レート制限</h3>${optList('rateLimit', FREE_RATE_OPTS, 0)}
          <h3 class="sub-head">対戦数</h3>${optList('games', GAME_OPTS, 0)}
          <h3 class="sub-head">対戦方式</h3>${optList('method', METHOD_OPTS, 'room')}
          <div class="row2" id="room-fields"><div><label for="r-code">部屋ID</label><input id="r-code" name="roomCode" maxlength="20"></div><div><label for="r-pass">パスワード</label><input id="r-pass" name="password" maxlength="20"></div></div>
          <p class="small muted" id="friend-note" hidden>参加者が決まると、お互いのフレンドコードが表示されます（マイページで設定してください）。</p>
          <h3 class="sub-head">対戦ルール</h3><textarea name="rule" maxlength="300" data-style="min-height:60px" placeholder="例：ストック3 7分 アイテムなし"></textarea>
          <button class="btn btn-green btn-block find-btn">対戦相手を探す！</button></form>`
      : `<hr><p>フリー対戦は、${esc(siteName())} に登録すると参加できます。</p><div data-style="display:grid;gap:6px">${loginButtons()}</div>`;
    app.innerHTML = layout({
      crumb: 'フリー対戦',
      title: 'フリー対戦',
      side: box('対戦相手を募集する', `<p>フリー対戦では対戦成績が記録されず、気軽に対戦相手を募集できます。</p>${form}`),
      main: `<div class="box-body flush gray" id="rooms" data-style="margin-top:0">${spinner}</div>`,
    });
    bindLoginButtons(app);
    const f = $('#room-form');
    if (f) {
      bindOptLists(f);
      f.addEventListener('optchange', () => {
        const friend = optValue(f, 'method') === 'friend';
        $('#room-fields').hidden = friend;
        $('#friend-note').hidden = !friend;
      });
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const body = { ...formData(f), waitMin: Number(optValue(f, 'waitMin')), rateLimit: Number(optValue(f, 'rateLimit')), games: Number(optValue(f, 'games')), method: optValue(f, 'method') };
        await withBusy(ev.submitter, async () => {
          const room = await api('/api/free/rooms', { method: 'POST', body });
          location.hash = `#/free/${room.roomId}`;
        });
      });
    }
    async function load() {
      try {
        const { rooms } = await api('/api/free/rooms');
        $('#rooms').innerHTML = freeRows(rooms);
        bindRowLinks($('#rooms'));
      } catch (e) { $('#rooms').innerHTML = errorBox(e); }
    }
    await load();
    every(20000, load);
  }

  async function pageFreeRoom(id) {
    let room;
    try { room = await api(`/api/free/rooms/${id}`); } catch (e) { app.innerHTML = errorBox(e); return; }
    const isMember = me && (room.hostId === me.userId || room.guestId === me.userId);
    const openMs = (room.waitMin || 180) * 60000;
    const expired = room.status === 'open' && Date.now() - new Date(room.createdAt).getTime() > openMs;
    const side = (uid, name, fighter, rating) => uid
      ? `<div class="side">${avatar('', uid)}${userLink(uid, name, 'pname')}${mainThumb(fighter)}<span class="small muted">レート ${rating}</span></div>`
      : `<div class="side">${avatar()}<span class="muted">対戦相手を募集中…</span></div>`;
    let actions = '';
    if (!me) actions = `<div data-style="display:grid;gap:6px">${loginButtons()}</div>`;
    else if (room.status === 'open' && !expired && room.hostId !== me.userId) actions = '<button class="btn btn-green btn-lg btn-block" id="join">この募集に参加する</button>';
    else if (isMember && room.status !== 'closed') actions = '<button class="btn btn-gray btn-block" id="close">対戦を終了する</button>';
    app.innerHTML = layout({
      crumb: [crumbLink('#/free', 'フリー対戦'), `対戦ルーム ${room.roomNo ?? ''}`],
      title: `対戦ルーム ${room.roomNo ?? ''}`,
      single: `
        ${room.status === 'closed' ? '<div class="alert alert-red">このルームは対戦終了しました。</div>' : expired ? '<div class="alert alert-red">この募集は期限切れです。</div>' : ''}
        <div id="secret"></div>
        <div class="players">
          <section class="pbox"><h2 class="box-head">プレイヤー1</h2>${side(room.hostId, room.hostName, room.hostFighter, room.hostRating)}</section>
          <section class="pbox"><h2 class="box-head">プレイヤー2</h2>${side(room.guestId, room.guestName, room.guestFighter, room.guestRating)}</section>
        </div>
        <section data-style="margin-top:16px"><h2 class="box-head">募集内容</h2><div class="box-body">
          <table class="kv">
            <tr><td>状態</td><td>${freeStatus(room)}</td></tr>
            <tr><td>待ち時間</td><td>${labelOf(WAIT_OPTS, room.waitMin)}</td></tr>
            <tr><td>レート制限</td><td>${labelOf(FREE_RATE_OPTS, room.rateLimit ?? 0)}</td></tr>
            <tr><td>対戦数</td><td>${labelOf(GAME_OPTS, room.games ?? 0)}</td></tr>
            <tr><td>対戦方式</td><td>${labelOf(METHOD_OPTS, room.method || 'room')}</td></tr>
            <tr><td>募集日時</td><td>${fullDate(room.createdAt)}</td></tr>
          </table>
          ${room.rule ? `<p class="prose" data-style="margin-top:10px">${esc(room.rule)}</p>` : ''}
          ${room.comment ? `<p class="prose">${esc(room.comment)}</p>` : ''}
          <div data-style="margin-top:12px">${actions}</div></div></section>
        <section data-style="margin-top:20px"><h2 class="box-head">コメント</h2><div data-style="margin-top:10px" id="chat">${isMember ? '' : '<p class="muted">コメントは対戦する2人のみ利用できます。</p>'}</div></section>`,
    });
    bindLoginButtons(app);
    $('#join')?.addEventListener('click', (ev) => withBusy(ev.target, async () => { await api(`/api/free/rooms/${id}/join`, { method: 'POST' }); route(); }));
    $('#close')?.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      await api(`/api/free/rooms/${id}/close`, { method: 'POST' });
      route();
    }));
    if (isMember) {
      mountChat($('#chat'), `/api/free/rooms/${id}`, { readOnly: room.status === 'closed' });
      api(`/api/free/rooms/${id}/secret`).then((s) => {
        const html = (room.method || 'room') === 'friend'
          ? `フレンドコード　P1：<b>SW-${esc(s.hostFriendCode || '未設定')}</b>　P2：<b>${room.guestId ? `SW-${esc(s.guestFriendCode || '未設定')}` : '-'}</b>`
          : `部屋ID：<b>「${esc(s.roomCode || '-')}」</b>　パスワード：<b>「${esc(s.password || 'なし')}」</b>`;
        $('#secret').innerHTML = `<div class="room-box sticky">${html}</div>`;
        document.body.classList.add('has-sticky');
      }).catch(() => {});
    }
    if (room.status === 'open' && !expired) {
      every(8000, async () => {
        try { const r = await api(`/api/free/rooms/${id}`); if (r.status !== 'open') route(); } catch { /* ignore */ }
      });
    }
  }

  // ---------- Rated match lobby ----------
  async function pageRate() {
    if (me) { await loadMe(); renderAccount(); }
    app.innerHTML = layout({
      crumb: 'レーティング対戦',
      title: 'レーティング対戦',
      side: box('対戦相手を探す', `<p class="season-end" id="season-end" hidden></p><p id="rate-stats" class="small"></p><div id="queue">${me ? spinner : `<p>レーティング対戦は、${esc(siteName())} に登録すると参加できます。</p><div data-style="display:grid;gap:6px">${loginButtons()}</div>`}</div>`),
      main: `<div class="box-body flush gray" id="matches" data-style="margin-top:0">${spinner}</div>`,
    });
    bindLoginButtons(app);
    api('/api/season').then((s) => {
      if (!s.endsAt || new Date(s.endsAt) < new Date()) return;
      const el = $('#season-end');
      el.innerHTML = `第${esc(s.no)}期レーティング対戦の終了予定日は<br>「${esc(jstEnd(s.endsAt))}」<br>です。`;
      el.hidden = false;
    }).catch(() => {});
    const loadStats = () => api('/api/rate/stats').then((s) => { $('#rate-stats').innerHTML = `現在約<b class="red">${s.total}</b>人がレーティング対戦に参加しています。`; }).catch(() => {});
    async function loadMatches() {
      try {
        const { matches } = await api('/api/matches');
        $('#matches').innerHTML = rateRows(matches);
        bindRowLinks($('#matches'));
      } catch (e) { $('#matches').innerHTML = errorBox(e); }
    }
    loadStats(); loadMatches();
    every(30000, () => { loadStats(); loadMatches(); });
    if (!me) return;

    const q = $('#queue');
    // Already in a room (waiting or playing): link to it instead of the search form
    if (me.currentMatchId) {
      const cur = await api(`/api/matches/${me.currentMatchId}`).catch(() => null);
      q.innerHTML = `<hr><p class="in-room">あなたは別の対戦ルームに参加しています。<br><a href="#/match/${esc(me.currentMatchId)}">${cur?.matchNo ? `ルームNo ${esc(cur.matchNo)}` : '対戦ルームへ'}</a></p>`;
      return;
    }
    let polling = null;
    const idle = () => {
      if (polling) { clearInterval(polling); polling = null; }
      let firstFighter = me.lastFighter || me.fighter || '';
      q.innerHTML = `
        <h3 class="sub-head">1戦目使用キャラ</h3><button type="button" class="pick-btn" id="first-fighter">${esc(firstFighter || '選択してください')}</button>
        <button type="button" class="pick-btn" id="switch-open">⇄ スイッチ設定(<span id="switch-count">${Object.keys(me.switches || {}).length}</span>／50)</button>
        <p class="switch-help"><a href="#" id="switch-help">スイッチ設定とは？</a></p>
        <h3 class="sub-head">レート制限</h3>${optList('rateLimit', RATE_LIMIT_OPTS, 0)}
        <button class="btn btn-green btn-block find-btn" id="start">対戦相手を探す！</button>
        <p class="small muted" data-style="margin-top:8px">対戦後は双方が勝敗を報告し、一致した時点でレートが更新されます。詳しくは<a href="#/rules">対戦ルール</a>をご覧ください。</p>`;
      bindOptLists(q);
      $('#first-fighter').addEventListener('click', () => pickFighter('1戦目使用キャラ', { omakase: true }, (f) => {
        firstFighter = f;
        $('#first-fighter').textContent = f;
      }));
      $('#switch-open').addEventListener('click', () => openSwitches(() => { $('#switch-count').textContent = Object.keys(me.switches || {}).length; }));
      $('#switch-help').addEventListener('click', (e) => { e.preventDefault(); openModal('スイッチ設定とは？', SWITCH_HELP); });
      $('#start')?.addEventListener('click', (ev) => withBusy(ev.target, async () => {
        const fighter = firstFighter;
        if (!fighter) { toast('1戦目に使用するキャラを選択してください'); return; }
        handle(await api('/api/rate/queue', { method: 'POST', body: { fighter, rateLimit: Number(optValue(q, 'rateLimit')) } }));
      }));
    };
    const waiting = (sec) => {
      q.innerHTML = `${spinner}<p class="center"><b>対戦相手を探しています…</b><br><span id="waited" class="muted">待ち時間 ${sec}秒</span></p><p class="small muted center">この画面を開いたままお待ちください。</p><button class="btn btn-gray btn-block" id="cancel">キャンセル</button>`;
      $('#cancel').addEventListener('click', (ev) => withBusy(ev.target, async () => { await api('/api/rate/queue', { method: 'DELETE' }); idle(); }));
    };
    function handle(s) {
      if (s.state === 'matched') { clearTimers(); toast('対戦相手が見つかりました！'); location.hash = `#/match/${s.matchId}`; return; }
      // No open room was available: you are now the host of a waiting room
      if (s.state === 'hosting') { clearTimers(); location.hash = `#/match/${s.matchId}`; return; }
      if (s.state === 'waiting') {
        if (!$('#waited')) waiting(s.waitedSec); else $('#waited').textContent = `待ち時間 ${s.waitedSec}秒`;
        if (!polling) polling = every(5000, poll);
        return;
      }
      idle();
    }
    async function poll() { try { handle(await api('/api/rate/status')); } catch { /* transient */ } }
    handle(await api('/api/rate/status').catch(() => ({ state: 'idle' })));
  }

  // ---------- Tournaments ----------
  async function pageTournaments() {
    app.innerHTML = layout({
      crumb: '大会トーナメント一覧',
      title: '大会トーナメント一覧',
      side: box('大会について', `<p>ユーザーが主催するトーナメント大会の一覧です。</p><p>大会を主催したり、エントリーして参加したりできます。参加条件やルールは大会ごとに異なります。</p>
          ${me ? '<hr><a class="btn btn-block" href="#/tournaments/new">大会を開催する</a>' : ''}`),
      main: `${boxList('開催予定の大会一覧', `<div id="tours">${spinner}</div>`)}${boxList('開催された大会一覧', `<div id="past">${spinner}</div>`)}`,
    });
    try {
      const { tournaments } = await api('/api/tournaments?past=1');
      const now = Date.now();
      const upcoming = tournaments.filter((t) => t.status !== 'finished' && new Date(t.startAt).getTime() > now - 6 * 3600_000);
      const past = tournaments.filter((t) => !upcoming.includes(t)).sort((a, b) => b.startAt.localeCompare(a.startAt));
      $('#tours').innerHTML = tourItems(upcoming);
      $('#past').innerHTML = past.length ? past.map((t) => `<div class="titem"><a class="ttitle" href="#/tournaments/${esc(t.tourId)}">参加者${t.entryCount}名 ${esc(t.title)}</a>
          <div class="small muted" data-style="text-align:right">${fullDate(t.startAt)}</div>
          <div class="torg">${avatar('sm', t.organizerId)}<a href="#/users/${esc(t.organizerId)}">主催者：${esc(t.organizerName)}</a></div></div>`).join('') : '<p class="empty">開催された大会はありません</p>';
      tickCountdowns();
    } catch (e) { $('#tours').innerHTML = errorBox(e); $('#past').innerHTML = ''; }
    every(1000, tickCountdowns);
  }

  // ---------- Fighter ranking ----------
  async function pageFighter(idx) {
    const f = window.FIGHTERS[Number(idx)];
    if (!f) { app.innerHTML = errorBox('ファイターが見つかりません'); return; }
    app.innerHTML = layout({
      crumb: [crumbLink('#/fighters', 'ファイター一覧'), `${esc(f)}使いのレートランキング`],
      title: `${f}使いのレートランキング`,
      single: `<p>${esc(f)} をメインファイターに設定しているプレイヤーのレートランキングです。</p>
        <div class="field"><label for="fsel">キャラクター選択</label><select id="fsel">${window.FIGHTERS.map((x, i) => `<option value="${i}" ${i === Number(idx) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        ${boxList(`${esc(f)}使いのレートランキング`, `<div id="fr">${spinner}</div>`)}`,
    });
    $('#fsel').addEventListener('change', (e) => { location.hash = `#/fighters/${e.target.value}`; });
    try { const { players } = await api(`/api/ranking?fighter=${encodeURIComponent(f)}`); $('#fr').innerHTML = rankingRows(players); } catch (e) { $('#fr').innerHTML = errorBox(e); }
  }

  // ---------- Diary detail with likes & comments ----------
  async function pageDiary(uid, did) {
    let d;
    try { d = await api(`/api/users/${uid}/diaries/${did}`); } catch (e) { app.innerHTML = errorBox(e); return; }
    const liked = me && d.likes.some((l) => l.userId === me.userId);
    app.innerHTML = layout({
      crumb: [crumbLink('#/diaries', '日記一覧'), esc(d.title)],
      title: d.title,
      single: `
        <div class="prose" data-style="margin-top:6px">${esc(d.body)}</div>
        <div class="diary-actions">
          <button class="btn btn-pink" id="like" ${me ? '' : 'disabled'}>${liked ? '♥' : '♡'} いいね <span class="count" data-style="background:#fff;color:#f19ec2">${d.likes.length}</span></button>
          <div class="row">${avatar('sm', d.userId)}${userLink(d.userId, d.userName)}</div>
          <div class="small muted">${fullDate(d.createdAt)}に投稿</div>
          ${me?.userId === d.userId ? '<button class="btn btn-gray btn-sm" id="del">この日記を削除する</button>' : ''}
        </div>
        <section data-style="margin-top:22px"><h2 class="box-head">いいねしたユーザー</h2>
          <div class="likers">${d.likes.map((l) => `<a href="#/users/${esc(l.userId)}" title="${esc(l.name)}">${avatar('', l.userId)}</a>`).join('') || '<span class="muted small">まだいません</span>'}</div></section>
        <section data-style="margin-top:22px"><h2 class="box-head">コメント</h2><div data-style="margin-top:10px">
          ${d.comments.map((c) => {
            const canDelete = me && (me.userId === uid || me.userId === c.userId || me.isAdmin);
            return `<div class="cmt"><div class="cmt-head">${avatar('sm', c.userId)}${userLink(c.userId, c.name)}<span class="meta">${fullDate(c.at)}</span>${canDelete ? `<button type="button" class="cmt-del" data-cid="${esc(c.id)}" aria-label="コメントを削除">×</button>` : ''}</div><div class="cmt-body">${esc(c.text)}</div></div>`;
          }).join('') || '<p>コメントはありません。</p>'}
          ${me ? '<form id="cmt-form"><textarea name="text" maxlength="1000" required data-style="min-height:80px"></textarea><p data-style="text-align:right;margin-top:8px"><button class="btn">コメントする</button></p></form>' : ''}
        </div></section>`,
    });
    $('#like')?.addEventListener('click', (ev) => withBusy(ev.target, async () => { await api(`/api/users/${uid}/diaries/${did}/like`, { method: 'POST' }); route(); }));
    // Two taps to delete a comment (no dialogs: in-app browsers block them)
    app.querySelectorAll('.cmt-del').forEach((b) => b.addEventListener('click', () => {
      if (!b.dataset.armed) {
        app.querySelectorAll('.cmt-del[data-armed]').forEach((x) => { x.textContent = '×'; delete x.dataset.armed; });
        b.dataset.armed = '1';
        b.textContent = '削除';
        setTimeout(() => { if (b.isConnected && b.dataset.armed) { b.textContent = '×'; delete b.dataset.armed; } }, 3000);
        return;
      }
      withBusy(b, async () => {
        await api(`/api/users/${uid}/diaries/${did}/comments/${encodeURIComponent(b.dataset.cid)}`, { method: 'DELETE' });
        toast('コメントを削除しました');
        route();
      });
    }));
    $('#cmt-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await withBusy(ev.submitter, async () => { await api(`/api/users/${uid}/diaries/${did}/comments`, { method: 'POST', body: formData(ev.target) }); route(); });
    });
    $('#del')?.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      await api(`/api/users/${uid}/diaries/${did}`, { method: 'DELETE' });
      toast('削除しました');
      location.hash = '#/diaries';
    }));
  }

  // ---------- My page ----------
  // 1600/1700 silver, 1800/1900 gold, each a shade apart; one look from 2000 up.
  // The highest medal of each season glows (medals arrive newest season, highest first).
  const medalCoin = (m, i, all) => {
    const tier = `s${Math.min(m.threshold, 2000)}`;
    const top = i === 0 || all[i - 1].season !== m.season;
    return `<div class="medal"><div class="medal-coin ${tier}${top ? ' top' : ''}"><span>${m.threshold}</span></div><span class="season">シーズン${esc(m.season)}</span></div>`;
  };

  const prefSelect = (id, name, label, options, value, hint) => `<div class="field"><label for="${id}">${esc(label)}</label>
    <select id="${id}" name="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(value) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    ${hint ? `<div class="hint red">${esc(hint)}</div>` : ''}</div>`;

  async function pageMyEdit() {
    if (!requireLogin('プロフィール編集')) return;
    // Symbols come from the gacha, so the field goes while the gacha is closed
    const { symbols } = closed('gacha') ? { symbols: null } : await api('/api/gacha').catch(() => ({ symbols: [] }));
    app.innerHTML = layout({
      crumb: [crumbLink('#/mypage', 'マイページ'), 'プロフィール編集'],
      title: 'プロフィール編集',
      single: `<form id="me-form" data-style="margin-top:16px">
          <div class="field"><label for="m-name">ユーザー名 <span class="red">※必須</span></label><input id="m-name" name="name" maxlength="20" required value="${esc(me.name)}"><div class="hint red">対戦相手が迷わないように、ゲーム内の登録名と合わせてください。</div></div>
          ${closed('friendCode') ? '' : `<div class="field"><label for="m-fc">フレンドコード</label><div class="row" data-style="flex-wrap:nowrap">SW-<input id="m-fc" name="friendCode" maxlength="14" value="${esc(me.friendCode || '')}" placeholder="0000-0000-0000"></div><div class="hint red">「XXXX-XXXX-XXXX」の形式で入力してください。</div></div>`}
          ${symbols ? `<div class="field"><label for="m-sym">シンボル</label><select id="m-sym" name="symbol"><option value="">（なし）</option>${symbols.map((s) => `<option ${s.symbol === me.symbol ? 'selected' : ''}>${esc(s.symbol)}</option>`).join('')}</select></div>` : ''}
          ${closed('profileFighter') ? '' : `<div class="field"><label>使用キャラクター</label><div class="row">${fthumb(me.fighter)}<span class="small muted">対戦相手からのキャラ投票で、最も多いキャラが表示されます。</span></div></div>`}
          <div class="field"><label for="m-bio">プロフィール</label><textarea id="m-bio" name="bio" maxlength="1000" data-style="min-height:140px">${esc(me.bio)}</textarea></div>
          <div class="field"><label for="m-pre">対戦前のコメント</label><input id="m-pre" name="preComment" maxlength="40" value="${esc(me.preComment)}"></div>
          <div class="field"><label for="m-post">対戦後のコメント</label><input id="m-post" name="postComment" maxlength="40" value="${esc(me.postComment)}"></div>
          <div class="field"><label for="m-tw">TwitterのユーザーID</label><div class="row" data-style="flex-wrap:nowrap">@<input id="m-tw" name="twitterId" maxlength="16" value="${esc(me.twitterId || '')}" placeholder="例：player_123" autocapitalize="off" spellcheck="false"></div><div class="hint">設定すると、プロフィールに「Twitterを見る」が表示されます。空欄にすると非表示になります。</div></div>
          ${prefSelect('m-rematch', 'rematch', '連戦設定', [['allow', '連戦を許可する'], ['deny', '連戦を許可しない']], me.rematch, '同じ相手と続けて対戦するかを設定できます。')}
          ${prefSelect('m-conn', 'conn', '接続環境設定', [['wired', '有線 無線接続のプレイヤーとの対戦を許可する'], ['wired-deny', '有線 無線接続のプレイヤーとの対戦を許可しない'], ['wireless', '無線']], me.conn, '')}
          ${prefSelect('m-stream', 'stream', '配信設定', [['no', '配信しない 配信者との対戦を許可する（配信後のアーカイブ録画の許可も含む）'], ['no-deny', '配信しない 配信者との対戦を許可しない'], ['yes', '配信する']], me.stream, '')}
          ${prefSelect('m-account', 'account', 'サブアカウント設定', [['main-deny', 'メインアカウントを使用 サブアカとの対戦を許可しない'], ['main', 'メインアカウントを使用 サブアカとの対戦を許可する'], ['sub', 'サブアカウントを使用']], me.account, '')}
          ${prefSelect('m-video', 'allowVideo', 'レーティングバトル 動画化許可設定', [['false', '動画化を許可しない'], ['true', '動画化を許可する']], String(me.allowVideo), 'この設定はマッチングには影響しません。動画化についてのスタンスを相手に示すためのもので、動画化をめぐるトラブルには当サイトは関与しません。')}
          ${prefSelect('m-showrate', 'showRate', 'レート表示設定', [['true', 'レートを表示する'], ['false', 'レートを表示しない']], String(me.showRate), '対戦ルームで自分と対戦相手のレートを非表示にできます。')}
          <div class="field"><label for="m-intro">紹介文許可設定</label><select id="m-intro" name="allowIntro"><option value="true" ${me.allowIntro ? 'selected' : ''}>紹介文を許可する</option><option value="false" ${me.allowIntro ? '' : 'selected'}>紹介文を許可しない</option></select><div class="hint red">自身への紹介文の投稿を許可するかを設定できます。</div></div>
          <button class="btn btn-outline">送信する</button>
        </form>`,
    });
    $('#me-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = formData(ev.target);
      body.allowIntro = body.allowIntro === 'true';
      await withBusy(ev.submitter, async () => {
        const u = await api('/api/me', { method: 'PUT', body });
        me = { ...me, ...u };
        renderAccount();
        toast('保存しました');
        location.hash = '#/mypage';
      });
    });
  }

  function pageAvatar() {
    if (!requireLogin('プロフィール画像設定')) return;
    app.innerHTML = layout({
      crumb: 'プロフィール画像設定',
      title: 'プロフィール画像設定',
      single: boxList('画像の設定', `<p>プロフィール画像を設定できます。画像は正方形に切り抜かれ、ランキングや対戦一覧に表示されます。</p>
        <div class="row">${avatar('', me.userId).replace('class="avatar ', 'class="avatar " id="av-preview" data-style="width:100px;height:100px"')}<input type="file" id="av-file" accept="image/*" data-style="max-width:240px"></div>
        <p data-style="margin-top:12px"><button class="btn btn-green" id="av-save" disabled>この画像に変更する</button></p>`),
    });
    let dataUrl = null;
    $('#av-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = 200;
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 200, 200);
        dataUrl = c.toDataURL('image/jpeg', 0.85);
        $('#av-preview').innerHTML = `<img src="${dataUrl}" alt="">`;
        $('#av-save').disabled = false;
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => toast('画像を読み込めませんでした');
      img.src = URL.createObjectURL(file);
    });
    $('#av-save').addEventListener('click', (ev) => withBusy(ev.target, async () => {
      await api('/api/me/avatar', { method: 'PUT', body: { image: dataUrl } });
      toast('プロフィール画像を変更しました（反映まで最大1分ほどかかります）');
    }));
  }

  // Reject stages: default row + per-opponent-character rows
  function pageMyStages() {
    if (!requireLogin('拒否ステージ設定')) return;
    const S = window.STAGES;
    const state = { default: [...(me.rejectStages || [])], ...JSON.parse(JSON.stringify(me.rejectByFighter || {})) };
    const rows = [['default', 'おまかせ（未設定キャラ）'], ...window.FIGHTERS.map((f) => [f, f])];
    const buttons = '<div class="row2" data-style="margin:10px 0"><button class="btn btn-green" data-save>保存する</button><button class="btn btn-orange" data-reset>リセットする</button></div>';
    app.innerHTML = layout({
      crumb: [crumbLink('#/mypage', 'マイページ'), '拒否ステージ設定'],
      title: '拒否ステージ設定',
      single: `<p>拒否ステージを、対戦相手のキャラクターごとに最大${window.MAX_REJECT}つまで設定できます。セルをタップして選択し、「保存する」を押してください。キャラごとに設定がない場合は「おまかせ」の設定が使われます。</p>
        ${buttons}
        <div class="table-wrap"><table class="smx"><thead><tr><th data-style="width:56px"></th>${S.map((s, i) => `<th><img src="assets/stages/${pad2(i + 1)}.jpg" alt="">${esc(s)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(([k, label]) => `<tr class="${k === 'default' ? 'def' : ''}" data-k="${esc(k)}"><td class="f">${k === 'default' ? esc(label) : `${fthumb(k)}<small>${esc(label)}</small>`}</td>${S.map((s) => `<td class="c ${(state[k] || []).includes(s) ? 'x' : ''}" data-s="${esc(s)}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
        ${buttons}`,
    });
    app.querySelector('.smx').addEventListener('click', (e) => {
      const td = e.target.closest('td.c');
      if (!td) return;
      const k = td.parentElement.dataset.k;
      const s = td.dataset.s;
      const cur = state[k] || (state[k] = []);
      if (cur.includes(s)) cur.splice(cur.indexOf(s), 1);
      else if (cur.length >= window.MAX_REJECT) { toast(`1キャラにつき${window.MAX_REJECT}つまでです`); return; }
      else cur.push(s);
      td.classList.toggle('x', cur.includes(s));
    });
    app.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
      Object.keys(state).forEach((k) => { state[k] = []; });
      app.querySelectorAll('.smx td.c.x').forEach((td) => td.classList.remove('x'));
    }));
    app.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      const { default: def, ...byF } = state;
      const u = await api('/api/me/stages', { method: 'PUT', body: { rejectStages: def, rejectByFighter: byF } });
      me = { ...me, ...u };
      toast('保存しました');
    })));
  }

  // Character memos
  async function pageMemos() {
    if (!requireLogin('キャラ対策メモ設定')) return;
    let { memos } = await api('/api/me/memos');
    let cur = null;
    app.innerHTML = layout({
      crumb: 'キャラ対策メモ設定',
      title: 'キャラ対策メモ設定',
      single: `<p>キャラクターごとのメモを3000文字まで保存できます。保存したメモは対戦ルームから呼び出せます。</p>
        <button class="btn btn-gray btn-block" id="pick" data-style="background:#e6e6e6;color:#333;border-color:#aaa">＋ 入力するキャラクターを選択</button>
        <div id="editor"></div>
        <p data-style="margin-top:30px"><button class="btn btn-outline btn-block" id="list" data-style="color:#333;border-color:#ccc">入力した対策メモを見る</button></p>`,
    });
    const memoOf = (i) => memos.find((m) => Number(m.idx) === i);
    function edit(i) {
      cur = i;
      const f = window.FIGHTERS[i];
      $('#pick').textContent = f;
      $('#editor').innerHTML = `<textarea id="memo-text" maxlength="3000" data-style="min-height:220px;margin-top:10px">${esc(memoOf(i)?.text || '')}</textarea>
        <div class="counter" id="memo-count"></div><button class="btn btn-green btn-block" id="memo-save">保存する</button>`;
      const ta = $('#memo-text');
      const upd = () => { $('#memo-count').textContent = `${ta.value.length}／3000`; };
      ta.addEventListener('input', upd); upd();
      $('#memo-save').addEventListener('click', (ev) => withBusy(ev.target, async () => {
        ({ memos } = await api(`/api/me/memos/${cur}`, { method: 'PUT', body: { fighter: window.FIGHTERS[cur], text: ta.value } }));
        toast('保存しました');
      }));
    }
    $('#pick').addEventListener('click', () => openModal('対策メモ', fighterPicker(), (body, close) => {
      body.addEventListener('click', (e) => { const b = e.target.closest('[data-fi]'); if (b) { close(); edit(Number(b.dataset.fi)); } });
    }));
    $('#list').addEventListener('click', () => openModal('入力した対策メモ', memos.length
      ? memos.sort((a, b) => a.idx - b.idx).map((m) => `<div class="cmt"><div class="cmt-head">${fthumb(m.fighter)}<b>${esc(m.fighter)}</b></div><div class="cmt-body">${esc(m.text)}</div></div>`).join('')
      : '<p class="muted">まだメモはありません</p>'));
  }

  // Memo viewer used from match rooms
  async function showMemoFor(fighter) {
    const { memos } = await api('/api/me/memos').catch(() => ({ memos: [] }));
    const find = (f) => memos.find((m) => m.fighter === f);
    openModal('対策メモ', `<div id="memo-view" class="cmt-body" data-style="min-height:60px">${esc(find(fighter)?.text || `${fighter || 'このキャラ'}のメモはまだありません`)}</div>
      <p class="small muted" data-style="margin:10px 0 6px">他のキャラのメモを見る</p>${fighterPicker()}`, (body) => {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-fi]');
        if (!b) return;
        const f = window.FIGHTERS[Number(b.dataset.fi)];
        body.querySelector('#memo-view').textContent = find(f)?.text || `${f}のメモはまだありません`;
      });
    });
  }

  // My battle data: rating balance per opponent character / player
  async function pageMyData() {
    if (!requireLogin('マイ対戦データ')) return;
    const { history } = await api(`/api/users/${me.userId}`);
    const sum = (key) => {
      const m = {};
      for (const h of history) { const k = h[key] || '不明'; m[k] = (m[k] || 0) + h.delta; }
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const chart = (rows) => {
      if (!rows.length) return '<p class="empty">まだ対戦データがありません</p>';
      // Axis like the original: bounds rounded to multiples of 50, a grid line every 50,
      // labels every 50 (or every 100 when the range is wide); zero line drawn darker.
      const vals = rows.map(([, v]) => v);
      const lo = Math.min(-50, Math.floor(Math.min(...vals) / 50) * 50);
      const hi = Math.max(50, Math.ceil(Math.max(...vals) / 50) * 50);
      const pos = (v) => ((v - lo) / (hi - lo)) * 100;
      const labelStep = hi - lo > 200 ? 100 : 50;
      const grid = [];
      for (let g = lo; g <= hi; g += 50) grid.push(g);
      const lines = grid.map((g) => `<span class="${g === 0 ? 'zero' : 'gl'}" data-style="left:${pos(g)}%"></span>`).join('');
      const labels = grid.filter((g) => g % labelStep === 0).map((g) => `<span data-style="left:${pos(g)}%">${g}</span>`).join('');
      return `<div class="bars">${rows.map(([k, v]) => {
        const a = pos(Math.min(0, v));
        const w = pos(Math.max(0, v)) - a;
        return `<div class="bar-row" title="${esc(k)}: ${v > 0 ? '+' : ''}${v}"><span class="lbl">${esc(k)}</span><div class="bar-track">${lines}<span class="bar" data-style="left:${a}%;width:${w}%"></span></div></div>`;
      }).join('')}<div class="bar-row bar-axis"><span></span><div class="axis-labels">${labels}</div></div></div>`;
    };
    app.innerHTML = layout({
      crumb: [crumbLink('#/mypage', 'マイページ'), 'マイ対戦データ'],
      title: 'マイ対戦データ',
      single: `${boxList('VSキャラクター別レート収支', chart(sum('opponentFighter')))}<div data-style="height:24px"></div>${boxList('VSプレイヤー別レート収支', chart(sum('opponentName')))}`,
    });
  }

  // ---------- Points: gacha / minimum game ----------
  async function pageGacha() {
    if (!requireLogin('シンボルガチャ')) return;
    await loadMe();
    const info = await api('/api/gacha');
    app.innerHTML = layout({
      crumb: [crumbLink('#/mypage', esc(me.name)), 'シンボルガチャ'],
      title: 'シンボルガチャ',
      single: `
        ${boxList('ガチャを引く', `<p class="center">あなたのポイントは${me.points}です。<br>あと${Math.floor(me.points / info.cost)}回ガチャが引けます。（1回${info.cost}ポイント）</p>
          <p class="center"><button class="btn btn-lg" id="draw" ${me.points < info.cost ? 'disabled' : ''}>ガチャ開始！</button></p>
          <p class="small muted center">ポイントはレーティング対戦の結果確定ごとに獲得できます（勝ち+5・負け+3）。獲得したシンボルはプロフィール編集で名前の横に表示できます。</p>`)}
        ${boxList(`あなたのシンボル（${info.symbols.length}種類）`, info.symbols.length ? `<ul class="list-plain">${info.symbols.map((s) => `<li class="row"><span>${esc(s.symbol)}</span><span class="spacer"></span><span class="small muted">×${s.count}</span></li>`).join('')}</ul>` : '<p class="empty">まだシンボルを持っていません</p>')}
        ${boxList('ガチャ履歴', info.history.length ? `<table class="tbl"><thead><tr><th>プレイヤー</th><th>GETシンボル</th></tr></thead><tbody>${info.history.map((h) => `<tr><td class="row" data-style="gap:6px">${avatar('sm', h.userId)}${userLink(h.userId, h.name)}</td><td>${h.gold ? '<b class="badge-sym">' : ''}${esc(h.symbol)}${h.gold ? '</b>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">まだ履歴はありません</p>')}`,
    });
    $('#draw')?.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      const r = await api('/api/gacha', { method: 'POST' });
      openModal('ガチャ結果', `<p class="center" data-style="font-size:1.3rem;font-weight:700;${r.gold ? 'color:#b8860b' : ''}">${esc(r.symbol)}</p><p class="center">${r.gold ? 'レアシンボルを獲得しました！' : 'シンボルを獲得しました！'}</p>`);
      route();
    }));
  }

  async function pageMinimum() {
    if (!requireLogin('ミニマムゲーム')) return;
    await loadMe();
    const info = await api('/api/minimum');
    app.innerHTML = layout({
      crumb: 'ミニマムゲーム',
      title: 'ミニマムゲーム',
      single: `
        ${boxList('ミニマムゲームとは？', `<p>1〜100の中から数字を1つ選び、「ほかの誰とも被らなかった数字のうち一番小さい数字」を選んだ人が勝ちになるゲームです。</p>
          <p>小さい数字ほど有利ですが、ほかの人と被った時点でその数字は無効になります。</p>
          <p>投票には<b>${info.cost}ポイント</b>が必要です。<b>勝者は参加者全員分のポイント（参加者×${info.cost}）を獲得</b>できます。</p>
          <p class="lead-red">1人で複数のアカウントを使って参加することは禁止です。</p>
          <p>毎日0時〜22時が投票期間で、22時に結果が確定します（日本時間）。</p>`)}
        ${boxList('投票する', `<p>あなたのポイントは${me.points}です。本日の参加者：${info.participants}人<br>${info.myVote ? `本日は<b>${info.myVote}</b>に投票済みです。` : info.open ? (me.points >= info.cost ? '投票に参加できます！' : 'ポイントが足りません。') : '本日の投票は締め切りました。'}</p>
          <div class="num-grid">${Array.from({ length: 100 }, (_, i) => i + 1).map((n) => `<button data-n="${n}" class="${info.myVote === n ? 'on' : ''}" ${info.myVote || !info.open || me.points < info.cost ? 'disabled' : ''}>${n}</button>`).join('')}</div>`)}
        ${boxList('結果', info.results.map((r) => `<p><b>${esc(r.date)}</b>：参加者${r.participants}人 ／ ${r.number ? `当選番号 <b>${r.number}</b>（${esc(r.winnerName)}さんが${r.prize}ポイント獲得）` : '当選者なし'}</p>`).join('') || '<p class="empty">まだ結果はありません</p>')}`,
    });
    app.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', (ev) => withBusy(ev.target, async () => {
      await api('/api/minimum', { method: 'POST', body: { n: Number(b.dataset.n) } });
      toast('投票しました');
      route();
    })));
  }

  // ---------- Player sub pages ----------
  async function pageMedals(uid) {
    const [{ user, medals }, season] = await Promise.all([api(`/api/users/${uid}`), api('/api/season').catch(() => null)]);
    app.innerHTML = layout({
      crumb: [userLink(uid, user.name), '獲得メダル'],
      title: '獲得メダル',
      single: `<p class="center muted">シーズン中にレーティング対戦でレート1600以上に到達すると、100ごとにメダルを獲得できます。${season ? `<br>現在はシーズン${esc(season.no)}です。` : ''}<br>所持メダル：<b>${medals.length}</b>個</p>
        ${medals.length ? `<div class="medals">${medals.map(medalCoin).join('')}</div>` : '<p class="empty">まだメダルはありません</p>'}`,
    });
  }

  async function pageUserTournaments(uid) {
    const [{ user }, { tournaments }] = await Promise.all([api(`/api/users/${uid}`), api(`/api/users/${uid}/tournaments`)]);
    app.innerHTML = layout({
      crumb: [userLink(uid, user.name), `${esc(user.name)}さんの参加大会一覧`],
      title: `${user.name}さんの参加大会一覧`,
      single: tournaments.length
        ? `<table class="tbl result-table">${tournaments.map((t) => `<tr><td><a href="#/tournaments/${esc(t.tourId)}">参加者${t.entryCount}名 ${esc(t.title)}</a></td><td>${esc(t.result)}</td></tr>`).join('')}</table>`
        : '<p class="empty">参加した大会はありません</p>',
    });
  }

  // ---------- Search / contact ----------
  function pageSearchForm() {
    app.innerHTML = layout({
      crumb: 'サイト内検索',
      title: 'サイト内検索',
      single: boxList('サイト内検索', `<form id="sform"><input name="q" placeholder="キーワードを入力" required><button class="btn btn-green btn-block" data-style="margin-top:10px">検索</button></form>
        <p data-style="margin-top:10px">キーワードから、大会・プレイヤー日記・プレイヤーを検索できます。</p>`),
    });
    $('#sform').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const q = ev.target.elements.q.value.trim();
      if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
    });
  }

  function pageContact() {
    const d = getDoc('contact');
    app.innerHTML = layout({
      crumb: 'お問い合わせ',
      title: rawFill(d.title),
      single: `${d.lead ? `<div class="doc-lead">${fill(d.lead)}</div>` : ''}
        <p>${esc(siteName())} に関するお問い合わせは、下記のフォームからお願いします。</p>
        <p class="lead-red">送信前に、<a href="#/faq">Q＆Aページ</a>に同じ内容がないかご確認ください。</p>
        <p>運営から返信する場合は、マイページの「お問い合わせ履歴」でお知らせします（すべてのお問い合わせに返信するとは限りません）。</p>
        ${me ? `<form id="contact-form" data-style="margin-top:16px">
          <div class="field"><label for="c-type">問い合わせ内容</label><select id="c-type" name="type"><option>不具合報告</option><option>悪質利用者の報告</option><option>要望</option><option>その他</option></select>
            <div class="hint">悪質利用者の報告は、ルーム番号や相手のユーザー名など、詳細な情報を記載してください。</div></div>
          <div class="field"><label for="c-body">内容</label><textarea id="c-body" name="body" maxlength="3000" required data-style="min-height:160px"></textarea></div>
          <button class="btn btn-green">送信</button></form>` : `<p>お問い合わせにはログインが必要です。</p><div data-style="max-width:300px;display:grid;gap:6px">${loginButtons()}</div>`}`,
    });
    bindLoginButtons(app);
    $('#contact-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await withBusy(ev.submitter, async () => {
        await api('/api/contact', { method: 'POST', body: formData(ev.target) });
        ev.target.reset();
        toast('送信しました。ご協力ありがとうございます。');
      });
    });
  }

  // Append-only record of what the admin account did, so a compromise is traceable
  const AUDIT_LABEL = {
    'site.update': 'サイト設定を変更',
    'match.setResult': '対戦結果を修正',
    'user.resetPassword': 'パスワードをリセット',
    'user.enable': '利用停止を解除',
    'user.disable': '利用停止',
    'user.delete': 'ユーザーを削除',
    'contact.delete': 'お問い合わせを削除',
    'contact.reply': 'お問い合わせに返信',
    'season.set': 'シーズンを変更',
    'season.end': 'シーズン終了予定日を設定',
  };
  const auditDetail = (e) => {
    if (e.action === 'site.update') return `サイト名「${esc(e.siteName || '')}」／お知らせ${e.notices ?? 0}件`;
    if (e.action === 'match.setResult') {
      const who = e.winner ? `勝者を変更（${userLink(e.winner, '対象プレイヤー')}）` : '無効化';
      return `ルーム${e.matchNo ?? '-'}：${who}　<span class="muted">変更前の状態：${esc(e.wasStatus || '-')}</span>`;
    }
    if (e.action === 'contact.delete') return `ID ${esc(e.contactId || '')}`;
    if (e.action === 'contact.reply') return `${esc(e.targetName || '(名前なし)')} さんのお問い合わせ（ID ${esc(e.contactId || '')}）`;
    if (e.action === 'season.set') return `第${esc(e.from)}期 → 第${esc(e.to)}期（レートとランキングをリセット）`;
    if (e.action === 'season.end') return `第${esc(e.season)}期：${e.endsAt ? esc(jstEnd(e.endsAt)) : '表示を解除'}`;
    if (e.target) {
      const name = e.targetName ? esc(e.targetName) : '(名前なし)';
      const extra = e.action === 'user.delete' ? `　<span class="muted">データ${e.removed ?? 0}件を削除</span>` : '';
      return `対象：${userLink(e.target, name)}${extra}`;
    }
    return '';
  };

  async function pageAdminAudit() {
    if (!requireLogin('管理操作の履歴')) return;
    if (!me.isAdmin) { app.innerHTML = errorBox('このページは管理者のみ利用できます。'); return; }
    let entries;
    try { ({ entries } = await api('/api/admin/audit')); } catch (e) { app.innerHTML = errorBox(e); return; }
    app.innerHTML = layout({
      crumb: [crumbLink('#/admin', '管理ページ'), '管理操作の履歴'],
      title: '管理操作の履歴',
      single: `<p class="small muted">管理ページから行った操作をすべて記録しています（1年間保存）。身に覚えのない操作があれば、Discordのパスワードと2要素認証を確認してください。</p>
        ${entries.length ? `<div data-style="margin-top:14px">${entries.map((e) => `<div class="cmt">
          <div class="cmt-head"><span class="tag tag-live">${esc(AUDIT_LABEL[e.action] || e.action)}</span>
            <span class="meta">${fullDate(e.at)}</span></div>
          <div class="cmt-body">${auditDetail(e)}<div class="small muted" data-style="margin-top:4px">実行者：${esc(e.byName || e.by)}</div></div>
        </div>`).join('')}</div>` : '<p class="empty">まだ記録はありません</p>'}`,
    });
  }

  // Replies are shown signed "運営" (never with an admin's name)
  const replyList = (replies) => (replies || []).map((r) => `<div class="reply"><div class="reply-head"><b>運営からの返信</b><span class="meta">${fullDate(r.at)}</span></div><div class="reply-body">${esc(r.text)}</div></div>`).join('');

  async function pageAdminContacts() {
    if (!requireLogin('お問い合わせ一覧')) return;
    if (!me.isAdmin) { app.innerHTML = errorBox('このページは管理者のみ利用できます。'); return; }
    const render = ({ contacts }) => {
      app.innerHTML = layout({
        crumb: [crumbLink('#/admin', '管理ページ'), 'お問い合わせ一覧'],
        title: 'お問い合わせ一覧',
        single: contacts.length ? contacts.map((c) => `<div class="cmt"><div class="cmt-head"><span class="tag tag-live">${esc(c.type)}</span>${c.replies?.length ? '<span class="tag tag-done">返信済</span>' : ''}${userLink(c.userId, c.name)}<span class="meta">${fullDate(c.at)}<br>${esc(c.email)}</span></div>
          <div class="cmt-body">${esc(c.body)}</div>${replyList(c.replies)}
          <form class="reply-form" data-reply="${esc(c.id)}"><textarea name="text" maxlength="2000" required placeholder="返信（送信者のマイページ「お問い合わせ履歴」に表示されます）"></textarea>
            <div class="row" data-style="margin-top:4px"><button class="btn btn-sm">返信する</button><span class="spacer"></span><button type="button" class="btn btn-gray btn-sm" data-del="${esc(c.id)}">削除</button></div></form></div>`).join('') : '<p class="empty">お問い合わせはありません</p>',
      });
      app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (ev) => withBusy(ev.target, async () => {
        render(await api(`/api/admin/contacts/${b.dataset.del}`, { method: 'DELETE' }));
      })));
      app.querySelectorAll('[data-reply]').forEach((f) => f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        withBusy(ev.submitter, async () => {
          render(await api(`/api/admin/contacts/${f.dataset.reply}/reply`, { method: 'POST', body: { text: f.elements.text.value } }));
          toast('返信しました');
        });
      }));
    };
    render(await api('/api/admin/contacts'));
  }

  // The player's own inquiries and the operators' replies; opening the page marks replies as read
  async function pageMyContacts() {
    if (!requireLogin('お問い合わせ履歴')) return;
    const { contacts } = await api('/api/me/contacts');
    app.innerHTML = layout({
      crumb: [crumbLink('#/mypage', 'マイページ'), 'お問い合わせ履歴'],
      title: 'お問い合わせ履歴',
      single: `<p class="small muted">送信したお問い合わせと、運営からの返信が表示されます。新しいお問い合わせは<a href="#/contact">お問い合わせページ</a>からどうぞ。</p>
        ${contacts.length ? contacts.map((c) => `<div class="cmt"><div class="cmt-head"><span class="tag tag-live">${esc(c.type)}</span>${c.unread ? '<span class="new">new!</span>' : ''}<span class="meta">${fullDate(c.at)}</span></div>
          <div class="cmt-body">${esc(c.body)}</div>${replyList(c.replies) || '<p class="small muted" data-style="margin:6px 0 0">返信はまだありません</p>'}</div>`).join('') : '<p class="empty">お問い合わせはありません</p>'}`,
    });
    if (contacts.some((c) => c.unread)) {
      await api('/api/me/contacts/read', { method: 'POST' }).catch(() => {});
      me.unreadReplies = 0;
      renderNotice();
    }
  }

  // ---------- Account pages (Japanese, in-app; no hosted UI) ----------
  const PW_HINT = '8文字以上で、英大文字・英小文字・数字をそれぞれ1文字以上含めてください';
  const afterLogin = async () => {
    await loadMe();
    renderAccount();
    const ret = session.get('va.return');
    session.del('va.return');
    location.hash = ret && ret !== '#/login' && ret !== '#/signup' ? ret : '#/mypage';
    toast('ログインしました');
  };
  // Discord's mark, so the button reads as "sign in with Discord" at a glance
  const DISCORD_MARK = '<svg class="dc-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>';
  const googleButton = () => {
    const btns = [
      CONFIG?.discordEnabled ? `<a class="acc-btn btn-discord btn-block" id="discord-login" href="#">${DISCORD_MARK}<span>Discordでログイン</span></a>
        ${/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? '<p class="small muted" data-style="margin:4px 0 0">スマホでは、Discordアプリでログイン中のアカウントで登録・ログインされます。</p>' : ''}
        <p class="small" id="discord-fallback" hidden>Discordアプリが開かない場合は、<a href="#">こちらからブラウザで続ける</a></p>` : '',
    ].filter(Boolean);
    return btns.length ? `<p class="center" data-style="margin:14px 0 4px">または</p><div class="sso-btns">${btns.join('')}</div>` : '';
  };
  // Discord: full-page redirect through our API (server-side OAuth2)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#discord-login');
    if (!a) return;
    e.preventDefault();
    const ret = session.get('va.return') || '#/mypage';
    const qs = new URLSearchParams({ return: ret });
    const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!mobile) { location.assign(`/api/auth/discord/login?${qs}`); return; }
    // Phones: open the Discord app. Never auto-fall back to the browser — running both
    // flows at once signed users in as whichever account (app vs. browser) answered last.
    // The browser path is offered only as an explicit link.
    api(`/api/auth/discord/start?${qs}`).then(({ appUrl, webUrl }) => {
      location.href = appUrl;
      const box = document.getElementById('discord-fallback');
      if (box) {
        box.hidden = false;
        box.querySelector('a').href = webUrl;
      }
    }).catch(() => location.assign(`/api/auth/discord/login?${qs}`));
  });

  // First Discord sign-in: agree to the terms, then the account is created
  async function pageDiscordSignup() {
    const { name } = await api('/api/auth/discord/pending').catch(() => ({ name: null }));
    if (!name) {
      app.innerHTML = layout({ crumb: 'Discordで登録', title: 'Discordで登録', single: '<p>Discordでの認証の有効期限が切れました。もう一度ログイン画面からお試しください。</p><p><a href="#/login">ログイン画面へ</a></p>' });
      return;
    }
    app.innerHTML = layout({
      crumb: 'Discordで登録',
      title: 'Discordで登録',
      single: boxList('アカウントを作成', `<p>Discordアカウント「<b>${esc(name)}</b>」で登録します。</p>
        <form id="dsu-form" novalidate>
          <label class="check"><input type="checkbox" id="d-agree"> <a href="#/terms" target="_blank" rel="noopener">利用規約</a>と<a href="#/privacy" target="_blank" rel="noopener">プライバシーポリシー</a>に同意します</label>
          <p class="error-text" id="d-err" hidden></p>
          <button class="btn btn-green btn-block btn-lg">登録してログイン</button>
        </form>
        <p class="small muted" data-style="margin-top:10px">${discordDataNote()}</p>`),
    });
    $('#dsu-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#d-err');
      err.hidden = true;
      ev.submitter.disabled = true;
      try {
        await api('/api/auth/discord/complete', { method: 'POST', body: { agree: $('#d-agree').checked } });
        toast('登録が完了しました');
        await afterLogin();
      } catch (e) { err.textContent = e.message; err.hidden = false; } finally { ev.submitter.disabled = false; }
    });
  }

  // Discord is the only way to sign up / sign in. The e-mail form survives only for
  // legacy accounts, and its entry link is shown only on devices that used it before.
  function pageLogin() {
    if (me) { location.hash = '#/mypage'; return; }
    const err = { cancelled: 'Discordでの認証がキャンセルされました。', state: '認証の有効期限が切れました。もう一度お試しください。', token: 'Discordでの認証に失敗しました。もう一度お試しください。', profile: 'Discordのユーザー情報を取得できませんでした。', young: '作成から1か月未満のDiscordアカウントでは登録できません。', guild: '指定のDiscordサーバーのメンバーのみ利用できます。サーバーに参加しているアカウントでログインしてください。' }[new URLSearchParams(location.hash.split('?')[1] || '').get('discord')];
    app.innerHTML = layout({
      crumb: 'ログイン',
      title: 'ログイン',
      single: boxList('ログイン・新規登録', `${err ?`<p class="error-text">${esc(err)}</p>` : ''}
        <p>${esc(siteName())} はDiscordアカウントでログイン・新規登録します。はじめての方も下のボタンから登録できます。</p>
        ${googleButton().replace('<p class="center" data-style="margin:14px 0 4px">または</p>', '')}
        <p class="small muted" data-style="margin-top:10px">${discordDataNote()}</p>`),
    });
    bindLoginButtons(app);
  }

  // What the sign-in asks Discord for: "identify" only, plus "guilds" on a members-only site
  const discordDataNote = () => `Discordからは、ユーザーID・ユーザー名・表示名などの基本的なユーザー情報だけを受け取ります${CONFIG?.guildOnly ? '。あわせて、指定のDiscordサーバーに参加しているかを確認します（参加サーバーの一覧は確認にのみ使い、保存しません）' : ''}。メールアドレスやメッセージは受け取りません。${hasDoc('security') ? '<a href="#/security">安全への取り組みはこちら</a>' : ''}`;

  function ratingSummary(u, history) {
    const j = new Date(Date.now() + 9 * 3600_000);
    const dayStart = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * 3600_000; // JST 0:00
    const dayDelta = history.filter((h) => new Date(h.at).getTime() >= dayStart).reduce((s, h) => s + h.delta, 0);
    const last = history[0]?.result;
    let streak = 0;
    for (const h of history) { if (h.result === last) streak++; else break; }
    // 前日比 only on a day the rating actually moved
    const dd = dayDelta > 0 ? `<br>前日比：<span class="red">+${dayDelta}</span>` : dayDelta < 0 ? `<br>前日比：<span class="minus">${dayDelta}</span>` : '';
    const st = streak >= 2 ? `<br><span class="${last === 'win' ? 'red' : 'minus'}">現在${streak}${last === 'win' ? '連勝' : '連敗'}！</span>` : '';
    return `<table class="rate-tbl"><tr><td>現在レート</td><td>${u.rating}${dd}</td></tr><tr><td>最高レート</td><td>${u.maxRating}</td></tr><tr><td>対戦成績</td><td>${u.wins}勝 ${u.losses}敗${st}</td></tr><tr><td>動画化</td><td>${u.allowVideo ? '許可する' : '許可しない'}</td></tr></table>`;
  }

  function profileLayout(u, data, { own }) {
    const PER = 20;
    let page = 0;
    const base = `#/users/${esc(u.userId)}`;
    app.innerHTML = layout({
      crumb: own ? 'マイページ' : esc(u.name),
      title: own ? 'マイページ' : u.name,
      side: `${own && me.mismatches?.length ? `<div class="alert alert-red mismatch-note">結果が不一致の対戦ルームがあります。ご確認ください。<br>${me.mismatches.map((x) => `<a href="#/match/${esc(x.matchId)}">対戦ルーム${x.matchNo ? ` ${esc(x.matchNo)}` : ''}</a>`).join('　')}</div>` : ''}
        ${box('ユーザー情報', `<div class="uinfo">${avatar('xl', u.userId)}<div>${u.symbol ? `<div class="badge-sym">${esc(u.symbol)}</div>` : ''}<b>${esc(u.name)}</b>${adminBadge(u.admin)}${u.fighter ? `<div>${fthumb(u.fighter)}</div>` : ''}</div></div>`)}
        <div class="box-body"><ul class="menu-list">
          ${u.memberNo ? `<li><b>ID ${u.memberNo}</b></li>` : ''}
          ${own && me.discordLinked ? '<li><b>Discord連携済</b></li>' : ''}
          ${u.twitterId ? `<li><a href="https://x.com/${encodeURIComponent(u.twitterId)}" target="_blank" rel="noopener noreferrer">Twitterを見る</a></li>` : ''}
          <li><a href="${base}/intro">紹介文を見る</a><span class="count">${data.introCount}</span></li>
          ${closed('diaries') ? '' : `<li><a href="${base}/diaries">日記を見る</a><span class="count">${data.diaries.length}</span></li>`}
          ${closed('medals') ? '' : `<li><a href="${base}/medals">取得メダルを見る</a><span class="count">${(data.medals ?? []).length}</span></li>`}
        </ul></div>
        ${own ? `<div class="box-body"><ul class="menu-list">
          ${closed('points') ? '' : `<li><b>ポイント ${me.points ?? 0}</b></li>`}
          <li><a href="#/mypage/edit">プロフィールを編集する</a></li>
          <li><a href="#/mypage/avatar">プロフィール画像を変更する</a></li>
          <li><a href="#/mypage/stages">拒否ステージを設定する</a></li>
          ${closed('diaries') ? '' : '<li><a href="#/diaries/new">日記を書く</a></li>'}
          <li><a href="#/mypage/data">マイ対戦データを見る</a></li>
          <li><a href="#/mypage/memos">キャラ対策メモを設定する</a></li>
          <li><a href="#/mypage/contacts">お問い合わせ履歴</a>${me.unreadReplies ? ' <span class="new">返信あり</span>' : ''}</li>
        </ul></div>` : ''}
        ${box('レーティング対戦', ratingSummary(u, data.history), 'rate-box')}`,
      main: `${box('プロフィール', u.bio ? `<div class="prose">${esc(u.bio)}</div>` : '<span class="muted">プロフィールは未設定です</span>')}
        ${boxList('レーティング対戦履歴', '<div id="hist"></div><div class="pager" id="hpager"></div>')}
        ${boxList('レーティンググラフ', ratingGraph(data.history))}`,
    });
    function renderHist() {
      const items = data.history.slice(page * PER, page * PER + PER);
      // Original layout: [No. / match no / my char] [opponent name / char] [result] [delta]
      $('#hist').innerHTML = items.length ? items.map((h) => {
        const cls = h.result === 'win' ? 'h-win' : 'h-lose';
        return `<div class="hrow">
          <div class="h-no"><span>No.</span><a href="#/match/${esc(h.matchId)}">${h.matchNo ?? '-'}</a>${fthumb(h.myFighter, 'hs')}</div>
          <a class="h-av" href="#/users/${esc(h.opponentId)}">${avatar('hav', h.opponentId)}</a>
          <div class="h-opp"><a href="#/users/${esc(h.opponentId)}">${esc(h.opponentName)}</a>${fthumb(h.opponentFighter, 'hs')}${h.opponentSwitched ? '<span class="h-switch">スイッチ</span>' : ''}</div>
          <div class="h-res ${cls}">${h.result === 'win' ? '勝ち' : '負け'}</div>
          <div class="h-delta ${cls}">${h.delta > 0 ? '＋' : '－'}${Math.abs(h.delta)}</div>
        </div>`;
      }).join('') : '<p class="empty">対戦履歴はありません</p>';
      pager($('#hpager'), data.history.length, PER, page, (p) => { page = p; renderHist(); });
    }
    renderHist();
  }

  // Achievements = top-4 tournament finishes
  const achievementsOf = (tours) => tours.filter((t) => ['優勝', '準優勝', 'ベスト4'].includes(t.result));
  const profileData = async (uid) => {
    const [data, t] = await Promise.all([api(`/api/users/${uid}`), api(`/api/users/${uid}/tournaments`).catch(() => ({ tournaments: [] }))]);
    return { ...data, tournaments: t.tournaments };
  };

  async function pageMyPage() {
    if (!requireLogin('マイページ')) return;
    await loadMe(); renderAccount();
    profileLayout(me, await profileData(me.userId), { own: true });
  }

  async function pageUser(uid) {
    if (me && uid === me.userId) { location.hash = '#/mypage'; return; }
    let data;
    try { data = await profileData(uid); } catch (e) { app.innerHTML = errorBox(e); return; }
    profileLayout(data.user, data, { own: false });
  }

  async function pageAchievements(uid) {
    const [{ user }, { tournaments }] = await Promise.all([api(`/api/users/${uid}`), api(`/api/users/${uid}/tournaments`)]);
    const list = achievementsOf(tournaments);
    app.innerHTML = layout({
      crumb: [userLink(uid, user.name), `${esc(user.name)}さんの実績一覧`],
      title: `${user.name}さんの実績一覧`,
      single: list.length
        ? `<table class="tbl result-table"><thead><tr><th>タイトル</th><th>結果</th></tr></thead>${list.map((t) => `<tr><td><a href="#/tournaments/${esc(t.tourId)}">参加者${t.entryCount}名 ${esc(t.title)}</a></td><td>${esc(t.result)}</td></tr>`).join('')}</table>`
        : '<p class="empty">まだ実績はありません（大会でベスト4以上に入ると記録されます）</p>',
    });
  }

  // ---------- Admin: correct rated match results ----------
  async function pageAdminMatches() {
    if (!requireLogin('対戦結果の修正')) return;
    if (!me.isAdmin) { app.innerHTML = errorBox('このページは管理者のみ利用できます。'); return; }
    let { matches } = await api('/api/admin/matches');
    const statusJa = { playing: '対戦中', done: '決着', disputed: '無効', cancelled: '中止' };
    const render = (q = '') => {
      const k = q.trim().toLowerCase();
      const list = matches.filter((m) => !k || String(m.matchNo).includes(k) || m.players.some((u) => String(m.playerInfo[u]?.name || '').toLowerCase().includes(k)));
      $('#am-list').innerHTML = list.length ? list.map((m) => {
        const [a, b] = m.players;
        const pa = m.playerInfo[a] || {};
        const pb = m.playerInfo[b] || {};
        const rep = (u) => ({ win: '勝ち', lose: '負け', cancel: '対戦中止' }[m.reports?.[u]] || '未報告');
        const res = m.status === 'done' ? `${esc(m.playerInfo[m.winnerId]?.name || '')} の勝ち（±${m.delta}）` : statusJa[m.status] || m.status;
        return `<div class="adm-user" data-mid="${esc(m.matchId)}">
          <div class="adm-head"><b>No.${m.matchNo ?? '-'}</b><span class="spacer"></span><span class="tag tag-done">${esc(statusJa[m.status] || m.status)}</span></div>
          <div class="small">P1：${esc(pa.name || '')}（報告：${rep(a)}） ／ P2：${esc(pb.name || '')}（報告：${rep(b)}）</div>
          <div class="small muted">結果：${res}${m.correctedAt ? ' ・管理者修正済' : ''} ／ ${fullDate(m.matchedAt || m.createdAt)}</div>
          <div class="adm-actions"><button class="btn-line" data-win="${esc(a)}">P1の勝ち</button><button class="btn-line" data-win="${esc(b)}">P2の勝ち</button><button class="btn-line adm-danger" data-win="void">無効</button></div>
        </div>`;
      }).join('') : '<p class="empty">該当する対戦はありません</p>';
    };
    app.innerHTML = layout({
      crumb: [crumbLink('#/admin', '管理ページ'), '対戦結果の修正'],
      title: '対戦結果の修正',
      single: `<p class="small">直近100件のレーティング対戦です。決着済みの対戦を修正すると、反映済みのレート・勝敗数・ポイント・対戦履歴をいったん取り消してから、新しい結果で付け直します（最高レートは戻りません）。</p>
        <input id="am-filter" placeholder="ルーム番号・プレイヤー名で絞り込み"><div id="am-list" data-style="margin-top:10px"></div>`,
    });
    render();
    $('#am-filter').addEventListener('input', (e) => render(e.target.value));
    $('#am-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-win]');
      if (!b) return;
      const mid = b.closest('[data-mid]').dataset.mid;
      const m = matches.find((x) => x.matchId === mid);
      // Two-tap confirmation instead of confirm(): in-app browsers (LINE, Google app…) may block dialogs
      if (!b.dataset.armed) {
        $('#am-list').querySelectorAll('[data-armed]').forEach((x) => { x.textContent = x.dataset.label; delete x.dataset.armed; });
        b.dataset.label = b.textContent;
        b.dataset.armed = '1';
        b.textContent = 'もう一度押して確定';
        setTimeout(() => { if (b.dataset.armed) { b.textContent = b.dataset.label; delete b.dataset.armed; } }, 3000);
        return;
      }
      delete b.dataset.armed;
      withBusy(b, async () => {
        const updated = await api(`/api/admin/matches/${mid}/result`, { method: 'POST', body: { result: b.dataset.win } });
        matches = matches.map((x) => (x.matchId === mid ? updated : x));
        toast('結果を修正しました');
        render($('#am-filter').value);
      });
    });
  }

  // ---------- Admin: user management ----------
  async function pageAdminUsers() {
    if (!requireLogin('ユーザー管理')) return;
    if (!me.isAdmin) { app.innerHTML = errorBox('このページは管理者のみ利用できます。'); return; }
    const { users } = await api('/api/admin/users');
    const statusLabel = { CONFIRMED: '確認済', UNCONFIRMED: 'メール未確認', RESET_REQUIRED: 'PW再設定待ち', FORCE_CHANGE_PASSWORD: '初期PW', EXTERNAL_PROVIDER: '外部ログイン' };
    app.innerHTML = layout({
      crumb: [crumbLink('#/admin', '管理ページ'), 'ユーザー管理'],
      title: 'ユーザー管理',
      single: `
        ${boxList(`登録ユーザー（${users.length}人）`, `<div class="adm-pad"><input id="u-filter" placeholder="名前・メールアドレス・IDで絞り込み"></div><div id="u-list"></div>`)}`,
    });

    const render = (q) => {
      const k = q.trim().toLowerCase();
      const list = users.filter((u) => !k || [u.name, u.email, u.discordUsername, u.discordGlobalName, u.discordId, String(u.memberNo ?? '')].some((v) => String(v).toLowerCase().includes(k)));
      $('#u-list').innerHTML = list.length ? list.map((u) => {
        const self = u.userId === me.userId;
        return `<div class="adm-user" data-uid="${esc(u.userId)}">
          <div class="adm-head">${avatar('sm', u.userId)}<a href="#/users/${esc(u.userId)}"><b>${esc(u.name || '(プロフィール未作成)')}</b></a>${u.memberNo ? `<span class="small muted">ID ${u.memberNo}</span>` : ''}
            <span class="spacer"></span>${u.enabled ? '' : '<span class="tag tag-end">停止中</span>'}<span class="tag tag-done">${esc(statusLabel[u.status] || u.status)}</span></div>
          <div class="small">${u.email ? esc(u.email) : 'Discordアカウント'}</div>
          ${u.discordId ? `<div class="small">Discord：${u.discordUsername ? `@${esc(u.discordUsername)}${u.discordGlobalName ? `（${esc(u.discordGlobalName)}）` : ''}` : '<span class="muted">次回ログイン時に取得</span>'}<span class="muted">　ID ${esc(u.discordId)}</span></div>` : ''}
          <div class="small muted">登録：${fullDate(u.createdAt)} ／ レート ${u.rating ?? '-'}（${u.wins}勝${u.losses}敗）</div>
          ${self ? '<p class="small muted">（あなたのアカウント）</p>' : `<div class="adm-actions">
            ${u.email ? '<button class="btn-line" data-act="reset">PWリセット</button>' : ''}
            <button class="btn-line" data-act="${u.enabled ? 'disable' : 'enable'}">${u.enabled ? '利用停止' : '停止解除'}</button>
            <button class="btn-line adm-danger" data-act="delete-open">削除</button></div>
          <div class="adm-del" hidden>
            <p class="small"><b class="red">このユーザーを削除すると元に戻せません。</b><br>プロフィール・日記などが削除されます。確認のため「削除」と入力してください。</p>
            <div class="row"><input class="adm-del-input" autocomplete="off" placeholder="削除" aria-label="確認の入力"><button class="btn-line adm-danger" data-act="delete" disabled>削除する</button><button class="btn-line" data-act="delete-close">やめる</button></div>
          </div>`}
        </div>`;
      }).join('') : '<p class="empty">該当するユーザーはいません</p>';
    };
    render('');
    $('#u-filter').addEventListener('input', (e) => render(e.target.value));
    // Deleting needs the word typed in; the delete button stays disabled until then
    $('#u-list').addEventListener('input', (e) => {
      if (!e.target.classList.contains('adm-del-input')) return;
      e.target.closest('.adm-del').querySelector('[data-act="delete"]').disabled = e.target.value.trim() !== '削除';
    });
    $('#u-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const card = b.closest('[data-uid]');
      const uid = card.dataset.uid;
      const u = users.find((x) => x.userId === uid);
      if (b.dataset.act === 'delete-open' || b.dataset.act === 'delete-close') {
        const panel = card.querySelector('.adm-del');
        panel.hidden = b.dataset.act === 'delete-close';
        panel.querySelector('input').value = '';
        panel.querySelector('[data-act="delete"]').disabled = true;
        if (!panel.hidden) panel.querySelector('input').focus();
        return;
      }
      if (b.dataset.act === 'delete' && card.querySelector('.adm-del-input').value.trim() !== '削除') return;
      // Stop / password reset: tap twice within 3 seconds (no dialogs: in-app browsers block them)
      if ((b.dataset.act === 'reset' || b.dataset.act === 'disable') && !b.dataset.armed) {
        b.dataset.label = b.textContent;
        b.dataset.armed = '1';
        b.textContent = 'もう一度タップで実行';
        setTimeout(() => { if (b.isConnected && b.dataset.armed) { b.textContent = b.dataset.label; delete b.dataset.armed; } }, 3000);
        return;
      }
      withBusy(b, async () => {
        if (b.dataset.act === 'reset') {
          await api(`/api/admin/users/${uid}/reset-password`, { method: 'POST' });
          toast('パスワードをリセットしました');
        } else if (b.dataset.act === 'disable' || b.dataset.act === 'enable') {
          const enabled = b.dataset.act === 'enable';
          await api(`/api/admin/users/${uid}/enabled`, { method: 'POST', body: { enabled } });
          u.enabled = enabled;
          toast(enabled ? '停止を解除しました' : '利用停止にしました');
        } else if (b.dataset.act === 'delete') {
          await api(`/api/admin/users/${uid}?confirm=delete`, { method: 'DELETE' });
          users.splice(users.indexOf(u), 1);
          toast(`${u.name || 'ユーザー'}を削除しました`);
        }
        render($('#u-filter').value);
      });
    });
  }

  function pageClosed() {
    app.innerHTML = layout({ title: 'この機能は現在準備中です', single: '<p>公開までしばらくお待ちください。</p><p><a href="#/">トップへ戻る</a></p>' });
  }

  // ---------- Router ----------
  const CLOSED_ROUTES = [
    ['free', /^\/free(\/|$)/],
    ['diaries', /^\/diaries(\/|$)|^\/users\/[\w-]+\/diaries(\/|$)/],
    ['links', /^\/links$/],
    ['medals', /^\/users\/[\w-]+\/medals$/],
  ];
  const ROUTES = [
    [/^\/?$/, pageHome],
    [/^\/free$/, pageFree, 'free'],
    [/^\/free\/([\w-]+)$/, pageFreeRoom, 'free'],
    [/^\/rate$/, pageRate, 'rate'],
    [/^\/match\/([\w-]+)$/, pageMatch, 'rate'],
    // Not opened yet (pre-release): tournaments, symbol gacha, minimum game
    [/^\/(?:tournaments(?:\/.*)?|gacha|minimum|users\/[\w-]+\/(?:tournaments|achievements))$/, pageClosed],
    [/^\/fighters$/, pageFighters, 'fighters'],
    [/^\/fighters\/(\d+)$/, pageFighter, 'fighters'],
    [/^\/ranking$/, pageRanking, 'ranking'],
    [/^\/diaries$/, pageDiaries, 'diaries'],
    [/^\/diaries\/new$/, pageDiaryNew, 'diaries'],
    [/^\/users\/([\w-]+)\/diaries\/([\w-]+)$/, pageDiary, 'diaries'],
    [/^\/users\/([\w-]+)\/diaries$/, pageUserDiaries, 'diaries'],
    [/^\/users\/([\w-]+)\/intro$/, pageIntro],
    [/^\/users\/([\w-]+)$/, pageUser],
    [/^\/login(?:\?.*)?$/, pageLogin],
    [/^\/discord-signup$/, pageDiscordSignup],
    // E-mail sign-up is closed: old links land on the Discord login
    [/^\/signup(?:\/confirm)?$/, pageLogin],
    [/^\/mypage(?:\?.*)?$/, pageMyPage],
    [/^\/mypage\/edit$/, pageMyEdit],
    [/^\/mypage\/stages$/, pageMyStages],
    [/^\/mypage\/avatar$/, pageAvatar],
    [/^\/mypage\/memos$/, pageMemos],
    [/^\/mypage\/contacts$/, pageMyContacts],
    [/^\/mypage\/data$/, pageMyData],
    [/^\/users\/([\w-]+)\/medals$/, pageMedals],
    [/^\/search$/, pageSearchForm],
    [/^\/contact$/, pageContact],
    [/^\/admin\/contacts$/, pageAdminContacts],
    [/^\/admin\/audit$/, pageAdminAudit],
    [/^\/admin\/users$/, pageAdminUsers],
    [/^\/admin\/matches$/, pageAdminMatches],
    [/^\/admin$/, pageAdmin],
    [/^\/search\/(.+)$/, pageSearch],
    [/^\/news\/([\w-]+)$/, pageNews],
    [/^\/updates$/, pageUpdates],
    [/^\/(about|terms|privacy|rules|faq|links)$/, pageDoc],
    [/^\/security$/, () => (hasDoc('security') ? pageDoc('security') : (app.innerHTML = layout({ title: 'ページが見つかりません', single: '<p><a href="#/">トップへ戻る</a></p>' })))],
  ];

  // Each navigation gets a number; a slower, superseded render must not show its errors
  let routeGen = 0;
  async function route() {
    const gen = ++routeGen;
    clearTimers();
    setDrawer(false);
    renderNotice();
    document.body.classList.remove('has-sticky');
    const path = location.hash.replace(/^#/, '') || '/';
    if (CLOSED_ROUTES.some(([feature, re]) => closed(feature) && re.test(path))) { pageClosed(); return; }
    for (const [re, fn, nav] of ROUTES) {
      const m = path.match(re);
      if (!m) continue;
      document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
      app.innerHTML = spinner;
      try { await fn(...m.slice(1)); } catch (e) { console.error(e); if (gen === routeGen) app.innerHTML = errorBox(e); }
      return;
    }
    app.innerHTML = layout({ title: 'ページが見つかりません', single: '<p><a href="#/">トップへ戻る</a></p>' });
  }

  // Templates write data-style="…" instead of style="…" (CSP has no 'unsafe-inline' for styles);
  // styles set through the CSSOM are allowed, so apply them as nodes are inserted.
  const applyStyles = (node) => {
    if (node.nodeType !== 1) return;
    const els = node.hasAttribute('data-style') ? [node, ...node.querySelectorAll('[data-style]')] : node.querySelectorAll('[data-style]');
    for (const el of els) {
      el.style.cssText = el.getAttribute('data-style');
      el.removeAttribute('data-style');
    }
  };
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(applyStyles)))
    .observe(document.documentElement, { childList: true, subtree: true });

  // Image fallbacks without inline handlers (CSP forbids them):
  // missing avatars/stage images are removed; a missing logo becomes the site name.
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLImageElement)) return;
    if (t.hasAttribute('data-logo')) {
      const span = document.createElement('span');
      span.className = 'logo-text';
      span.textContent = siteName();
      t.replaceWith(span);
    } else if (t.hasAttribute('data-fb')) t.remove();
  }, true);

  async function boot() {
    // Remove tokens left in localStorage by the old client-side login (now HttpOnly cookies)
    try { localStorage.removeItem('va.tokens'); } catch { /* ignore */ }
    for (const f of [$('#search-form')]) {
      f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const q = ev.target.elements.q.value.trim();
        if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
      });
    }
    $('#menu-btn').addEventListener('click', () => setDrawer(true));
    $('#drawer-overlay').addEventListener('click', () => setDrawer(false));
    $('#drawer').addEventListener('click', (e) => { if (e.target.closest('a[href^="#"]')) setDrawer(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
    try {
      CONFIG = await (await fetch('config.json', { cache: 'no-store' })).json();
      // The built-in launch notice lists features this site does not have
      if (CONFIG.edition === 'sbr') {
        SITE.notices = [];
        SITE.footer = 'ゲームタイトルおよびキャラクター名は、各権利者の商標または登録商標です。\n当サイトは個人が運営するファン向けWebサービスであり、スマメイトの運営者、ゲームの権利者・関連企業とは一切関係ありません。';
      }
    } catch {
      app.innerHTML = errorBox('config.json を読み込めませんでした。cdk deploy 後に配信されるファイルです。');
      return;
    }
    SITE.docs = null;
    try {
      const { site } = await api('/api/site');
      if (site) Object.assign(SITE, site);
    } catch { /* fall back to defaults */ }
    applySite();
    await loadMe();
    renderAccount();
    window.addEventListener('hashchange', async () => {
      if (await newVersionDeployed()) { location.reload(); return; }
      route(); window.scrollTo(0, 0);
    });
    route();
  }

  // A tab left open keeps running the version it loaded. When a newer one has been deployed,
  // the next page change loads it (checked at most once a minute).
  const LOADED_VERSION = document.querySelector('script[src*="app.js?v="]')?.getAttribute('src').split('v=')[1] ?? '';
  let versionCheckedAt = Date.now();
  async function newVersionDeployed() {
    if (!LOADED_VERSION || Date.now() - versionCheckedAt < 60_000) return false;
    versionCheckedAt = Date.now();
    try {
      const html = await (await fetch(location.pathname, { cache: 'no-store' })).text();
      const v = html.match(/app\.js\?v=([^"']+)/)?.[1];
      return Boolean(v && v !== LOADED_VERSION);
    } catch { return false; }
  }

  boot();
})();
