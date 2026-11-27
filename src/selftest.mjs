/*
 * Copyright (C) 2026 静瑶 (Dwscdv3)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 自测。只覆盖纯数据逻辑，不碰网络。
 *
 * 两部分：
 *   1. store —— JSON 序列化必须逐字节幂等，否则每次同步都会制造假 diff。
 *   2. sync  —— 用假接口喂数据，验证增量断点、id 分配、取消标记、安全阀。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { diffRecords, parse, readRecords, serialize, sortRecords, writeRecords } from './store.mjs';
import { normalizeTags, parseEditorPage, writeLocalBookmark } from './bookmark-edit.mjs';
import { applyRating, findRating, parseRatingTag, stripRating } from './rating.mjs';
import { keepPreviousMeta, syncKind, SyncAbort } from './sync.mjs';
import { RequestPacer } from './pacer.mjs';
import { RateLimiter } from './http.mjs';
import { planTagConversion } from './tag-convert.mjs';
import { normalizeGroups } from '../viewer/tag-groups.mjs';
import { hasUsableMeta, isPlaceholderText } from './placeholder.mjs';
import { compileQuery, matches as matchQuery } from '../viewer/query.mjs';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

const sample = [
  {
    id: 2,
    pid: '120000003',
    type: 'manga',
    title: '标题里带引号 "x"、反斜杠 \\ 和换行\n第二行',
    author: '作者名',
    author_id: '100',
    published: '2024-05-01T12:00:00+09:00',
    pages: 3,
    width: 1200,
    height: 1697,
    tags: ['原创', 'a,b', 'say "hi"'],
    bookmark_tags: ['私藏分类', '10/10'],
    x_restrict: 1,
    ai_type: 0,
    private_bookmark: 'no',
    first_seen: '2026-11-17',
    url: 'https://www.pixiv.net/artworks/120000003',
  },
  {
    id: 1,
    pid: '120000001',
    type: 'illust',
    title: '普通标题',
    author: 'Another',
    author_id: '200',
    published: '2024-01-01T00:00:00+09:00',
    pages: 1,
    tags: [],
    x_restrict: 0,
    private_bookmark: 'yes',
    first_seen: '2026-11-17',
    url: 'https://www.pixiv.net/artworks/120000001',
  },
];

/** 假接口：ids 是服务端收藏列表（index 0 = 最新收藏），按 offset/limit 切片返回。 */
function makeFakeServer(ids) {
  return {
    calls: 0,
    lastVisibility: null,
    async fetchBookmarkPage(kind, offset, { limit, visibility = 'public' }) {
      this.calls += 1;
      this.lastVisibility = visibility;
      const slice = ids.slice(offset, offset + limit);
      return {
        total: ids.length,
        items: slice.map((id) => ({
          item: {
            id: String(id),
            title: `作品 ${id}`,
            userName: '作者',
            userId: '1',
            createDate: '2024-01-01T00:00:00+09:00',
            pageCount: 1,
            tags: ['tag'],
            illustType: 0,
          },
          bookmark: { id: String(id), private: visibility === 'private' },
        })),
      };
    },
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dollery-test-'));
const tempFile = path.join(tempRoot, 'bookmarks.json');

const baseOptions = {
  kind: 'illust',
  visibility: 'public',
  label: '插画',
  filePath: tempFile,
  limit: 20,
  full: false,
  dryRun: false,
  maxPages: 0,
};

console.log('store —— JSON 格式\n');

await test('序列化后再解析，字段完全一致', () => {
  const { records } = parse(serialize(sample));
  assert.equal(records.length, 2);
  const first = records.find((r) => r.pid === '120000003');
  assert.equal(first.title, sample[0].title);
  assert.deepEqual(first.tags, sample[0].tags);
  assert.deepEqual(first.bookmark_tags, sample[0].bookmark_tags);
  assert.equal(first.pages, 3);
  assert.equal(first.id, 2);
});

await test('读写往返是幂等的（不产生假 diff）', () => {
  const once = serialize(sortRecords(sample), { lastSync: '固定值' });
  const twice = serialize(sortRecords(parse(once).records), { lastSync: '固定值' });
  assert.equal(once, twice);
});

await test('标题里的引号、反斜杠、换行都能原样还原', () => {
  const back = parse(serialize(sample)).records.find((r) => r.pid === '120000003');
  assert.equal(back.title, sample[0].title);
});

await test('标签里的逗号和引号原样还原', () => {
  const back = parse(serialize(sample)).records.find((r) => r.pid === '120000003');
  assert.deepEqual(back.tags, ['原创', 'a,b', 'say "hi"']);
});

await test('标签数组内联成一行，不会把文件撑开', () => {
  const text = serialize(sample);
  assert.ok(text.includes('"tags": ["原创", "a,b"'), '标签数组应在一行内');
});

await test('空标签数组不写进文件', () => {
  const text = serialize([{ ...sample[1], tags: [], bookmark_tags: [] }]);
  assert.ok(!text.includes('"tags"'));
  assert.ok(!text.includes('"bookmark_tags"'));
});

await test('_meta 能正确写入与读回', () => {
  const text = serialize(sample, {
    kindLabel: '插画（公开）',
    lastSync: '2026-11-18 00:00:00',
    sourceTotal: 99,
  });
  const { meta } = parse(text);
  assert.equal(meta.kind, '插画（公开）');
  assert.equal(meta.count, 2);
  assert.equal(meta.sourceTotal, 99);
});

await test('按 id 升序排列，最早收藏的排最前', () => {
  assert.deepEqual(
    sortRecords(sample).map((r) => r.id),
    [1, 2],
  );
});

await test('没有 id 的旧记录排在最后，且不打乱有序号的部分', () => {
  const mixed = [
    { pid: '9', id: 5 },
    { pid: '8' },
    { pid: '7', id: 1 },
  ];
  assert.deepEqual(
    sortRecords(mixed).map((r) => r.pid),
    ['7', '9', '8'],
  );
});

await test('差分能识别新增、移除、字段变更', () => {
  const diff = diffRecords(
    [
      { pid: '1', title: 'A' },
      { pid: '2', title: 'B' },
    ],
    [
      { pid: '1', title: 'A改' },
      { pid: '3', title: 'C' },
    ],
  );
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].fields[0].key, 'title');
});

await test('收藏标签变化能被差分捕获', () => {
  const diff = diffRecords(
    [{ pid: '1', bookmark_tags: ['旧分类'] }],
    [{ pid: '1', bookmark_tags: ['新分类'] }],
  );
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].fields[0].key, 'bookmark_tags');
});

await test('没有变化时差分为空', () => {
  const diff = diffRecords(sample, structuredClone(sample));
  assert.equal(diff.added.length + diff.removed.length + diff.changed.length, 0);
});

await test('undefined、空字符串、空数组之间不算字段变更', () => {
  const before = [{ pid: '1', title: 'A', status: undefined, tags: [] }];
  const after = [{ pid: '1', title: 'A', status: '', tags: [] }];
  assert.equal(diffRecords(before, after).changed.length, 0);
});

await test('非法 JSON 给出可定位的报错', () => {
  assert.throws(() => parse('{ 这不是 json ]'), /不是合法的 JSON/);
});

await test('空文件解析为空记录', () => {
  assert.deepEqual(parse('').records, []);
});

console.log('\nsync —— 序号、增量与安全阀\n');

const serverIds = Array.from({ length: 100 }, (_, i) => 200 - i); // 200..101，index 0 最新

await test('首次全量：id 从 1 开始，最旧的作品拿到 1 号', async () => {
  const result = await syncKind(makeFakeServer(serverIds), {
    ...baseOptions,
    filePath: tempFile,
    full: true,
  });
  assert.equal(result.added.length, 100);

  const records = await readRecords(tempFile);
  assert.equal(records.length, 100);

  const oldest = records.find((r) => r.pid === '101');
  const newest = records.find((r) => r.pid === '200');
  assert.equal(Number(oldest.id), 1, '最早的收藏应该是 1 号');
  assert.equal(Number(newest.id), 100, '最新的收藏应该是 100 号');
});

await test('二次增量：连续两页全已知就停止，不发多余请求', async () => {
  const fresh = makeFakeServer(serverIds);
  const result = await syncKind(fresh, { ...baseOptions, filePath: tempFile });
  assert.equal(result.added.length, 0);
  assert.equal(fresh.calls, 2, `应该只请求 2 页，实际 ${fresh.calls} 页`);
  assert.match(result.stoppedReason, /追平/);
});

await test('新增收藏的 id 接续在后面，已有记录序号不变', async () => {
  const withNew = makeFakeServer([300, 299, 298, ...serverIds]);
  const result = await syncKind(withNew, { ...baseOptions, filePath: tempFile });
  assert.equal(result.added.length, 3);

  const records = await readRecords(tempFile);
  assert.equal(records.find((r) => r.pid === '101').id, 1, '最老的仍是 1 号');
  assert.equal(records.find((r) => r.pid === '298').id, 101);
  assert.equal(records.find((r) => r.pid === '300').id, 103, '最新加的是最大序号');
});

await test('已有记录的 first_seen 不会被后续全量同步覆盖', async () => {
  const records = await readRecords(tempFile);
  records.find((r) => r.pid === '200').first_seen = '2020-01-01';
  await writeRecords(tempFile, records, { lastSync: 'test' });

  await syncKind(makeFakeServer([300, 299, 298, ...serverIds]), {
    ...baseOptions,
    filePath: tempFile,
    full: true,
  });

  const after = await readRecords(tempFile);
  assert.equal(after.find((r) => r.pid === '200').first_seen, '2020-01-01');
  assert.equal(after.length, 103);
});

await test('全量发现取消收藏时只打 removed 标记，不删除记录', async () => {
  const shrunk = makeFakeServer([300, 299, 298, ...serverIds.slice(0, 95)]);
  const result = await syncKind(shrunk, { ...baseOptions, filePath: tempFile, full: true });

  assert.equal(result.removed.length, 5, '应报告 5 条新标记');
  assert.equal(result.localAfter, 103, '记录数不该减少');

  const after = await readRecords(tempFile);
  const marked = after.filter((r) => r.removed === 'yes');
  assert.equal(marked.length, 5);
  assert.ok(
    marked.every((r) => r.title && Number(r.id) > 0),
    '被标记的记录原始内容应完整保留',
  );
});

await test('重新收藏会清除 removed 标记，记录数不变', async () => {
  await syncKind(makeFakeServer([300, 299, 298, ...serverIds]), {
    ...baseOptions,
    filePath: tempFile,
    full: true,
  });
  const after = await readRecords(tempFile);
  assert.equal(after.filter((r) => r.removed === 'yes').length, 0);
  assert.equal(after.length, 103);
});

await test('全量遇到结果异常缩水时中止，且不破坏原文件', async () => {
  const before = await readRecords(tempFile);
  const collapsed = makeFakeServer(serverIds.slice(0, 5));

  let aborted = false;
  try {
    await syncKind(collapsed, { ...baseOptions, filePath: tempFile, full: true });
  } catch (err) {
    aborted = err instanceof SyncAbort;
  }

  assert.ok(aborted, '应该抛出 SyncAbort');
  assert.deepEqual(await readRecords(tempFile), before, '原文件必须一字不改');
});

await test('dry-run 不写入文件', async () => {
  const before = await readRecords(tempFile);
  await syncKind(makeFakeServer([300, 299, 298, ...serverIds]), {
    ...baseOptions,
    filePath: tempFile,
    full: true,
    dryRun: true,
  });
  assert.deepEqual(await readRecords(tempFile), before);
});

await test('本地被 --max-pages 截断后，增量能自愈补全而不是误判追平', async () => {
  const partialFile = path.join(tempRoot, 'partial.json');

  await syncKind(makeFakeServer(serverIds), { ...baseOptions, filePath: partialFile, maxPages: 1 });
  assert.equal((await readRecords(partialFile)).length, 20);

  const srv = makeFakeServer(serverIds);
  const result = await syncKind(srv, { ...baseOptions, filePath: partialFile });
  assert.equal(result.localAfter, 100, '应该补齐到 100 条');
  assert.equal(srv.calls, 5, `应该翻 5 页，实际 ${srv.calls} 页`);
});

await test('旧数据缺 id 时拒绝增量同步，全量可完成迁移', async () => {
  const legacyFile = path.join(tempRoot, 'legacy.json');
  await fs.writeFile(
    legacyFile,
    JSON.stringify({ records: [{ pid: '111', title: '旧数据' }] }),
    'utf8',
  );

  let aborted = false;
  try {
    await syncKind(makeFakeServer(serverIds), { ...baseOptions, filePath: legacyFile });
  } catch (err) {
    aborted = err instanceof SyncAbort;
  }
  assert.ok(aborted, '应该拒绝并要求先跑 --full');

  await syncKind(makeFakeServer(serverIds), { ...baseOptions, filePath: legacyFile, full: true });
  const migrated = await readRecords(legacyFile);
  assert.equal(migrated.filter((r) => Number(r.id) > 0).length, migrated.length);
});

await test('私密通道确实以 visibility=private 发起请求', async () => {
  const srv = makeFakeServer(serverIds);
  await syncKind(srv, {
    ...baseOptions,
    filePath: path.join(tempRoot, 'vis.json'),
    visibility: 'private',
  });
  assert.equal(srv.lastVisibility, 'private');
});

console.log('\npacer —— 概率触发的随机休息\n');

// 概率和时长都压到毫秒级：测的是触发 / 计数 / 放行的逻辑，而不是真的等半小时
const fastPacer = (over = {}) =>
  new RequestPacer({
    pauseChance: 1,
    perRequestMs: 1000,
    minPauseMs: 60,
    maxPauseMs: 60,
    shape: 1,
    ...over,
  });

await test('pauseChance=0 时永不休息', async () => {
  const pacer = fastPacer({ pauseChance: 0 });
  const started = Date.now();
  for (let i = 0; i < 10; i += 1) await pacer.gate();
  assert.ok(Date.now() - started < 100, '不该有任何等待');
  assert.equal(pacer.status().paused, false);
  assert.equal(pacer.status().count, 10);
  assert.equal(pacer.status().pauses, 0);
});

await test('命中概率就整队停下，休息完继续', async () => {
  const pacer = fastPacer();
  const started = Date.now();
  await pacer.gate(); // 第一次就命中（pauseChance=1）
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 50, `命中后应该等一段，实际 ${elapsed}ms`);
  assert.equal(pacer.status().paused, false, '休息结束后不该还挂着暂停');
  assert.equal(pacer.status().count, 1, '休息后从 0 重算，这次请求算 1');
  assert.equal(pacer.status().pauses, 1);
});

await test('期望时长随连续请求数线性增长，并被上下限夹住', async () => {
  const pacer = new RequestPacer({
    pauseChance: 0,
    perRequestMs: 5000,
    minPauseMs: 60000,
    maxPauseMs: 5400000,
  });

  for (let i = 0; i < 100; i += 1) await pacer.gate({ bypass: true });
  assert.equal(pacer.status().count, 100);
  assert.equal(pacer.status().expectedPauseMs, 500000, '100 次 × 5 秒');
  assert.equal(pacer.expectedPauseMs(1), 60000, '低于下限时夹到下限');
  assert.equal(pacer.expectedPauseMs(5000), 5400000, '超过上限时夹到上限');
});

await test('连续请求数随时间回落：每 5 秒减 1，最少到 0', async () => {
  const pacer = new RequestPacer({ pauseChance: 0, decayMs: 5000 });
  const t0 = Date.now();
  pacer.count = 10;
  pacer.decayAt = t0;

  assert.equal(pacer.decay(t0 + 4999), 0, '不到 5 秒不该扣');
  assert.equal(pacer.count, 10);
  assert.equal(pacer.decay(t0 + 5000), 1, '满 5 秒扣 1');
  assert.equal(pacer.count, 9);
  assert.equal(pacer.decay(t0 + 26000), 4, '再隔 21 秒累计扣 4（共 5 个周期）');
  assert.equal(pacer.count, 5);
  assert.equal(pacer.decay(t0 + 600000), 5, '最多扣到 0');
  assert.equal(pacer.count, 0);
  assert.equal(pacer.decay(t0 + 900000), 0, '已经是 0 就不再扣');
  assert.equal(pacer.count, 0);
});

await test('status() 报告的是回落之后的计数与期望时长', async () => {
  const pacer = new RequestPacer({
    pauseChance: 0,
    perRequestMs: 5000,
    decayMs: 5000,
    minPauseMs: 60000,
    maxPauseMs: 5400000,
  });
  const t0 = Date.now();
  pacer.count = 100;
  pacer.decayAt = t0;

  const status = pacer.status(t0 + 60000); // 12 个回落周期
  assert.equal(status.count, 88);
  assert.equal(status.expectedPauseMs, 440000, '88 次 × 5 秒');
  assert.equal(pacer.status().limits.decayMs, 5000);
});

await test('空闲很久之后重新开始，不会被补扣', async () => {
  const pacer = new RequestPacer({ pauseChance: 0, decayMs: 5000 });
  pacer.count = 0;
  pacer.decayAt = Date.now() - 600000; // 假装已经空了 10 分钟

  await pacer.gate();
  assert.equal(pacer.status().count, 1, '新一轮从 1 开始，而不是负值或 0');
});

await test('抽样均值贴近期望，且不越界', async () => {
  const pacer = new RequestPacer({
    pauseChance: 0,
    perRequestMs: 1000,
    minPauseMs: 1000,
    maxPauseMs: 600000,
    shape: 2,
  });

  const mean = 120000;
  const rounds = 3000;
  let sum = 0;
  for (let i = 0; i < rounds; i += 1) {
    const ms = pacer.samplePause(mean);
    assert.ok(ms >= 1000 && ms <= 600000, `抽样越界: ${ms}`);
    sum += ms;
  }

  const avg = sum / rounds;
  assert.ok(Math.abs(avg - mean) / mean < 0.1, `均值偏离过大: ${Math.round(avg)}`);
});

await test('skip() 能提前结束休息', async () => {
  const pacer = fastPacer({ minPauseMs: 20000, maxPauseMs: 20000 });
  const started = Date.now();

  const pending = pacer.gate(); // 必定命中，开始 20 秒休息
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pacer.status().paused, true, '这时应该正在休息');

  const result = pacer.skip();
  await pending;

  assert.equal(result.skipped, true);
  assert.ok(Date.now() - started < 2000, '跳过之后不该继续等满 20 秒');
  assert.equal(pacer.status().skips, 1);
});

await test('bypass 照常计数但不想休息', async () => {
  const pacer = fastPacer({ minPauseMs: 20000, maxPauseMs: 20000 });

  const started = Date.now();
  await pacer.gate({ bypass: true });
  await pacer.gate({ bypass: true });
  assert.ok(Date.now() - started < 1000, '手动请求不该被休息卡住');
  assert.equal(pacer.status().paused, false, '手动请求自己不开启休息');
  assert.equal(pacer.status().total, 2);
  assert.equal(pacer.status().count, 2, '手动请求照样计入连续请求数');

  // 下一个后台请求才会真的停下来，且期望时长按 2 次算
  const pending = pacer.gate();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pacer.status().paused, true);
  assert.equal(pacer.status().pauseRequests, 2, '触发时已连续请求 2 次');
  pacer.skip();
  await pending;
});

await test('enabled=false 时完全不介入', async () => {
  const pacer = fastPacer({ enabled: false });
  for (let i = 0; i < 10; i += 1) await pacer.gate();
  assert.equal(pacer.status().paused, false);
  assert.equal(pacer.status().pauses, 0);
});

await test('限速器把休息挡在串行链里，bypass 的那次能穿过去', async () => {
  const pacer = new RequestPacer({
    pauseChance: 1,
    perRequestMs: 0,
    minPauseMs: 150,
    maxPauseMs: 150,
    shape: 1,
  });
  const limiter = new RateLimiter(0, 0, pacer);

  const started = Date.now();
  await limiter.run(async () => {}); // 第一次就命中，休息 150ms
  assert.ok(Date.now() - started >= 120, `应该被休息挡住，实际 ${Date.now() - started}ms`);

  // 手动请求不等：pauseChance=1 本该休息，但 bypassPacer 直接放行
  const manual = Date.now();
  await limiter.run(async () => {}, { bypassPacer: true });
  assert.ok(Date.now() - manual < 100, '手动请求不该被挡住');
});

/* ── 编辑收藏：解析编辑页 + 本地写入 ────────────────────── */

await test('解析旧版编辑页：token、可见性、标签', () => {
  const html =
    '<form method="post" action="bookmark_add.php?id=1">' +
    '<input type="hidden" name="mode" value="add">' +
    '<input type="hidden" name="tt" value="6fb2caff5ce6566c8f5f2afc0660a161">' +
    '<input type="radio" name="restrict" value="0" checked>' +
    '<input type="radio" name="restrict" value="1">' +
    '<input type="text" name="tag" value="Zwei!! 百合" data-limit="10"></form>';

  const page = parseEditorPage(html);
  assert.equal(page.token, '6fb2caff5ce6566c8f5f2afc0660a161');
  assert.equal(page.restrict, 0);
  assert.equal(page.isPrivate, false);
  assert.deepEqual(page.tags, ['Zwei!!', '百合']);

  // 不是编辑页（比如被重定向到登录页）必须返回 null，不能当成「没有标签」
  assert.equal(parseEditorPage('<div>登录</div>'), null);
});

await test('收藏标签整理：去重、过滤默认分类、超限报错', () => {
  const result = normalizeTags([' 原神 ', '风景,原神', '未分類']);
  assert.deepEqual(result.tags, ['原神', '风景']);
  assert.equal(result.error, '');

  const many = normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`));
  assert.ok(many.error.includes('10'), '超过 10 个应当报错，而不是静默截断');
});

await test('编辑落盘：同文件改标签不动 id，跨文件按目标 max+1 编号', async () => {
  const files = {
    illustPublic: path.join(tempRoot, 'edit-illust.json'),
    illustPrivate: path.join(tempRoot, 'edit-illust-private.json'),
    novelPublic: path.join(tempRoot, 'edit-novel.json'),
    novelPrivate: path.join(tempRoot, 'edit-novel-private.json'),
  };
  const meta = { kindLabel: '插画/漫画（公开）', lastSync: '2026-11-01 00:00:00', sourceTotal: 42 };

  await writeRecords(
    files.illustPublic,
    [
      { id: 3, pid: '111', type: 'illust', title: 'A', bookmark_tags: ['旧'], private_bookmark: 'no' },
      { id: 7, pid: '222', type: 'illust', title: 'B', private_bookmark: 'no' },
    ],
    meta,
  );
  await writeRecords(files.illustPrivate, [
    { id: 9, pid: '111', type: 'illust', title: 'A', removed: 'yes', private_bookmark: 'yes', first_seen: '2025-12-01' },
  ]);

  // 同文件：只改标签，id 与 _meta 都不该动
  await writeLocalBookmark({
    files,
    kind: 'illust',
    pid: '111',
    tags: ['新', '标签'],
    isPrivate: false,
    source: 'illustPublic',
  });

  let pub = await readRecords(files.illustPublic);
  assert.equal(pub.find((r) => r.pid === '111').id, 3);
  assert.deepEqual(pub.find((r) => r.pid === '111').bookmark_tags, ['新', '标签']);

  // 跨文件：私密侧还留着这条作品的「已取消」旧记录，应当复活它并沿用 id / first_seen
  const moved = await writeLocalBookmark({
    files,
    kind: 'illust',
    pid: '111',
    tags: ['新'],
    isPrivate: true,
    source: 'illustPublic',
  });

  pub = await readRecords(files.illustPublic);
  const priv = await readRecords(files.illustPrivate);
  const revived = priv.filter((r) => r.pid === '111');

  assert.equal(moved.moved, true);
  assert.equal(moved.source, 'illustPrivate');
  assert.equal(pub.some((r) => r.pid === '111'), false, '来源文件里应当已删除');
  assert.equal(revived.length, 1, '目标文件里不能出现两条同 pid');
  assert.equal(revived[0].id, 9, '应当沿用旧记录的 id');
  assert.equal(revived[0].removed, undefined, '重新收藏后要清掉 removed');
  assert.equal(revived[0].first_seen, '2025-12-01');

  // 再搬回公开：目标里没有记录，编号接在末尾
  const back = await writeLocalBookmark({
    files,
    kind: 'illust',
    pid: '111',
    tags: [],
    isPrivate: false,
    source: 'illustPrivate',
  });
  pub = await readRecords(files.illustPublic);
  const record = pub.find((r) => r.pid === '111');

  assert.equal(back.moved, true);
  assert.equal(record.id, 8, '新 id 应该是目标文件的 max+1');
  assert.equal('bookmark_tags' in record, false, '空标签要把字段删掉');

  const ids = pub.map((r) => Number(r.id));
  assert.equal(new Set(ids).size, ids.length, '同一文件内 id 必须唯一');
});

/* ── 评分标签 ───────────────────────────────────────────── */

await test('识别评分标签：只认 1/10 ~ 10/10', () => {
  assert.equal(parseRatingTag('9/10'), 9);
  assert.equal(parseRatingTag(' 10/10 '), 10);
  assert.equal(parseRatingTag('3 / 10'), 3);

  for (const bad of ['0/10', '11/10', '9/10分', '/10', '10/10/', '風景', '']) {
    assert.equal(parseRatingTag(bad), null, `${bad} 不该被当成评分`);
  }

  assert.deepEqual(findRating(['風景', '7/10']), { value: 7, tag: '7/10', index: 1 });
  assert.equal(findRating(['風景']), null);
});

await test('改评分是「顶替原来那一格」，不是追加到末尾', () => {
  // 位置不变，git diff 里只是同一行的数字变化
  assert.deepEqual(applyRating(['a', 'b', '7/10', 'c'], 9), ['a', 'b', '9/10', 'c']);
  // 原来没有就追加
  assert.deepEqual(applyRating(['a', 'b'], 4), ['a', 'b', '4/10']);
  // 0 表示清除
  assert.deepEqual(applyRating(['a', '7/10'], 0), ['a']);
  // 历史脏数据里的多个评分一起收掉
  assert.deepEqual(applyRating(['5/10', 'a', '6/10'], 8), ['8/10', 'a']);
  assert.deepEqual(stripRating(['5/10', 'a', '6/10']), ['a']);
  // 非法值不能顺手把已有评分抹掉
  assert.deepEqual(applyRating(['a', '7/10'], 11), ['a', '7/10']);
});

await test('标签已满且没有评分时，applyRating 会超到 11 个（由调用方拦下）', () => {
  const full = Array.from({ length: 10 }, (_, i) => `t${i}`);
  assert.equal(applyRating(full, 8).length, 11);

  // 已经有评分时不额外占位：替换后仍是 10 个
  const withRating = [...full.slice(0, 9), '6/10'];
  assert.equal(applyRating(withRating, 9).length, 10);
});

await test('快速通道默认完全不排队，但串行仍然成立', async () => {
  const limiter = new RateLimiter(2000, 0);
  await limiter.run(async () => {});

  let concurrent = 0;
  let maxConcurrent = 0;
  const task = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
  };

  const started = Date.now();
  await Promise.all([limiter.run(task, { fast: true }), limiter.run(task, { fast: true })]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 300, `两次快速请求应该立刻发出去，实际 ${elapsed}ms`);
  assert.equal(maxConcurrent, 1, '快速通道也不能并发，必须一个接一个');
});

await test('快速通道不等后台的长休息', async () => {
  // 后台任务一进去就命中休息（400ms），快速请求不该跟着等
  const pacer = new RequestPacer({ pauseChance: 1, perRequestMs: 0, minPauseMs: 400, maxPauseMs: 400, shape: 1 });
  const limiter = new RateLimiter(0, 0, pacer);

  const background = limiter.run(async () => 'bg');
  await new Promise((resolve) => setTimeout(resolve, 20)); // 让后台真的进到 gate 里

  const started = Date.now();
  const result = await limiter.run(async () => 'fast', { fast: true });
  const elapsed = Date.now() - started;

  assert.equal(result, 'fast');
  assert.ok(elapsed < 150, `快速请求不该等后台的长休息，实际 ${elapsed}ms`);

  // 后台那条还在休息里，等它自己走完
  assert.equal(await background, 'bg');
});

await test('快速通道：手动写操作不用等满普通间隔', async () => {
  const limiter = new RateLimiter(400, 0, null, 60);

  await limiter.run(async () => {}); // 第一个普通请求

  const fastStart = Date.now();
  await limiter.run(async () => {}, { fast: true });
  const fastElapsed = Date.now() - fastStart;
  assert.ok(fastElapsed >= 40 && fastElapsed < 300, `快速通道等了 ${fastElapsed}ms，应该只有几十毫秒`);

  // 快速请求之后，普通请求仍然按完整间隔排队
  const normalStart = Date.now();
  await limiter.run(async () => {});
  const normalElapsed = Date.now() - normalStart;
  assert.ok(normalElapsed >= 380, `普通请求应该等满 400ms，实际 ${normalElapsed}ms`);
});

/* ── 标签组：归一化、搜索展开、批量迁移计划 ─────────────── */

await test('标签组归一化：去重、短组丢弃、跨组冲突', () => {
  const result = normalizeGroups([
    { id: 'g1', tags: ['A', ' a ', 'B'] },
    { id: 'g2', tags: ['b', 'C'] },
    { id: 'g3', tags: ['D'] },
  ]);

  assert.deepEqual(
    result.groups.map((group) => group.tags),
    [['A', 'B']],
  );
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.dropped, 2);
});

await test('标签组 id 自动分配不与已有 id 冲突', () => {
  const result = normalizeGroups([{ tags: ['a', 'b'] }, { id: 'g1', tags: ['c', 'd'] }]);
  assert.deepEqual(
    result.groups.map((group) => group.id),
    ['g2', 'g1'],
  );
});

await test('搜索：命中组员展开成 OR，排除词连整组一起排除', () => {
  const groups = [{ id: 'g1', tags: ['原神', 'Genshin Impact'] }];
  const record = { title: '', author: '', pid: '1', tags: [], bookmark_tags: ['Genshin Impact'] };

  assert.equal(matchQuery(compileQuery('原神', { groups }), record), true);
  assert.equal(matchQuery(compileQuery('genshin impact', { groups }), record), true, '大小写不敏感');
  assert.equal(matchQuery(compileQuery('-原神', { groups }), record), false);
  assert.equal(matchQuery(compileQuery('原神', { groups: [] }), record), false);
});

await test('搜索：不完全相等不展开，字段词不受组影响', () => {
  const groups = [{ id: 'g1', tags: ['原神', 'Genshin Impact'] }];

  // 「原神启动」不是组员本身，不能因为含子串就把整组牵进来
  const titled = { title: '原神启动', author: '', pid: '2', tags: [], bookmark_tags: [] };
  assert.equal(matchQuery(compileQuery('原神启动', { groups }), titled), true);

  const onlyGroup = { title: '', author: '', pid: '3', tags: [], bookmark_tags: ['原神'] };
  // 「Genshin」只是成员「Genshin Impact」的前缀，不该因此把整组牵进来
  assert.equal(matchQuery(compileQuery('Genshin', { groups }), onlyGroup), false);

  assert.equal(matchQuery(compileQuery('type:illust', { groups }), { type: 'illust' }), true);
});

await test('评分筛选：前端拼出来的 (7/10 OR 9/10) 能编译并命中', () => {
  const seven = { title: '', author: '', pid: '1', tags: [], bookmark_tags: ['7/10', 'x'] };
  const nine = { title: '', author: '', pid: '2', tags: [], bookmark_tags: ['9/10'] };
  const eight = { title: '', author: '', pid: '3', tags: [], bookmark_tags: ['8/10'] };

  const multi = compileQuery('(7/10 OR 9/10)');
  assert.equal(matchQuery(multi, seven), true);
  assert.equal(matchQuery(multi, nine), true);
  assert.equal(matchQuery(multi, eight), false, '没选的分不该命中');

  // 单选时前端只发 `7/10`，不带括号
  const single = compileQuery('7/10');
  assert.equal(matchQuery(single, seven), true);
  assert.equal(matchQuery(single, nine), false);
});

await test('占位元数据：一排横杠不算内容', () => {
  assert.equal(isPlaceholderText('-----'), true);
  assert.equal(isPlaceholderText(''), true);
  assert.equal(isPlaceholderText('   '), true);
  assert.equal(isPlaceholderText('——'), true);
  assert.equal(isPlaceholderText('标题'), false);

  // 失效作品真实形态：三处文本都是横杠，只剩自己打的收藏标签有价值
  assert.equal(hasUsableMeta({ title: '-----', description: '-----', author: '-----', bookmark_tags: [] }), false);
  assert.equal(hasUsableMeta({ title: '-----', bookmark_tags: ['R-18'] }), true);
  assert.equal(hasUsableMeta({ title: '-----', tags: ['オリジナル'] }), true);
});

await test('失效分档：占位标题归到「只剩记录」', () => {
  const dash = { pid: '1', status: 'unavailable', title: '-----', description: '-----', author: '-----' };
  const withTags = { pid: '2', status: 'unavailable', title: '-----', bookmark_tags: ['R-18'] };
  const ctx = { hasMedia: () => false, hasMeta: hasUsableMeta };

  assert.equal(matchQuery(compileQuery('is:dead-bare'), dash, ctx), true);
  assert.equal(matchQuery(compileQuery('is:dead-bare'), withTags, ctx), false);
  assert.equal(matchQuery(compileQuery('is:dead-meta'), withTags, ctx), true);
  assert.equal(matchQuery(compileQuery('is:dead-meta'), dash, ctx), false);
});

await test('失效分档：is:dead-* 按「有没有图 / 有没有元数据」区分', () => {
  const withImage = { pid: '1', title: '标题', status: 'unavailable', tags: [], bookmark_tags: [] };
  const withMetaOnly = { pid: '2', title: '标题', status: 'unavailable', tags: [], bookmark_tags: [] };
  const bare = { pid: '3', status: 'unavailable', tags: [], bookmark_tags: [] };
  const ctx = { hasMedia: (record) => record.pid === '1' };

  assert.equal(matchQuery(compileQuery('is:dead-image'), withImage, ctx), true);
  assert.equal(matchQuery(compileQuery('is:dead-image'), withMetaOnly, ctx), false, '没有图不算有图档');

  assert.equal(matchQuery(compileQuery('is:dead-meta'), withMetaOnly, ctx), true);
  assert.equal(matchQuery(compileQuery('is:dead-meta'), bare, ctx), false, '没元数据不算这一档');

  assert.equal(matchQuery(compileQuery('is:dead-bare'), bare, ctx), true);
  assert.equal(matchQuery(compileQuery('is:dead-bare'), withMetaOnly, ctx), false);

  // 默认过滤器靠这两个：有数据的失效作品要留下，没图的才藏
  assert.equal(matchQuery(compileQuery('is:lost'), withMetaOnly, ctx), true);
  assert.equal(matchQuery(compileQuery('is:lost'), withImage, ctx), false);
  assert.equal(matchQuery(compileQuery('-is:lost'), withImage, ctx), true);

  // 没有 ctx 时不能崩，退化成「没有图」
  assert.equal(matchQuery(compileQuery('is:lost'), { pid: '9', status: 'unavailable' }), true);
});

await test('同步：失效作品的占位值不覆盖本地真实元数据', () => {
  const previous = {
    pid: '1',
    title: '真实标题',
    description: '真实简介',
    author: '某作者',
    author_id: '12345',
    published: '2020-05-01T00:00:00+09:00',
    width: 1200,
    height: 1600,
    pages: 3,
    tags: ['オリジナル'],
    bookmark_tags: ['R-18', '好き'],
    status: '',
  };
  const incoming = {
    pid: '1',
    title: '-----',
    description: '-----',
    author: '-----',
    author_id: '0',
    published: '1970-01-01T00:00:00+09:00',
    width: 100,
    height: 100,
    pages: 1,
    tags: [],
    bookmark_tags: [],
    status: 'unavailable',
  };

  const merged = keepPreviousMeta(incoming, previous);
  assert.equal(merged.title, '真实标题');
  assert.equal(merged.description, '真实简介');
  assert.equal(merged.author, '某作者');
  assert.equal(merged.author_id, '12345');
  assert.equal(merged.published, '2020-05-01T00:00:00+09:00');
  assert.equal(merged.width, 1200);
  assert.equal(merged.pages, 3);
  assert.deepEqual(merged.bookmark_tags, ['R-18', '好き']);
  assert.equal(merged.status, 'unavailable', '失效状态本身要保留');

  // 正常作品不受影响：仍然以服务端为准
  const alive = { ...incoming, status: '', title: '新标题' };
  assert.equal(keepPreviousMeta(alive, previous).title, '新标题');
});

await test('迁移计划：只换组内成员，保留其它标签', () => {
  const items = planTagConversion({
    records: [
      { pid: 1, source: 'illustPublic', bookmark_tags: ['B', 'x'] },
      { pid: 2, source: 'illustPublic', bookmark_tags: ['A', 'B', 'x'] },
      { pid: 3, source: 'illustPublic', bookmark_tags: ['A', 'x'] },
      { pid: 4, source: 'illustPrivate', bookmark_tags: ['B'] },
      { pid: 5, source: 'illustPublic', bookmark_tags: [], tags: ['B'] },
      { pid: 6, source: 'illustPublic', bookmark_tags: ['B'], removed: 'yes' },
    ],
    source: 'illustPublic',
    members: ['A', 'B'],
    target: 'A',
  });

  assert.deepEqual(
    items.map((item) => item.pid),
    ['1', '2'],
  );
  assert.deepEqual(items[0].after, ['A', 'x']);
  assert.deepEqual(items[1].after, ['A', 'x']);
  assert.equal(items[0].isPrivate, false);
});

await fs.rm(tempRoot, { recursive: true, force: true });

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`);
