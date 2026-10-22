/**
 * 最小 ZIP 读写（自己实现，零依赖）。
 *
 * 为什么自己写：项目零运行时依赖，而「备份」和「便携包」都要求**一个文件**（用户能拷走、能发给我）。
 *   - 备份用 store（不压缩）：读取逻辑十几行，不会有解压库与 zip-slip 的坑；
 *   - 便携包用 deflate（node.exe 能压到 1/3），Windows 资源管理器直接能打开。
 *
 * 支持：store(0) 与 deflate(8)、UTF-8 文件名、CRC32 校验。
 * 不支持：加密、zip64（>4GB 会报错，本项目不可能）、注释、分卷。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;

export interface ZipEntryInput {
  /** 归档里的路径（用 / 分隔，不允许 .. 或绝对路径）。 */
  name: string;
  data: Buffer | string;
  /** 修改时间（默认现在）。 */
  mtime?: Date;
}

export interface ZipEntry {
  name: string;
  /** 解压后的字节数。 */
  size: number;
  crc32: number;
  data: Buffer;
  mtime: Date;
  /** 存储方式：0 = store，8 = deflate。 */
  method: number;
}

export interface ZipWriteOptions {
  /** 默认 false（store）。 */
  compress?: boolean;
}

/* ---------------- CRC32 ---------------- */

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------------- 写 ---------------- */

/** 打成一个 zip。条目名会做安全校验。 */
export function zipArchive(files: ZipEntryInput[], options: ZipWriteOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = normalizeEntryName(file.name);
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const wantCompress = options.compress === true;
    let stored = raw;
    let method = 0;
    if (wantCompress) {
      const deflated = zlib.deflateRawSync(raw);
      // 压完反而更大就不压（很小的 JSON 常见）
      if (deflated.length < raw.length) {
        stored = deflated;
        method = 8;
      }
    }

    const crc = crc32(raw);
    const { time, date } = dosDateTime(file.mtime ?? new Date());
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + stored.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

/** 只 store（备份用）。 */
export function zipStore(files: ZipEntryInput[]): Buffer {
  return zipArchive(files, { compress: false });
}

/** 写到磁盘（先写临时文件再改名，避免半截文件）。 */
export function writeZipFile(
  file: string,
  files: ZipEntryInput[],
  options: ZipWriteOptions = {},
): { file: string; bytes: number; entries: number } {
  const buffer = zipArchive(files, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
  return { file, bytes: buffer.length, entries: files.length };
}

/* ---------------- 读 ---------------- */

/** 读 zip（store 与 deflate 都行）。任何结构异常都抛错，不猜。 */
export function readZipStore(buffer: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（找不到 EOCD）');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) throw new Error('中央目录损坏');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString((flags & FLAG_UTF8) !== 0 ? 'utf8' : 'latin1');
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式（${method}）`);

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`条目 ${name} 的本地头损坏`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const stored = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(stored) : Buffer.from(stored);
    if (data.length !== size) throw new Error(`条目 ${name} 的长度对不上（${data.length} != ${size}）`);
    if (crc32(data) !== crc) throw new Error(`条目 ${name} 的 CRC 校验失败`);

    entries.push({ name, size, crc32: crc, data, mtime: fromDosDateTime(date, time), method });
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

export function readZipFile(file: string): ZipEntry[] {
  return readZipStore(fs.readFileSync(file));
}

/* ---------------- 文件名安全 ---------------- */

/** 只允许相对路径、正斜杠、无 ..、无盘符；否则抛错（杜绝 zip-slip）。 */
export function normalizeEntryName(name: string): string {
  const raw = String(name).replace(/\\/g, '/').trim();
  if (!raw) throw new Error('zip 条目名不能为空');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error(`zip 条目名不能是绝对路径：${name}`);
  const parts = raw.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) throw new Error(`zip 条目名里不允许 . 或 ..：${name}`);
  return parts.join('/');
}

/* ---------------- DOS 时间 ---------------- */

function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  return { time: time & 0xffff, date: date & 0xffff };
}

function fromDosDateTime(date: number, time: number): Date {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  return new Date(year, month, Math.max(1, day), hours, minutes, seconds);
}
