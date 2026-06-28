---
title: Bienvenida al vault .brain
type: index
tags: [meta, onboarding, mcp]
created: 2026-06-06
---

# Bienvenida a `.brain`

Esta es la nota de prueba del vault compartido del proyecto [[Gateway]].

## Propósito

- Notas compartidas del equipo: specs, ADRs, decisiones técnicas, documentación libre.
- Editable desde Obsidian (con wikilinks, graph view, plugins) **o** desde el agente vía [[MCP|@bitbonsai/mcpvault]].

## Convenciones

- Wikilinks: `[[nombre-de-nota]]`.
- Tags: `#meta` `#spec` `#adr` `#onboarding`.
- Frontmatter: manipular vía la herramienta `update_frontmatter` del MCP (no editar a mano para evitar corrupción de YAML).

## Cómo verificar el setup

```bash
pnpm validate:mcp
```

Este comando corre un smoke test que valida:

1. Que `.mcp.json` existe y es JSON válido con la estructura esperada.
2. Que la carpeta `.brain/` existe.
3. Que esta nota de bienvenida existe.
4. (Si hay red) Que el server MCP arranca, responde a `tools/list` con las 15 herramientas, y `read_note` devuelve el contenido + frontmatter de esta nota.

## Carpetas sugeridas

- `00-inbox/` — notas en borrador, ideas sueltas, esta bienvenida.
- `10-projects/` — proyectos activos con fecha de inicio/fin.
- `20-areas/` — áreas de responsabilidad de largo plazo.
- `30-resources/` — referencias, lecturas, links útiles.
- `50-adrs/` — Architecture Decision Records del proyecto.
