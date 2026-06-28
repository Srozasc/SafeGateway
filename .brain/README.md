# .brain — Bóveda compartida de Obsidian

Esta carpeta es una **bóveda de Obsidian versionada en el repo**. Funciona como espacio de notas compartidas por el equipo (specs, ADRs, decisiones técnicas, documentación libre) editable desde Obsidian o desde el agente vía MCP.

## Acceso vía MCP

Esta carpeta está expuesta como servidor MCP a través de [`@bitbonsai/mcpvault`](https://www.npmjs.com/package/@bitbonsai/mcpvault), configurado en [`.mcp.json`](../.mcp.json) en la raíz del proyecto. El agente puede leer, escribir, buscar y modificar notas sin necesidad de tener Obsidian abierto.

Herramientas disponibles (14): `read_note`, `write_note`, `patch_note`, `delete_note`, `move_note`, `list_directory`, `search_notes` (BM25), `get_frontmatter`, `update_frontmatter`, `manage_tags`, etc.

## Convenciones

- **Wikilinks `[[]]`** se renderizan correctamente en Obsidian y se preservan en plano.
- **Frontmatter YAML** se manipula con `update_frontmatter` (no editar a mano para evitar corrupción).
- **Búsqueda** soporta multi-word y reranking por relevancia (BM25).
- **`search_notes` con scope "vault"** lee recursivamente desde esta carpeta.

## Ignorados (config local, no se commitea)

- `.obsidian/` — configuración local de la app Obsidian (plugins, tema, atajos). El MCP la excluye automáticamente de la lectura.
- `.trash/` — papelera interna de Obsidian.
