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
 * 收藏同步的「通道」概念，从 cli.mjs 抽出来给查看器共用。
 *
 * 通道 = 一种收藏类型 × 一种可见性，落到一个 JSON 文件。四条：插画公开/私密、小说公开/私密。
 * 之前这些写死在命令行里，前端要同步就只能复制一份 —— 两份口径迟早分叉，所以抽到这里。
 *
 * 这里只管「怎么跑」，不管「往哪打印」：进度通过 log 回调交出去，
 * 命令行传 console.log，查看器传自己的进度收集器。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { updateBookmarkTagMap, applyBookmarkTags, refreshBookmarkTags } from './bookmark-tags.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 按配置和筛选条件拼出要同步的通道列表。
 *
 * @param {object} config 完整配置
 * @param {{ novelOnly?: boolean, illustOnly?: boolean, publicOnly?: boolean, privateOnly?: boolean }} [filters]
 * @returns {Array<{ kind: string, visibility: string, label: string, file: string }>}
 */
export function buildChannels(config, filters = {}) {
  const wantIllust = !filters.novelOnly;
  const wantNovel = config.includeNovels && !filters.illustOnly;
  const wantPublic = !filters.privateOnly;
  const wantPrivate = !filters.publicOnly;

  const channels = [];

  if (wantIllust) {
    if (wantPublic) {
      channels.push({
        kind: 'illust',
        visibility: 'public',
        label: '插画/漫画·公开',
        file: config.output.illustPublic,
      });
    }
    if (wantPrivate) {
      channels.push({
        kind: 'illust',
        visibility: 'private',
        label: '插画/漫画·私密',
        file: config.output.illustPrivate,
      });
    }
  }

  if (wantNovel) {
    if (wantPublic) {
      channels.push({
        kind: 'novel',
        visibility: 'public',
        label: '小说·公开',
        file: config.output.novelPublic,
      });
    }
    if (wantPrivate) {
      channels.push({
        kind: 'novel',
        visibility: 'private',
        label: '小说·私密',
        file: config.output.novelPrivate,
      });
    }
  }

  return channels.filter((channel) => Boolean(channel.file));
}

/**
 * 同步某一个通道的收藏标签。
 *
 * 两种模式：
 *   · 增量（默认）：只查本次新增的作品，一个作品一次请求，便宜；
 *   · 全量（full 或 rebuildTags）：逐标签反推，一次要把所有标签翻一遍（约 868 个），贵。
 *
 * @param {object} client PixivClient
 * @param {object} options
 * @param {object} options.entry 通道（buildChannels 里的一项）
 * @param {object} options.config 完整配置
 * @param {string} options.filePath 该通道的数据文件
 * @param {boolean} [options.full] 全量同步
 * @param {boolean} [options.rebuildTags] 强制重建标签缓存
 * @param {number} [options.sourceTotal] 该通道收藏总数（写进 meta）
 * @param {object} [options.result] syncKind 的返回值，增量模式要用其中的 added
 * @param {object} options.guard 守卫，用来按请求数记账
 * @param {(text: string) => void} [options.log] 进度输出
 */
export async function syncTagsForChannel(
  client,
  { entry, config, filePath, full = false, rebuildTags = false, sourceTotal, result, guard, log = () => {} },
) {
  const meta = {
    kindLabel: entry.label,
    lastSync: new Date().toISOString().replace('T', ' ').slice(0, 19),
    sourceTotal: sourceTotal || undefined,
  };

  // ---- 差分：只查本次新增的作品，一个作品一次请求 ----
  // 全量才用「逐标签反推」，因为反推一次要把所有标签翻一遍（约 868 个标签）。
  if (!full && !rebuildTags) {
    const pids = (result?.added ?? []).map((record) => record.pid).filter(Boolean);

    if (pids.length === 0) {
      log('    收藏标签：本次没有新增作品，无需检查');
      return { changed: 0, stats: { total: 0, checked: 0, changed: 0, failed: 0 } };
    }

    const stats = await refreshBookmarkTags(client, {
      filePath,
      kind: entry.kind,
      pids,
      meta,
      onProgress: async (event) => {
        if (event.index % 10 === 0 || event.index === event.total) {
          log(`    逐个检查标签 ${event.index}/${event.total}（已改 ${event.changed}）`);
        }
        // 一个作品一次请求
        await guard.bump({ requests: 1 });
      },
    });

    const failedNote = stats.failed > 0 ? `，${stats.failed} 个读取失败（保留原值）` : '';
    log(`    收藏标签：检查 ${stats.checked}/${stats.total} 个新增作品，${stats.changed} 条更新${failedNote}`);

    return { changed: stats.changed, stats };
  }

  // ---- 全量：逐标签反推 ----
  const cacheDir = path.resolve(PROJECT_ROOT, config.bookmarkTags.cacheDir);

  const { map, stats } = await updateBookmarkTagMap(client, {
    kind: entry.kind,
    visibility: entry.visibility,
    cacheDir,
    limit: Number(config.pageSize[entry.kind] ?? 100),
    force: rebuildTags,
    onProgress: async (event) => {
      // 868 个标签逐个打印太吵，每 20 个报一次进度
      if (event.index % 20 === 0 || event.index === event.total) {
        log(`    标签扫描 ${event.index}/${event.total}（当前「${event.tag}」）已映射 ${event.mapped} 个作品`);
      }
      await guard.bump({ requests: 1 });
    },
  });

  if (stats.truncated) {
    log('    注意：Pixiv 标记了 tooManyBookmarkTags，可能有标签没返回。');
  }

  if (stats.reused) {
    log(`    收藏标签：缓存有效（${stats.tags} 个标签），未产生额外请求`);
  } else {
    log(`    收藏标签：扫描 ${stats.scannedTags} 个标签 / ${stats.requests} 次请求，映射 ${stats.mapped} 个作品`);
  }

  const changed = await applyBookmarkTags(filePath, map, meta);

  if (changed > 0) {
    log(`    收藏标签：${changed} 条记录已更新`);
  }

  return { changed, stats };
}
