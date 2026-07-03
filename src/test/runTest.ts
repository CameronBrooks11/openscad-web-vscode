import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // The folder containing package.json (the extension to develop).
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    // The compiled test suite entry point.
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // The P4 test mutates project files (fix-on-save), so each run opens a
    // FRESH COPY of the fixture project in a temp dir, never the repo fixture.
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'openscad-web-vscode-test-'));
    fs.cpSync(path.resolve(extensionDevelopmentPath, 'test-fixtures/scad-project'), workspacePath, {
      recursive: true,
    });

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Headless WebGL: Chromium >= 130 dropped the automatic SwiftShader
      // fallback. These keep the GL path alive on CI runners without a GPU; the
      // smoke test tolerates GL-unavailable runs regardless.
      launchArgs: [
        workspacePath,
        '--disable-workspace-trust',
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
