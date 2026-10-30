import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { metadata } from './release.ts';

export const licenseMetadataFile = 'THIRD_PARTY_LICENSES.json';
export const licenseNoticesFile = 'THIRD_PARTY_NOTICES.txt';

interface BundledLicense {
  name: string;
  version: string;
  identifier: string;
  text: string;
  source: string;
}

const approved = new Map([
  [
    '@wxt-dev/browser@0.3.7',
    'https://github.com/wxt-dev/wxt/blob/8fb1f6d84eb0bb9a6391eb6affb4182e033bdde2/LICENSE',
  ],
  [
    'wxt@0.21.5',
    'https://github.com/wxt-dev/wxt/blob/e690f91730aa679a58fba905f30f8ca80ea4f490/LICENSE',
  ],
]);

export function completeLicenses(value: unknown): BundledLicense[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('The bundler did not report dependency licenses');
  }
  const text = readFileSync(new URL('../licenses/wxt-MIT.txt', import.meta.url), 'utf8').trim();
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid bundled dependency license metadata');
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.version !== 'string') {
      throw new Error('Bundled dependency name and version must be strings');
    }
    const key = `${item.name}@${item.version}`;
    const source = approved.get(key);
    if (!source || item.identifier !== 'MIT') {
      throw new Error(`Review the license for ${key} before adding it to scripts/licenses.ts`);
    }
    if (seen.has(key)) throw new Error(`Duplicate bundled dependency: ${key}`);
    seen.add(key);
    // These npm packages omit LICENSE. Keep the reviewed upstream text locally.
    if (item.text !== undefined && (typeof item.text !== 'string' || item.text.trim() !== text)) {
      throw new Error(`License text changed for ${key}; review the upstream license`);
    }
    return {
      name: item.name,
      version: item.version,
      identifier: 'MIT',
      text,
      source,
    };
  });
}

export function renderNotices(licenses: readonly BundledLicense[]): string {
  return (
    'Third-party notices for MTG Harness\n\n' +
    licenses
      .map(({ name, version, identifier, text, source }) =>
        [`${name}@${version} (${identifier})`, `Source: ${source}`, '', text].join('\n'),
      )
      .join('\n\n---\n\n') +
    '\n'
  );
}

export function licensePlugin(): Plugin {
  return {
    name: 'mtg-harness:licenses',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const asset = bundle[licenseMetadataFile];
        if (!asset || asset.type !== 'asset' || typeof asset.source !== 'string') {
          throw new Error('Vite license metadata is missing from the build');
        }
        const licenses = completeLicenses(JSON.parse(asset.source));
        asset.source = JSON.stringify(licenses, null, 2) + '\n';
        this.emitFile({
          type: 'asset',
          fileName: licenseNoticesFile,
          source: renderNotices(licenses),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'LICENSE',
          source: readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'),
        });
      },
    },
  };
}

export function checkLicenseZip(cwd = process.cwd()): void {
  const { asset } = metadata(cwd);
  const zip = resolve(cwd, '.output', asset);
  const readZip = (file: string): string =>
    execFileSync('unzip', ['-p', zip, file], { encoding: 'utf8' });
  const raw = readZip(licenseMetadataFile);
  const licenses = completeLicenses(JSON.parse(raw));
  assert.equal(raw, JSON.stringify(licenses, null, 2) + '\n', 'ZIP license metadata is incomplete');
  assert.equal(readZip(licenseNoticesFile), renderNotices(licenses), 'ZIP notices are incomplete');
  assert.equal(
    readZip('LICENSE'),
    readFileSync(resolve(cwd, 'LICENSE'), 'utf8'),
    'ZIP license differs',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkLicenseZip();
  console.log('ZIP includes the project license and complete bundled dependency notices.');
}
