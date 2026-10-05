import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Only release-managed default themes are touched. Never walk customer content.
export async function brandBundledThemes(root) {
    const templates = ['casper/default.hbs', 'source/partials/components/footer.hbs'];
    for (const template of templates) {
        const file = join(root, template);
        const original = await readFile(file, 'utf8');
        const branded = original
            .replaceAll('Powered by Ghost', 'Powered by Frontro')
            .replaceAll('https://ghost.org/', 'https://frontro.com/')
            .replaceAll('>Ghost</a>', '>Frontro</a>');
        if (!branded.includes('https://frontro.com/') || /Powered by Ghost|>Ghost<\/a>/.test(branded)) {
            throw new Error(`Unsupported bundled theme attribution: ${template}`);
        }
        await writeFile(file, branded);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (!process.argv[2]) throw new Error('Bundled theme directory required');
    await brandBundledThemes(resolve(process.argv[2]));
}
