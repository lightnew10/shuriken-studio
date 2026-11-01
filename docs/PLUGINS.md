# Plugins — extending Shuriken without changing core

A plugin is a folder in `%APPDATA%\Shuriken Studio\plugins\<id>\` containing `plugin.json`:

```json
{
  "id": "blender",
  "name": "Blender",
  "version": "1.0.0",
  "enabled": true,
  "trust": "allow",
  "mcpServers": { "blender": { "command": "uvx", "args": ["blender-mcp"] } },
  "skills": "skills",
  "knowledge": "knowledge"
}
```

What a plugin can contribute today:

| Contribution | How it is used |
|---|---|
| `mcpServers` | Each server is connected over stdio with reconnect/backoff. Every tool it exposes is recorded in the capability registry (`plugin:<id>/<server>.<tool>`, with schema) and is callable by agents through `external_tools` / `external_call`, audited and policy-checked like every other tool. |
| `skills` | Folder of `<name>/SKILL.md` skills, indexed with the global skills and offered by the context compiler when relevant. |
| `knowledge` | Folder of seed JSON (same format as `resources/knowledge`), loaded once into the global knowledge base with its sources. |
| `trust` | `allow` (calls audited) or `ask` (calls refused until the user changes trust). |

Health: plugins appear under Integrations → Plugins; a broken plugin disables only itself.

Planned contribution types (the boundary exists, not yet wired): UI panels, validators, asset importers/exporters, document parsers, additional AI providers.

See `resources/plugin-examples/blender` for a disabled example.
