'use strict';
// The depth models a video can be converted with. Each one is a Depth Anything V2
// style graph with its position-table Resize cut out (tools/strip_posembed.py):
// models/<file>_fp16_pe.onnx (+ _fp32_pe.onnx where shipped) and
// models/<file>_posembed_1x<dim>x37x37.f32.
const DEPTH_MODELS = {
  standard: { file: 'dav2s', dim: 384, label: 'Standard' },
  distill: { file: 'dads', dim: 384, label: 'Distill' },
  distillbase: { file: 'dadb', dim: 768, label: 'Distill Base' },
};

module.exports = { DEPTH_MODELS };
