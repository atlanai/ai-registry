# Examples

Status: two complete file registries and one host document.

| Example | What it shows |
|---|---|
| [acme-registry](acme-registry/README.md) | a complete file-spec root in one directory: three kinds, one namespace, one blob, every digest real. aireg reads it from a folder or a git repository. |
| [aireg](aireg/README.md) | a registry made with the CLI: the skills an agent uses to set up a registry, install from one and publish to one, offered by the installer, or installed later with the two commands `aireg doctor` prints, pinned to the release that matches your aireg |
| [host-document.json](host-document.json) | what `GET https://{host}/.well-known/registry.json` returns when a host serves several roots: the roots the caller may see, and how to authenticate |

## Boundaries

Examples use documented public interfaces, synthetic data, and reproducible setup. Each example identifies the specification version it uses. Examples demonstrate usage rather than define additional contract requirements.
