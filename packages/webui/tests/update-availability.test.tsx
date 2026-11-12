import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UpdateAvailability } from '../src/components/settings/update-availability';
import { updateSourceSaveNotice } from '../src/components/settings/update-sources';
import type { UpdateSourceSaveResult } from '../src/types';

describe('Jiyu update availability', () => {
    it('states the current policy without presenting an active updater', () => {
        const markup = renderToStaticMarkup(<UpdateAvailability />);
        expect(markup).toContain('霁羽在线更新尚未启用');
        expect(markup).toContain('更新来源配置会保留');
        expect(markup).toContain('目前不生效');
        expect(markup).toContain('https://github.com/JiyuHane/Jiyu/releases');
        expect(markup).not.toContain('下载更新');
        expect(markup).not.toContain('重新检查');
    });

    it('distinguishes a saved source from one already applied and retains server errors', () => {
        const result: UpdateSourceSaveResult = {
            config: { mode: 'auto', mirror: '', mirrors: [] },
            saved: true,
            applied: false,
            online: false,
            errors: ['待启用'],
            message: '',
        };
        expect(updateSourceSaveNotice(result)).toBe('更新来源已保存，但尚未生效；待启用');
        expect(updateSourceSaveNotice({ ...result, applied: true, errors: [] })).toBe(
            '更新来源已保存并生效',
        );
    });
});
