import { readFileSync } from 'fs';

/* eslint-disable no-console */

try {
    const dockerfileContent = readFileSync('./Dockerfile', 'utf-8');
    const packageJsonContent = readFileSync('./package.json', 'utf-8');

    const dockerMatch = dockerfileContent.match(/apify\/actor-node-playwright-(?:chrome|firefox|camoufox):\d+-(\d+\.\d+\.\d+)/);
    const dockerVersion = dockerMatch ? dockerMatch[1] : null;
    const packageJson = JSON.parse(packageJsonContent);
    const packageVersion = packageJson.dependencies?.playwright;

    if (!dockerVersion || !packageVersion) {
        console.log('Playwright version check skipped.');
        process.exit(0);
    }

    const cleanPackageVersion = packageVersion.replace(/^[\^~]/, '');
    if (dockerVersion !== cleanPackageVersion) {
        console.error(`Playwright version mismatch: Dockerfile uses ${dockerVersion}, package.json uses ${cleanPackageVersion}`);
        process.exit(1);
    }

    console.log(`Playwright versions match: ${dockerVersion}`);
} catch (error) {
    console.log('Playwright version check skipped:', error.message);
    process.exit(0);
}
