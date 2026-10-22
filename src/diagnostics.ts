/**
 * 诊断包。
 *
 * 职责：把排障需要的东西打成一个 JSON（脱敏后）：版本、系统、路径、配置、体检、状态摘要、
 *   最近几轮 run、事件流尾部、日志尾部、产出文件清单。
 *   CLI/面板都能下载；用户可以把它发回来。
 * 不做什么：不含 cookie、API key、聊天内容；不含日记正文（只列文件名）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDeep } from './shared/redact.ts';
import { localIso } from './shared/time.ts';
import type { AppContext } from './bootstrap.ts';
import type { DoctorReport } from './doctor.ts';
import type { RunRecord } from './shared/types.ts';

export interface DiagBundle {
  generatedAt: string;
  version: string;
  system: {
    platform: string;
    release: string;
    arch: string;
    node: string;
    pid: number;
    cpus: number;
    rssMb: number;
    heapUsedMb: number;
    hostname: string;
    timezone: string;
  };
  paths: { dataDir: string; localDir: string; logsDir: string };
  config: unknown;
  configIssues: Array<{ path: string; message: string; severity: string }>;
  doctor: DoctorReport;
  state: unknown;
  runs: RunRecord[];
  events: unknown[];
  logs: string[];
  files: {
    reports: number;
    diariesPublic: number;
    diariesPrivate: number;
    archive: number;
    runs: number;
  };
  notes: string[];
}

export interface DiagOptions {
  version: string;
  doctor: DoctorReport;
  /** 各尾部保留多少条。 */
  eventLimit?: number;
  logLines?: number;
  runLimit?: number;
}

export async function buildDiagBundle(ctx: AppContext, opts: DiagOptions): Promise<DiagBundle> {
  const eventLimit = opts.eventLimit ?? 300;
  const logLines = opts.logLines ?? 200;
  const runLimit = opts.runLimit ?? 5;

  const bundle: DiagBundle = {
    generatedAt: localIso(),
    version: opts.version,
    system: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      cpus: os.cpus().length,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      hostname: os.hostname(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    paths: { dataDir: ctx.paths.dataDir, localDir: ctx.paths.localDir, logsDir: ctx.paths.logsDir },
    config: ctx.config.exportForUser(),
    configIssues: ctx.config.getIssues().map((issue) => ({ path: issue.path, message: issue.message, severity: issue.severity })),
    doctor: opts.doctor,
    state: summarizeState(ctx),
    runs: ctx.runs.list(runLimit).map(trimRun),
    events: ctx.logger.recentEvents(eventLimit),
    logs: readLogTail(ctx.paths.logsDir, logLines),
    files: countOutputs(ctx),
    notes: [
      '这是诊断包：只含排障信息，已脱敏（不含 cookie / API key / 日记正文）。',
      '日记与报告只统计文件数，不打包内容。',
    ],
  };

  return redactDeep(bundle);
}

export function diagFileName(now: Date = new Date()): string {
  const stamp = localIso(now).slice(0, 19).replace(/[:T]/g, '-');
  return `biliwhale-diag-${stamp}.json`;
}

function summarizeState(ctx: AppContext): unknown {
  const state = ctx.state.get();
  return {
    paused: state.paused,
    pausedAt: state.pausedAt,
    lastRunAt: state.lastRunAt,
    lastRunStatus: state.lastRunStatus,
    budget: state.budget,
    counters: state.counters,
    riskCooldownUntil: state.riskCooldownUntil,
    today: state.today
      ? {
          date: state.today.date,
          action: state.today.action,
          targetWakes: state.today.targetWakes,
          wakes: state.today.wakes,
          done: state.today.done,
          reason: state.today.reason,
          slots: state.today.slots.map((slot) => ({ atText: slot.atText, window: slot.window, kind: slot.kind, fired: slot.fired, missed: slot.missed })),
        }
      : null,
    modelCache: state.modelCache,
  };
}

function trimRun(record: RunRecord): RunRecord {
  return {
    ...record,
    errors: record.errors.slice(0, 20),
    notes: record.notes.slice(0, 20),
  };
}

function readLogTail(logDir: string, lines: number): string[] {
  try {
    const files = fs
      .readdirSync(logDir)
      .filter((name) => name.startsWith('app-') && name.endsWith('.log'))
      .sort();
    const latest = files[files.length - 1];
    if (!latest) return [];
    const text = fs.readFileSync(path.join(logDir, latest), 'utf8');
    return text.split('\n').filter((line) => line.trim().length > 0).slice(-lines);
  } catch {
    return [];
  }
}

function countOutputs(ctx: AppContext): DiagBundle['files'] {
  const count = (dir: string): number => {
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).length;
    } catch {
      return 0;
    }
  };
  return {
    reports: count(ctx.paths.reportsDir),
    diariesPublic: count(ctx.paths.diariesPublicDir),
    diariesPrivate: count(ctx.paths.diariesPrivateDir),
    archive: count(ctx.paths.archiveDir),
    runs: count(ctx.paths.runsDir),
  };
}

