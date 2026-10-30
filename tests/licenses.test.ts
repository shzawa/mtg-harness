import { describe, expect, it } from 'vitest';
import { completeLicenses, renderNotices } from '../scripts/licenses.ts';

const bundled = [
  { name: '@wxt-dev/browser', version: '0.3.7', identifier: 'MIT' },
  { name: 'wxt', version: '0.21.5', identifier: 'MIT' },
];

describe('bundled license notices', () => {
  it('includes the reviewed upstream copyright and full permission text for both packages', () => {
    const completed = completeLicenses(bundled);
    const notices = renderNotices(completed);
    for (const license of completed) {
      expect(license.text).toContain('Copyright (c) 2023 Aaron');
      expect(license.text).toContain('Permission is hereby granted, free of charge');
      expect(license.text).toContain('SOFTWARE.');
      expect(notices).toContain(`${license.name}@${license.version} (MIT)`);
      expect(notices).toContain(license.source);
    }
    expect(completeLicenses(completed)).toEqual(completed);
  });

  it.each([
    { name: 'new-dependency', version: '1.0.0', identifier: 'MIT' },
    { name: 'wxt', version: '0.22.0', identifier: 'MIT' },
    { name: 'wxt', version: '0.21.5', identifier: 'GPL-3.0-only' },
  ])(
    'requires review of a new package, version, or license: $name@$version ($identifier)',
    (entry) => {
      expect(() => completeLicenses([entry])).toThrow('Review the license');
    },
  );

  it('rejects changed license text instead of silently replacing it', () => {
    expect(() => completeLicenses([{ ...bundled[1], text: 'Different copyright terms' }])).toThrow(
      'License text changed',
    );
  });

  it.each([
    { value: null, message: 'The bundler did not report' },
    { value: [], message: 'The bundler did not report' },
    { value: [null], message: 'Invalid bundled dependency' },
    {
      value: [{ name: ['wxt'], version: '0.21.5', identifier: 'MIT' }],
      message: 'must be strings',
    },
    { value: [bundled[0], bundled[0]], message: 'Duplicate bundled dependency' },
  ])('rejects incomplete or duplicate metadata: $value', ({ value, message }) => {
    expect(() => completeLicenses(value)).toThrow(message);
  });
});
