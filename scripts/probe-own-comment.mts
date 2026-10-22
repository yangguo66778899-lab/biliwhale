// 只读：用新的 findOwnComment 复核已有的三条评论，确认能区分「挂起」与「没发出去」。
import fs from 'node:fs';
import path from 'node:path';

import { createBili } from '../src/bili/api.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from '../test/helpers.ts';

const dataDir = path.join(process.env.APPDATA ?? '', 'BiliWhale');
const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')) as { bili?: { cookie?: string } };
const dir = tmpDir('probe-own');
const logger = new Logger({ logDir: dir, eventsFile: path.join(dir, 'e.jsonl'), level: 'error' });
const { api } = createBili({ cookie: secrets.bili?.cookie ?? '', logger, readIntervalMs: 1200 });

const cases = [
  { bvid: 'BV1Vwn76tEtq', rpid: '321476589712' },
  { bvid: 'BV1gEny6hE5k', rpid: '317785549457' },
  { bvid: 'BV1Cfni6cELz', rpid: '321468492896' },
  { bvid: 'BV1Vwn76tEtq', rpid: '999999999999' }, // 反例：不存在的 rpid
];

for (const item of cases) {
  const video = await api.video(item.bvid);
  if (!video.ok) {
    console.log(`${item.bvid}: 取视频失败 ${video.error.message}`);
    continue;
  }
  const res = await api.findOwnComment(video.data.aid, item.rpid);
  console.log(
    `${item.bvid} rpid=${item.rpid} →`,
    res.ok ? JSON.stringify({ found: res.data.found, visible: res.data.visible, state: res.data.state ?? null, note: res.data.note ?? null }) : `失败 ${res.error.message}`,
  );
}
