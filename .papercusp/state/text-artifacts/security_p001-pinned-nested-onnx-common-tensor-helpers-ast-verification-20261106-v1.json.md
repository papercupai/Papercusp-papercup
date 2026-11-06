---
rel_path: "security/p001-pinned-nested-onnx-common-tensor-helpers-ast-verification-20261106-v1.json"
updated_at: 1793945584791
_body: "content"
---

{
  "schema": "p001-pinned-nested-onnx-common-tensor-helpers-ast-verification-v1",
  "recordedAt": "2026-11-06T06:10:25.360Z",
  "compiler": "6.0.3",
  "archive": {
    "bytes": 66168,
    "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
    "retainedIntegrityMatched": true
  },
  "records": [
    {
      "schema": "p001-pinned-nested-onnx-common-tensor-helpers-ast-record-v1",
      "path": "dist/esm/version.js",
      "bytes": 287,
      "sha256": "f31ccccd8245226aa7af3cb1de6257b208be40335ca80270a6c21f6249cdb126",
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [],
      "assignments": [],
      "independentMatchesPython": true,
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "pythonSourceSpansVerified": true
    },
    {
      "schema": "p001-pinned-nested-onnx-common-tensor-helpers-ast-record-v1",
      "path": "dist/esm/tensor-conversion-impl.js",
      "bytes": 7852,
      "sha256": "df6fa3cd1813c2d3e588cc07973cfe5ea2ab8647c957168200caa58e51440161",
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [
        {
          "kind": "CallExpression",
          "callee": "document.createElement",
          "start": 251,
          "end": 283,
          "line": 7,
          "column": 54,
          "expression": "document.createElement('canvas')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "OffscreenCanvas",
          "start": 286,
          "end": 311,
          "line": 7,
          "column": 89,
          "expression": "new OffscreenCanvas(1, 1)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "canvas.getContext",
          "start": 412,
          "end": 435,
          "line": 10,
          "column": 29,
          "expression": "canvas.getContext('2d')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.fillRect",
          "start": 3432,
          "end": 3468,
          "line": 83,
          "column": 17,
          "expression": "pixels2DContext.fillRect(j, i, 1, 1)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "canvas.toDataURL",
          "start": 3550,
          "end": 3568,
          "line": 87,
          "column": 20,
          "expression": "canvas.toDataURL()",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 3613,
          "end": 3652,
          "line": 90,
          "column": 19,
          "expression": "new Error('toDataURL is not supported')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 3695,
          "end": 3733,
          "line": 94,
          "column": 15,
          "expression": "new Error('Can not access image data')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "document.createElement('canvas').getContext",
          "start": 3920,
          "end": 3969,
          "line": 102,
          "column": 11,
          "expression": "document.createElement('canvas').getContext('2d')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "document.createElement",
          "start": 3920,
          "end": 3952,
          "line": 102,
          "column": 11,
          "expression": "document.createElement('canvas')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "new OffscreenCanvas(1, 1).getContext",
          "start": 3980,
          "end": 4022,
          "line": 103,
          "column": 11,
          "expression": "new OffscreenCanvas(1, 1).getContext('2d')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "OffscreenCanvas",
          "start": 3980,
          "end": 4005,
          "line": 103,
          "column": 11,
          "expression": "new OffscreenCanvas(1, 1)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 6052,
          "end": 6110,
          "line": 157,
          "column": 23,
          "expression": "new Error(\"Tensor format doesn't match input tensor dims\")",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.createImageData",
          "start": 7009,
          "end": 7055,
          "line": 181,
          "column": 17,
          "expression": "pixels2DContext.createImageData(width, height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 7735,
          "end": 7773,
          "line": 191,
          "column": 15,
          "expression": "new Error('Can not access image data')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        }
      ],
      "assignments": [
        {
          "start": 317,
          "end": 346,
          "line": 8,
          "column": 5,
          "expression": "canvas.width = tensor.dims[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 352,
          "end": 382,
          "line": 9,
          "column": 5,
          "expression": "canvas.height = tensor.dims[2]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 665,
          "end": 687,
          "line": 16,
          "column": 13,
          "expression": "width = tensor.dims[2]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 701,
          "end": 724,
          "line": 17,
          "column": 13,
          "expression": "height = tensor.dims[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 801,
          "end": 823,
          "line": 21,
          "column": 13,
          "expression": "width = tensor.dims[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 837,
          "end": 860,
          "line": 22,
          "column": 13,
          "expression": "height = tensor.dims[2]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1109,
          "end": 1140,
          "line": 29,
          "column": 13,
          "expression": "normMean = [255, 255, 255, 255]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1232,
          "end": 1287,
          "line": 33,
          "column": 17,
          "expression": "normMean = [norm.mean, norm.mean, norm.mean, norm.mean]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1338,
          "end": 1394,
          "line": 36,
          "column": 17,
          "expression": "normMean = [norm.mean[0], norm.mean[1], norm.mean[2], 0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1466,
          "end": 1492,
          "line": 38,
          "column": 21,
          "expression": "normMean[3] = norm.mean[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1609,
          "end": 1632,
          "line": 43,
          "column": 13,
          "expression": "normBias = [0, 0, 0, 0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1724,
          "end": 1779,
          "line": 47,
          "column": 17,
          "expression": "normBias = [norm.bias, norm.bias, norm.bias, norm.bias]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1830,
          "end": 1886,
          "line": 50,
          "column": 17,
          "expression": "normBias = [norm.bias[0], norm.bias[1], norm.bias[2], 0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 1958,
          "end": 1984,
          "line": 52,
          "column": 21,
          "expression": "normBias[3] = norm.bias[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2339,
          "end": 2357,
          "line": 61,
          "column": 13,
          "expression": "rTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2371,
          "end": 2394,
          "line": 62,
          "column": 13,
          "expression": "gTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2408,
          "end": 2435,
          "line": 63,
          "column": 13,
          "expression": "bTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2449,
          "end": 2476,
          "line": 64,
          "column": 13,
          "expression": "aTensorPointer = stride * 3",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2542,
          "end": 2560,
          "line": 67,
          "column": 13,
          "expression": "rTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2574,
          "end": 2597,
          "line": 68,
          "column": 13,
          "expression": "gTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2611,
          "end": 2638,
          "line": 69,
          "column": 13,
          "expression": "bTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2704,
          "end": 2722,
          "line": 72,
          "column": 13,
          "expression": "rTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2736,
          "end": 2759,
          "line": 73,
          "column": 13,
          "expression": "bTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 2773,
          "end": 2800,
          "line": 74,
          "column": 13,
          "expression": "gTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 3339,
          "end": 3414,
          "line": 82,
          "column": 17,
          "expression": "pixels2DContext.fillStyle = 'rgba(' + R + ',' + G + ',' + B + ',' + A + ')'",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 175
            }
          ]
        },
        {
          "start": 4289,
          "end": 4311,
          "line": 111,
          "column": 13,
          "expression": "width = tensor.dims[2]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 4325,
          "end": 4348,
          "line": 112,
          "column": 13,
          "expression": "height = tensor.dims[1]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 4362,
          "end": 4387,
          "line": 113,
          "column": 13,
          "expression": "channels = tensor.dims[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 4464,
          "end": 4486,
          "line": 117,
          "column": 13,
          "expression": "width = tensor.dims[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 4500,
          "end": 4523,
          "line": 118,
          "column": 13,
          "expression": "height = tensor.dims[2]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 4537,
          "end": 4562,
          "line": 119,
          "column": 13,
          "expression": "channels = tensor.dims[1]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 4844,
          "end": 4875,
          "line": 126,
          "column": 13,
          "expression": "normMean = [255, 255, 255, 255]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 4967,
          "end": 5022,
          "line": 130,
          "column": 17,
          "expression": "normMean = [norm.mean, norm.mean, norm.mean, norm.mean]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 5073,
          "end": 5131,
          "line": 133,
          "column": 17,
          "expression": "normMean = [norm.mean[0], norm.mean[1], norm.mean[2], 255]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 5203,
          "end": 5229,
          "line": 135,
          "column": 21,
          "expression": "normMean[3] = norm.mean[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 5346,
          "end": 5369,
          "line": 140,
          "column": 13,
          "expression": "normBias = [0, 0, 0, 0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 5461,
          "end": 5516,
          "line": 144,
          "column": 17,
          "expression": "normBias = [norm.bias, norm.bias, norm.bias, norm.bias]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 5567,
          "end": 5623,
          "line": 147,
          "column": 17,
          "expression": "normBias = [norm.bias[0], norm.bias[1], norm.bias[2], 0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 5695,
          "end": 5721,
          "line": 149,
          "column": 21,
          "expression": "normBias[3] = norm.bias[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6520,
          "end": 6538,
          "line": 166,
          "column": 13,
          "expression": "rTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6552,
          "end": 6575,
          "line": 167,
          "column": 13,
          "expression": "gTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6589,
          "end": 6616,
          "line": 168,
          "column": 13,
          "expression": "bTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6630,
          "end": 6657,
          "line": 169,
          "column": 13,
          "expression": "aTensorPointer = stride * 3",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6723,
          "end": 6741,
          "line": 172,
          "column": 13,
          "expression": "rTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6755,
          "end": 6778,
          "line": 173,
          "column": 13,
          "expression": "gTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6792,
          "end": 6819,
          "line": 174,
          "column": 13,
          "expression": "bTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6885,
          "end": 6903,
          "line": 177,
          "column": 13,
          "expression": "rTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6917,
          "end": 6940,
          "line": 178,
          "column": 13,
          "expression": "bTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 6954,
          "end": 6981,
          "line": 179,
          "column": 13,
          "expression": "gTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7001,
          "end": 7055,
          "line": 181,
          "column": 9,
          "expression": "image = pixels2DContext.createImageData(width, height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7101,
          "end": 7122,
          "line": 182,
          "column": 45,
          "expression": "rImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7124,
          "end": 7145,
          "line": 182,
          "column": 68,
          "expression": "gImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7147,
          "end": 7168,
          "line": 182,
          "column": 91,
          "expression": "bImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7170,
          "end": 7191,
          "line": 182,
          "column": 114,
          "expression": "aImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7212,
          "end": 7299,
          "line": 183,
          "column": 13,
          "expression": "image.data[rImagePointer] = (tensor.data[rTensorPointer++] - normBias[0]) * normMean[0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7324,
          "end": 7411,
          "line": 184,
          "column": 13,
          "expression": "image.data[gImagePointer] = (tensor.data[gTensorPointer++] - normBias[1]) * normMean[1]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7436,
          "end": 7523,
          "line": 185,
          "column": 13,
          "expression": "image.data[bImagePointer] = (tensor.data[bTensorPointer++] - normBias[2]) * normMean[2]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        },
        {
          "start": 7548,
          "end": 7681,
          "line": 186,
          "column": 13,
          "expression": "image.data[aImagePointer] =\n                aTensorPointer === -1 ? 255 : (tensor.data[aTensorPointer++] - normBias[3]) * normMean[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3827
            }
          ]
        }
      ],
      "independentMatchesPython": true,
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "pythonSourceSpansVerified": true
    },
    {
      "schema": "p001-pinned-nested-onnx-common-tensor-helpers-ast-record-v1",
      "path": "dist/esm/tensor-factory-impl.js",
      "bytes": 11002,
      "sha256": "cf5606fe23461e01bff59c2d72ac47d74e652548718f1e5fab07a22b441379b4",
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "./tensor-impl.js",
          "start": 119,
          "end": 137,
          "line": 3,
          "column": 24,
          "expression": "'./tensor-impl.js'"
        }
      ],
      "effects": [
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 542,
          "end": 583,
          "line": 13,
          "column": 15,
          "expression": "new Error('Image buffer must be defined')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 676,
          "end": 727,
          "line": 16,
          "column": 15,
          "expression": "new Error('Image height and width must be defined')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 792,
          "end": 844,
          "line": 19,
          "column": 15,
          "expression": "new Error('NHWC Tensor layout is not supported yet')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Float32Array",
          "start": 1786,
          "end": 1814,
          "line": 41,
          "column": 51,
          "expression": "new Float32Array(stride * 4)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Float32Array",
          "start": 1817,
          "end": 1845,
          "line": 41,
          "column": 82,
          "expression": "new Float32Array(stride * 3)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 3432,
          "end": 3489,
          "line": 77,
          "column": 11,
          "expression": "new Tensor('float32', float32Data, [1, 4, height, width])",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 3500,
          "end": 3557,
          "line": 78,
          "column": 11,
          "expression": "new Tensor('float32', float32Data, [1, 3, height, width])",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "document.createElement",
          "start": 4234,
          "end": 4266,
          "line": 94,
          "column": 20,
          "expression": "document.createElement('canvas')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 4160
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "OffscreenCanvas",
          "start": 4356,
          "end": 4381,
          "line": 97,
          "column": 20,
          "expression": "new OffscreenCanvas(1, 1)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 4160
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 4426,
          "end": 4462,
          "line": 100,
          "column": 19,
          "expression": "new Error('Canvas is not supported')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 4160
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "canvas.getContext",
          "start": 4641,
          "end": 4664,
          "line": 105,
          "column": 20,
          "expression": "canvas.getContext('2d')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 4513
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "canvas.getContext",
          "start": 4749,
          "end": 4772,
          "line": 108,
          "column": 20,
          "expression": "canvas.getContext('2d')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 4513
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvas",
          "start": 5017,
          "end": 5031,
          "line": 117,
          "column": 24,
          "expression": "createCanvas()",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvasContext",
          "start": 5139,
          "end": 5166,
          "line": 120,
          "column": 33,
          "expression": "createCanvasContext(canvas)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 5683,
          "end": 5755,
          "line": 131,
          "column": 27,
          "expression": "new Error('Image input config format must be RGBA for HTMLImageElement')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.drawImage",
          "start": 6217,
          "end": 6255,
          "line": 144,
          "column": 13,
          "expression": "pixels2DContext.drawImage(image, 0, 0)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.getImageData",
          "start": 6276,
          "end": 6325,
          "line": 145,
          "column": 20,
          "expression": "pixels2DContext.getImageData(0, 0, width, height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 6375,
          "end": 6413,
          "line": 148,
          "column": 19,
          "expression": "new Error('Can not access image data')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvas",
          "start": 7103,
          "end": 7117,
          "line": 169,
          "column": 32,
          "expression": "createCanvas()",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvasContext",
          "start": 7233,
          "end": 7264,
          "line": 172,
          "column": 37,
          "expression": "createCanvasContext(tempCanvas)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.putImageData",
          "start": 7325,
          "end": 7366,
          "line": 174,
          "column": 17,
          "expression": "pixels2DContext.putImageData(image, 0, 0)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.getImageData",
          "start": 7391,
          "end": 7440,
          "line": 175,
          "column": 24,
          "expression": "pixels2DContext.getImageData(0, 0, width, height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 7502,
          "end": 7540,
          "line": 178,
          "column": 23,
          "expression": "new Error('Can not access image data')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 7785,
          "end": 7853,
          "line": 188,
          "column": 19,
          "expression": "new Error('Please provide image config with format for Imagebitmap')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvas",
          "start": 7888,
          "end": 7902,
          "line": 190,
          "column": 24,
          "expression": "createCanvas()",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvasContext",
          "start": 8010,
          "end": 8037,
          "line": 193,
          "column": 33,
          "expression": "createCanvasContext(canvas)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.drawImage",
          "start": 8170,
          "end": 8223,
          "line": 197,
          "column": 13,
          "expression": "pixels2DContext.drawImage(image, 0, 0, width, height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "pixels2DContext.getImageData",
          "start": 8244,
          "end": 8293,
          "line": 198,
          "column": 20,
          "expression": "pixels2DContext.getImageData(0, 0, width, height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "bufferToTensor",
          "start": 8419,
          "end": 8462,
          "line": 201,
          "column": 20,
          "expression": "bufferToTensor(data, bufferToTensorOptions)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 8507,
          "end": 8545,
          "line": 204,
          "column": 19,
          "expression": "new Error('Can not access image data')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Promise",
          "start": 8603,
          "end": 9467,
          "line": 208,
          "column": 16,
          "expression": "new Promise((resolve, reject) => {\n            const canvas = createCanvas();\n            const context = createCanvasContext(canvas);\n            if (!image || !context) {\n                return reject();\n            }\n            const newImage = new Image();\n            newImage.crossOrigin = 'Anonymous';\n            newImage.src = image;\n            newImage.onload = () => {\n                canvas.width = newImage.width;\n                canvas.height = newImage.height;\n                context.drawImage(newImage, 0, 0, canvas.width, canvas.height);\n                const img = context.getImageData(0, 0, canvas.width, canvas.height);\n                bufferToTensorOptions.height = canvas.height;\n                bufferToTensorOptions.width = canvas.width;\n                resolve(bufferToTensor(img.data, bufferToTensorOptions));\n            };\n        })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvas",
          "start": 8665,
          "end": 8679,
          "line": 209,
          "column": 28,
          "expression": "createCanvas()",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "createCanvasContext",
          "start": 8709,
          "end": 8736,
          "line": 210,
          "column": 29,
          "expression": "createCanvasContext(canvas)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "reject",
          "start": 8799,
          "end": 8807,
          "line": 212,
          "column": 24,
          "expression": "reject()",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Image",
          "start": 8852,
          "end": 8863,
          "line": 214,
          "column": 30,
          "expression": "new Image()",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "context.drawImage",
          "start": 9097,
          "end": 9159,
          "line": 220,
          "column": 17,
          "expression": "context.drawImage(newImage, 0, 0, canvas.width, canvas.height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "context.getImageData",
          "start": 9189,
          "end": 9244,
          "line": 221,
          "column": 29,
          "expression": "context.getImageData(0, 0, canvas.width, canvas.height)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "resolve",
          "start": 9384,
          "end": 9440,
          "line": 224,
          "column": 17,
          "expression": "resolve(bufferToTensor(img.data, bufferToTensorOptions))",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "bufferToTensor",
          "start": 9392,
          "end": 9439,
          "line": 224,
          "column": 25,
          "expression": "bufferToTensor(img.data, bufferToTensorOptions)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 9500,
          "end": 9575,
          "line": 229,
          "column": 15,
          "expression": "new Error('Input data provided is not supported - aborted tensor creation')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "bufferToTensor",
          "start": 9628,
          "end": 9671,
          "line": 232,
          "column": 16,
          "expression": "bufferToTensor(data, bufferToTensorOptions)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 9704,
          "end": 9779,
          "line": 235,
          "column": 15,
          "expression": "new Error('Input data provided is not supported - aborted tensor creation')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 10076,
          "end": 10162,
          "line": 245,
          "column": 12,
          "expression": "new Tensor({ location: 'texture', type: 'float32', texture, dims, download, dispose })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 9874
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 10351,
          "end": 10454,
          "line": 252,
          "column": 12,
          "expression": "new Tensor({ location: 'gpu-buffer', type: dataType ?? 'float32', gpuBuffer, dims, download, dispose })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 10255
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 10640,
          "end": 10741,
          "line": 259,
          "column": 12,
          "expression": "new Tensor({ location: 'ml-tensor', type: dataType ?? 'float32', mlTensor, dims, download, dispose })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 10545
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 10864,
          "end": 10953,
          "line": 264,
          "column": 63,
          "expression": "new Tensor({ location: 'cpu-pinned', type, data: buffer, dims: dims ?? [buffer.length] })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 10840
            }
          ]
        }
      ],
      "assignments": [
        {
          "start": 1033,
          "end": 1088,
          "line": 26,
          "column": 9,
          "expression": "normMean = [norm.mean, norm.mean, norm.mean, norm.mean]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 1115,
          "end": 1189,
          "line": 29,
          "column": 9,
          "expression": "normMean = [norm.mean[0], norm.mean[1], norm.mean[2], norm.mean[3] ?? 255]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 1246,
          "end": 1301,
          "line": 32,
          "column": 9,
          "expression": "normBias = [norm.bias, norm.bias, norm.bias, norm.bias]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 1328,
          "end": 1400,
          "line": 35,
          "column": 9,
          "expression": "normBias = [norm.bias[0], norm.bias[1], norm.bias[2], norm.bias[3] ?? 0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2192,
          "end": 2200,
          "line": 47,
          "column": 9,
          "expression": "step = 3",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2210,
          "end": 2227,
          "line": 48,
          "column": 9,
          "expression": "rImagePointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2237,
          "end": 2254,
          "line": 49,
          "column": 9,
          "expression": "gImagePointer = 1",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2264,
          "end": 2281,
          "line": 50,
          "column": 9,
          "expression": "bImagePointer = 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2291,
          "end": 2309,
          "line": 51,
          "column": 9,
          "expression": "aImagePointer = -1",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2434,
          "end": 2461,
          "line": 55,
          "column": 9,
          "expression": "aTensorPointer = stride * 3",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2516,
          "end": 2534,
          "line": 58,
          "column": 9,
          "expression": "rTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2544,
          "end": 2567,
          "line": 59,
          "column": 9,
          "expression": "bTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2577,
          "end": 2604,
          "line": 60,
          "column": 9,
          "expression": "gTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2659,
          "end": 2677,
          "line": 63,
          "column": 9,
          "expression": "bTensorPointer = 0",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2687,
          "end": 2710,
          "line": 64,
          "column": 9,
          "expression": "gTensorPointer = stride",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2720,
          "end": 2747,
          "line": 65,
          "column": 9,
          "expression": "rTensorPointer = stride * 2",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2792,
          "end": 2813,
          "line": 67,
          "column": 38,
          "expression": "rImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2815,
          "end": 2836,
          "line": 67,
          "column": 61,
          "expression": "bImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2838,
          "end": 2859,
          "line": 67,
          "column": 84,
          "expression": "gImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2861,
          "end": 2882,
          "line": 67,
          "column": 107,
          "expression": "aImagePointer += step",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2894,
          "end": 2977,
          "line": 68,
          "column": 9,
          "expression": "float32Data[rTensorPointer++] = (buffer[rImagePointer] + normBias[0]) / normMean[0]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 2987,
          "end": 3070,
          "line": 69,
          "column": 9,
          "expression": "float32Data[gTensorPointer++] = (buffer[gImagePointer] + normBias[1]) / normMean[1]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 3080,
          "end": 3163,
          "line": 70,
          "column": 9,
          "expression": "float32Data[bTensorPointer++] = (buffer[bImagePointer] + normBias[2]) / normMean[2]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 3238,
          "end": 3321,
          "line": 72,
          "column": 13,
          "expression": "float32Data[aTensorPointer++] = (buffer[aImagePointer] + normBias[3]) / normMean[3]",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 473
            }
          ]
        },
        {
          "start": 5041,
          "end": 5067,
          "line": 118,
          "column": 9,
          "expression": "canvas.width = image.width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 5077,
          "end": 5105,
          "line": 119,
          "column": 9,
          "expression": "canvas.height = image.height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 5417,
          "end": 5447,
          "line": 125,
          "column": 17,
          "expression": "height = options.resizedHeight",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 5465,
          "end": 5493,
          "line": 126,
          "column": 17,
          "expression": "width = options.resizedWidth",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 5566,
          "end": 5597,
          "line": 129,
          "column": 17,
          "expression": "bufferToTensorOptions = options",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 5818,
          "end": 5861,
          "line": 134,
          "column": 21,
          "expression": "bufferToTensorOptions.tensorFormat = 'RGBA'",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 5897,
          "end": 5934,
          "line": 136,
          "column": 17,
          "expression": "bufferToTensorOptions.height = height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 5952,
          "end": 5987,
          "line": 137,
          "column": 17,
          "expression": "bufferToTensorOptions.width = width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6038,
          "end": 6081,
          "line": 140,
          "column": 17,
          "expression": "bufferToTensorOptions.tensorFormat = 'RGBA'",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6099,
          "end": 6136,
          "line": 141,
          "column": 17,
          "expression": "bufferToTensorOptions.height = height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6154,
          "end": 6189,
          "line": 142,
          "column": 17,
          "expression": "bufferToTensorOptions.width = width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6269,
          "end": 6330,
          "line": 145,
          "column": 13,
          "expression": "data = pixels2DContext.getImageData(0, 0, width, height).data",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6627,
          "end": 6657,
          "line": 155,
          "column": 13,
          "expression": "height = options.resizedHeight",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6671,
          "end": 6699,
          "line": 156,
          "column": 13,
          "expression": "width = options.resizedWidth",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6738,
          "end": 6759,
          "line": 159,
          "column": 13,
          "expression": "height = image.height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6773,
          "end": 6792,
          "line": 160,
          "column": 13,
          "expression": "width = image.width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6853,
          "end": 6884,
          "line": 163,
          "column": 13,
          "expression": "bufferToTensorOptions = options",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6904,
          "end": 6941,
          "line": 165,
          "column": 9,
          "expression": "bufferToTensorOptions.format = 'RGBA'",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6951,
          "end": 6988,
          "line": 166,
          "column": 9,
          "expression": "bufferToTensorOptions.height = height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 6998,
          "end": 7033,
          "line": 167,
          "column": 9,
          "expression": "bufferToTensorOptions.width = width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 7131,
          "end": 7155,
          "line": 170,
          "column": 13,
          "expression": "tempCanvas.width = width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 7169,
          "end": 7195,
          "line": 171,
          "column": 13,
          "expression": "tempCanvas.height = height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 7384,
          "end": 7445,
          "line": 175,
          "column": 17,
          "expression": "data = pixels2DContext.getImageData(0, 0, width, height).data",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 7593,
          "end": 7610,
          "line": 182,
          "column": 13,
          "expression": "data = image.data",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 7912,
          "end": 7938,
          "line": 191,
          "column": 9,
          "expression": "canvas.width = image.width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 7948,
          "end": 7976,
          "line": 192,
          "column": 9,
          "expression": "canvas.height = image.height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 8237,
          "end": 8298,
          "line": 198,
          "column": 13,
          "expression": "data = pixels2DContext.getImageData(0, 0, width, height).data",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 8312,
          "end": 8349,
          "line": 199,
          "column": 13,
          "expression": "bufferToTensorOptions.height = height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 8363,
          "end": 8398,
          "line": 200,
          "column": 13,
          "expression": "bufferToTensorOptions.width = width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 8877,
          "end": 8911,
          "line": 215,
          "column": 13,
          "expression": "newImage.crossOrigin = 'Anonymous'",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 8925,
          "end": 8945,
          "line": 216,
          "column": 13,
          "expression": "newImage.src = image",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 8959,
          "end": 9455,
          "line": 217,
          "column": 13,
          "expression": "newImage.onload = () => {\n                canvas.width = newImage.width;\n                canvas.height = newImage.height;\n                context.drawImage(newImage, 0, 0, canvas.width, canvas.height);\n                const img = context.getImageData(0, 0, canvas.width, canvas.height);\n                bufferToTensorOptions.height = canvas.height;\n                bufferToTensorOptions.width = canvas.width;\n                resolve(bufferToTensor(img.data, bufferToTensorOptions));\n            }",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 9001,
          "end": 9030,
          "line": 218,
          "column": 17,
          "expression": "canvas.width = newImage.width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 9048,
          "end": 9079,
          "line": 219,
          "column": 17,
          "expression": "canvas.height = newImage.height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 9262,
          "end": 9306,
          "line": 222,
          "column": 17,
          "expression": "bufferToTensorOptions.height = canvas.height",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        },
        {
          "start": 9324,
          "end": 9366,
          "line": 223,
          "column": 17,
          "expression": "bufferToTensorOptions.width = canvas.width",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8977
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 8615
            },
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 3667
            }
          ]
        }
      ],
      "independentMatchesPython": true,
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "pythonSourceSpansVerified": true
    },
    {
      "schema": "p001-pinned-nested-onnx-common-tensor-helpers-ast-record-v1",
      "path": "dist/esm/tensor-impl-type-mapping.js",
      "bytes": 2706,
      "sha256": "20bd5ddb858954cf071bace6c7a6628c8e311433798ec172f4c778bebd81d407",
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [
        {
          "kind": "NewExpression",
          "callee": "Map",
          "start": 248,
          "end": 565,
          "line": 4,
          "column": 54,
          "expression": "new Map([\n    ['float32', Float32Array],\n    ['uint8', Uint8Array],\n    ['int8', Int8Array],\n    ['uint16', Uint16Array],\n    ['int16', Int16Array],\n    ['int32', Int32Array],\n    ['bool', Uint8Array],\n    ['float64', Float64Array],\n    ['uint32', Uint32Array],\n    ['int4', Uint8Array],\n    ['uint4', Uint8Array],\n])",
          "functionAncestors": []
        },
        {
          "kind": "NewExpression",
          "callee": "Map",
          "start": 719,
          "end": 957,
          "line": 18,
          "column": 54,
          "expression": "new Map([\n    [Float32Array, 'float32'],\n    [Uint8Array, 'uint8'],\n    [Int8Array, 'int8'],\n    [Uint16Array, 'uint16'],\n    [Int16Array, 'int16'],\n    [Int32Array, 'int32'],\n    [Float64Array, 'float64'],\n    [Uint32Array, 'uint32'],\n])",
          "functionAncestors": []
        },
        {
          "kind": "CallExpression",
          "callee": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set",
          "start": 1877,
          "end": 1942,
          "line": 41,
          "column": 13,
          "expression": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('int64', BigInt64Array)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.set",
          "start": 1956,
          "end": 2021,
          "line": 42,
          "column": 13,
          "expression": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.set(BigInt64Array, 'int64')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set",
          "start": 2086,
          "end": 2153,
          "line": 45,
          "column": 13,
          "expression": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('uint64', BigUint64Array)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.set",
          "start": 2167,
          "end": 2234,
          "line": 46,
          "column": 13,
          "expression": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.set(BigUint64Array, 'uint64')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set",
          "start": 2297,
          "end": 2363,
          "line": 49,
          "column": 13,
          "expression": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('float16', Float16Array)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.set",
          "start": 2377,
          "end": 2443,
          "line": 50,
          "column": 13,
          "expression": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.set(Float16Array, 'float16')",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        },
        {
          "kind": "CallExpression",
          "callee": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set",
          "start": 2568,
          "end": 2633,
          "line": 54,
          "column": 13,
          "expression": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('float16', Uint16Array)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        }
      ],
      "assignments": [
        {
          "start": 1331,
          "end": 1357,
          "line": 34,
          "column": 9,
          "expression": "isTypedArrayChecked = true",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 1283
            }
          ]
        }
      ],
      "independentMatchesPython": true,
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "pythonSourceSpansVerified": true
    },
    {
      "schema": "p001-pinned-nested-onnx-common-tensor-helpers-ast-record-v1",
      "path": "dist/esm/tensor-utils-impl.js",
      "bytes": 1920,
      "sha256": "87d3e07c153616138c2f57846545eea9c47957c714d50c0264696bdc293e6732",
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "./tensor-impl.js",
          "start": 119,
          "end": 137,
          "line": 3,
          "column": 24,
          "expression": "'./tensor-impl.js'"
        }
      ],
      "effects": [
        {
          "kind": "CallExpression",
          "callee": "Number.isSafeInteger",
          "start": 407,
          "end": 432,
          "line": 13,
          "column": 41,
          "expression": "Number.isSafeInteger(dim)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 264
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "start": 454,
          "end": 513,
          "line": 14,
          "column": 19,
          "expression": "new TypeError(`dims[${i}] must be an integer, got: ${dim}`)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 264
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "RangeError",
          "start": 566,
          "end": 638,
          "line": 17,
          "column": 19,
          "expression": "new RangeError(`dims[${i}] must be a non-negative integer, got: ${dim}`)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 264
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 862,
          "end": 904,
          "line": 29,
          "column": 20,
          "expression": "new Tensor(tensor.type, tensor.data, dims)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 772
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 952,
          "end": 1111,
          "line": 31,
          "column": 20,
          "expression": "new Tensor({\n                location: 'cpu-pinned',\n                data: tensor.data,\n                type: tensor.type,\n                dims,\n            })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 772
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 1156,
          "end": 1318,
          "line": 38,
          "column": 20,
          "expression": "new Tensor({\n                location: 'texture',\n                texture: tensor.texture,\n                type: tensor.type,\n                dims,\n            })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 772
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 1366,
          "end": 1535,
          "line": 45,
          "column": 20,
          "expression": "new Tensor({\n                location: 'gpu-buffer',\n                gpuBuffer: tensor.gpuBuffer,\n                type: tensor.type,\n                dims,\n            })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 772
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "start": 1582,
          "end": 1748,
          "line": 52,
          "column": 20,
          "expression": "new Tensor({\n                location: 'ml-tensor',\n                mlTensor: tensor.mlTensor,\n                type: tensor.type,\n                dims,\n            })",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 772
            }
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "start": 1785,
          "end": 1864,
          "line": 59,
          "column": 19,
          "expression": "new Error(`tensorReshape: tensor location ${tensor.location} is not supported`)",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 772
            }
          ]
        }
      ],
      "assignments": [
        {
          "start": 658,
          "end": 669,
          "line": 19,
          "column": 9,
          "expression": "size *= dim",
          "functionAncestors": [
            {
              "kind": "ArrowFunction",
              "name": null,
              "start": 264
            }
          ]
        }
      ],
      "independentMatchesPython": true,
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "pythonSourceSpansVerified": true
    }
  ],
  "targetExecuted": false,
  "independentPythonChecks": [
    {
      "path": "dist/esm/version.js",
      "bytes": 287,
      "sha256": "f31ccccd8245226aa7af3cb1de6257b208be40335ca80270a6c21f6249cdb126",
      "moduleEdgeCount": 0,
      "callOrConstructorCount": 0,
      "topLevelCallOrConstructorCount": 0,
      "assignmentCount": 0,
      "independentSourceAndSpanMatches": true
    },
    {
      "path": "dist/esm/tensor-conversion-impl.js",
      "bytes": 7852,
      "sha256": "df6fa3cd1813c2d3e588cc07973cfe5ea2ab8647c957168200caa58e51440161",
      "moduleEdgeCount": 0,
      "callOrConstructorCount": 14,
      "topLevelCallOrConstructorCount": 0,
      "assignmentCount": 58,
      "independentSourceAndSpanMatches": true
    },
    {
      "path": "dist/esm/tensor-factory-impl.js",
      "bytes": 11002,
      "sha256": "cf5606fe23461e01bff59c2d72ac47d74e652548718f1e5fab07a22b441379b4",
      "moduleEdgeCount": 1,
      "callOrConstructorCount": 46,
      "topLevelCallOrConstructorCount": 0,
      "assignmentCount": 60,
      "independentSourceAndSpanMatches": true
    },
    {
      "path": "dist/esm/tensor-impl-type-mapping.js",
      "bytes": 2706,
      "sha256": "20bd5ddb858954cf071bace6c7a6628c8e311433798ec172f4c778bebd81d407",
      "moduleEdgeCount": 0,
      "callOrConstructorCount": 9,
      "topLevelCallOrConstructorCount": 2,
      "assignmentCount": 1,
      "independentSourceAndSpanMatches": true
    },
    {
      "path": "dist/esm/tensor-utils-impl.js",
      "bytes": 1920,
      "sha256": "87d3e07c153616138c2f57846545eea9c47957c714d50c0264696bdc293e6732",
      "moduleEdgeCount": 1,
      "callOrConstructorCount": 9,
      "topLevelCallOrConstructorCount": 0,
      "assignmentCount": 1,
      "independentSourceAndSpanMatches": true
    }
  ],
  "captureCommand": "node --input-type=module <<'JS' > /tmp/security-p001-common-helpers-ast-20261106-v1.json\nimport fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport zlib from 'node:zlib';\nimport ts from './node_modules/typescript/lib/typescript.js';\nconst prior=JSON.parse(JSON.parse(fs.readFileSync('/tmp/security-canonical-nested-onnx-common-v24-20261106.json','utf8')).results[0].content);\nconst unit=prior.pinnedNestedOnnxCommonImplementationPreparation.nextNamedSourceUnit;\nconst response=await fetch(unit.archiveUrl,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('HTTP '+response.status);\nconst archive=Buffer.from(await response.arrayBuffer());\nconst digest=(b,a='sha256',encoding='hex')=>crypto.createHash(a).update(b).digest(encoding);\nif(archive.length!==unit.archiveBytes||digest(archive)!==unit.archiveSha256||'sha512-'+digest(archive,'sha512','base64')!==unit.retainedIntegrity)throw Error('archive identity mismatch');\nconst tar=zlib.gunzipSync(archive),wanted=new Set(unit.files.map(p=>'package/'+p)),files=new Map();\nfor(let o=0;o+512<=tar.length;){const h=tar.subarray(o,o+512);if(h.every(b=>b===0))break;const field=(s,n)=>h.subarray(s,s+n).toString().split('\\0')[0];const name=field(0,100),prefix=field(345,155);const path=prefix?prefix+'/'+name:name;const size=parseInt(field(124,12).trim(),8)||0;if(wanted.has(path))files.set(path,tar.subarray(o+512,o+512+size));o+=512+Math.ceil(size/512)*512;}\nconst independent=JSON.parse(fs.readFileSync('/tmp/security-p001-common-helpers-source-20261106-v1.json','utf8'));\nconst records=[];\nfor(const path of unit.files){const data=files.get('package/'+path);if(!data)throw Error('missing '+path);const text=data.toString('utf8'),py=independent.records.find(r=>r.path===path);if(data.length!==py.bytes||digest(data)!==py.sha256||text!==py.sourceText)throw Error('independent mismatch '+path);const sf=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const edges=[],effects=[],assignments=[];const span=n=>{const start=n.getStart(sf),end=n.end,pos=sf.getLineAndCharacterOfPosition(start);return {start,end,line:pos.line+1,column:pos.character+1,expression:text.slice(start,end)};};const ancestors=n=>{const a=[];for(let p=n.parent;p;p=p.parent)if(ts.isFunctionLike(p))a.push({kind:ts.SyntaxKind[p.kind],name:p.name?.getText(sf)||null,start:p.getStart(sf)});return a;};const visit=n=>{if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier)edges.push({kind:ts.SyntaxKind[n.kind],specifier:n.moduleSpecifier.text,...span(n.moduleSpecifier)});if(ts.isCallExpression(n)||ts.isNewExpression(n)){const e={kind:ts.SyntaxKind[n.kind],callee:n.expression.getText(sf),...span(n),functionAncestors:ancestors(n)};effects.push(e);if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||n.expression.getText(sf)==='require'))edges.push({kind:n.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require',specifier:n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0])?n.arguments[0].text:null,argumentKind:n.arguments[0]?ts.SyntaxKind[n.arguments[0].kind]:null,...span(n)});}if(ts.isBinaryExpression(n)&&ts.isAssignmentOperator(n.operatorToken.kind))assignments.push({...span(n),functionAncestors:ancestors(n)});ts.forEachChild(n,visit);};visit(sf);records.push({schema:'p001-pinned-nested-onnx-common-tensor-helpers-ast-record-v1',path,bytes:data.length,sha256:digest(data),parseDiagnostics:sf.parseDiagnostics.map(d=>({code:d.code,start:d.start,length:d.length,message:ts.flattenDiagnosticMessageText(d.messageText,' ')})),moduleEdges:edges,effects,assignments,independentMatchesPython:true,targetExecuted:false,installedRuntimeIdentityProven:false});}\nconsole.log(JSON.stringify({schema:'p001-pinned-nested-onnx-common-tensor-helpers-ast-verification-v1',recordedAt:new Date().toISOString(),compiler:ts.version,archive:{bytes:archive.length,sha256:digest(archive),retainedIntegrityMatched:true},records,targetExecuted:false}));\nJS",
  "inputCanonical": {
    "slug": "papercusp",
    "rel_path": "security/p001-native-distribution-source-classification-20261106-nested-onnx-common-implementation-v24.json"
  }
}
