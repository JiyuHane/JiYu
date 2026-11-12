import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APP_VERSION } from '@snowluma/common/version';
import type { UpdateCheckResult } from './check';
import type { UpdateService } from './service';

export const UPDATE_UNAVAILABLE = 'Jiyu 更新暂不可用：尚未确定 Jiyu 自有发行源和版本方案';

// The old updater had no cross-process lock. This checks only the current root and
// current system temp directory; stop old processes and inspect historical temp
// directories and path aliases manually before resolving a legacy transaction.
export async function assertNoLegacyUpdate(root: string): Promise<void> {
    const identity = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
    const local = path.join(root, 'tmp');
    const system = path.join(os.tmpdir(), `snowluma-update-${identity}`);
    const paths = [
        [local, path.join(local, 'update'), path.join(local, 'update', 'pending')],
        [system, path.join(system, 'pending')],
        [path.join(root, '.update-install')],
    ];

    for (const components of paths) {
        for (const [index, component] of components.entries()) {
            let stat;

            try {
                stat = await lstat(component);
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                    break;
                }

                throw error;
            }

            if (stat.isSymbolicLink() || index === components.length - 1) {
                throw new Error(
                    `检测到旧更新待处理或暂存路径是链接: ${component}；可能已部分应用。请停止同目录的其他进程，保留全部文件和事务记录，并人工检查当前及历史临时目录和路径别名；启动已停止`,
                );
            }

            if (!stat.isDirectory()) {
                throw new Error(
                    `旧更新暂存路径不是目录: ${component}；可能已部分应用。请停止同目录的其他进程，保留全部文件和事务记录，并人工检查当前及历史临时目录和路径别名；启动已停止`,
                );
            }
        }
    }
}

export async function getJiyuUpdateInfo(_force = false): Promise<UpdateCheckResult> {
    return {
        current: APP_VERSION,
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        notes: null,
        publishedAt: null,
        checkedAt: Date.now(),
        error: UPDATE_UNAVAILABLE,
    };
}

export async function createJiyuUpdateService(current: string): Promise<UpdateService> {
    return {
        status: () => ({ current, phase: 'unavailable', message: UPDATE_UNAVAILABLE }),
        start: (_version: unknown) => {
            throw new Error(UPDATE_UNAVAILABLE);
        },
        restart: () => {
            throw new Error(UPDATE_UNAVAILABLE);
        },
    };
}
