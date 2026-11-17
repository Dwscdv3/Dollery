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

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-export-test-'));
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

await fs.rm(tempRoot, { recursive: true, force: true });

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`);
