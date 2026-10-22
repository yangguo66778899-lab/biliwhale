/**
 * 极简状态页（M1 的「打开面板」）。
 *
 * 职责：让人在浏览器里看到「在不在跑、下一次什么时候、最近一轮、今天花了多少」，并能点几个按钮。
 *   M2 会换成正式面板（设置/账号/报告/日记/待审/日志），这里刻意只保留最小可用的东西。
 * 不做什么：不引 CDN、不引框架、不存任何凭据（token 从 URL 传进来，只用于同源请求）。
 */

export const STATUS_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BiliWhale __VERSION__</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; max-width: 780px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .muted { opacity: .65; font-size: 13px; }
  .card { border: 1px solid rgba(127,127,127,.30); border-radius: 10px; padding: 14px 16px; margin: 14px 0; }
  .row { display: flex; gap: 10px; justify-content: space-between; padding: 3px 0; }
  .row span:first-child { opacity: .65; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(127,127,127,.45); background: transparent; cursor: pointer; }
  button:hover { background: rgba(127,127,127,.12); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,.45); font-size: 12px; }
  #toast { min-height: 22px; font-size: 13px; }
  ul { margin: 6px 0 0; padding-left: 18px; font-size: 13px; }
</style>
</head>
<body>
  <h1>BiliWhale</h1>
  <div class="muted">内核版本 __VERSION__ · 本页面只在本机可访问</div>

  <div class="card" id="overview">
    <div class="row"><span>状态</span><span id="state">读取中…</span></div>
    <div class="row"><span>作息</span><span id="plan">—</span></div>
    <div class="row"><span>下一次</span><span id="next">—</span></div>
    <div class="row"><span>最近一轮</span><span id="lastrun">—</span></div>
    <div class="row"><span>今日额度</span><span id="quota">—</span></div>
    <div class="row"><span>今日花费</span><span id="budget">—</span></div>
    <div class="row"><span>账号</span><span id="account">—</span></div>
    <div class="row"><span>模型</span><span id="model">—</span></div>
    <div class="actions">
      <button id="run">现在跑一轮</button>
      <button id="pause">暂停</button>
      <button id="resume">恢复</button>
      <button id="autostart">开机自启</button>
    </div>
    <div id="toast" class="muted"></div>
  </div>

  <div class="card">
    <div class="muted">最近事件</div>
    <ul id="events"></ul>
  </div>

<script>
const TOKEN = "__TOKEN__";
const headers = { authorization: "Bearer " + TOKEN };
const $ = (id) => document.getElementById(id);

function toast(text) { $("toast").textContent = text || ""; }
function fmtAgo(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!isFinite(t)) return iso;
  const diff = Math.round((Date.now() - t) / 1000);
  if (diff < 60) return diff + " 秒前";
  if (diff < 3600) return Math.round(diff / 60) + " 分钟前";
  return Math.round(diff / 3600) + " 小时前";
}
function fmtNext(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!isFinite(t)) return iso;
  const mins = Math.round((t - Date.now()) / 60000);
  const d = new Date(t);
  const hhmm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return hhmm + (mins >= 0 ? "（约 " + mins + " 分钟后）" : "（已过）");
}

async function refresh() {
  try {
    const res = await fetch("/api/status", { headers });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    $("state").textContent = data.scheduler.paused ? "已暂停" : "运行中";
    $("plan").textContent = data.scheduler.plan || "—";
    $("next").textContent = data.scheduler.paused ? "暂停中" : fmtNext(data.scheduler.nextWakeAt);
    $("lastrun").textContent = data.lastRun ? data.lastRun.status + " · " + fmtAgo(data.lastRun.endedAt) + " · " + data.lastRun.tokens + " token" : "还没跑过";
    $("quota").textContent = data.today.shares + " / " + data.today.shareCap + " 条";
    $("budget").textContent = data.today.tokens + " token" + (data.today.costCny > 0 ? " · ¥" + data.today.costCny : "");
    $("account").textContent = data.account.loggedIn ? (data.account.name || "已登录") + (data.account.mid ? "（" + data.account.mid + "）" : "") : "未登录";
    $("model").textContent = (data.model.actual || data.model.configured) + (data.model.discoveredAt ? "（自动发现）" : "");
    $("events").innerHTML = "";
    const logs = await fetch("/api/logs?limit=8", { headers }).then((r) => r.json());
    for (const evt of logs.events || []) {
      const li = document.createElement("li");
      const time = new Date(Date.parse(evt.at)).toLocaleTimeString();
      li.textContent = time + " · " + evt.kind + " · " + evt.note;
      $("events").appendChild(li);
    }
  } catch (err) {
    $("state").textContent = "连不上内核：" + String(err);
  }
}

async function action(path, body) {
  toast("…");
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    toast(data.message || (data.ok ? "完成" : "失败"));
    await refresh();
  } catch (err) {
    toast("失败：" + String(err));
  }
}

$("run").addEventListener("click", () => action("/api/run", { dryRun: true }));
$("pause").addEventListener("click", () => action("/api/pause"));
$("resume").addEventListener("click", () => action("/api/resume"));
$("autostart").addEventListener("click", async () => {
  const current = await fetch("/api/autostart", { headers }).then((r) => r.json());
  await action("/api/autostart", { enabled: !current.enabled });
});

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>
`;
