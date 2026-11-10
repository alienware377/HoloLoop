// Packs HoloLoop into dist/HoloLoop-win32-x64 (Windows x64 only).
// Native bits (ffmpeg, onnxruntime, the depth model, the PowerShell helper) are
// unpacked from the asar so they can be run or loaded from disk.
'use strict';
const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');
const out = process.env.HOLOLOOP_DIST || path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ stamp, version: pkg.version }, null, 2));

const ignore = [
  /^\/tools($|\/)/, /^\/build\/pack\.js$/, /^\/dist($|\/)/, /^\/\.git($|\/)/,
  /^\/models\/dav2s_(fp32|fp16|fp16io32)\.onnx$/,                 // only the stripped *_pe models ship
  /^\/models\/(dads|dadb)_fp32(_pe)?\.onnx$/,                       // the extra models ship as fp16 only
  /\/ffprobe-static\/bin\/(darwin|linux)($|\/)/, /\/ffprobe-static\/bin\/win32\/ia32($|\/)/,
  /\/onnxruntime-node\/bin\/napi-v6\/(darwin|linux)($|\/)/, /\/onnxruntime-node\/bin\/napi-v6\/win32\/arm64($|\/)/,
  /\.log$/, /\/test(s)?\//,
];

(async () => {
  const paths = await packager({
    dir: root, out, overwrite: true, platform: 'win32', arch: 'x64', name: 'HoloLoop',
    executableName: 'HoloLoop', icon: path.join(root, 'assets', 'icon.ico'), appVersion: pkg.version,
    win32metadata: { CompanyName: 'alienware377', FileDescription: 'HoloLoop', ProductName: 'HoloLoop' },
    asar: { unpack: '{**/*.node,**/*.dll,**/*.exe,**/models/**,**/*.ps1,**/assets/viewnum_*}' },
    ignore, prune: true,
  });
  console.log('packed', paths[0], 'build', stamp);
})().catch((e) => { console.error(e); process.exit(1); });
