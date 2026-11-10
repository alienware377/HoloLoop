"""Cut the bicubic position-table Resize out of a Depth Anything V2 style model.

DirectML has no cubic Resize, so onnxruntime runs that one node on the CPU every
frame, and it costs most of the frame. This makes its output a graph input
(pos_embed_resized) instead, and saves the 37x37 table it was made from;
src/convert/posembed.js does the resize once per input size.

Writes, next to the input model (name = the input's name up to the first "_"):
  <name>_fp32_pe.onnx, <name>_fp16_pe.onnx (fp16 weights, fp32 inputs and outputs)
  <name>_posembed_1x<C>x37x37.f32
--fp16-only skips the fp32 copy.

Needs: pip install onnx onnxconverter-common numpy
Usage: python tools/strip_posembed.py models/dav2s_fp32.onnx [--fp16-only]
"""
import os
import sys
import warnings

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnxconverter_common import float16


def main(src, fp16_only=False):
    warnings.filterwarnings('ignore', module='onnxconverter_common')  # tiny weights rounding to fp16
    out_dir = os.path.dirname(os.path.abspath(src))
    prefix = os.path.basename(src).split('_')[0]
    m = onnx.load(src)
    g = m.graph

    inits = {i.name: i for i in g.initializer}
    table = numpy_helper.to_array(inits['/Transpose_output_0']).astype(np.float32)
    table.tofile(os.path.join(out_dir, '%s_posembed_1x%dx%dx%d.f32' % ((prefix,) + table.shape[1:])))

    rz = next(n for n in g.node if n.name == '/Resize')
    for n in g.node:
        for k, name in enumerate(n.input):
            if name == rz.output[0]:
                n.input[k] = 'pos_embed_resized'
    g.node.remove(rz)
    g.input.append(helper.make_tensor_value_info('pos_embed_resized', TensorProto.FLOAT, [1, table.shape[1], 'ph', 'pw']))

    # drop whatever only fed the Resize
    while True:
        used = {i for n in g.node for i in n.input} | {o.name for o in g.output}
        dead = [n for n in g.node if not any(o in used for o in n.output)]
        if not dead:
            break
        for n in dead:
            g.node.remove(n)
    used = {i for n in g.node for i in n.input}
    for i in list(g.initializer):
        if i.name not in used:
            g.initializer.remove(i)

    onnx.checker.check_model(m)
    if not fp16_only:
        onnx.save(m, os.path.join(out_dir, prefix + '_fp32_pe.onnx'))
    onnx.save(float16.convert_float_to_float16(m, keep_io_types=True), os.path.join(out_dir, prefix + '_fp16_pe.onnx'))
    print('done:', len(g.node), 'nodes, table', table.shape)


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--fp16-only']
    if len(args) != 1:
        sys.exit(__doc__)
    main(args[0], '--fp16-only' in sys.argv)
