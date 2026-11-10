"""Put another Depth Anything V2 style checkpoint (original key names, e.g. the
Distill-Any-Depth weights) into an onnx-community Depth Anything V2 graph of the
same size. The graph keeps its dynamic sizes and the node names that
strip_posembed.py looks for; every weight in it is replaced.

Needs: pip install onnx numpy safetensors
Usage: python tools/swap_weights.py <graph.onnx> <model.safetensors> <out.onnx>
"""
import sys

import numpy as np
import onnx
from onnx import numpy_helper
from safetensors.numpy import load_file


def main(ref, ck, out):
    m = onnx.load(ref)
    g = m.graph
    w = {k: v.astype(np.float32) for k, v in load_file(ck).items()}
    inits = {i.name: i for i in g.initializer}
    users = {}
    for n in g.node:
        for x in n.input:
            users.setdefault(x, []).append(n)

    done, left = 0, []

    def put(name, arr):
        nonlocal done
        old = numpy_helper.to_array(inits[name])
        assert old.shape == arr.shape, (name, old.shape, arr.shape)
        inits[name].CopyFrom(numpy_helper.from_array(arr.astype(old.dtype), name))
        done += 1

    for name, init in inits.items():
        if name in w:
            put(name, w[name])
        elif name.startswith('onnx::MatMul'):
            # a Linear layer's weight, stored transposed; its bias in the following Add names it
            mm = users[name][0]
            add = users[mm.output[0]][0]
            bias = next(x for x in add.input if x != mm.output[0])
            assert add.op_type == 'Add' and bias.endswith('.bias'), (name, add.op_type, bias)
            put(name, w[bias[:-5] + '.weight'].T)
        elif name == '/Transpose_output_0':
            # the 37x37 position table that the cubic Resize stretches
            pe = w['pretrained.pos_embed'][0, 1:]
            s = int(round(len(pe) ** 0.5))
            put(name, pe.reshape(1, s, s, -1).transpose(0, 3, 1, 2))
        elif name.startswith('onnx::Concat') and list(init.dims)[:2] == [1, 1]:
            # the class token with its position entry already added
            put(name, w['pretrained.cls_token'] + w['pretrained.pos_embed'][:, :1])
        elif init.data_type == onnx.TensorProto.FLOAT and np.prod(init.dims) > 16:
            left.append(name)

    assert not left, 'weights not replaced: %s' % left
    onnx.save(m, out)
    print('done:', done, 'weights replaced')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:4])
