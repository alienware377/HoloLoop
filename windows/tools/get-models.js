'use strict';
// Downloads the models HoloLoop uses into models/ and makes the depth models'
// DirectML-friendly copies. Needs Node 18+, Windows tar, and Python with
// onnx, onnxconverter-common, numpy and safetensors for the last steps.
// The Distill-Any-Depth models are their weights put into the matching
// onnx-community Depth Anything V2 graph (tools/swap_weights.py).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '..', 'models');
const MODELS = [
  ['dav2s_fp32.onnx', 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx'],
  ['yunet_2023mar.onnx', 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'],
  ['person_det_mp_2023mar.onnx', 'https://github.com/opencv/opencv_zoo/raw/main/models/person_detection_mediapipe/person_detection_mediapipe_2023mar.onnx'],
  ['rtmo-s.zip', 'https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip'],
  ['dav2b_graph.onnx', 'https://huggingface.co/onnx-community/depth-anything-v2-base/resolve/main/onnx/model.onnx'],
  ['dads.safetensors', 'https://huggingface.co/xingyang1/Distill-Any-Depth/resolve/main/small/model.safetensors'],
  ['dadb.safetensors', 'https://huggingface.co/xingyang1/Distill-Any-Depth/resolve/main/base/model.safetensors'],
];

async function get(name, url) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return console.log('have', name);
  console.log('get ', name);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(file + '.part', file);
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, url] of MODELS) await get(name, url);

  const rtmo = path.join(dir, 'rtmo_s_body7_640.onnx');
  if (!fs.existsSync(rtmo)) {
    const tmp = path.join(dir, 'rtmo-s');
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync('tar', ['-xf', path.join(dir, 'rtmo-s.zip'), '-C', tmp]);
    fs.renameSync(path.join(tmp, 'end2end.onnx'), rtmo);
    fs.rmSync(tmp, { recursive: true });
  }

  const py = process.env.PYTHON || 'python';
  if (!fs.existsSync(path.join(dir, 'dav2s_fp16_pe.onnx'))) {
    execFileSync(py, [path.join(__dirname, 'strip_posembed.py'), path.join(dir, 'dav2s_fp32.onnx')], { stdio: 'inherit' });
  }
  for (const [name, graph] of [['dads', 'dav2s_fp32.onnx'], ['dadb', 'dav2b_graph.onnx']]) {
    if (fs.existsSync(path.join(dir, name + '_fp16_pe.onnx'))) continue;
    const full = path.join(dir, name + '_fp32.onnx');
    execFileSync(py, [path.join(__dirname, 'swap_weights.py'), path.join(dir, graph), path.join(dir, name + '.safetensors'), full], { stdio: 'inherit' });
    execFileSync(py, [path.join(__dirname, 'strip_posembed.py'), full, '--fp16-only'], { stdio: 'inherit' });
  }
  console.log('models ready');
})().catch((e) => { console.error(e.message); process.exit(1); });
