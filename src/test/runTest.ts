import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // The folder containing package.json (the extension to develop).
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    // The compiled test suite entry point.
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Headless WebGL: Chromium >= 130 dropped the automatic SwiftShader
      // fallback. These keep the GL path alive on CI runners without a GPU; the
      // smoke test tolerates GL-unavailable runs regardless.
      launchArgs: [
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

void main();
