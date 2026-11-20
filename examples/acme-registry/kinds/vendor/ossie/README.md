# Apache Ossie schemas

The JSON Schemas the [`semantic_model`](../../semantic_model.json) kind validates a model against,
copied byte for byte from [apache/ossie](https://github.com/apache/ossie). Apache-2.0. Nothing
here is edited, so each file keeps the `$id` its project gave it.

| Ossie version | File | Source | sha256 |
|---|---|---|---|
| 0.1.1 | [0.1.1/osi-schema.json](0.1.1/osi-schema.json) | `core-spec/osi-schema.json` at tag `osi-0.1.1-rc1` (`faf5810`) | `c1e9adec39562786aa78809665fba568797b15f4c53a0847d9cbcf2dead1bc94` |
| 0.2.0.dev0 | [0.2.0.dev0/ossie-schema.json](0.2.0.dev0/ossie-schema.json) | `core-spec/ossie-schema.json` on `main` at `7a8de20` | `2cf11e3c555b767b2612a4e479545e55485d81af62c3bf465a03f33a861aae4c` |

0.2.0.dev0 is unreleased, and Ossie's spec says its schema can change. It is here because every
converter in apache/ossie-converters writes it. Replace it with 0.2.0 when Ossie releases that.

To add a version, copy its schema into a folder named after the version, add a row here, and add
the version to `model.version` and to `model.allOf` in `semantic_model.json`.

Apache Ossie (incubating). Copyright 2026 The Apache Software Foundation. This product includes
software developed at The Apache Software Foundation (http://www.apache.org/).
