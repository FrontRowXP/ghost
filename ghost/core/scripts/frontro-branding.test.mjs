import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {brandBundledThemes} from './frontro-theme-branding.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = file => readFile(join(repo, file), 'utf8');

test('pinned default themes brand their footers without touching custom themes or source submodules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontro-themes-'));
    try {
        const templates = ['casper/default.hbs', 'source/partials/components/footer.hbs'];
        const originals = [];
        for (const name of templates) {
            const original = await source(`ghost/core/content/themes/${name}`);
            originals.push(original);
            await mkdir(join(root, name, '..'), {recursive: true});
            await writeFile(join(root, name), original);
        }
        await mkdir(join(root, 'custom'));
        const custom = '<p>Owner content: Ghost story</p>';
        await writeFile(join(root, 'custom/default.hbs'), custom);
        await brandBundledThemes(root);
        for (const [index, name] of templates.entries()) {
            const branded = await readFile(join(root, name), 'utf8');
            assert.match(branded, /https:\/\/frontro\.com\//);
            assert.doesNotMatch(branded, /Powered by Ghost|>Ghost<\/a>/);
            assert.match(branded, /Frontro/);
            assert.equal(await source(`ghost/core/content/themes/${name}`), originals[index]);
        }
        await brandBundledThemes(root); // Repeat builds are idempotent.
        assert.equal(await readFile(join(root, 'custom/default.hbs'), 'utf8'), custom);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});

test('an upstream footer contract change fails the build instead of silently shipping Ghost branding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontro-theme-contract-'));
    try {
        await mkdir(join(root, 'casper'));
        await writeFile(join(root, 'casper/default.hbs'), '<footer>Unexpected upstream layout</footer>');
        await assert.rejects(brandBundledThemes(root), /Unsupported bundled theme attribution/);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});

test('shipped Portal and public template footers use Frontro attribution', async () => {
    const portal = await source('apps/portal/umd/portal.min.js');
    assert.match(portal, /Powered by Frontro/);
    assert.doesNotMatch(portal, /Powered by Ghost/);
    for (const file of [
        'ghost/core/core/frontend/apps/private-blogging/lib/views/private.hbs',
        'ghost/core/core/server/services/email-service/email-templates/template.hbs',
        'apps/admin/src/settings/email-design/email-preview.tsx',
        'apps/admin/src/settings/email/newsletters/newsletter-preview-content.tsx',
    ]) {
        const text = await source(file);
        assert.match(text, /Powered by Frontro/);
        assert.doesNotMatch(text, /Powered by Ghost|images\/powered\.png/);
    }
});

test('admin loading screens use Frontro and upstream licensing remains accurate', async () => {
    for (const file of ['apps/admin/index.html', 'apps/ember-admin/app/index.html']) {
        const html = await source(file);
        assert.match(html, /<title>Frontro<\/title>/);
        assert.match(html, /alt="Frontro"/);
        assert.doesNotMatch(html, /logo-loader\.mp4/);
    }
    const about = await source('apps/admin/src/settings/general/about.tsx');
    assert.match(await source('LICENSE'), /Ghost Foundation/);
    assert.match(about, /github\.com\/TryGhost\/Ghost\/blob\/main\/LICENSE/);
});
