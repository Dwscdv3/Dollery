/**
 * 自测。只覆盖纯数据逻辑，不碰网络。
 *
 * 两部分：
 *   1. store —— 序列化往返必须逐字节幂等，否则每次同步都会制造假 diff。
 *   2. sync  —— 用假接口喂数据，验证增量断点、合并、以及防清空的安全阀。
 *      这部分特别重要：真实账号只跑一次，跑错了未必立刻发现。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { diffRecords, parse, readRecords, serialize, sortRecords, writeRecords } from './store.mjs';
import { syncKind, SyncAbort } from './sync.mjs';

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
    id: '120000003',
    type: 'manga',
    title: '标题里带冒号: 和反斜杠 \\ 还有引号 "x"',
    author: '作者名',
    author_id: '100',
    account: 'account',
    published: '2024-05-01T12:00:00+09:00',
    pages: 3,
    tags: ['原创', 'a,b', 'say "hi"', 'back\\slash'],
    x_restrict: 1,
    ai_type: 0,
    private_bookmark: 'no',
    first_seen: '2026-11-17',
    url: 'https://www.pixiv.net/artworks/120000003',
  },
  {
    id: '120000001',
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

/** 假接口：把 id 数组当作服务端收藏列表，按 offset/limit 切片返回。 */
function makeFakeServer(ids) {
  return {
    calls: 0,
    async fetchBookmarkPage(kind, offset, { limit }) {
      this.calls += 1;
      const slice = ids.slice(offset, offset + limit);
      return {
        total: ids.length,
        items: slice.map((id) => ({
          item: {
            illustId: String(id),
            illustTitle: `作品 ${id}`,
            userName: '作者',
            userId: '1',
            uploadDate: '2024-01-01T00:00:00+09:00',
            pageCount: 1,
            tags: ['tag'],
            illustType: 0,
          },
          bookmark: { id: String(id), private: false },
        })),
      };
    },
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-export-test-'));
const tempFile = path.join(tempRoot, 'bookmarks.txt');

const baseOptions = {
  kind: 'illust',
  label: '插画',
  filePath: tempFile,
  limit: 20,
  includePrivate: true,
  full: false,
  dryRun: false,
  maxPages: 0,
};

console.log('store —— 纯文本格式\n');

await test('序列化后再解析，字段完全一致', () => {
  const back = parse(serialize(sample));
  assert.equal(back.length, 2);
  const first = back.find((r) => r.id === '120000003');
  assert.equal(first.title, sample[0].title);
  assert.deepEqual(first.tags, sample[0].tags);
  assert.equal(first.pages, 3);
});

await test('读写往返是幂等的（不产生假 diff）', () => {
  const once = serialize(sortRecords(sample), { lastSync: '固定值' });
  const twice = serialize(sortRecords(parse(once)), { lastSync: '固定值' });
  assert.equal(once, twice);
});

await test('标题里的换行不会撑破记录边界', () => {
  const back = parse(serialize([{ ...sample[1], title: '第一行\n第二行\r\n第三行' }]));
  assert.equal(back.length, 1);
  assert.equal(back[0].title, '第一行\n第二行\r\n第三行');
});

await test('标签里的逗号、引号、反斜杠能正确还原', () => {
  const tricky = [{ ...sample[1], tags: ['a,b', 'say "hi"', '普通', '带\\反斜杠'] }];
  assert.deepEqual(parse(serialize(tricky))[0].tags, tricky[0].tags);
});

await test('空标签列表不写 tags 行', () => {
  assert.ok(!serialize([{ ...sample[1], tags: [] }]).includes('tags:'));
});

await test('按 id 降序排列是稳定的', () => {
  assert.deepEqual(
    sortRecords(sample).map((r) => r.id),
    ['120000003', '120000001'],
  );
});

await test('差分能识别新增、移除、字段变更', () => {
  const diff = diffRecords(
    [
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ],
    [
      { id: '1', title: 'A改' },
      { id: '3', title: 'C' },
    ],
  );
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].fields[0].key, 'title');
});

console.log('\nsync —— 增量与安全阀\n');

const serverIds = Array.from({ length: 100 }, (_, i) => 200 - i); // 200..101
const server = makeFakeServer(serverIds);

await test('首次增量：本地为空时翻完整个列表', async () => {
  const result = await syncKind(server, { ...baseOptions, filePath: tempFile });
  assert.equal(result.added.length, 100);
  assert.equal(result.localAfter, 100);
  const onDisk = await readRecords(tempFile);
  assert.equal(onDisk.length, 100);
});

await test('二次增量：连续两页全已知就停止，不发多余请求', async () => {
  const fresh = makeFakeServer(serverIds);
  const result = await syncKind(fresh, { ...baseOptions, filePath: tempFile });
  assert.equal(result.added.length, 0);
  assert.equal(fresh.calls, 2, `应该只请求 2 页，实际 ${fresh.calls} 页`);
  assert.match(result.stoppedReason, /追平/);
});

await test('新增几条后，增量只抓到头部就能追平', async () => {
  const withNew = makeFakeServer([300, 299, 298, 297, 296, ...serverIds]);
  const result = await syncKind(withNew, { ...baseOptions, filePath: tempFile });
  assert.equal(result.added.length, 5);
  assert.equal(result.localAfter, 105);
  assert.ok(withNew.calls <= 3, `请求页数应 <=3，实际 ${withNew.calls}`);
});

await test('已有记录的 first_seen 不会被后续全量同步覆盖', async () => {
  // 手动把一个日期改到远古，再跑全量同步，它必须原样保留。
  const records = await readRecords(tempFile);
  records.find((r) => r.id === '200').first_seen = '2020-01-01';
  await writeRecords(tempFile, records, { lastSync: 'test' });

  const complete = makeFakeServer([300, 299, 298, 297, 296, ...serverIds]);
  await syncKind(complete, { ...baseOptions, filePath: tempFile, full: true });

  const after = await readRecords(tempFile);
  assert.equal(after.find((r) => r.id === '200').first_seen, '2020-01-01');
  assert.equal(after.length, 105);
});

await test('全量模式能发现取消收藏并移除', async () => {
  const shrunk = makeFakeServer(serverIds.slice(0, 80));
  const result = await syncKind(shrunk, { ...baseOptions, filePath: tempFile, full: true });
  assert.equal(result.localAfter, 80);
  assert.equal(result.removed.length, 25);
});

await test('全量模式遇到结果异常缩水时中止，且不破坏原文件', async () => {
  const before = await readRecords(tempFile);
  const collapsed = makeFakeServer(serverIds.slice(0, 5));

  let aborted = false;
  try {
    await syncKind(collapsed, { ...baseOptions, filePath: tempFile, full: true });
  } catch (err) {
    aborted = err instanceof SyncAbort;
  }

  assert.ok(aborted, '应该抛出 SyncAbort');
  const after = await readRecords(tempFile);
  assert.equal(after.length, before.length, '原文件必须保持不变');
});

await test('dry-run 不写入文件', async () => {
  const before = await readRecords(tempFile);
  const unchanged = makeFakeServer(serverIds.slice(0, 80));
  await syncKind(unchanged, { ...baseOptions, filePath: tempFile, full: true, dryRun: true });
  const after = await readRecords(tempFile);
  assert.deepEqual(after, before);
});

await fs.rm(tempRoot, { recursive: true, force: true });

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`);
