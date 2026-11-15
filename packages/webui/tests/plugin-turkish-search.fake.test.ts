import { describe, expect, it, vi } from 'vitest';
import type { CommunityPlugin } from '../src/lib/api/types';
import { filterPlugins } from '../src/lib/plugin-index';

function fake(overrides: Partial<CommunityPlugin> = {}): CommunityPlugin {
    return {
        id: '',
        name: '',
        description: '',
        author: '',
        version: '',
        homepage: '',
        downloadUrl: '',
        minVersion: '',
        ...overrides,
    };
}

function withTurkishLocale(run: () => void): void {
    const original = String.prototype.toLocaleLowerCase;
    const spy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
        this: string,
    ) {
        return original.call(this, 'tr');
    });

    try {
        run();
    } finally {
        spy.mockRestore();
    }
}

describe('community search with Turkish locale (synthetic data)', () => {
    it.each(['id', 'name', 'description', 'author'] as const)(
        'matches mathematical bold I independently in %s',
        (key) => {
            const plugin = fake({ [key]: '𝐈' });
            withTurkishLocale(() => {
                expect(filterPlugins([plugin], 'i')).toEqual([plugin]);
            });
        },
    );

    it('preserves the original Turkish locale path and raw substring matching', () => {
        const turkish = fake({ name: 'I' });
        const decomposed = fake({ description: 'e\u0301' });
        withTurkishLocale(() => {
            expect(filterPlugins([turkish], 'ı')).toEqual([turkish]);
            expect(filterPlugins([decomposed], 'e')).toEqual([decomposed]);
        });
    });

    it('uses locale-independent lowercase after both Turkish paths miss, not full case folding', () => {
        const ascii = fake({ name: 'I' });
        const sharpS = fake({ name: 'ß' });
        const doubleS = fake({ name: 'ss' });
        withTurkishLocale(() => {
            expect(filterPlugins([ascii], 'i')).toEqual([ascii]);
            expect(filterPlugins([sharpS], 'ss')).toEqual([]);
            expect(filterPlugins([doubleS], 'ß')).toEqual([]);
        });
    });

    it('matches tags independently without combining fields or tags', () => {
        const matched = fake({ tags: ['', '𝐈', '𝐈'] });
        const splitFields = fake({ id: '𝐈', name: '𝐀' });
        const splitTags = fake({ tags: ['𝐈', '', '𝐀'] });
        const emptyTags = fake({ tags: [] });
        const noTags = fake();
        withTurkishLocale(() => {
            expect(filterPlugins([matched, emptyTags, noTags], 'i')).toEqual([matched]);
            expect(filterPlugins([splitFields, splitTags], 'ia')).toEqual([]);
        });
    });

    it('preserves original objects, ordering, input fields and empty-query array identity', () => {
        const first = fake({ name: '𝐈', tags: ['', '𝐈', '𝐈'] });
        const omitted = fake({ name: 'other', tags: [] });
        const second = fake({ description: 'i' });
        const plugins = [first, omitted, second];
        const snapshot = structuredClone(plugins);
        withTurkishLocale(() => {
            expect(filterPlugins(plugins, ' \t ')).toBe(plugins);
            const result = filterPlugins(plugins, ' i ');
            expect(result).toEqual([first, second]);
            expect(result[0]).toBe(first);
            expect(result[1]).toBe(second);
            expect(plugins).toEqual(snapshot);
        });
    });
});
