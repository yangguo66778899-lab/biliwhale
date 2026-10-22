import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatHhmm, localDate, localIso, localStamp, minuteOfDay, parseHhmm, daysAgoText } from '../src/shared/time.ts';
import { redact, redactDeep, cookieFingerprint } from '../src/shared/redact.ts';
import { classifyBiliCode, classifyHttpStatus } from '../src/shared/errors.ts';

test('parseHhmm 支持 24:00 与单位数小时，拒绝非法值', () => {
  assert.equal(parseHhmm('20:30'), 1230);
  assert.equal(parseHhmm('24:00'), 1440);
  assert.equal(parseHhmm('0:05'), 5);
  assert.equal(parseHhmm('9:00'), 540);
  assert.equal(parseHhmm('24:01'), null);
  assert.equal(parseHhmm('25:00'), null);
  assert.equal(parseHhmm('12:60'), null);
  assert.equal(parseHhmm('abc'), null);
});

test('formatHhmm 与 parseHhmm 互逆（除 1440 折回 0）', () => {
  for (const minutes of [0, 5, 540, 1230, 1439]) {
    const text = formatHhmm(minutes);
    assert.equal(parseHhmm(text), minutes);
  }
  assert.equal(formatHhmm(1440), '00:00');
  assert.equal(formatHhmm(-30), '23:30');
});

test('localDate / localIso / localStamp 形状正确', () => {
  const d = new Date(2026, 9, 21, 20, 30, 5);
  assert.equal(localDate(d), '2026-10-21');
  assert.match(localIso(d), /^2026-10-21T20:30:05[+-]\d{2}:\d{2}$/);
  assert.equal(localStamp(d), '2026-10-21T20-30-05');
  assert.equal(minuteOfDay(d), 1230);
});

test('daysAgoText 说人话', () => {
  const now = new Date(2026, 9, 21, 12, 0, 0);
  assert.equal(daysAgoText(new Date(2026, 9, 21, 10, 0, 0).toISOString(), now), '今天');
  assert.equal(daysAgoText(new Date(2026, 9, 20, 10, 0, 0).toISOString(), now), '昨天');
  assert.equal(daysAgoText(new Date(2026, 9, 18, 10, 0, 0).toISOString(), now), '3 天前');
  assert.equal(daysAgoText('not-a-date', now), '时间未知');
});

test('redact 抹掉 cookie / api key / bearer，且不动普通文字', () => {
  const raw = 'cookie: SESSDATA=abc%2C123; bili_jct=0123456789abcdef0123456789abcdef; buvid3=xyz';
  const masked = redact(raw);
  assert.ok(!masked.includes('abc%2C123'));
  assert.ok(!masked.includes('0123456789abcdef0123456789abcdef'));
  assert.ok(masked.includes('buvid3=xyz'));

  assert.ok(!redact('Authorization: Bearer sk-abcdefghijklmn').includes('sk-abcdefghijklmn'));
  assert.ok(!redact('{"apiKey":"very-secret-value"}').includes('very-secret-value'));
  assert.equal(redact('今天看了一条讲猫的视频'), '今天看了一条讲猫的视频');
});

test('redactDeep 保留结构，只脱敏字符串', () => {
  const out = redactDeep({ a: 'SESSDATA=secret', b: 3, c: ['sk-1234567890'], d: { e: 'ok' } });
  assert.ok(!String(out.a).includes('secret'));
  assert.equal(out.b, 3);
  assert.ok(!String(out.c[0]).includes('sk-1234567890'));
  assert.equal(out.d.e, 'ok');
});

test('cookieFingerprint 只暴露 mid', () => {
  assert.equal(cookieFingerprint('SESSDATA=x; DedeUserID=123456; bili_jct=y'), 'mid:123456');
  assert.equal(cookieFingerprint('SESSDATA=x'), 'mid:未知');
});

test('错误分类：auth / risk / notfound 各自归位', () => {
  assert.equal(classifyBiliCode(-101), 'auth');
  assert.equal(classifyBiliCode(-111), 'auth');
  assert.equal(classifyBiliCode(-352), 'risk');
  assert.equal(classifyBiliCode(12015), 'risk');
  assert.equal(classifyBiliCode(-404), 'notfound');
  assert.equal(classifyBiliCode(21007), 'business');
  assert.equal(classifyHttpStatus(412), 'risk');
  assert.equal(classifyHttpStatus(429), 'rate');
  assert.equal(classifyHttpStatus(503), 'network');
  assert.equal(classifyHttpStatus(403), 'auth');
});
