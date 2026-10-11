import { describe, expect, it } from 'vitest';
import { parseSiteConfig, v } from '../src';
import { mangaConfig } from './helpers';

describe('validate', () => {
  const Item = v
    .object({
      name: v.string().min(1),
      count: v.number().int().min(0).default(0),
      tags: v.array(v.string(), { max: 2 }).optional(),
    })
    .strict();

  it('fills defaults, leaves absent optional keys out, and rejects unknown keys', () => {
    expect(Item.parse({ name: 'a' })).toEqual({ name: 'a', count: 0 });
    expect(Item.safeParse({ name: 'a', nmae: 'b' })).toEqual({
      success: false,
      error: { issues: [{ path: [], message: "unrecognized key(s) in object: 'nmae'" }] },
    });
  });

  it('reports every problem with its path', () => {
    const result = Item.safeParse({ name: '', count: 1.5, tags: ['x', 2, 'y'] });
    expect(!result.success && result.error.issues).toEqual([
      { path: ['name'], message: 'string must contain at least 1 character(s)' },
      { path: ['count'], message: 'expected integer, received float' },
      { path: ['tags'], message: 'array must contain at most 2 element(s)' },
      { path: ['tags', 1], message: 'expected string, received number' },
    ]);
  });

  it('explains the union option matching the input’s type', () => {
    const Field = v.union([v.string().min(1), v.object({ selector: v.string().min(1) }).strict()]);
    expect(Field.parse('a')).toBe('a');
    expect(!Field.safeParse({ selector: 'a', atr: 'x' }).success && Field.safeParse({ selector: 'a', atr: 'x' })).toMatchObject({
      error: { issues: [{ message: "unrecognized key(s) in object: 'atr'" }] },
    });
    expect(Field.safeParse(3)).toMatchObject({ success: false, error: { issues: [{ message: 'invalid input' }] } });
  });

  it('keeps site config errors as the writing guide documents them', () => {
    const series = { ...mangaConfig.series, chapters: { ...mangaConfig.series.chapters, nxt: 'a' } };
    expect(() => parseSiteConfig({ ...mangaConfig, series })).toThrow("invalid site config: series.chapters: unrecognized key(s) in object: 'nxt'");
  });
});
