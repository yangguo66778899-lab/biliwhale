/* BiliWhale 面板（原生 JS，无框架、无 CDN、离线可用）。
 *
 * 约定：
 *  - token 从 URL 的 ?token= 取一次，放进 sessionStorage，然后把地址栏里的 token 抹掉；
 *  - 所有请求带 Authorization: Bearer；写操作再带 x-csrf-token（从 /api/session 拿）；
 *  - 资源都由内核提供，页面不做任何外部请求。
 */

'use strict';

const state = {
  token: '',
  csrf: '',
  version: '',
  status: null,
  config: null,
  qr: { key: null, timer: null },
  diaryKind: 'public',
  diaryQuery: '',
  logLevel: 'all',
  reportDate: null,
  diaryDate: null,
};

/* ---------------- 基础 ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    // onClick → 'click'：事件名大小写敏感，slice(2) 会得到 "Click"，那样注册的监听永远不会触发
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};

function toast(text, bad = false) {
  const box = $('#toast');
  box.textContent = text;
  box.className = bad ? 'toast bad' : 'toast';
  box.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    box.hidden = true;
  }, 4200);
}

function initToken() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    sessionStorage.setItem('bw_token', fromUrl);
    params.delete('token');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }
  state.token = sessionStorage.getItem('bw_token') || '';
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  // 凭据：地址里带过 token 就用 Bearer；否则靠内核种下的 HttpOnly 会话 cookie（浏览器自动带）
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (method !== 'GET') {
    if (!state.csrf) await loadSession();
    headers['x-csrf-token'] = state.csrf;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: false, error: text.slice(0, 200) };
  }
  if (res.status === 401) {
    throw new Error('token 不对或已失效：请从托盘「打开面板」重新进入（地址里要带 ?token=）');
  }
  if (!res.ok && (!data || data.ok !== false)) {
    throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  }
  if (data && data.ok === false && !data.issues) {
    throw new Error(data.error || data.message || '请求失败');
  }
  return data;
}

async function loadSession() {
  const session = await api('/api/session');
  state.csrf = session.csrfToken;
  state.version = session.version;
  // 启动时就按配置上色：不用先点进设置页（auto = 跟着系统，不设 data-theme）
  applyTheme(session.theme);
  $('#version').textContent = `v${session.version}`;
}

/** 面板配色：auto 跟着系统；light/dark 明确覆盖系统。 */
function applyTheme(theme) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root || typeof root.setAttribute !== 'function') return;
  const value = theme === 'light' || theme === 'dark' ? theme : 'auto';
  if (value === 'auto') {
    if (typeof root.removeAttribute === 'function') root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', value);
  }
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.round((t - Date.now()) / 60000);
  const d = new Date(t);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < -1) return `${clock}（已过）`;
  if (Math.abs(diff) <= 1) return `${clock}（马上）`;
  if (diff < 60) return `${clock}（约 ${diff} 分钟后）`;
  return `${clock}（约 ${Math.round(diff / 60)} 小时后）`;
}

function fmtAgo(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时前`;
  return `${Math.round(sec / 86400)} 天前`;
}

/* ---------------- 极简 Markdown ---------------- */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let inCode = false;
  let inList = false;

  const inline = (text) => {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
      const safe = /^https?:\/\//.test(href) ? href : '#';
      return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    });
    return html;
  };

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      inCode = !inCode;
      out.push(inCode ? '<pre class="md"><code>' : '</code></pre>');
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(raw));
      continue;
    }
    const line = raw.replace(/\s+$/, '');
    if (/^\s*$/.test(line)) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level + 1}>${inline(heading[2])}</h${level + 1}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

/* ---------------- 二维码 ---------------- */

function rowsToSvg(rows, moduleSize = 5, margin = 3) {
  const size = rows.length;
  const total = (size + margin * 2) * moduleSize;
  let path = '';
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (rows[y][x] !== '1') {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < size && rows[y][x + run] === '1') run += 1;
      path += `M${(x + margin) * moduleSize} ${(y + margin) * moduleSize}h${run * moduleSize}v${moduleSize}h${-run * moduleSize}z`;
      x += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/* ---------------- 概览 ---------------- */

async function renderOverview(options = {}) {
  const panel = $('#panel-overview');
  panel.innerHTML = '<h1>概览</h1><div class="card">读取中…</div>';
  // doctor 会外呼 B 站 nav + DeepSeek /models + spawn reg：只在切到本页时跑，轮询不跑（审计 §3.36）
  const wantDoctor = options.doctor !== false;
  const [status, doctor] = await Promise.all([
    api('/api/status'),
    wantDoctor ? api('/api/doctor').catch(() => null) : Promise.resolve(state.doctor ?? null),
  ]);
  if (wantDoctor) state.doctor = doctor;
  state.status = status;

  const paused = status.scheduler.paused;
  const running = false;
  const head = el('div', { class: 'card' }, [
    el('div', { class: 'row' }, [el('span', {}, ['状态']), el('span', {}, [paused ? '已暂停（手动仍可跑）' : '运行中'])]),
    el('div', { class: 'row' }, [el('span', {}, ['作息']), el('span', {}, [status.scheduler.plan || '—'])]),
    el('div', { class: 'row' }, [el('span', {}, ['下一次']), el('span', {}, [fmtWhen(status.scheduler.nextWakeAt)])]),
    el('div', { class: 'row' }, [el('span', {}, ['最近一轮']), el('span', {}, [status.lastRun ? `${status.lastRun.status} · ${fmtAgo(status.lastRun.endedAt)} · ${status.lastRun.tokens} token` : '还没跑过'])]),
    el('div', { class: 'row' }, [el('span', {}, ['今日']), el('span', {}, [`醒 ${status.today.wakes}/${status.today.targetWakes} 次 · 分享 ${status.today.shares}/${status.today.shareCap} 条`])]),
    el('div', { class: 'row' }, [el('span', {}, ['今日花费']), el('span', {}, [status.today.costCny > 0 ? `¥${status.today.costCny}` : `${status.today.tokens} token`])]),
    el('div', { class: 'row' }, [el('span', {}, ['账号']), el('span', {}, [status.account.loggedIn ? status.account.name || '已登录' : '未登录（去「账号」页扫码）'])]),
    el('div', { class: 'row' }, [el('span', {}, ['模型']), el('span', {}, [status.model.actual || status.model.configured])]),
    el('div', { class: 'row' }, [el('span', {}, ['待审']), el('span', {}, [status.pending && status.pending.count > 0 ? `${status.pending.count} 条等你决定（去「待审」页）` : '没有'])]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'primary', onClick: () => runRound(true) }, ['预演一轮']),
      el('button', { onClick: () => runRound(false) }, ['现在跑一轮']),
      el('button', { onClick: () => togglePause(paused) }, [paused ? '恢复自动唤醒' : '暂停自动唤醒']),
    ]),
  ]);
  panel.innerHTML = '<h1>概览</h1>';

  // 首次配置清单：缺什么一眼看到，点一下跳到对应页
  if (status.setup && !status.setup.ready) {
    const setup = el('div', { class: 'card setup-card' }, [
      el('h3', {}, ['还差这些才能正常跑']),
      el('div', { class: 'hint', text: '「鲸鲸」和「你」是两个号：鲸鲸负责看和发，你是主人（@、私信、聊天都找你）。' }),
    ]);
    for (const item of status.setup.items) {
      setup.appendChild(
        el('div', { class: 'row' }, [
          el('span', {}, [`${item.ok ? '✓' : '✗'} ${item.label}`]),
          el('span', { class: item.ok ? 'mono' : 'mono bad' }, [item.ok ? (item.hint || '已就绪') : item.hint]),
        ]),
      );
    }
    setup.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'primary', onClick: () => goto('account') }, ['去「账号」页']),
        el('button', { onClick: () => goto('settings') }, ['去「设置」页']),
      ]),
    );
    panel.appendChild(setup);
  }

  panel.appendChild(head);

  // 「本轮挑中」：今天报告里挑中的视频；每条旁边一个「发动态…」入口（P0-3）
  const picked = await api('/api/picked').catch(() => null);
  const pickedItemsToday = pickedItems(picked);
  const pickedCard = el('div', { class: 'card' }, [el('h3', {}, ['本轮挑中'])]);
  if (pickedItemsToday.length === 0) {
    pickedCard.appendChild(el('div', { class: 'hint', text: '今天还没挑出视频：跑一轮之后这里会出现（每条旁边有「发动态…」）。' }));
  }
  for (const item of pickedItemsToday) {
    pickedCard.appendChild(
      el('div', { class: 'picked-row' }, [
        el('div', {}, [
          el('div', { text: item.title || item.bvid }),
          el('div', { class: 'mono hint', text: `${item.bvid}${item.oneliner ? ` · ${item.oneliner}` : ''}` }),
        ]),
        renderDynamicButton(item),
      ]),
    );
  }
  panel.appendChild(pickedCard);

  if (status.warnings && status.warnings.length > 0) {
    const warn = el('div', { class: 'card' }, [el('h3', {}, ['需要注意'])]);
    for (const text of status.warnings) warn.appendChild(el('div', { class: 'issue warn', text }));
    panel.appendChild(warn);
  }

  if (doctor && doctor.report) {
    const card = el('div', { class: 'card' }, [el('h3', {}, [`体检（${doctor.report.healthy ? '没有硬伤' : '有硬性项没过'}）`])]);
    const table = el('table');
    table.appendChild(el('tr', {}, [el('th', {}, ['项目']), el('th', {}, ['结果'])]));
    for (const row of doctor.report.rows) {
      table.appendChild(
        el('tr', {}, [
          el('td', {}, [row.name]),
          el('td', { class: `mono ${row.level === 'bad' ? 'bad' : ''}` }, [`${row.level === 'ok' ? '✓' : row.level === 'warn' ? '!' : '✗'} ${row.detail}`]),
        ]),
      );
    }
    card.appendChild(table);
    panel.appendChild(card);
  }

  const events = await api('/api/logs?limit=8');
  const card = el('div', { class: 'card' }, [el('h3', {}, ['最近发生的事'])]);
  const list = el('div', { class: 'list' });
  for (const event of events.events || []) {
    list.appendChild(
      el('div', { class: 'item' }, [el('span', { class: 'mono' }, [new Date(event.at).toLocaleTimeString()]), el('span', {}, [event.note])]),
    );
  }
  card.appendChild(list);
  panel.appendChild(card);

  void running;
}

async function runRound(dryRun) {
  try {
    const res = await api('/api/run', { method: 'POST', body: { dryRun } });
    toast(res.message || '已开始');
    setTimeout(renderOverview, 1500);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function togglePause(paused) {
  try {
    const res = await api(paused ? '/api/resume' : '/api/pause', { method: 'POST' });
    toast(res.message || '已切换');
    await renderOverview();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

/* ---------------- 设置 ---------------- */

async function renderSettings() {
  const panel = $('#panel-settings');
  panel.innerHTML = '<h1>设置</h1><div class="card">读取中…</div>';
  const [data, secrets] = await Promise.all([api('/api/config'), api('/api/secrets')]);
  state.config = data;
  applyTheme(data.config && data.config.ui ? data.config.ui.theme : 'auto');

  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['设置']));
  panel.appendChild(renderKeyCard(secrets));
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'hint', text: '保存即生效。作息（schedule）改了会让调度器重算计划；其它字段下一次调用生效。' }),
      el('div', { class: 'actions' }, [
        el('button', { class: 'primary', onClick: () => saveConfig() }, ['保存']),
        el('button', { onClick: () => validateCurrent() }, ['只校验']),
        el('button', { onClick: exportConfig }, ['导出']),
        el('button', { onClick: () => importConfig() }, ['导入']),
        el('button', { class: 'danger', onClick: () => resetConfig() }, ['恢复默认']),
      ]),
      el('div', { id: 'settings-issues' }),
    ]),
  );

  for (const group of data.groups) {
    // 通知组用自己的画法：主界面只露「B 站私信 / 本机日志」，另外两个折进「高级」
    if (group.key === 'notify') {
      panel.appendChild(renderNotifyCard(group, data));
      continue;
    }
    const card = el('div', { class: 'card' }, [el('h2', {}, [group.label]), group.desc ? el('div', { class: 'hint', text: group.desc }) : null]);
    for (const field of group.fields) {
      // 值为 undefined 时回落到 schema 默认值：读路径写错时也不会显示成「空/未勾选」
      const current = valueAt(data.config, field.path);
      card.appendChild(
        renderField(field, current === undefined ? field.default : current, (next) => setValueAt(data.config, field.path, next)),
      );
    }
    panel.appendChild(card);
  }
  showIssues(data.issues || []);
}

function renderField(field, value, onChange) {
  const wrap = el('div', { class: 'field' });
  const labelText = field.label || field.path;
  // 给每个字段标上绝对路径：测试与排障时能一眼看出「这个框写的是哪一项」
  wrap.setAttribute('data-field', field.path);

  if (field.widget === 'boolean') {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(value);
    input.setAttribute('data-field', field.path);
    input.addEventListener('change', () => onChange(input.checked));
    wrap.appendChild(el('label', { class: 'inline' }, [input, labelText]));
    if (field.desc) wrap.appendChild(el('div', { class: 'hint', text: field.desc }));
    return wrap;
  }

  wrap.appendChild(el('label', { text: labelText }));

  if (field.widget === 'enum') {
    const select = el('select');
    for (const option of field.values || []) {
      // 只显示中文名；写回配置的仍是英文枚举（field.valueLabels 由 config/spec.ts 提供）
      const text = (field.valueLabels && field.valueLabels[option]) || option;
      const opt = el('option', { value: option }, [text]);
      if (option === value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => onChange(select.value));
    wrap.appendChild(select);
  } else if (field.widget === 'number') {
    const input = el('input', { type: 'number' });
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    input.step = field.int ? '1' : 'any';
    input.value = value === undefined || value === null ? '' : String(value);
    input.addEventListener('change', () => onChange(input.value === '' ? 0 : Number(input.value)));
    wrap.appendChild(input);
  } else if (field.widget === 'string-list') {
    const area = el('textarea');
    area.value = Array.isArray(value) ? value.join('\n') : '';
    area.addEventListener('change', () =>
      onChange(
        area.value
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );
    wrap.appendChild(area);
    // 不再额外加「一行一个」的小字：字段标题里已经写了（P1 文案规范）
  } else if (field.widget === 'object') {
    const box = el('div', { class: 'item-card' });
    for (const child of field.fields || []) {
      box.appendChild(renderField(child, valueAt(value, child.relPath), (next) => setValueAt(value, child.relPath, next)));
    }
    wrap.appendChild(box);
  } else if (field.widget === 'object-list') {
    wrap.appendChild(renderObjectList(field, Array.isArray(value) ? value : [], onChange));
  } else {
    const input = el('input', { type: 'text' });
    if (field.maxLen) input.maxLength = field.maxLen;
    input.value = value === undefined || value === null ? '' : String(value);
    input.addEventListener('change', () => onChange(input.value));
    wrap.appendChild(input);
  }

  if (field.desc) wrap.appendChild(el('div', { class: 'hint', text: field.desc }));
  if (field.kind === 'string' && field.default !== undefined && field.widget === 'text' && field.path.includes('proxy')) {
    wrap.appendChild(el('div', { class: 'hint', text: '留空 = 跟随系统代理；填 direct = 强制直连' }));
  }
  return wrap;
}

function renderObjectList(field, list, onChange) {
  const box = el('div');
  const fields = (field.item && field.item.fields) || [];
  const defaults = (field.item && field.item.default) || {};

  const draw = () => {
    box.innerHTML = '';
    list.forEach((item, index) => {
      const card = el('div', { class: 'item-card' }, [
        el('div', { class: 'item-head' }, [
          el('strong', { text: `#${index + 1}` }),
          el('button', {
            class: 'danger',
            onClick: () => {
              list.splice(index, 1);
              draw();
              onChange(list);
            },
          }, ['删除']),
        ]),
      ]);
      for (const child of fields) {
        card.appendChild(renderField(child, valueAt(item, child.relPath), (next) => setValueAt(item, child.relPath, next)));
      }
      box.appendChild(card);
    });
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          onClick: () => {
            list.push(JSON.parse(JSON.stringify(defaults)));
            draw();
            onChange(list);
          },
        }, ['添加一项']),
      ]),
    );
  };
  draw();
  return box;
}

/* ---------------- 通知（主界面只露两个渠道 + 发条测试） ---------------- */

/**
 * 面板主界面只露这两个渠道（P0-2）。
 *
 * 为什么：以前把 `file / webhook / command / dm / format / template / sendSummary` 全摆出来，
 * 用户不知道该选哪个，干脆没测。webhook / command 的能力没删，只是折进「高级（一般不用改）」，
 * 默认折叠、展开才渲染（所以页面源码里看不到那几个英文词）。
 */
const NOTIFY_MAIN = [
  { type: 'dm', title: 'B 站私信', desc: '把结果发到你的 B 站私信（最常用）' },
  { type: 'file', title: '本机日志', desc: '写在程序目录的日志里，不打扰你' },
];

function notifyChannelDefaults(type) {
  return {
    type,
    enabled: false,
    path: '',
    url: '',
    format: 'generic',
    template: 'text',
    cmd: '',
    args: '',
    sendSummary: true,
    sendDiary: false,
    sendVideoInfo: false,
  };
}

/** 确保 config.notify 的形状存在（面板第一次打开时 config 可能是旧文件）。 */
function ensureNotifyConfig(config) {
  if (!config.notify || typeof config.notify !== 'object') config.notify = {};
  if (!Array.isArray(config.notify.channels)) config.notify.channels = [];
  if (!config.notify.quietHours || typeof config.notify.quietHours !== 'object') {
    config.notify.quietHours = { enabled: false, start: '23:00', end: '08:00' };
  }
  return config.notify;
}

function ensureNotifyChannel(config, type) {
  const channels = ensureNotifyConfig(config).channels;
  const found = channels.find((item) => item && item.type === type);
  if (found) return found;
  const entry = notifyChannelDefaults(type);
  channels.push(entry);
  return entry;
}

/** 从 /api/config 的元数据里取某个渠道字段的中文说明（不在面板里硬抄一份）。 */
function notifyFieldMeta(key) {
  const groups = (state.config && state.config.groups) || [];
  const group = groups.find((item) => item.key === 'notify');
  const channels = group && (group.fields || []).find((item) => item.path === 'notify.channels');
  const fields = (channels && channels.item && channels.item.fields) || [];
  return fields.find((field) => field.relPath === key) || null;
}

function copyText(text) {
  const fallback = () => {
    // 剪贴板接口被浏览器拒绝时：把例子塞进一个临时输入框并选中，让用户自己按 Ctrl+C
    try {
      const area = el('textarea');
      area.value = text;
      document.body.appendChild(area);
      if (typeof area.select === 'function') area.select();
      if (typeof document.execCommand === 'function') document.execCommand('copy');
      area.remove();
      toast('已复制');
    } catch {
      toast(`复制不了，手动抄一下：${text}`, true);
    }
  };
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => toast('已复制'), fallback);
    return;
  }
  fallback();
}

async function testNotifyChannel(type, box) {
  if (box) box.textContent = '正在发一条测试…（最多等十几秒）';
  try {
    const res = await api('/api/notify/test', { method: 'POST', body: { channel: type } });
    const text = res.message || (res.ok ? '发出去了' : '没发出去');
    if (box) box.textContent = text;
    toast(text, !res.ok);
  } catch (err) {
    const text = String(err.message || err);
    if (box) box.textContent = text;
    toast(text, true);
  }
}

function renderNotifyChannel(config, spec) {
  const current = () => {
    const channels = ensureNotifyConfig(config).channels;
    return channels.find((item) => item && item.type === spec.type) || null;
  };
  const tag = el('span', { class: 'tag' });
  const refresh = () => {
    const entry = current();
    const on = Boolean(entry && entry.enabled);
    tag.textContent = on ? '已打开' : '关着';
    tag.className = on ? 'tag on' : 'tag';
  };
  refresh();

  const card = el('div', { class: 'sub-card' }, [
    el('div', { class: 'row' }, [el('b', { text: spec.title }), tag]),
    el('div', { class: 'hint', text: spec.desc }),
  ]);
  card.setAttribute('data-channel', spec.type);

  const box = el('input', { type: 'checkbox' });
  box.checked = Boolean(current() && current().enabled);
  box.setAttribute('data-field', `notify.channels.${spec.type}.enabled`);
  box.addEventListener('change', () => {
    const entry = box.checked ? ensureNotifyChannel(config, spec.type) : current();
    if (entry) entry.enabled = box.checked;
    refresh();
  });
  card.appendChild(el('label', { class: 'inline' }, [box, '开着']));

  if (spec.type === 'dm') {
    const extras = el('div', { class: 'sub-fields' }, [el('div', { class: 'hint', text: '私信里发什么（上面「开着」才有效）：' })]);
    for (const [key, text] of [
      ['sendSummary', '发本轮摘要'],
      ['sendDiary', '发今天的公开日记'],
      ['sendVideoInfo', '发视频信息块'],
    ]) {
      const input = el('input', { type: 'checkbox' });
      const entry = current();
      input.checked = entry ? Boolean(entry[key]) : key === 'sendSummary';
      input.setAttribute('data-field', `notify.channels.dm.${key}`);
      input.addEventListener('change', () => {
        ensureNotifyChannel(config, 'dm')[key] = input.checked;
      });
      extras.appendChild(el('label', { class: 'inline' }, [input, text]));
    }
    card.appendChild(extras);
  }

  const result = el('div', { class: 'hint test-result', text: '' });
  card.appendChild(
    el('div', { class: 'actions' }, [el('button', { onClick: () => testNotifyChannel(spec.type, result) }, ['发条测试'])]),
  );
  card.appendChild(result);
  return card;
}

function renderAdvancedField(config, type, key, fallback) {
  const meta = notifyFieldMeta(key) || {};
  const wrap = el('div', { class: 'field' });
  wrap.setAttribute('data-field', `notify.channels.${type}.${key}`);
  wrap.appendChild(el('label', { text: meta.label || fallback.label }));
  const entry = () => ensureNotifyChannel(config, type);

  if (meta.widget === 'enum') {
    const select = el('select');
    for (const value of meta.values || []) {
      const text = (meta.valueLabels && meta.valueLabels[value]) || value;
      const opt = el('option', { value }, [text]);
      if ((entry()[key] || meta.default) === value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      entry()[key] = select.value;
    });
    wrap.appendChild(select);
  } else {
    const input = el('input', { type: 'text' });
    input.value = String(entry()[key] || meta.default || '');
    input.addEventListener('change', () => {
      entry()[key] = input.value;
    });
    wrap.appendChild(input);
  }

  const hint = meta.desc || fallback.hint;
  if (hint) wrap.appendChild(el('div', { class: 'hint', text: hint }));
  if (fallback.example) {
    wrap.appendChild(
      el('div', { class: 'example' }, [
        el('code', { text: fallback.example }),
        el('button', { class: 'mini', onClick: () => copyText(fallback.example) }, ['复制']),
      ]),
    );
  }
  return wrap;
}

function renderAdvancedChannel(config, spec) {
  const current = () => ensureNotifyChannel(config, spec.type);
  const card = el('div', { class: 'sub-card' }, [
    el('div', { class: 'row' }, [el('b', { text: spec.title })]),
    el('div', { class: 'hint', text: spec.desc }),
  ]);
  card.setAttribute('data-channel', spec.type);

  const box = el('input', { type: 'checkbox' });
  box.checked = Boolean(current().enabled);
  box.setAttribute('data-field', `notify.channels.${spec.type}.enabled`);
  box.addEventListener('change', () => {
    current().enabled = box.checked;
  });
  card.appendChild(el('label', { class: 'inline' }, [box, '开着']));
  for (const field of spec.fields) card.appendChild(renderAdvancedField(config, spec.type, field.key, field));

  const result = el('div', { class: 'hint test-result', text: '' });
  card.appendChild(
    el('div', { class: 'actions' }, [el('button', { onClick: () => testNotifyChannel(spec.type, result) }, ['发条测试'])]),
  );
  card.appendChild(result);
  return card;
}

function renderNotifyAdvanced(config) {
  const details = el('details', { class: 'sub-card advanced' });
  const summary = el('summary', {}, ['高级（一般不用改）']);
  details.appendChild(summary);
  const examples = (state.config && state.config.examples) || {};
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    details.appendChild(
      el('div', {
        class: 'hint',
        text: '这两个给会折腾的人用：填错不会有提示，不确定就留在上面的「本机日志」。能力没删，只是默认收起来。',
      }),
    );
    details.appendChild(
      renderAdvancedChannel(config, {
        type: 'webhook',
        title: '自定义地址推送',
        desc: '把一段 JSON 推到你自己搭的地址（飞书 / 钉钉 / 企微群机器人、自建服务都行）。',
        fields: [
          {
            key: 'url',
            label: '地址',
            hint: '机器人给你的那条完整链接，整条粘进来',
            example: examples.webhookUrl || '',
          },
          { key: 'format', label: '对方是哪家服务', hint: '不确定就选「通用」：只发一个 text 字段' },
          { key: 'template', label: '消息格式', hint: '纯文本最稳；富文本要对方支持' },
        ],
      }),
    );
    details.appendChild(
      renderAdvancedChannel(config, {
        type: 'command',
        title: '本地命令',
        desc: '跑完一轮后执行一个本机程序，消息放在环境变量里传给它。',
        fields: [
          {
            key: 'cmd',
            label: '要执行的命令',
            hint: '程序名或完整路径；不走 shell',
            example: examples.command || '',
          },
          {
            key: 'args',
            label: '命令参数',
            hint: '空格分隔；消息内容不放在这里，程序从环境变量 BILIWHALE_NOTIFY_TEXT 读',
            example: examples.commandArgs || '',
          },
        ],
      }),
    );
  };
  details.addEventListener('toggle', build);
  summary.addEventListener('click', build);
  return details;
}

function renderNotifyCard(group, data) {
  ensureNotifyConfig(data.config);
  const card = el('div', { class: 'card' }, [
    el('h2', {}, [group.label || '通知']),
    el('div', {
      class: 'hint',
      text: '跑完一轮之后，结果发到哪里。只开你要的那个就行；拿不准就点「发条测试」，它会立刻试一次（现在就去试，不用等下一轮）。',
    }),
  ]);
  for (const spec of NOTIFY_MAIN) card.appendChild(renderNotifyChannel(data.config, spec));

  // 静默时段：不是渠道，但有话直说（只在日志里记）
  const quietField = (group.fields || []).find((item) => item.path === 'notify.quietHours');
  if (quietField) {
    const quiet = el('div', { class: 'sub-card' }, [el('b', { text: '夜里别吵我' })]);
    const value = valueAt(data.config, 'notify.quietHours');
    // 组里的 desc 由 renderField 自己带出来，这里不再重复一遍
    quiet.appendChild(
      renderField(quietField, value === undefined ? quietField.default : value, (next) => setValueAt(data.config, 'notify.quietHours', next)),
    );
    card.appendChild(quiet);
  }

  card.appendChild(renderNotifyAdvanced(data.config));
  return card;
}

/* ---------------- 挑中的视频（发动态入口按它列） ---------------- */

function pickedItems(data) {
  return (data && Array.isArray(data.items) ? data.items : []).filter((item) => item && item.bvid);
}

/** 「发动态…」按钮交给外面（概览与报告页各有一处）。 */
function renderDynamicButton(item, label = '发动态…') {
  return el('button', { class: 'mini', onClick: () => openDynamicDialog(dynamicDraft(item)) }, [label]);
}

function dynamicDraft(item) {
  const head = item.oneliner || item.title || '';
  const lines = [head];
  if (item.oneliner && item.title) lines.push(`《${item.title}》`);
  // 视频地址由服务端给出（面板不许自己拼外部地址：离线可用 + 不变式测试）
  if (item.url) lines.push(item.url);
  return lines.filter((line) => String(line || '').trim().length > 0).join('\n');
}

function openDynamicDialog(defaultText) {
  const area = el('textarea', { rows: '7' });
  area.value = defaultText;
  const status = el('div', { class: 'hint', text: '' });
  const mask = el('div', { class: 'modal-mask' });
  const dryHint =
    state.status && state.status.safety && state.status.safety.dryRun
      ? el('div', { class: 'issue warn', text: '现在是一律预演：点「确认发出去」也只会打印，不会真的发。' })
      : null;
  const card = el('div', { class: 'modal' }, [
    el('h3', {}, ['发一条动态']),
    el('div', {
      class: 'hint',
      text: '发出去只能整条删掉，改不了。文案可以直接改；不想要哪一行就删掉。',
    }),
    dryHint,
    area,
    status,
    el('div', { class: 'actions' }, [
      el('button', { class: 'primary', onClick: () => sendDynamic(area.value, status, mask) }, ['确认发出去']),
      el('button', { onClick: () => mask.remove() }, ['算了']),
    ]),
  ]);
  mask.appendChild(card);
  document.body.appendChild(mask);
  return mask;
}

async function sendDynamic(text, statusBox, mask) {
  const clean = String(text || '').trim();
  if (!clean) {
    toast('文案是空的：先写一句再发', true);
    return;
  }
  if (statusBox) statusBox.textContent = '正在发…';
  try {
    const res = await api('/api/dynamic', { method: 'POST', body: { text: clean, confirm: true } });
    const message = res.message || (res.ok ? '发出去了' : '没发出去');
    toast(message, !res.ok);
    if (statusBox) statusBox.textContent = message;
    if (res.ok) mask.remove();
  } catch (err) {
    const message = String(err.message || err);
    if (statusBox) statusBox.textContent = message;
    toast(message, true);
  }
}

/* ---------------- 删自己的评论（账本旁，输入「删除」才可点） ---------------- */

function renderDeleteComment(bvid, rpid) {
  const box = el('div', { class: 'inline' }, [
    el('button', { class: 'mini danger', onClick: () => box.appendChild(buildDeleteConfirm(bvid, rpid)) }, ['删除…']),
  ]);
  return box;
}

function buildDeleteConfirm(bvid, rpid) {
  const input = el('input', { type: 'text', placeholder: '输入「删除」两个字' });
  const confirm = el('button', { class: 'danger' }, ['确认删除']);
  confirm.disabled = true;
  input.addEventListener('input', () => {
    confirm.disabled = input.value.trim() !== '删除';
  });
  confirm.addEventListener('click', () => {
    if (input.value.trim() !== '删除') return;
    deleteCommentNow(bvid, rpid);
  });
  return el('div', { class: 'confirm-delete' }, [
    el('div', { class: 'hint', text: `删掉自己在 ${bvid} 下的这条评论？（B 站那边会真的消失，不能撤回）` }),
    input,
    confirm,
  ]);
}

async function deleteCommentNow(bvid, rpid) {
  try {
    const res = await api(`/api/comments/${encodeURIComponent(bvid)}/${encodeURIComponent(rpid)}`, { method: 'DELETE' });
    toast(res.message || (res.ok ? '已删除' : '没删'), !res.ok);
    await renderPending();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

function valueAt(root, path) {
  if (root === undefined || root === null) return undefined;
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), root);
}

function setValueAt(root, path, value) {
  const keys = path.split('.');
  let cursor = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

/** DeepSeek key：只写不读——已经配置时只显示指纹，永远不回显原值。 */
function renderKeyCard(secrets) {
  const status =
    secrets.source === 'env'
      ? '环境变量 BILIWHALE_API_KEY 正在生效（面板里存的不生效）'
      : secrets.hasApiKey
        ? `已配置：${secrets.fingerprint}`
        : '还没配 key：没有它跑不了任何一轮（预演也要真调模型）';
  const input = el('input', { type: 'password', placeholder: 'sk-…（只保存在本机 secrets.json）' });
  const card = el('div', { class: 'card' }, [
    el('h2', {}, ['DeepSeek key']),
    el('div', { class: secrets.hasApiKey ? 'hint' : 'issue warn', text: status }),
    el('div', { class: 'hint', text: '拿 key：platform.deepseek.com → API keys。填进来点保存会立刻验证并列出可用模型。' }),
    el('label', { text: secrets.hasApiKey ? '换一个 key（留空不动）' : '粘贴 key' }),
    input,
    el('div', { class: 'actions' }, [
      el('button', { class: 'primary', onClick: () => saveKey(input.value) }, ['保存并验证']),
      el('button', { onClick: () => renderSettings() }, ['刷新状态']),
    ]),
    el('div', { id: 'key-result', class: 'hint', text: '' }),
  ]);
  return card;
}

async function saveKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    toast('先把 key 粘进来', true);
    return;
  }
  const box = $('#key-result');
  if (box) box.textContent = '正在验证…';
  try {
    const res = await api('/api/secrets/llm', { method: 'PUT', body: { apiKey } });
    const models = Array.isArray(res.models) && res.models.length > 0 ? `（${res.models.join(', ')}）` : '';
    toast(`${res.message}${models}`, !res.ok);
    if (box) box.textContent = `${res.message}${models}`;
    if (res.ok) await renderSettings();
  } catch (err) {
    toast(String(err.message || err), true);
    if (box) box.textContent = String(err.message || err);
  }
}

function showIssues(issues) {
  const box = $('#settings-issues');
  if (!box) return;
  box.innerHTML = '';
  if (!issues || issues.length === 0) {
    box.appendChild(el('div', { class: 'issue info', text: '配置没有发现问题' }));
    return;
  }
  for (const issue of issues) {
    box.appendChild(el('div', { class: `issue ${issue.severity || 'info'}`, text: `${issue.path || '(根)'}：${issue.message}` }));
  }
}

async function saveConfig() {
  try {
    const res = await api('/api/config', { method: 'PUT', body: state.config.config });
    showIssues(res.issues || []);
    toast(res.message || (res.ok ? '已保存' : '没保存'), !res.ok);
    if (res.ok) await renderSettings();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}
async function validateCurrent() {
  try {
    const res = await api('/api/config/validate', { method: 'POST', body: state.config.config });
    showIssues(res.issues || []);
    toast(res.ok ? '校验通过' : '校验没通过', !res.ok);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

function exportConfig() {
  const url = `/api/config/export?token=${encodeURIComponent(state.token)}`;
  const a = el('a', { href: url, download: 'biliwhale-config.json' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function importConfig() {
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await api('/api/config/import', { method: 'POST', body: { config: parsed } });
      toast(res.message || '已导入', !res.ok);
      showIssues(res.issues || []);
      if (res.ok) await renderSettings();
    } catch (err) {
      toast(`导入失败：${err.message || err}`, true);
    }
  });
  input.click();
}

async function resetConfig() {
  if (!confirm('恢复默认配置？凭据（cookie / API key）不会被清掉。')) return;
  try {
    const res = await api('/api/config/reset', { method: 'POST' });
    toast(res.message || '已恢复默认', !res.ok);
    await renderSettings();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

/* ---------------- 账号 ---------------- */

async function renderAccount() {
  const panel = $('#panel-account');
  panel.innerHTML = '<h1>账号</h1><div class="card">读取中…</div>';
  const account = await api('/api/account');

  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['账号']));
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [el('span', {}, ['登录态（鲸鲸）']), el('span', {}, [account.loggedIn ? `已登录：${account.name || '未知'}` : '未登录'])]),
      el('div', { class: 'row' }, [el('span', {}, ['登录账号 UID']), el('span', { class: 'mono' }, [account.mid ? String(account.mid) : '—'])]),
      el('div', { class: 'row' }, [el('span', {}, ['本地凭据']), el('span', { class: 'mono' }, [account.fingerprint || '—'])]),
      el('div', { class: 'hint', text: account.note || '' }),
      el('div', { class: 'actions' }, [
        el('button', { class: 'primary', onClick: () => startQr() }, ['生成二维码']),
        el('button', { onClick: () => recheck() }, ['重新验证']),
        el('button', { class: 'danger', onClick: () => logout() }, ['退出登录']),
      ]),
    ]),
  );

  // 主人（你）：和登录账号必须是两个号；@、私信、聊天都发给它
  const owner = account.owner || {};
  const ownerCard = el('div', { class: 'card' }, [
    el('h3', {}, ['主人（你）']),
    el('div', {
      class: 'hint',
      text: '这是你自己的 B 站号，不是「鲸鲸」。评论里 @ 谁、私信发给谁、聊天只回谁，都看这里。必须是另一个 UID。',
    }),
    el('div', { class: 'row' }, [
      el('span', {}, ['当前']),
      el('span', { class: owner.ok && owner.name ? '' : 'warn-text' }, [owner.text || '还没填']),
    ]),
    ...(owner.problem ? [el('div', { class: 'hint warn-text', text: owner.problem })] : []),
  ]);
  const ownerMidInput = el('input', { type: 'number', placeholder: '你的 UID（数字）', value: account.ownerMidInput || (owner.mid ? String(owner.mid) : '') });
  const ownerNameInput = el('input', { type: 'text', placeholder: '昵称（@ 用，可留空自动取）', value: owner.name || '' });
  ownerCard.appendChild(
    el('div', { class: 'field' }, [el('label', {}, ['主人 UID']), ownerMidInput]),
  );
  ownerCard.appendChild(
    el('div', { class: 'field' }, [el('label', {}, ['主人昵称']), ownerNameInput]),
  );
  ownerCard.appendChild(
    el('div', { class: 'actions' }, [
      el('button', { class: 'primary', onClick: () => saveOwner(ownerMidInput.value, ownerNameInput.value) }, ['保存主人']),
      el('button', { onClick: () => lookupOwner(ownerMidInput.value) }, ['按 UID 自动取昵称']),
    ]),
  );
  panel.appendChild(ownerCard);

  const qrCard = el('div', { class: 'card', id: 'qr-card' }, [
    el('h3', {}, ['二维码']),
    el('div', { class: 'hint', text: '用手机 B 站 App 扫这个码；页面每 2 秒查一次状态。' }),
    el('div', { class: 'qr-empty', id: 'qr-box', text: '正在生成二维码…' }),
    el('div', { class: 'hint', id: 'qr-state', text: '' }),
  ]);
  panel.appendChild(qrCard);

  const cookieCard = el('details', { class: 'card' }, [
    el('summary', {}, ['或者粘贴 cookie（不想扫码时）']),
    el('div', { class: 'hint', text: '至少要有 SESSDATA；写操作还需要 bili_jct（32 位十六进制）。粘贴的内容只会存到本机。' }),
  ]);
  const area = el('textarea', { placeholder: 'SESSDATA=...; bili_jct=...; buvid3=...' });
  cookieCard.appendChild(area);
  cookieCard.appendChild(
    el('div', { class: 'actions' }, [el('button', { class: 'primary', onClick: () => saveCookie(area.value) }, ['保存并验证'])]),
  );
  panel.appendChild(cookieCard);

  // 没登录就直接把二维码画出来，不用先点按钮（点了没反应的按钮是最糟的体验）
  if (!account.loggedIn) await startQr();
}

async function startQr() {
  const box = $('#qr-box');
  const stateBox = $('#qr-state');
  box.innerHTML = '生成中…';
  try {
    const data = await api('/api/account/qr', { method: 'POST' });
    if (!data.ok) {
      box.textContent = data.message || '生成失败';
      return;
    }
    box.className = 'qr';
    box.innerHTML = rowsToSvg(data.rows || []);
    stateBox.textContent = '等待扫码…';
    state.qr.key = data.key;
    stopQrPolling();
    state.qr.timer = setInterval(pollQr, 2000);
  } catch (err) {
    box.textContent = String(err.message || err);
  }
}

function stopQrPolling() {
  if (state.qr.timer) clearInterval(state.qr.timer);
  state.qr.timer = null;
}

async function pollQr() {
  if (!state.qr.key) return;
  try {
    const data = await api(`/api/account/qr/poll?key=${encodeURIComponent(state.qr.key)}`);
    const box = $('#qr-state');
    if (!data.ok) {
      box.textContent = data.message || '查询失败';
      return;
    }
    box.textContent = data.message || data.state;
    if (data.state === 'confirmed') {
      stopQrPolling();
      toast(data.message || '登录成功');
      await renderAccount();
    } else if (data.state === 'expired' || data.state === 'error') {
      stopQrPolling();
    }
  } catch (err) {
    const box = $('#qr-state');
    if (box) box.textContent = String(err.message || err);
    stopQrPolling();
  }
}

async function saveCookie(raw) {
  try {
    const res = await api('/api/account/cookie', { method: 'POST', body: { cookie: raw } });
    const warns = (res.warnings || []).join('；');
    toast(`${res.message || '已保存'}${warns ? `（${warns}）` : ''}`, !res.ok);
    if (res.ok) await renderAccount();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function recheck() {
  try {
    const res = await api('/api/account/verify', { method: 'POST' });
    toast(res.message || (res.loggedIn ? '登录有效' : '登录已失效'), !res.loggedIn);
    await renderAccount();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function logout() {
  if (!confirm('退出登录？只清本机的 cookie，浏览器里的登录不受影响。')) return;
  try {
    const res = await api('/api/account/logout', { method: 'POST' });
    toast(res.message || '已退出');
    await renderAccount();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

/** 保存主人（UID + 昵称）；自己就是登录账号的话服务端会拒绝。 */
async function saveOwner(midRaw, nameRaw) {
  const mid = Number(midRaw);
  if (!Number.isFinite(mid) || mid <= 0) return toast('先填主人 UID（数字）', true);
  try {
    const res = await api('/api/config', {
      method: 'PUT',
      body: { account: { ownerMid: mid, ownerName: String(nameRaw || '').trim() } },
    });
    if (!res.ok) return toast(res.message || '保存失败', true);
    toast('主人已保存');
    await renderAccount();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

/** 按 UID 自动取昵称（B 站名片接口）；取不到就让用户手填。 */
async function lookupOwner(midRaw) {
  const mid = Number(midRaw);
  if (!Number.isFinite(mid) || mid <= 0) return toast('先填主人 UID', true);
  try {
    const res = await api('/api/account/owner', { method: 'POST', body: { mid } });
    toast(res.message || (res.ok ? '已取到昵称' : '没取到昵称'));
    if (res.ok) await renderAccount();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

/* ---------------- 报告 ---------------- */

async function renderReports() {
  const panel = $('#panel-reports');
  panel.innerHTML = '<h1>报告</h1><div class="card">读取中…</div>';
  const data = await api('/api/reports');
  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['报告']));

  if (!data.items || data.items.length === 0) {
    panel.appendChild(el('div', { class: 'card', text: '还没有报告：跑一轮就会写一份。' }));
    return;
  }

  const list = el('div', { class: 'list' });
  const preview = el('pre', { class: 'md', id: 'report-preview', text: '选一天看内容' });
  for (const item of data.items) {
    list.appendChild(
      el('div', { class: 'item', onClick: () => openReport(item.date, list.lastChild) }, [
        el('span', { class: 'mono', text: item.date }),
        el('span', { text: `${Math.round(item.size / 1024)} KB` }),
      ]),
    );
  }
  panel.appendChild(el('div', { class: 'card' }, [list]));
  panel.appendChild(preview);
  panel.appendChild(el('div', { class: 'card', id: 'report-picked' }));
  await openReport(data.items[0].date);
}

async function openReport(date) {
  const doc = await api(`/api/reports/${encodeURIComponent(date)}`);
  const preview = $('#report-preview');
  if (preview) preview.innerHTML = renderMarkdown(doc.markdown);

  // 报告里挑中的视频：在内容后面给「发动态…」小入口（P0-3：报告页对应记录旁）
  const box = $('#report-picked');
  if (!box) return;
  box.innerHTML = '';
  const picked = await api(`/api/picked?date=${encodeURIComponent(date)}`).catch(() => null);
  const items = pickedItems(picked);
  box.appendChild(el('div', { class: 'hint', text: items.length > 0 ? '这一份报告里挑中的视频（想发动态就直接点）：' : '这一份报告里没有挑中的视频。' }));
  for (const item of items) {
    box.appendChild(
      el('div', { class: 'picked-row' }, [
        el('div', {}, [el('div', { text: item.title || item.bvid }), el('div', { class: 'mono hint', text: item.bvid })]),
        renderDynamicButton(item),
      ]),
    );
  }
}

/* ---------------- 日记 ---------------- */

async function renderDiaries() {
  const panel = $('#panel-diaries');
  panel.innerHTML = '<h1>日记</h1><div class="card">读取中…</div>';
  const data = await api(`/api/diaries?kind=${state.diaryKind}${state.diaryQuery ? `&q=${encodeURIComponent(state.diaryQuery)}` : ''}`);
  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['日记']));
  panel.appendChild(
    el('div', { class: 'actions' }, [
      el('button', { class: state.diaryKind === 'public' ? 'primary' : '', onClick: () => { state.diaryKind = 'public'; renderDiaries(); } }, ['给你看的']),
      el('button', { class: state.diaryKind === 'private' ? 'primary' : '', onClick: () => { state.diaryKind = 'private'; renderDiaries(); } }, ['给自己看的']),
    ]),
  );

  const search = el('input', { type: 'text', placeholder: '搜日记内容（回车）' });
  search.value = state.diaryQuery;
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    state.diaryQuery = search.value.trim();
    renderDiaries();
  });
  panel.appendChild(el('div', { class: 'card' }, [search, el('div', { class: 'hint', text: '回车搜索；清空后回车恢复全部' })]));

  if (!data.items || data.items.length === 0) {
    panel.appendChild(el('div', { class: 'card', text: state.diaryQuery ? `没有日记提到「${state.diaryQuery}」` : '这本还是空的。' }));
    return;
  }

  const list = el('div', { class: 'list' });
  for (const item of data.items) {
    list.appendChild(
      el('div', { class: 'item', onClick: () => openDiary(item.date) }, [
        el('span', { class: 'mono', text: item.date }),
        el('span', { text: item.hits ? `${item.hits} 处命中` : `${item.size} B` }),
      ]),
    );
  }
  panel.appendChild(el('div', { class: 'card' }, [list]));
  panel.appendChild(el('pre', { class: 'md', id: 'diary-preview', text: '' }));
  await openDiary(data.items[0].date);
}

async function openDiary(date) {
  const doc = await api(`/api/diaries/${state.diaryKind}/${encodeURIComponent(date)}`);
  const preview = $('#diary-preview');
  if (preview) preview.innerHTML = renderMarkdown(doc.markdown);
}

/* ---------------- 待审 ---------------- */

async function renderPending() {
  const panel = $('#panel-pending');
  panel.innerHTML = '<h1>待审</h1><div class="card">读取中…</div>';
  const data = await api('/api/pending');

  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['待审']));
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'hint', text: '陌生人回了我们的评论。发不发由你定；批准后才会真的发出去，并发完复核。' }),
      el('div', { class: 'actions' }, [
        el('button', { onClick: () => scanPending() }, ['扫描新回复']),
        el('button', { onClick: () => renderPending() }, ['刷新']),
      ]),
      el('div', { id: 'scan-result' }),
    ]),
  );

  if (!data.items || data.items.length === 0) {
    panel.appendChild(el('div', { class: 'card', text: '没有待审的回复。' }));
  } else {
    for (const item of data.items) {
      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'row' }, [
            el('span', {}, ['谁']),
            el('span', {}, [`${item.target.uname}（${item.target.mid}）${item.timesReplied > 1 ? ` · 第 ${item.timesReplied} 次回我们` : ''}`]),
          ]),
          el('div', { class: 'row' }, [el('span', {}, ['视频']), el('span', { class: 'mono' }, [item.bvid])]),
          el('div', { class: 'row' }, [el('span', {}, ['他说的']), el('span', {}, [item.sourceComment])]),
          el('div', { class: 'hint', text: `拟回复（${Array.from(item.draft).length} 字）` }),
          el('pre', { class: 'md', text: item.draft }),
          el('div', { class: 'hint', text: `创建于 ${new Date(item.createdAt).toLocaleString()}${item.expiresAt ? ` · 过期于 ${new Date(item.expiresAt).toLocaleString()}` : ''}` }),
          el('div', { class: 'actions' }, [
            el('button', { class: 'primary', onClick: () => approvePending(item.id, false) }, ['发']),
            el('button', { onClick: () => approvePending(item.id, true) }, ['预演一下']),
            el('button', { class: 'danger', onClick: () => rejectPending(item.id) }, ['不发']),
          ]),
        ]),
      );
    }
  }

  if (data.recent && data.recent.length > 0) {
    const card = el('div', { class: 'card' }, [
      el('h3', {}, ['我们最近发过的评论（扫描只认这些）']),
      el('div', { class: 'hint', text: '如果你刚发的评论不在这里，说明它不是程序发的（预演/手打的不算），或者账本还没写入。' }),
    ]);
    const table = el('table');
    table.appendChild(
      el('tr', {}, [
        el('th', {}, ['什么时候']),
        el('th', {}, ['视频']),
        el('th', {}, ['评论 rpid']),
        el('th', {}, ['状态']),
        el('th', {}, ['操作']),
      ]),
    );
    for (const row of data.recent.slice().reverse()) {
      const action = el('td');
      if (row.rpid) action.appendChild(renderDeleteComment(row.bvid, row.rpid));
      else action.appendChild(el('span', { class: 'hint', text: '（没记录 rpid）' }));
      table.appendChild(
        el('tr', {}, [
          el('td', { class: 'mono' }, [row.at ? new Date(row.at).toLocaleString() : '—']),
          el('td', { class: 'mono' }, [row.bvid]),
          el('td', { class: 'mono' }, [row.rpid || '（没记录）']),
          el('td', {}, [row.status + (row.aid ? '' : ' · 缺 aid')]),
          action,
        ]),
      );
    }
    card.appendChild(table);
    panel.appendChild(card);
  }

  if (data.history && data.history.length > 0) {
    const card = el('div', { class: 'card' }, [el('h3', {}, ['处理过的'])]);
    const table = el('table');
    table.appendChild(el('tr', {}, [el('th', {}, ['时间']), el('th', {}, ['谁']), el('th', {}, ['结果'])]));
    for (const row of data.history.slice().reverse()) {
      table.appendChild(
        el('tr', {}, [
          el('td', { class: 'mono' }, [row.decidedAt ? new Date(row.decidedAt).toLocaleString() : '—']),
          el('td', {}, [row.uname]),
          el('td', {}, [`${row.status}${row.note ? `（${row.note}）` : ''}`]),
        ]),
      );
    }
    card.appendChild(table);
    panel.appendChild(card);
  }
}

async function approvePending(id, dryRun) {
  try {
    const res = await api(`/api/pending/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { dryRun } });
    toast(res.message || (res.ok ? '已处理' : '没处理'), !res.ok);
    await renderPending();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function rejectPending(id) {
  const reason = prompt('不发这条？可以写一句理由（记下来当偏好信号，可留空）');
  if (reason === null) return;
  try {
    const res = await api(`/api/pending/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason } });
    toast(res.message || '已拒绝', !res.ok);
    await renderPending();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function scanPending() {
  const box = $('#scan-result');
  if (box) box.innerHTML = '扫描中…（会读我们最近 7 天发过的评论）';
  try {
    const res = await api('/api/pending/scan', { method: 'POST' });
    const created = Array.isArray(res.created) ? res.created.length : 0;
    const details = Array.isArray(res.details) ? res.details : [];
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];
    toast(created > 0 ? `新生成 ${created} 条待审` : '没有新的陌生人回复（下面有原因）');
    if (box) {
      box.innerHTML = '';
      box.appendChild(
        el('div', {
          class: created > 0 ? 'issue info' : 'issue warn',
          text: `我们最近的评论 ${res.considered ?? 0} 条，读了 ${res.scanned ?? 0} 条的回复，新增待审 ${created} 条`,
        }),
      );
      for (const item of details) {
        box.appendChild(
          el('div', { class: 'issue info', text: `${item.bvid} · 评论 #${item.root} · 回复 ${item.replies} 条（别人 ${item.strangers} 条）· ${item.note}` }),
        );
      }
      for (const line of skipped) box.appendChild(el('div', { class: 'issue warn', text: line }));
    }
    await renderPending();
  } catch (err) {
    toast(String(err.message || err), true);
    if (box) box.textContent = String(err.message || err);
  }
}

/* ---------------- 私聊 ---------------- */

async function renderDm() {
  const panel = $('#panel-dm');
  panel.innerHTML = '<h1>私聊</h1><div class="card">读取中…</div>';
  const [status, chat] = await Promise.all([api('/api/dm'), api('/api/dm/chat?limit=100')]);

  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['私聊']));
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [el('span', {}, ['监听私信']), el('span', {}, [status.enabled ? '开' : '关（设置 → 监听与回复）'])]),
      el('div', { class: 'row' }, [el('span', {}, ['聊天']), el('span', {}, [status.chat ? '开' : '关'])]),
      el('div', { class: 'row' }, [el('span', {}, ['发给谁（主人）']), el('span', { class: 'mono' }, [status.receiver ? String(status.receiver) : '（还没填主人 UID）'])]),
      ...(status.ownerOk === false ? [el('div', { class: 'hint warn-text', text: status.ownerProblem || '主人没配好：去「账号」页填主人 UID（必须是另一个号）' })] : []),
      el('div', { class: 'row' }, [
        el('span', {}, ['通知推送']),
        el('span', {}, [status.notifyEnabled ? `开（摘要${status.sendSummary ? '✓' : '✗'} 日记${status.sendDiary ? '✓' : '✗'} 视频${status.sendVideoInfo ? '✓' : '✗'}）` : '关']),
      ]),
      el('div', { class: 'row' }, [el('span', {}, ['最近一小时']), el('span', {}, [`发了 ${status.sentLastHour} 条（上限 ${status.maxPerHour}）`])]),
      el('div', { class: 'hint', text: '聊天只认主人：陌生人的私信不回、不记账。它只聊天，不能改设置、跑一轮、发评论或给别人发私信。' }),
    ]),
  );

  const sendCard = el('div', { class: 'card' }, [
    el('h3', {}, ['手动发一条']),
    el('div', { class: 'inline' }, [
      el('button', { onClick: () => dmSend({ kind: 'diary' }) }, ['发今天的公开日记']),
      el('button', { onClick: () => dmSend({ kind: 'video_info' }) }, ['发今天的视频信息']),
      el('button', { class: 'danger', onClick: () => dmClear() }, ['清空聊天记录']),
    ]),
    el('div', { class: 'hint', text: '「发视频信息」只发今天报告里出现过的 BV；不认识的一律说没有。' }),
  ]);
  const input = el('input', { type: 'text', placeholder: '发一条测试消息（回车发送）' });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim()) dmSend({ text: input.value.trim() });
  });
  sendCard.appendChild(input);
  panel.appendChild(sendCard);

  const hist = el('div', { class: 'card' }, [el('h3', {}, [`聊天记录（${chat.total} 条）`])]);
  const list = el('div', { class: 'list' });
  for (const line of chat.items || []) {
    list.appendChild(
      el('div', { class: 'item' }, [
        el('span', { class: 'mono' }, [`${line.from === 'owner' ? '主人' : '我'} · ${new Date(line.at).toLocaleString()}`]),
        el('span', {}, [line.text.slice(0, 120)]),
      ]),
    );
  }
  if (!chat.items || chat.items.length === 0) list.appendChild(el('div', { class: 'item' }, [el('span', {}, ['还没有聊过'])]));
  hist.appendChild(list);
  panel.appendChild(hist);
}

async function dmSend(body) {
  try {
    const payload = { ...body };
    if (body.kind === 'video_info') {
      const reports = await api('/api/reports');
      const latest = reports.items && reports.items[0];
      if (!latest) {
        toast('今天还没有报告，没有视频信息可发', true);
        return;
      }
      const doc = await api(`/api/reports/${encodeURIComponent(latest.date)}`);
      const match = /(BV[0-9A-Za-z]{10})/.exec(doc.markdown);
      if (!match) {
        toast('今天的报告里没有挑中的视频', true);
        return;
      }
      payload.bvid = match[1];
    }
    const res = await api('/api/dm/send', { method: 'POST', body: payload });
    toast(res.message || (res.ok ? '已发送' : '没发出去'), !res.ok);
    await renderDm();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function dmClear() {
  if (!confirm('清空聊天记录？（只删本机的记录，B 站那边不动）')) return;
  try {
    const res = await api('/api/dm/chat/clear', { method: 'POST' });
    toast(res.message || '已清空');
    await renderDm();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

/* ---------------- 日志 ---------------- */

async function renderLogs() {
  const panel = $('#panel-logs');
  panel.innerHTML = '<h1>日志</h1><div class="card">读取中…</div>';
  const data = await api('/api/logs?limit=300');

  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['日志']));
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'inline' }, [
        el('label', { text: '级别' }),
        (() => {
          const select = el('select');
          for (const level of ['all', 'info', 'warn', 'error']) {
            const opt = el('option', { value: level }, [level]);
            if (level === state.logLevel) opt.selected = true;
            select.appendChild(opt);
          }
          select.addEventListener('change', () => {
            state.logLevel = select.value;
            renderLogs();
          });
          return select;
        })(),
        el('button', { onClick: downloadDiag }, ['下载诊断包（脱敏）']),
      ]),
    ]),
  );

  const table = el('table');
  table.appendChild(el('tr', {}, [el('th', {}, ['时间']), el('th', {}, ['级别']), el('th', {}, ['来源']), el('th', {}, ['内容'])]));
  const rows = (data.events || []).filter((event) => state.logLevel === 'all' || event.level === state.logLevel);
  for (const event of rows.slice().reverse()) {
    table.appendChild(
      el('tr', {}, [
        el('td', { class: 'mono' }, [new Date(event.at).toLocaleString()]),
        el('td', {}, [event.level]),
        el('td', { class: 'mono' }, [event.target || '']),
        el('td', {}, [event.note]),
      ]),
    );
  }
  panel.appendChild(el('div', { class: 'card' }, [table]));
}

function downloadDiag() {
  const a = el('a', { href: `/api/diag?token=${encodeURIComponent(state.token)}`, download: 'biliwhale-diag.json' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------- 关于 ---------------- */

async function renderAbout() {
  const panel = $('#panel-about');
  const [status, models, doctor] = await Promise.all([api('/api/status'), api('/api/models'), api('/api/doctor').catch(() => null)]);
  const dataDir = doctor && doctor.report ? doctor.report.dataDir : '（体检没跑成）';
  panel.innerHTML = '';
  panel.appendChild(el('h1', {}, ['关于']));
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [el('span', {}, ['版本']), el('span', { class: 'mono' }, [state.version || '—'])]),
      el('div', { class: 'row' }, [el('span', {}, ['数据目录']), el('span', { class: 'mono' }, [dataDir])]),
      el('div', { class: 'row' }, [el('span', {}, ['模型']), el('span', {}, [`${models.actual}${models.configured !== models.actual ? `（配置里是 ${models.configured}）` : ''}`])]),
      el('div', { class: 'row' }, [el('span', {}, ['许可证']), el('span', {}, ['MIT'])]),
      el('div', { class: 'hint', text: '一切都在本机：面板只绑 127.0.0.1，数据在 %APPDATA%\\BiliWhale，日志在 %LOCALAPPDATA%\\BiliWhale。' }),
      el('div', { class: 'hint', text: '参考项目：dsh-bili-whale（产品形态）、dsh-bili-scroll（工程克制）；详见仓库 NOTICE。' }),
    ]),
  );
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('h3', {}, ['今日预算']),
      el('div', { class: 'row' }, [el('span', {}, ['token']), el('span', { class: 'mono' }, [String(models.budget ? models.budget.tokens : 0)])]),
      el('div', { class: 'row' }, [el('span', {}, ['调用次数']), el('span', { class: 'mono' }, [String(models.budget ? models.budget.calls : 0)])]),
      el('div', { class: 'row' }, [el('span', {}, ['健康检查']), el('span', {}, [status.lastRun ? `最近一轮 ${status.lastRun.status}` : '还没跑过'])]),
    ]),
  );
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('h3', {}, ['更新与备份']),
      el('div', { class: 'hint', text: '检查更新只看一眼有没有新版（不自动下载、不自动安装）；备份会把数据打成一个 zip。' }),
      el('div', { class: 'actions' }, [
        el('button', { onClick: () => checkUpdateUi() }, ['检查更新']),
        el('button', { onClick: () => backupNow() }, ['备份数据']),
      ]),
      el('div', { id: 'about-update', class: 'hint', text: '' }),
      el('div', { id: 'about-backup', class: 'hint', text: '' }),
    ]),
  );
  panel.appendChild(
    el('div', { class: 'card' }, [
      el('h3', {}, ['快速操作']),
      el('div', { class: 'actions' }, [
        el('button', { onClick: downloadDiag }, ['下载诊断包']),
        el('button', { class: 'danger', onClick: shutdownKernel }, ['退出内核']),
      ]),
    ]),
  );
}

async function checkUpdateUi() {
  const box = $('#about-update');
  if (box) box.textContent = '检查中…';
  try {
    const res = await api('/api/update/check');
    const info = res.result || {};
    if (info.error) {
      if (box) box.textContent = info.error;
      toast(info.error, true);
      return;
    }
    const text = info.hasUpdate
      ? `当前 ${info.current} → 最新 ${info.latest}${info.url ? `（下载：${info.url}）` : ''}${info.notes ? ` · ${info.notes}` : ''}`
      : `已是最新（${info.current}${info.latest ? `，远端 ${info.latest}` : ''}）`;
    if (box) box.textContent = text;
    toast(info.hasUpdate ? '有新版本，看下面的地址' : '已是最新');
  } catch (err) {
    if (box) box.textContent = String(err.message || err);
    toast(String(err.message || err), true);
  }
}

async function backupNow() {
  const box = $('#about-backup');
  if (box) box.textContent = '备份中…';
  try {
    const res = await api('/api/backup', { method: 'POST' });
    const text = res.ok ? `${res.message} → ${res.file}` : res.message;
    if (box) box.textContent = text;
    toast(res.ok ? '备份完成' : res.message, !res.ok);
  } catch (err) {
    if (box) box.textContent = String(err.message || err);
    toast(String(err.message || err), true);
  }
}

async function shutdownKernel() {
  if (!confirm('退出内核？之后到点不会自动跑了，托盘会显示「内核没在跑」。')) return;
  try {
    await api('/api/shutdown', { method: 'POST' });
    toast('内核正在退出');
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

/* ---------------- 路由 ---------------- */

const routes = {
  overview: renderOverview,
  settings: renderSettings,
  account: renderAccount,
  reports: renderReports,
  diaries: renderDiaries,
  pending: renderPending,
  dm: renderDm,
  logs: renderLogs,
  about: renderAbout,
};

async function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  const render = routes[name] || routes.overview;
  for (const tab of document.querySelectorAll('#tabs a')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) panel.classList.remove('active');
  const target = $(`#panel-${routes[name] ? name : 'overview'}`);
  if (target) target.classList.add('active');
  try {
    await render();
    setPill('已连接', 'ok');
  } catch (err) {
    setPill('连接失败', 'bad');
    const panel = target;
    if (panel) panel.innerHTML = `<h1>出错了</h1><div class="card issue error">${escapeHtml(String(err.message || err))}</div>`;
  }
}

function setPill(text, kind) {
  const pill = $('#pill');
  pill.textContent = text;
  pill.className = `pill ${kind || ''}`;
}

/** 跳到某个页签（概览里的「去账号页」用它）。 */
function goto(name) {
  location.hash = `#/${name}`;
  void route();
}

async function boot() {
  initToken();
  // 没 token 也行：内核种下的会话 cookie 就是凭据（浏览器自动带）
  try {
    await loadSession();
  } catch (err) {
    setPill('没连上', 'bad');
    $('#main').innerHTML = `<div class="card issue error">${escapeHtml(String(err.message || err))}<br><br>如果是从托盘「打开面板」进来的，可能是内核刚重启过：关掉这个页面，再从托盘点一次。</div>`;
    return;
  }
  setPill('已连接', 'ok');
  window.addEventListener('hashchange', () => {
    stopQrPolling();
    route();
  });
  await route();

  // 概览页每 5 秒自己刷新一下（只刷状态，不打断输入）
  setInterval(() => {
    const active = document.querySelector('.panel.active');
    if (active && active.id === 'panel-overview' && !document.querySelector('#panel-overview input:focus')) {
      renderOverview({ doctor: false }).catch(() => undefined);
    }
  }, 5000);
}

boot();
