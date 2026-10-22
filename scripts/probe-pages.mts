// 只读探针：确认 B 站热门/搜索的第 2 页确实带回新的 bvid（匿名请求，不用 cookie）。
import { createBili } from '../src/bili/api.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from '../test/helpers.ts';

const dir = tmpDir('probe-pages');
const logger = new Logger({ logDir: `${dir}/logs`, eventsFile: `${dir}/events.jsonl`, level: 'warn' });
const { api } = createBili({ cookie: '', logger });

const hot1 = await api.popular(20, 1);
const hot2 = await api.popular(20, 2);
const s1 = await api.searchVideos('猫咪', { order: 'pubdate', page: 1 });
const s2 = await api.searchVideos('猫咪', { order: 'pubdate', page: 2 });

function report(name: string, a: { ok: boolean; data?: Array<{ bvid: string }>; error?: unknown }, b: { ok: boolean; data?: Array<{ bvid: string }>; error?: unknown }) {
  if (!a.ok || !b.ok) {
    console.log(`${name}: 取数失败`, JSON.stringify(a.ok ? b.error : a.error));
    return;
  }
  const set1 = new Set((a.data ?? []).map((v) => v.bvid));
  const set2 = new Set((b.data ?? []).map((v) => v.bvid));
  const overlap = [...set2].filter((id) => set1.has(id)).length;
  console.log(`${name}: 第1页 ${set1.size} 条, 第2页 ${set2.size} 条, 重叠 ${overlap} 条, 新增 ${set2.size - overlap} 条`);
  console.log(`   第1页样例: ${[...set1].slice(0, 3).join(', ')}`);
  console.log(`   第2页样例: ${[...set2].slice(0, 3).join(', ')}`);
}

report('热门', hot1, hot2);
report('搜索「猫咪」', s1, s2);
