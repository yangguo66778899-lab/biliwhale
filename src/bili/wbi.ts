/**
 * WBI 签名。
 *
 * 职责：给需要签名的接口（搜索、player/wbi/v2）生成 `wts` + `w_rid`。
 *   算法（B 站前端公开使用的通用算法，参考实现里六个脚本内联的是同一份）：
 *   1. `img_key`/`sub_key` = `nav.data.wbi_img.img_url`/`.sub_url` 的文件名主干，拼成 64 字符；
 *   2. 按 MIXIN_TAB 的 64 个下标重排，拼起来取前 32 位 = mixin；
 *   3. `wts` = 秒级时间戳，并入参数后按默认 ASCII 升序排序；
 *   4. 值先删 `!'()*` 再 encodeURIComponent（key 也 encode）；
 *   5. `w_rid` = md5(query + mixin) 小写 hex，接在最后。
 * 不做什么：不猜密钥、不做缓存（缓存在 api 层）、不发请求。
 */

import crypto from 'node:crypto';

/** 64 个下标的重排表。别动它——动一个字签名就全错。 */
export const MIXIN_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

/** 从 `.../xxx.png` 这类 URL 里取文件名主干（`xxx`）。 */
export function keyFromUrl(url: string): string {
  if (!url) return '';
  const file = url.slice(url.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot >= 0 ? file.slice(0, dot) : file;
}

/** 由 img_url + sub_url 算出 mixin key（32 位）。任一为空 → 空串（调用方据此决定不签名）。 */
export function mixinFromUrls(imgUrl: string, subUrl: string): string {
  return mixinFromKeys(keyFromUrl(imgUrl), keyFromUrl(subUrl));
}

/** 由两个 key 算 mixin（key 已是文件名主干）。 */
export function mixinFromKeys(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  if (raw.length < 64) return '';
  let out = '';
  for (const idx of MIXIN_TAB) out += raw[idx] ?? '';
  return out.slice(0, 32);
}

function clean(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

/** 生成带 `wts` 与 `w_rid` 的 query 字符串（不含 `?`）。 */
export function signedQuery(params: Record<string, string | number | undefined>, mixin: string, wts: number): string {
  const withWts: Record<string, string | number> = { wts };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    withWts[key] = value;
  }
  const query = Object.keys(withWts)
    .sort()
    .map((key) => {
      const raw = String(withWts[key]);
      return `${encodeURIComponent(key)}=${encodeURIComponent(clean(raw))}`;
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** 当前秒级时间戳（签名用；单独抽出来方便测试注入）。 */
export function wbiTimestamp(now: number = Date.now()): number {
  return Math.round(now / 1000);
}
