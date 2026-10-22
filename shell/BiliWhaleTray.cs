// BiliWhale 托盘（M1 最小壳）。
//
// 职责：让内核「看得见、控得住」——状态摘要、打开面板、现在跑一轮、暂停/恢复、
//       开机自启开关、打开数据目录、退出。全部通过 127.0.0.1 的本地控制接口与内核通信，
//       端口与 token 从 runtime.json 读（<local>/runtime.json）。
// 不做什么：不碰业务数据、不读配置、不做任何 B 站请求。内核没起来时可以代劳启动它。
//
// 编译：scripts/build-tray.ps1（用 .NET Framework 自带的 csc.exe，不需要 SDK）
// 注意：csc 4.8 只支持 C# 5，所以这里不用字符串插值 / ?. / nameof。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace BiliWhaleTray
{
    internal sealed class RuntimeInfo
    {
        public int Pid;
        public int Port;
        public string Token;
        public string DataDir;
        public string Url;
    }

    internal sealed class HealthInfo
    {
        public bool Reachable;
        public bool Running;
        public bool Paused;
        public string NextWakeAt;
        public string LastRunStatus;
        public int PendingCount;
        public string LastError;
    }

    internal static class Program
    {
        private const string AppName = "BiliWhale";
        private const int PollMs = 15000;

        private static NotifyIcon icon;
        private static System.Windows.Forms.Timer pollTimer;
        private static MenuItem statusItem;
        private static MenuItem pauseItem;
        private static MenuItem autostartItem;
        private static MenuItem startKernelItem;
        private static MenuItem openPanelItem;
        private static MenuItem runNowItem;

        private static string dataDirArg;
        private static bool autostartMode;
        private static bool selfTest;

        private static string runtimeDirOverride;
        private static RuntimeInfo runtime;
        private static HealthInfo health;

        [STAThread]
        private static void Main(string[] args)
        {
            ParseArgs(args);
            runtime = RuntimeLoader.Load(dataDirArg);

            BuildTray();

            if (selfTest)
            {
                RefreshHealth();
                PrintSelfTest();
                return;
            }

            RefreshHealth();
            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = PollMs;
            pollTimer.Tick += delegate { RefreshHealth(); };
            pollTimer.Start();

            Application.Run();
        }

        private static void ParseArgs(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--autostart")
                {
                    autostartMode = true;
                }
                else if (arg == "--selftest")
                {
                    selfTest = true;
                }
                else if (arg == "--data-dir" && i + 1 < args.Length)
                {
                    dataDirArg = args[i + 1];
                    i++;
                }
                else if (arg == "--runtime-dir" && i + 1 < args.Length)
                {
                    runtimeDirOverride = args[i + 1];
                    i++;
                }
            }
        }

        private static void BuildTray()
        {
            statusItem = new MenuItem("读取状态中…");
            statusItem.Enabled = false;

            startKernelItem = new MenuItem("启动内核", delegate { StartKernel(); });

            openPanelItem = new MenuItem("打开面板", delegate { OpenPanel(); });
            runNowItem = new MenuItem("现在跑一轮", delegate { RunNow(); });
            pauseItem = new MenuItem("暂停自动唤醒", delegate { TogglePause(); });
            autostartItem = new MenuItem("开机自启", delegate { ToggleAutostart(); });

            MenuItem openDataItem = new MenuItem("打开数据目录", delegate { OpenDataDir(); });
            MenuItem exitItem = new MenuItem("退出", delegate { ExitTray(); });

            ContextMenu menu = new ContextMenu(new MenuItem[]
            {
                statusItem,
                startKernelItem,
                new MenuItem("-"),
                openPanelItem,
                runNowItem,
                pauseItem,
                autostartItem,
                new MenuItem("-"),
                openDataItem,
                exitItem,
            });

            icon = new NotifyIcon();
            icon.Icon = SystemIcons.Application;
            icon.Text = AppName;
            icon.ContextMenu = menu;
            icon.Visible = true;
            icon.DoubleClick += delegate { OpenPanel(); };
        }

        /* ---------------- 状态刷新 ---------------- */

        private static void RefreshHealth()
        {
            HealthInfo next = new HealthInfo();
            runtime = RuntimeLoader.Load(dataDirArg);

            if (runtime == null)
            {
                next.Reachable = false;
                next.LastError = "没找到 runtime.json（内核没在跑）";
            }
            else
            {
                string body;
                if (TryRequest("GET", "/api/health", null, out body))
                {
                    next.Reachable = true;
                    Dictionary<string, object> json = Json.Parse(body);
                    next.Running = Json.Bool(json, "running");
                    next.Paused = Json.Bool(json, "paused");
                    next.NextWakeAt = Json.Str(json, "nextWakeAt");
                    next.LastRunStatus = Json.Str(json, "lastRunStatus");
                    next.LastError = Json.Str(json, "lastError");
                    next.PendingCount = ReadPendingCount();
                }
                else
                {
                    next.Reachable = false;
                    next.LastError = "连不上内核（端口 " + runtime.Port + "）";
                }
            }

            health = next;
            ApplyHealthToMenu();
        }

        /// <summary>待审条数：只影响显示，取不到就算 0（不让托盘因为一个计数变红）。</summary>
        private static int ReadPendingCount()
        {
            try
            {
                string body;
                if (!TryRequest("GET", "/api/status", null, out body)) return 0;
                Dictionary<string, object> json = Json.Parse(body);
                object pendingObj;
                if (!json.TryGetValue("pending", out pendingObj)) return 0;
                Dictionary<string, object> pending = pendingObj as Dictionary<string, object>;
                if (pending == null) return 0;
                object countObj;
                if (!pending.TryGetValue("count", out countObj)) return 0;
                if (countObj is double) return (int)(double)countObj;
                if (countObj is int) return (int)countObj;
                if (countObj is long) return (int)(long)countObj;
                return 0;
            }
            catch
            {
                return 0;
            }
        }

        private static void ApplyHealthToMenu()
        {
            bool up = health != null && health.Reachable;
            bool busy = up && health.Running;

            statusItem.Text = BuildStatusText();
            icon.Text = Shorten(BuildStatusText(), 63);

            startKernelItem.Visible = !up;
            openPanelItem.Enabled = up;
            runNowItem.Enabled = up && !busy;
            pauseItem.Enabled = up;
            autostartItem.Enabled = true;
            pauseItem.Text = up && health.Paused ? "恢复自动唤醒" : "暂停自动唤醒";

            icon.Icon = SystemIcons.Application;
        }

        private static string BuildStatusText()
        {
            if (health == null) return "读取状态中…";
            if (!health.Reachable)
            {
                return "内核没在跑" + (health.LastError == null ? "" : "（" + health.LastError + "）");
            }
            string phase = health.Paused ? "已暂停" : (health.Running ? "正在跑一轮" : "待命");
            string next = string.IsNullOrEmpty(health.NextWakeAt) ? "" : " · 下一次 " + TimeText(health.NextWakeAt);
            string last = string.IsNullOrEmpty(health.LastRunStatus) ? "" : " · 上次 " + health.LastRunStatus;
            string err = string.IsNullOrEmpty(health.LastError) ? "" : " · 出错：" + health.LastError;
            string pending = health.PendingCount > 0 ? " · 待审 " + health.PendingCount : "";
            return phase + next + last + pending + err;
        }

        /* ---------------- 动作 ---------------- */

        private static void OpenPanel()
        {
            if (runtime == null || string.IsNullOrEmpty(runtime.Url))
            {
                MessageBox.Show("内核没在跑，先点「启动内核」。", AppName);
                return;
            }
            TryStart(runtime.Url);
        }

        private static void OpenDataDir()
        {
            string dir = runtime != null && !string.IsNullOrEmpty(runtime.DataDir) ? runtime.DataDir : dataDirArg;
            if (string.IsNullOrEmpty(dir))
            {
                dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName);
            }
            if (!Directory.Exists(dir))
            {
                MessageBox.Show("数据目录还不存在：" + dir, AppName);
                return;
            }
            TryStart("explorer.exe", "\"" + dir + "\"");
        }

        private static void RunNow()
        {
            string body;
            if (TryRequest("POST", "/api/run", "{\"dryRun\":true}", out body))
            {
                ShowBalloon("已开始跑一轮", "跑完会写报告与日记");
                RefreshHealth();
            }
            else
            {
                ShowBalloon("没跑起来", "内核没响应，看一眼「打开面板」");
            }
        }

        private static void TogglePause()
        {
            bool paused = health != null && health.Paused;
            string body;
            bool ok = TryRequest("POST", paused ? "/api/resume" : "/api/pause", null, out body);
            ShowBalloon(ok ? (paused ? "已恢复自动唤醒" : "已暂停自动唤醒") : "操作失败", ok ? "" : "内核没响应");
            RefreshHealth();
        }

        private static void ToggleAutostart()
        {
            string body;
            if (!TryRequest("GET", "/api/autostart", null, out body))
            {
                ShowBalloon("读不到自启状态", "内核没响应");
                return;
            }
            Dictionary<string, object> current = Json.Parse(body);
            bool enabled = Json.Bool(current, "enabled");
            string payload = enabled ? "{\"enabled\":false}" : "{\"enabled\":true}";
            if (!TryRequest("POST", "/api/autostart", payload, out body))
            {
                ShowBalloon("改不了自启", "内核没响应");
                return;
            }
            Dictionary<string, object> after = Json.Parse(body);
            bool nowEnabled = Json.Bool(after, "enabled");
            string warning = Json.Str(after, "warning");
            string text = nowEnabled ? "已开启开机自启" : "已关闭开机自启";
            if (!string.IsNullOrEmpty(warning)) text = text + "（" + warning + "）";
            ShowBalloon(text, "");
        }

        private static void StartKernel()
        {
            string command = Environment.GetEnvironmentVariable("BILIWHALE_KERNEL_CMD");
            if (string.IsNullOrEmpty(command))
            {
                string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
                string cli = Path.Combine(root, "src", "cli.ts");
                if (!File.Exists(cli))
                {
                    MessageBox.Show("找不到内核入口：" + cli + "\r\n可以设环境变量 BILIWHALE_KERNEL_CMD 指定启动命令。", AppName);
                    return;
                }
                command = "\"node\" \"" + cli + "\" serve";
                if (!string.IsNullOrEmpty(dataDirArg)) command = command + " --data-dir \"" + dataDirArg + "\"";
            }

            try
            {
                ProcessStartInfo info = new ProcessStartInfo("cmd.exe", "/c start \"\" " + command);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(info);
                ShowBalloon("正在启动内核", "几秒后菜单会变成「待命」");
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动内核失败：" + ex.Message, AppName);
            }
        }

        private static void ExitTray()
        {
            // 先请内核自己优雅退出（它会等当前一轮跑完、落盘、放锁）；连不上就只关托盘。
            if (runtime != null)
            {
                string body;
                TryRequest("POST", "/api/shutdown", null, out body);
            }
            if (icon != null)
            {
                icon.Visible = false;
                icon.Dispose();
            }
            Application.Exit();
        }

        /* ---------------- HTTP ---------------- */

        private static bool TryRequest(string method, string path, string payload, out string body)
        {
            body = null;
            if (runtime == null || runtime.Port <= 0 || string.IsNullOrEmpty(runtime.Token)) return false;

            string url = "http://127.0.0.1:" + runtime.Port + path;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = method;
            request.Timeout = 5000;
            request.ReadWriteTimeout = 5000;
            request.Headers.Add("Authorization", "Bearer " + runtime.Token);
            request.UserAgent = "BiliWhaleTray";

            try
            {
                if (payload != null)
                {
                    byte[] data = Encoding.UTF8.GetBytes(payload);
                    request.ContentType = "application/json";
                    request.ContentLength = data.Length;
                    using (Stream stream = request.GetRequestStream())
                    {
                        stream.Write(data, 0, data.Length);
                    }
                }

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    body = reader.ReadToEnd();
                    return true;
                }
            }
            catch (WebException)
            {
                return false;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void TryStart(string target)
        {
            TryStart(target, null);
        }

        private static void TryStart(string target, string arguments)
        {
            try
            {
                ProcessStartInfo info = arguments == null ? new ProcessStartInfo(target) : new ProcessStartInfo(target, arguments);
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch (Exception ex)
            {
                MessageBox.Show("打不开：" + ex.Message, AppName);
            }
        }

        /* ---------------- 小工具 ---------------- */

        private static void ShowBalloon(string title, string text)
        {
            if (autostartMode && string.IsNullOrEmpty(text)) return; // 自启时不打扰
            try
            {
                icon.ShowBalloonTip(3000, AppName, title + (string.IsNullOrEmpty(text) ? "" : "\r\n" + text), ToolTipIcon.Info);
            }
            catch (Exception)
            {
                // 气泡失败无所谓
            }
        }

        private static string Shorten(string text, int max)
        {
            if (text == null) return "";
            return text.Length <= max ? text : text.Substring(0, max - 1) + "…";
        }

        private static string TimeText(string iso)
        {
            DateTime parsed;
            if (DateTime.TryParse(iso, out parsed))
            {
                TimeSpan diff = parsed - DateTime.Now;
                string clock = parsed.ToString("HH:mm");
                if (diff.TotalMinutes < 0) return clock + "（已过）";
                if (diff.TotalHours < 1) return clock + "（约 " + ((int)diff.TotalMinutes) + " 分钟后）";
                return clock + "（约 " + ((int)diff.TotalHours) + " 小时后）";
            }
            return iso;
        }

        private static void PrintSelfTest()
        {
            // /target:winexe 没有控制台，自检结果同时写一份到 exe 旁边的文件
            StringBuilder report = new StringBuilder();
            report.AppendLine("BiliWhaleTray 自检");
            Console.WriteLine("BiliWhaleTray 自检");
            report.AppendLine("  runtime.json：" + (runtime == null ? "未找到" : "端口 " + runtime.Port + "，数据目录 " + runtime.DataDir));
            report.AppendLine("  菜单项：" + (icon.ContextMenu == null ? 0 : icon.ContextMenu.MenuItems.Count));
            report.AppendLine("  状态文案：" + BuildStatusText());
            if (icon.ContextMenu != null)
            {
                foreach (MenuItem item in icon.ContextMenu.MenuItems)
                {
                    report.AppendLine("    - " + (item.Text == "-" ? "（分隔线）" : item.Text));
                }
            }
            icon.Visible = false;
            icon.Dispose();
            try
            {
                string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tray-selftest.txt");
                File.WriteAllText(path, report.ToString(), Encoding.UTF8);
            }
            catch (Exception)
            {
                // 写不了文件也不影响自检结论
            }
        }
    }

    internal static class RuntimeLoader
    {
        public static RuntimeInfo Load(string dataDir)
        {
            foreach (string candidate in Candidates(dataDir))
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    string text = File.ReadAllText(candidate, Encoding.UTF8);
                    Dictionary<string, object> json = Json.Parse(text);
                    RuntimeInfo info = new RuntimeInfo();
                    info.Port = (int)Json.Num(json, "port");
                    info.Pid = (int)Json.Num(json, "pid");
                    info.Token = Json.Str(json, "token");
                    info.DataDir = Json.Str(json, "dataDir");
                    info.Url = Json.Str(json, "url");
                    if (info.Port > 0 && !string.IsNullOrEmpty(info.Token)) return info;
                }
                catch (Exception)
                {
                    // 坏文件就试下一个候选
                }
            }
            return null;
        }

        private static IEnumerable<string> Candidates(string dataDir)
        {
            if (!string.IsNullOrEmpty(dataDir))
            {
                yield return Path.Combine(dataDir, "local", "runtime.json");
                yield return Path.Combine(dataDir, "runtime.json");
            }
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            yield return Path.Combine(local, "BiliWhale", "runtime.json");
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            yield return Path.Combine(roaming, "BiliWhale", "local", "runtime.json");
        }
    }

    internal static class Json
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        public static Dictionary<string, object> Parse(string text)
        {
            Dictionary<string, object> parsed = Serializer.Deserialize<Dictionary<string, object>>(text);
            return parsed == null ? new Dictionary<string, object>() : parsed;
        }

        public static string Str(Dictionary<string, object> json, string key)
        {
            object value;
            if (json != null && json.TryGetValue(key, out value) && value != null) return value.ToString();
            return null;
        }

        public static bool Bool(Dictionary<string, object> json, string key)
        {
            object value;
            if (json != null && json.TryGetValue(key, out value) && value != null)
            {
                if (value is bool) return (bool)value;
                bool parsed;
                if (bool.TryParse(value.ToString(), out parsed)) return parsed;
            }
            return false;
        }

        public static double Num(Dictionary<string, object> json, string key)
        {
            object value;
            if (json != null && json.TryGetValue(key, out value) && value != null)
            {
                double parsed;
                if (double.TryParse(value.ToString(), out parsed)) return parsed;
            }
            return 0;
        }
    }
}
